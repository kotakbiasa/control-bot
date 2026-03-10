const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const EventEmitter = require("events");
const cron = require("node-cron");
const { ensureDir, nowIso, getAugmentedEnv } = require("./utils");
const {
  normalizeAppRuntimeConfig,
  resolveRuntimeMode,
  shellQuote,
  dockerEnvArgs
} = require("./services/runtimeMode");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTailLines(filePath, lines = 80) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8");
  const arr = content.split(/\r?\n/);
  return arr.slice(-lines).join("\n");
}

class ProcessManager extends EventEmitter {
  constructor({ db, logsDir }) {
    super();
    this.db = db;
    this.logsDir = logsDir;
    this.running = new Map();
    this.stopping = new Set();
    this.starting = new Set();
    this.cronJobs = new Map();
    ensureDir(this.logsDir);

    // Hitung mundur pengecekan crash setiap 10 detik
    this.crashCheckInterval = setInterval(() => this._checkCrashes(), 10000);
  }

  async _checkCrashes() {
    try {
      const apps = this.db.getApps();
      for (const appName of Object.keys(apps)) {
        if (this.stopping.has(appName) || this.starting.has(appName)) continue;

        const app = this._hydrateApp(appName, apps[appName]);
        const mode = resolveRuntimeMode(app);
        const status = app.runtime && app.runtime.status ? app.runtime.status : "stopped";
        if (status !== "running") continue;

        if (mode === "docker") {
          const dockerState = this._inspectDockerState(app.docker.containerName);
          if (!dockerState.exists || !dockerState.running) {
            await this.updateRuntime(appName, {
              status: "stopped",
              pid: null,
              mode,
              lastStopAt: nowIso(),
              lastExitCode: dockerState.exists ? dockerState.exitCode : "DOCKER_CONTAINER_MISSING"
            });
            this.emit("crash", appName, app);
          }
          continue;
        }

        const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
        if (pid && !isPidAlive(pid)) {
          await this.updateRuntime(appName, {
            status: "stopped",
            pid: null,
            mode,
            lastStopAt: nowIso(),
            lastExitCode: "CRASH_DETECTED"
          });
          this.emit("crash", appName, app);
        }
      }
    } catch (err) {
      console.error("[ProcessManager._checkCrashes]", err);
    }
  }

  getLogPaths(appName) {
    ensureDir(this.logsDir);
    return {
      out: path.join(this.logsDir, `${appName}.out.log`),
      err: path.join(this.logsDir, `${appName}.err.log`)
    };
  }

  async recoverState() {
    const apps = this.db.getApps();
    const names = Object.keys(apps);
    for (const name of names) {
      const app = this._hydrateApp(name, apps[name]);
      const mode = resolveRuntimeMode(app);
      if (mode === "docker") {
        const dockerState = this._inspectDockerState(app.docker.containerName);
        if (dockerState.exists) {
          await this.updateRuntime(name, {
            mode,
            status: dockerState.running ? "running" : "stopped",
            pid: dockerState.running ? dockerState.pid : null,
            lastExitCode: dockerState.exitCode
          });
        } else {
          await this.updateRuntime(name, {
            mode,
            status: "stopped",
            pid: null
          });
        }
      } else {
        const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
        const alive = isPidAlive(pid);
        await this.updateRuntime(name, {
          mode,
          status: alive ? "running" : "stopped",
          pid: alive ? pid : null
        });
      }
      if (app.cronSchedule) {
        this.updateCron(name, app.cronSchedule);
      }
    }
  }

  async updateRuntime(appName, runtimePatch) {
    await this.db.upsertApp(appName, (existing) => {
      if (!existing) {
        throw new Error(`App "${appName}" tidak ditemukan`);
      }

      const runtime = {
        mode: "auto",
        status: "stopped",
        pid: null,
        lastStartAt: null,
        lastStopAt: null,
        lastExitCode: null,
        lastSignal: null,
        ...(existing.runtime || {}),
        ...runtimePatch
      };

      return {
        ...existing,
        runtime,
        updatedAt: nowIso()
      };
    });
  }

  async start(appName) {
    this.starting.add(appName);
    try {
      const app = this._hydrateApp(appName, this.db.getApp(appName));
      if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
      const mode = resolveRuntimeMode(app);

      if (mode === "docker") {
        const pid = await this._startDockerApp(appName, app);
        this.starting.delete(appName);
        return pid;
      }

      const pid = await this._startProcessApp(appName, app);
      this.starting.delete(appName);
      return pid;
    } catch (err) {
      this.starting.delete(appName);
      throw err;
    }
  }

