const fs = require("fs");
const path = require("path");
const { ensureDir, nowIso } = require("./utils");

class JsonDb {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.lock = Promise.resolve();
    ensureDir(path.dirname(this.dbPath));
    this.ensureFile();
  }

  ensureFile() {
    if (!fs.existsSync(this.dbPath)) {
      const initial = { apps: {}, meta: { createdAt: nowIso(), updatedAt: nowIso() } };
      fs.writeFileSync(this.dbPath, JSON.stringify(initial, null, 2), "utf8");
      return;
    }

    const raw = fs.readFileSync(this.dbPath, "utf8");
    if (!raw.trim()) {
      const initial = { apps: {}, meta: { createdAt: nowIso(), updatedAt: nowIso() } };
      fs.writeFileSync(this.dbPath, JSON.stringify(initial, null, 2), "utf8");
      return;
    }

    JSON.parse(raw);
  }

  async queueWrite(mutator) {
    const run = async () => {
      const db = this.read();
      const next = await mutator(db);
      next.meta = next.meta || {};
      next.meta.updatedAt = nowIso();
      fs.writeFileSync(this.dbPath, JSON.stringify(next, null, 2), "utf8");
      return next;
    };
    this.lock = this.lock.then(run, run);
    return this.lock;
  }

  read() {
    this.ensureFile();
    const raw = fs.readFileSync(this.dbPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.apps = parsed.apps || {};
    parsed.meta = parsed.meta || {};
    return parsed;
  }

  getApps() {
    return this.read().apps;
  }

  getApp(name) {
    const apps = this.getApps();
    return apps[name] || null;
  }

  async upsertApp(name, patch) {
    return this.queueWrite((db) => {
      const existing = db.apps[name] || null;
      const next = typeof patch === "function" ? patch(existing) : { ...(existing || {}), ...patch };
      db.apps[name] = next;
      return db;
    });
  }

  async deleteApp(name) {
    return this.queueWrite((db) => {
      delete db.apps[name];
      return db;
    });
  }
}

module.exports = {
  JsonDb
};
