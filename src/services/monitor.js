const os = require("os");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const cron = require("node-cron");
const { escapeHtml } = require("../utils");
const { formatBytes, formatUptime, getDiskUsage, getPidUsage } = require("./vpsInfo");

class Monitor {
    constructor(deps) {
        this.db = deps.db;
        this.bot = deps.bot;
        this.ADMIN_IDS = deps.ADMIN_IDS;
        this.cronJob = null;
        this.backupCronJob = null;
        this.deps = deps; // store for backup paths
        this._initFromSettings();
    }

    _initFromSettings() {
        const settings = this.db.getSettings();
        if (settings.monitorSchedule) {
            this._setCron(settings.monitorSchedule);
        }
        if (settings.autoBackupSchedule) {
            this._setBackupCron(settings.autoBackupSchedule);
        }
    }

    setSchedule(schedule) {
        if (this.cronJob) { this.cronJob.stop(); this.cronJob = null; }
        if (schedule && cron.validate(schedule)) {
            this._setCron(schedule);
        }
    }

    _setCron(schedule) {
        if (this.cronJob) { this.cronJob.stop(); }
        this.cronJob = cron.schedule(schedule, () => this._run());
    }

    async _run() {
        try {
            const report = await this._buildReport();
            await this._sendToAdmins(report);
            await this._checkDiskAlert();
        } catch (err) {
            console.error("[Monitor._run]", err);
        }
    }

