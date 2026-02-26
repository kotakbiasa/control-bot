const os = require("os");
const cron = require("node-cron");
const { escapeHtml } = require("../utils");
const { formatBytes, formatUptime, getDiskUsage, getPidUsage } = require("./vpsInfo");

class Monitor {
    constructor(deps) {
        this.db = deps.db;
        this.bot = deps.bot;
        this.ADMIN_IDS = deps.ADMIN_IDS;
        this.cronJob = null;
        this._initFromSettings();
    }

    _initFromSettings() {
        const settings = this.db.getSettings();
        if (settings.monitorSchedule) {
            this._setCron(settings.monitorSchedule);
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
}

module.exports = { Monitor };
