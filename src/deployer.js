const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { nowIso, withinDir, getAugmentedEnv } = require("./utils");

const execAsync = promisify(exec);

async function runShell(command, options = {}) {
  const { cwd } = options;
  const result = await execAsync(command, {
    cwd,
    maxBuffer: 1024 * 1024 * 20,
    env: getAugmentedEnv()
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
  constructor({ db, deploymentsDir }) {
    this.db = db;
    this.deploymentsDir = deploymentsDir;
  }

  async deploy(appName, { updateOnly = false } = {}) {
    const app = this.db.getApp(appName);
    if (!app) throw new Error(`App "${appName}" tidak ditemukan`);

    if (!app.directory || !withinDir(this.deploymentsDir, app.directory)) {
      throw new Error(`Direktori app tidak valid: ${app.directory || "-"}`);
    }

    const summary = {
      repository: "",
      install: "",
      build: ""
    };

    if (!updateOnly && !fs.existsSync(app.directory)) {
      const action = await ensureRepo(app, this.deploymentsDir);
      summary.repository = `Repo ${action}`;
    } else {
      const action = await ensureRepo(app, this.deploymentsDir);
      summary.repository = `Repo ${action}`;
    }

    if (app.installCommand && app.installCommand.trim()) {
      const installResult = await runShell(app.installCommand, { cwd: app.directory });
      summary.install = [installResult.stdout, installResult.stderr].filter(Boolean).join("\n").trim();
    } else {
      summary.install = "Install command kosong (skip)";
    }

    if (app.buildCommand && app.buildCommand.trim()) {
      const buildResult = await runShell(app.buildCommand, { cwd: app.directory });
      summary.build = [buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n").trim();
    } else {
      summary.build = "Build command kosong (skip)";
    }

    await this.db.upsertApp(appName, (existing) => {
      if (!existing) throw new Error(`App "${appName}" tidak ditemukan`);
      return {
        ...existing,
        lastDeployAt: nowIso(),
        updatedAt: nowIso()
      };
    });

    return summary;
  }
}

module.exports = {
  Deployer,
  runShell
};
