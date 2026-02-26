const fs = require("fs");
const path = require("path");
const { nowIso } = require("../utils");

const AUDIT_LOG_MAX_SIZE = 500 * 1024; // 500KB max

class AuditLog {
    constructor(deps) {
        this.logPath = path.join(deps.DATA_DIR, "audit.log");
    }

    log(adminId, action, details = "") {
        try {
            const timestamp = nowIso();
            const entry = `[${timestamp}] [${adminId}] ${action}${details ? ": " + details : ""}\n`;
            fs.appendFileSync(this.logPath, entry, "utf8");
            this._trim();
        } catch (err) {
            console.error("[AuditLog]", err);
        }
    }

    _trim() {
        try {
            const stat = fs.statSync(this.logPath);
            if (stat.size > AUDIT_LOG_MAX_SIZE) {
                const content = fs.readFileSync(this.logPath, "utf8");
                const lines = content.split("\n");
                const half = Math.floor(lines.length / 2);
                fs.writeFileSync(this.logPath, lines.slice(half).join("\n"), "utf8");
            }
        } catch { /* ignore */ }
    }

    getRecent(count = 20) {
        try {
            if (!fs.existsSync(this.logPath)) return [];
            const content = fs.readFileSync(this.logPath, "utf8");
            const lines = content.split("\n").filter(Boolean);
            return lines.slice(-count);
        } catch { return []; }
    }
}

module.exports = { AuditLog };
