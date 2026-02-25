const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ensureDir, nowIso } = require("./utils");

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

class ProcessManager {
  constructor({ db, logsDir }) {
    this.db = db;
    this.logsDir = logsDir;
    this.running = new Map();
    ensureDir(this.logsDir);
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
      env: { ...process.env, ...(app.env || {}) },
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

    return child.pid;
  }

  async stop(appName) {
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
  }

  async restart(appName) {
    await this.stop(appName);
    return this.start(appName);
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
}

module.exports = {
  ProcessManager,
  isPidAlive
};