  async stop(appName) {
    this.stopping.add(appName);
    try {
      const app = this._hydrateApp(appName, this.db.getApp(appName));
      if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
      const mode = resolveRuntimeMode(app);
      if (mode === "docker") {
        return this._stopDockerApp(appName, app);
      }
      return this._stopProcessApp(appName, app);
    } finally {
      this.stopping.delete(appName);
    }
  }

  async restart(appName) {
    const app = this._hydrateApp(appName, this.db.getApp(appName));
    if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
    const mode = resolveRuntimeMode(app);
    if (mode === "docker") {
      return this._restartDockerApp(appName, app);
    }
    await this.stop(appName);
    return this.start(appName);
  }

  updateCron(appName, schedule) {
    const key = `cron:${appName}`;
    if (this.cronJobs.has(key)) {
      this.cronJobs.get(key).stop();
      this.cronJobs.delete(key);
    }
    if (schedule && cron.validate(schedule)) {
      const job = cron.schedule(schedule, async () => {
        try {
          const app = this.db.getApp(appName);
          if (app && app.runtime.status === "running") {
            console.log(`[CRON] Auto-restarting app: ${appName}`);
            await this.restart(appName);
          }
        } catch (err) {
          console.error(`[CRON] Restart failed for ${appName}:`, err);
        }
      });
      this.cronJobs.set(key, job);
    }
  }

  readLogs(appName, lines = 80) {
    const app = this._hydrateApp(appName, this.db.getApp(appName));
    if (!app) {
      return {
        out: "",
        err: `App "${appName}" tidak ditemukan`,
        outPath: "",
        errPath: ""
      };
    }
    const mode = resolveRuntimeMode(app);
    if (mode === "docker") {
      const containerName = app.docker.containerName;
      const logs = this._runCommand(`docker logs --tail ${Number(lines) || 80} ${shellQuote(containerName)}`, {
        allowFailure: true
      });
      const merged = [logs.stdout, logs.stderr].filter(Boolean).join("\n").trim();
      return {
        out: merged || "(container logs kosong)",
        err: "",
        outPath: `docker:${containerName}`,
        errPath: `docker:${containerName}`
      };
    }

    const { out, err } = this.getLogPaths(appName);
    return {
      out: readTailLines(out, lines),
      err: readTailLines(err, lines),
      outPath: out,
      errPath: err
    };
  }

  // === Scheduled Commands ===
  addScheduledCommand(appName, label, schedule, command) {
    const key = `sched:${appName}:${label}`;
    if (this.cronJobs.has(key)) {
      this.cronJobs.get(key).stop();
      this.cronJobs.delete(key);
    }
    if (schedule && cron.validate(schedule)) {
      const job = cron.schedule(schedule, async () => {
        try {
          console.log(`[SCHED] Running "${label}" for ${appName}: ${command}`);
          await this.runCommandInApp(appName, command);
        } catch (err) {
          console.error(`[SCHED] Command "${label}" failed for ${appName}:`, err);
        }
      });
      this.cronJobs.set(key, job);
    }
  }

  removeScheduledCommand(appName, label) {
    const key = `sched:${appName}:${label}`;
    if (this.cronJobs.has(key)) {
      this.cronJobs.get(key).stop();
      this.cronJobs.delete(key);
    }
  }

  recoverScheduledCommands() {
    const apps = this.db.getApps();
    for (const appName of Object.keys(apps)) {
      const app = apps[appName];
      if (app.scheduledCommands && Array.isArray(app.scheduledCommands)) {
        for (const sc of app.scheduledCommands) {
          this.addScheduledCommand(appName, sc.label, sc.schedule, sc.command);
        }
      }
    }
  }

