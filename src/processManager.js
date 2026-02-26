const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const EventEmitter = require("events");
const cron = require("node-cron");
const { ensureDir, nowIso, getAugmentedEnv } = require("./utils");

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

        const app = apps[appName];
        const status = app.runtime && app.runtime.status ? app.runtime.status : "stopped";
        const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;

        if (status === "running" && pid && !isPidAlive(pid)) {
          await this.updateRuntime(appName, {
            status: "stopped",
            pid: null,
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
      const app = apps[name];
      const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
      const alive = isPidAlive(pid);
      if (alive) {
        await this.updateRuntime(name, { status: "running" });
      } else {
        await this.updateRuntime(name, {
          status: "stopped",
          pid: null
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

  getStatus(app) {
    const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
    const alive = isPidAlive(pid);
    return {
      alive,
      pid: alive ? pid : null,
      status: alive ? "running" : "stopped"
    };
  }

  async start(appName) {
    this.starting.add(appName);
    try {
      const app = this.db.getApp(appName);
      if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
      const status = this.getStatus(app);
      if (status.alive) {
        throw new Error(`App "${appName}" sudah berjalan (PID ${status.pid})`);
      }

      if (!fs.existsSync(app.directory)) {
        throw new Error(`Direktori app belum ada: ${app.directory}. Jalankan /deploy ${appName} dulu.`);
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
          status: "stopped",
          pid: null,
          lastExitCode: code,
          lastSignal: signal || null,
          lastStopAt: nowIso()
        });
      });

      await this.updateRuntime(appName, {
        status: "running",
        pid: child.pid,
        lastStartAt: nowIso()
      });

      this.starting.delete(appName);
      return child.pid;
    } catch (err) {
      this.starting.delete(appName);
      throw err;
    }
  }

  async stop(appName) {
    this.stopping.add(appName);
    try {
      const app = this.db.getApp(appName);
      if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
      const pid = app.runtime && app.runtime.pid ? app.runtime.pid : null;
      if (!isPidAlive(pid)) {
        await this.updateRuntime(appName, {
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
        status: "stopped",
        pid: null,
        lastStopAt: nowIso()
      });

      return { alreadyStopped: false };
    } finally {
      this.stopping.delete(appName);
    }
  }

  async restart(appName) {
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
    const { execSync } = require("child_process");
    const app = this.db.getApp(appName);
    if (!app) throw new Error(`App "${appName}" tidak ditemukan`);
    if (!fs.existsSync(app.directory)) throw new Error(`Direktori app belum ada: ${app.directory}`);
    const result = execSync(command, { cwd: app.directory, timeout: 60000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return result;
  }
}

module.exports = {
  ProcessManager,
  isPidAlive
};

