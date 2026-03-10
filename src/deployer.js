const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { nowIso, withinDir, getAugmentedEnv } = require("./utils");
const {
  normalizeAppRuntimeConfig,
  detectProjectProfile,
  resolveRuntimeMode,
  buildPythonInstallCommand,
  buildPythonStartCommand,
  pythonExecutable,
  shellQuote,
  toPosixPath
} = require("./services/runtimeMode");

const execAsync = promisify(exec);

async function runShell(command, options = {}) {
  const { cwd, env = {} } = options;
  const result = await execAsync(command, {
    cwd,
    maxBuffer: 1024 * 1024 * 20,
    env: getAugmentedEnv(env)
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

async function ensureRepo(app, deploymentsDir) {
  if (app.repo === "local") {
    return "local (uploaded)";
  }

  const dir = app.directory;
  if (!withinDir(deploymentsDir, dir)) {
    throw new Error(`Direktori app di luar folder deployments: ${dir}`);
  }

  if (!fs.existsSync(dir)) {
    await runShell(`git clone --branch ${app.branch} --single-branch ${app.repo} "${dir}"`);
    return "cloned";
  }

  const gitDir = path.join(dir, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Direktori ${dir} ada tapi bukan git repository`);
  }

  await runShell(`git checkout ${app.branch}`, { cwd: dir });
  await runShell(`git pull origin ${app.branch}`, { cwd: dir });
  return "pulled";
}

class Deployer {
  constructor({ db, deploymentsDir, processManager }) {
    this.db = db;
    this.deploymentsDir = deploymentsDir;
    this.processManager = processManager;
  }

  async deploy(appName, { updateOnly = false } = {}) {
    const appRaw = this.db.getApp(appName);
    if (!appRaw) throw new Error(`App "${appName}" tidak ditemukan`);
    const app = normalizeAppRuntimeConfig(appName, appRaw, this.deploymentsDir);

    if (!app.directory || !withinDir(this.deploymentsDir, app.directory)) {
      throw new Error(`Direktori app tidak valid: ${app.directory || "-"}`);
    }

    const summary = {
      mode: "process",
      repository: "",
      install: "",
      build: "",
      docker: "",
      python: ""
    };

    if (!updateOnly && !fs.existsSync(app.directory)) {
      const action = await ensureRepo(app, this.deploymentsDir);
      summary.repository = `Repo ${action}`;
    } else {
      const action = await ensureRepo(app, this.deploymentsDir);
      summary.repository = `Repo ${action}`;
    }

    const sync = await this.syncRuntimeProfile(appName);
    const latestApp = sync.app;
    const mode = sync.mode;
    summary.mode = mode;

    if (mode === "docker") {
      const buildResult = await runShell(
        `docker build -t ${shellQuote(latestApp.docker.imageTag)} .`,
        { cwd: latestApp.directory }
      );
      summary.build = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n").trim() || "Docker build selesai";
      const dockerRun = await this.processManager.recreateDockerContainer(appName, latestApp);
      summary.docker = `Container recreated: ${latestApp.docker.containerName} (PID ${dockerRun.pid || "-"})`;
      summary.install = "Docker mode aktif: install command di-skip";
    } else {
      if (latestApp.python.detected && latestApp.python.venvEnabled) {
        const pySummary = await this.ensurePythonVenv(latestApp, sync.profile);
        summary.python = pySummary;
      } else if (latestApp.python.detected && !latestApp.python.venvEnabled) {
        summary.python = "Python terdeteksi, tetapi Python venv dimatikan";
      } else {
        summary.python = "Python tidak terdeteksi (skip)";
      }

      if (latestApp.installCommand && latestApp.installCommand.trim()) {
        const installResult = await runShell(latestApp.installCommand, { cwd: latestApp.directory });
        summary.install = [installResult.stdout, installResult.stderr].filter(Boolean).join("\n").trim();
      } else {
        summary.install = "Install command kosong (skip)";
      }

      if (latestApp.buildCommand && latestApp.buildCommand.trim()) {
        const buildResult = await runShell(latestApp.buildCommand, { cwd: latestApp.directory });
        summary.build = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n").trim();
      } else {
        summary.build = "Build command kosong (skip)";
      }
    }

    await this.db.upsertApp(appName, (existing) => {
      if (!existing) throw new Error(`App "${appName}" tidak ditemukan`);
      return {
        ...existing,
        runtime: {
          ...(existing.runtime || {}),
          mode
        },
        lastDeployAt: nowIso(),
        updatedAt: nowIso()
      };
    });

    return summary;
  }

  async rebuildPythonVenv(appName) {
    const appRaw = this.db.getApp(appName);
    if (!appRaw) throw new Error(`App "${appName}" tidak ditemukan`);
    const sync = await this.syncRuntimeProfile(appName);
    if (sync.mode === "docker") {
      throw new Error(`App "${appName}" sedang berada di docker mode. Matikan docker mode dulu untuk rebuild Python venv.`);
    }
    if (!sync.app.python.detected) {
      throw new Error(`Python tidak terdeteksi di app "${appName}".`);
    }
    if (!sync.app.python.venvEnabled) {
      throw new Error(`Python venv sedang nonaktif untuk app "${appName}". Aktifkan dulu di settings app.`);
    }
    return this.ensurePythonVenv(sync.app, sync.profile);
  }

  async syncRuntimeProfile(appName) {
    const existingRaw = this.db.getApp(appName);
    if (!existingRaw) throw new Error(`App "${appName}" tidak ditemukan`);
    const existing = normalizeAppRuntimeConfig(appName, existingRaw, this.deploymentsDir);
    const profile = detectProjectProfile(existing.directory);

    const python = {
      ...(existing.python || {}),
      detected: profile.pythonDetected,
      entrypoint: profile.entrypoint || existing.python.entrypoint || null
    };
    const docker = {
      ...(existing.docker || {}),
      detected: profile.hasDockerfile
    };
    const previewApp = {
      ...existing,
      python,
      docker
    };
    const mode = resolveRuntimeMode(previewApp);

    let forcedInstallCommand;
    let forcedStartCommand;
    if (mode === "process" && python.detected && python.venvEnabled) {
      forcedInstallCommand = buildPythonInstallCommand(previewApp, profile);
      forcedStartCommand = buildPythonStartCommand(previewApp, python.entrypoint);
    }

    await this.db.upsertApp(appName, (currentRaw) => {
      if (!currentRaw) throw new Error(`App "${appName}" tidak ditemukan`);
      const current = normalizeAppRuntimeConfig(appName, currentRaw, this.deploymentsDir);
      const next = {
        ...current,
        python: {
          ...current.python,
          ...python
        },
        docker: {
          ...current.docker,
          ...docker
        },
        runtime: {
          ...current.runtime,
          mode
        },
        updatedAt: nowIso()
      };

      if (typeof forcedInstallCommand === "string") {
        next.installCommand = forcedInstallCommand;
      }
      if (typeof forcedStartCommand === "string" && forcedStartCommand.trim()) {
        next.startCommand = forcedStartCommand;
      }
      return next;
    });

    const nextRaw = this.db.getApp(appName);
    if (!nextRaw) throw new Error(`App "${appName}" tidak ditemukan`);
    return {
      app: normalizeAppRuntimeConfig(appName, nextRaw, this.deploymentsDir),
      profile,
      mode
    };
  }

  async ensurePythonVenv(app, profile) {
    const venvDir = app.python.venvDir || ".venv";
    const pythonExec = pythonExecutable(app);

    const createResult = await runShell(`python3 -m venv ${shellQuote(toPosixPath(venvDir))}`, {
      cwd: app.directory
    });
    const pipUpgrade = await runShell(`${shellQuote(pythonExec)} -m pip install --upgrade pip`, {
      cwd: app.directory
    });

    let installResult = { stdout: "", stderr: "" };
    if (profile.hasRequirements) {
      installResult = await runShell(`${shellQuote(pythonExec)} -m pip install -r requirements.txt`, {
        cwd: app.directory
      });
    } else if (profile.hasPyproject) {
      installResult = await runShell(`${shellQuote(pythonExec)} -m pip install .`, {
        cwd: app.directory
      });
    }

    return [
      "Python venv siap",
      [createResult.stdout, createResult.stderr].filter(Boolean).join("\n").trim(),
      [pipUpgrade.stdout, pipUpgrade.stderr].filter(Boolean).join("\n").trim(),
      [installResult.stdout, installResult.stderr].filter(Boolean).join("\n").trim()
    ].filter(Boolean).join("\n");
  }
}

module.exports = {
  Deployer,
  runShell
};