  async runCommandInApp(appName, command) {
    const app = this._hydrateApp(appName, this.db.getApp(appName));
    if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
    const mode = resolveRuntimeMode(app);
    if (mode === "docker") {
      const containerName = app.docker.containerName;
      const state = this._inspectDockerState(containerName);
      if (!state.exists || !state.running) {
        throw new Error(`Container "${containerName}" tidak berjalan. Jalankan /start ${appName} dulu.`);
      }
      const result = this._runCommand(
        `docker exec ${shellQuote(containerName)} sh -lc ${shellQuote(command)}`,
        { allowFailure: false, timeout: 60000 }
      );
      return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    }
    if (!fs.existsSync(app.directory)) throw new Error(`Direktori app belum ada: ${app.directory}`);
    const result = this._runCommand(command, {
      cwd: app.directory,
      timeout: 60000,
      env: app.env || {}
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  }

  async recreateDockerContainer(appName, appLike) {
    const app = this._hydrateApp(appName, appLike || this.db.getApp(appName));
    if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
    const containerName = app.docker.containerName;
    const imageTag = app.docker.imageTag;

    await this._removeDockerContainer(containerName);

    const envArgs = dockerEnvArgs(app.env || {});
    const portArgs = (app.docker.ports || []).map((item) => `-p ${shellQuote(item)}`);
    const volumeArgs = (app.docker.volumes || []).map((item) => `-v ${shellQuote(item)}`);
    const extraArgs = app.docker.extraArgs ? ` ${app.docker.extraArgs}` : "";

    const runCommand = [
      "docker run -d",
      `--name ${shellQuote(containerName)}`,
      "--restart unless-stopped",
      ...envArgs,
      ...portArgs,
      ...volumeArgs
    ].join(" ") + `${extraArgs} ${shellQuote(imageTag)}`;

    const runResult = this._runCommand(runCommand, { allowFailure: false });
    const containerId = (runResult.stdout || "").trim();
    const inspect = this._inspectDockerState(containerName);

    await this.updateRuntime(appName, {
      mode: "docker",
      status: inspect.running ? "running" : "stopped",
      pid: inspect.running ? inspect.pid : null,
      lastStartAt: inspect.running ? nowIso() : null,
      lastExitCode: inspect.exitCode
    });

    return {
      containerId,
      pid: inspect.pid,
      command: runCommand
    };
  }

  async removeDockerResources(appName) {
    const app = this._hydrateApp(appName, this.db.getApp(appName));
    if (!app) return;
    const containerName = app.docker.containerName;
    const imageTag = app.docker.imageTag;

    await this._removeDockerContainer(containerName);
    this._runCommand(`docker rmi -f ${shellQuote(imageTag)}`, { allowFailure: true });
    await this.updateRuntime(appName, {
      mode: "docker",
      status: "stopped",
      pid: null,
      lastStopAt: nowIso()
    });
  }

  _hydrateApp(appName, appLike) {
    if (!appLike) return null;
    return normalizeAppRuntimeConfig(appName, appLike);
  }

  _runCommand(command, options = {}) {
    const {
      cwd,
      timeout = 120000,
      env = {},
      allowFailure = false
    } = options;

    try {
      const stdout = execSync(command, {
        cwd,
        timeout,
        env: getAugmentedEnv(env),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"]
      });
      return {
        ok: true,
        stdout: stdout || "",
        stderr: "",
        code: 0
      };
    } catch (error) {
      const status = typeof error.status === "number" ? error.status : 1;
      const stdout = Buffer.isBuffer(error.stdout) ? error.stdout.toString("utf8") : (error.stdout || "");
      const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : (error.stderr || error.message || "");
      if (allowFailure) {
        return { ok: false, stdout, stderr, code: status };
      }
      const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
      throw new Error(detail || `Command failed: ${command}`);
    }
  }

  _inspectDockerState(containerName) {
    const inspect = this._runCommand(
      `docker inspect -f "{{.State.Running}}|{{.State.Status}}|{{.State.Pid}}|{{.State.ExitCode}}" ${shellQuote(containerName)}`,
      { allowFailure: true }
    );

    if (!inspect.ok) {
      return {
        exists: false,
        running: false,
        status: "missing",
        pid: null,
        exitCode: null
      };
    }

    const raw = (inspect.stdout || "").trim();
    const [runningRaw, statusRaw, pidRaw, exitCodeRaw] = raw.split("|");
    const running = String(runningRaw).trim() === "true";
    const pid = Number(pidRaw);
    const exitCode = Number(exitCodeRaw);
    return {
      exists: true,
      running,
      status: statusRaw || (running ? "running" : "stopped"),
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      exitCode: Number.isFinite(exitCode) ? exitCode : null
    };
  }

  async _removeDockerContainer(containerName) {
    const state = this._inspectDockerState(containerName);
    if (!state.exists) return;
    this._runCommand(`docker rm -f ${shellQuote(containerName)}`, { allowFailure: true });
  }

  async _startDockerApp(appName, app) {
    const containerName = app.docker.containerName;
    const state = this._inspectDockerState(containerName);
    if (!state.exists) {
      throw new Error(`Container "${containerName}" belum ada. Jalankan /deploy ${appName} dulu.`);
    }
    if (state.running) {
      throw new Error(`App "${appName}" sudah berjalan (container ${containerName})`);
    }

    this._runCommand(`docker start ${shellQuote(containerName)}`, { allowFailure: false });
    const next = this._inspectDockerState(containerName);
    await this.updateRuntime(appName, {
      mode: "docker",
      status: next.running ? "running" : "stopped",
      pid: next.running ? next.pid : null,
      lastStartAt: nowIso(),
      lastExitCode: next.exitCode
    });
    return next.pid;
  }

  async _stopDockerApp(appName, app) {
    const containerName = app.docker.containerName;
    const state = this._inspectDockerState(containerName);
    if (!state.exists || !state.running) {
      await this.updateRuntime(appName, {
        mode: "docker",
        status: "stopped",
        pid: null,
        lastStopAt: nowIso(),
        lastExitCode: state.exitCode
      });
      return { alreadyStopped: true };
    }

    this._runCommand(`docker stop ${shellQuote(containerName)}`, { allowFailure: false });
    const next = this._inspectDockerState(containerName);
    await this.updateRuntime(appName, {
      mode: "docker",
      status: next.running ? "running" : "stopped",
      pid: next.running ? next.pid : null,
      lastStopAt: nowIso(),
      lastExitCode: next.exitCode
    });
    return { alreadyStopped: false };
  }

  async _restartDockerApp(appName, app) {
    const containerName = app.docker.containerName;
    const state = this._inspectDockerState(containerName);
    if (!state.exists) {
      throw new Error(`Container "${containerName}" belum ada. Jalankan /deploy ${appName} dulu.`);
    }

    if (state.running) {
      this._runCommand(`docker restart ${shellQuote(containerName)}`, { allowFailure: false });
    } else {
      this._runCommand(`docker start ${shellQuote(containerName)}`, { allowFailure: false });
    }
    const next = this._inspectDockerState(containerName);
    await this.updateRuntime(appName, {
      mode: "docker",
      status: next.running ? "running" : "stopped",
      pid: next.running ? next.pid : null,
      lastStartAt: nowIso(),
      lastExitCode: next.exitCode
    });
    return next.pid;
  }

  async _startProcessApp(appName, app) {
    if (!fs.existsSync(app.directory)) {
      throw new Error(`Direktori app belum ada: ${app.directory}. Jalankan /deploy ${appName} dulu.`);
    }
    if (!app.startCommand || !app.startCommand.trim()) {
      throw new Error(`Start command untuk "${appName}" kosong. Atur dulu via /setcmd.`);
    }

    const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
    if (pid && isPidAlive(pid)) {
      throw new Error(`App "${appName}" sudah berjalan (PID ${pid})`);
    }

    const { out, err } = this.getLogPaths(appName);
    const outFd = fs.openSync(out, "a");
    const errFd = fs.openSync(err, "a");
    const child = spawn(app.startCommand, {
      cwd: app.directory,
      env: getAugmentedEnv(app.env || {}),
      shell: true,
      detached: true,
      stdio: ["ignore", outFd, errFd]
    });

    child.unref();
    this.running.set(appName, child);

    child.on("exit", async (code, signal) => {
      this.running.delete(appName);
      await this.updateRuntime(appName, {
        mode: "process",
        status: "stopped",
        pid: null,
        lastExitCode: code,
        lastSignal: signal || null,
        lastStopAt: nowIso()
      });
    });

    await this.updateRuntime(appName, {
      mode: "process",
      status: "running",
      pid: child.pid,
      lastStartAt: nowIso()
    });

    return child.pid;
  }

  async _stopProcessApp(appName, app) {
    const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
    if (!isPidAlive(pid)) {
      await this.updateRuntime(appName, {
        mode: "process",
        status: "stopped",
        pid: null,
        lastStopAt: nowIso()
      });
      return { alreadyStopped: true };
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    const maxWaitMs = 8000;
    const step = 250;
    let waited = 0;
    while (waited < maxWaitMs && isPidAlive(pid)) {
      await delay(step);
      waited += step;
    }

    if (isPidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }

    await this.updateRuntime(appName, {
      mode: "process",
      status: "stopped",
      pid: null,
      lastStopAt: nowIso()
    });

    return { alreadyStopped: false };
  }
}

module.exports = {
  ProcessManager,
  isPidAlive
};