    async _buildReport() {
        const apps = this.db.getApps();
        const names = Object.keys(apps).sort();
        const running = [];
        const stopped = [];

        for (const name of names) {
            const app = apps[name];
            const runtime = app.runtime || {};
            if (runtime.status === "running" && runtime.pid) {
                running.push({ name, pid: runtime.pid });
            } else {
                stopped.push(name);
            }
        }

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : "-";
        const disk = await getDiskUsage();
        const load = os.loadavg().map((n) => n.toFixed(2)).join(" / ");

        const lines = [
            "📊 <b>Monitoring Report</b>",
            "",
            "<b>🖥️ System</b>",
            "<blockquote>",
            `<b>Load:</b> ${escapeHtml(load)}`,
            `<b>RAM:</b> ${escapeHtml(formatBytes(usedMem))} / ${escapeHtml(formatBytes(totalMem))} (${escapeHtml(memPct)}%)`,
            `<b>Disk:</b> ${escapeHtml(disk.used)} / ${escapeHtml(disk.total)} (${escapeHtml(disk.percent)})`,
            `<b>Uptime:</b> ${escapeHtml(formatUptime(os.uptime()))}`,
            "</blockquote>"
        ];

        lines.push("", `<b>📱 Apps</b> (${running.length} running / ${names.length} total)`);

        if (running.length > 0) {
            lines.push("<blockquote>");
            for (const { name, pid } of running) {
                const usage = await getPidUsage(pid);
                if (usage) {
                    lines.push(`🟢 <b>${escapeHtml(name)}</b> — CPU ${escapeHtml(usage.cpu)}% | RAM ${escapeHtml(usage.rss)}`);
                } else {
                    lines.push(`🟢 <b>${escapeHtml(name)}</b> — pid ${pid}`);
                }
            }
            lines.push("</blockquote>");
        }

        if (stopped.length > 0) {
            lines.push("<blockquote>");
            for (const name of stopped) {
                lines.push(`🔴 ${escapeHtml(name)}`);
            }
            lines.push("</blockquote>");
        }

        const d = new Date();
        const dateOptions = { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
        lines.push("", `🕒 <i>${d.toLocaleString('id-ID', dateOptions)}</i>`);

        return lines.join("\n");
    }

    async _checkDiskAlert() {
        try {
            const settings = this.db.getSettings();
            const threshold = settings.diskAlertThreshold || 85;
            const disk = await getDiskUsage();
            const pctNum = parseInt(disk.percent, 10);
            if (!isNaN(pctNum) && pctNum >= threshold) {
                const msg = [
                    "⚠️ <b>DISK SPACE ALERT</b> ⚠️",
                    "",
                    `Penggunaan disk telah mencapai <b>${escapeHtml(disk.percent)}</b> (threshold: ${threshold}%)`,
                    `<b>Used:</b> ${escapeHtml(disk.used)} / ${escapeHtml(disk.total)}`,
                    `<b>Available:</b> ${escapeHtml(disk.avail)}`,
                    "",
                    "Silakan lakukan cleanup melalui /panel → VPS Info → 🧹 Cleanup System"
                ].join("\n");
                await this._sendToAdmins(msg);
            }
        } catch (err) {
            console.error("[Monitor._checkDiskAlert]", err);
        }
    }

    async _sendToAdmins(text) {
        const allAdmins = [...this.ADMIN_IDS];
        const dbSettings = this.db.getSettings();
        if (dbSettings.admins) {
            for (const id of dbSettings.admins) {
                if (!allAdmins.includes(id)) allAdmins.push(id);
            }
        }
        for (const adminId of allAdmins) {
            try {
                await this.bot.telegram.sendMessage(adminId, text, { parse_mode: "HTML" });
            } catch (err) {
                console.error(`[Monitor] Gagal kirim ke ${adminId}:`, err.message);
            }
        }
    }

    // Manual trigger for /monitor command
    async getReport() {
        return this._buildReport();
    }

    // === Auto-Backup ===
    setBackupSchedule(schedule) {
        if (this.backupCronJob) { this.backupCronJob.stop(); this.backupCronJob = null; }
        if (schedule && cron.validate(schedule)) {
            this._setBackupCron(schedule);
        }
    }

    _setBackupCron(schedule) {
        if (this.backupCronJob) { this.backupCronJob.stop(); }
        this.backupCronJob = cron.schedule(schedule, () => this._runBackup());
    }

    async _runBackup() {
        try {
            await this._sendToAdmins("💾 <b>Auto-Backup</b> dimulai...");
            await this.sendBackup();
        } catch (err) {
            console.error("[Monitor._runBackup]", err);
            await this._sendToAdmins(`❌ Auto-Backup gagal: ${escapeHtml(err.message)}`);
        }
    }

    async sendBackup() {
        const { DB_PATH, ROOT_DIR, DEPLOYMENTS_DIR } = this.deps;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFilename = `control-bot-backup-${timestamp}.zip`;
        const backupPath = path.join(os.tmpdir(), backupFilename);

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(backupPath);
            const archive = archiver("zip", { zlib: { level: 9 } });

            output.on("close", async () => {
                try {
                    const allAdmins = [...this.ADMIN_IDS];
                    const dbSettings = this.db.getSettings();
                    if (dbSettings.admins) { for (const id of dbSettings.admins) { if (!allAdmins.includes(id)) allAdmins.push(id); } }
                    for (const adminId of allAdmins) {
                        try {
                            await this.bot.telegram.sendDocument(adminId, { source: backupPath, filename: backupFilename }, { caption: "💾 Auto-Backup (db.json & .env)" });
                        } catch (err) { console.error(`[Backup] Gagal kirim ke ${adminId}:`, err.message); }
                    }
                    fs.unlinkSync(backupPath);
                    resolve();
                } catch (err) { reject(err); }
            });

            archive.on("error", (err) => reject(err));
            archive.pipe(output);

            if (DB_PATH && fs.existsSync(DB_PATH)) archive.file(DB_PATH, { name: "db.json" });
            const mainEnv = path.join(ROOT_DIR, ".env");
            if (fs.existsSync(mainEnv)) archive.file(mainEnv, { name: "control-bot.env" });

            const apps = this.db.getApps();
            for (const name of Object.keys(apps)) {
                const appEnv = path.join(DEPLOYMENTS_DIR, name, ".env");
                if (fs.existsSync(appEnv)) { archive.file(appEnv, { name: `apps/${name}/.env` }); }
            }

            archive.finalize();
        });
    }
}

module.exports = { Monitor };
