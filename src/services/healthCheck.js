const http = require("http");
const https = require("https");
const cron = require("node-cron");
const { escapeHtml } = require("../utils");

class HealthCheck {
    constructor(deps) {
        this.db = deps.db;
        this.bot = deps.bot;
        this.ADMIN_IDS = deps.ADMIN_IDS;
        this.cronJobs = new Map();
        this._initFromApps();
    }

    _initFromApps() {
        const apps = this.db.getApps();
        for (const name of Object.keys(apps)) {
            const app = apps[name];
            if (app.healthCheckUrl && app.healthCheckSchedule) {
                this._setCron(name, app.healthCheckSchedule, app.healthCheckUrl);
            }
        }
    }

    updateCheck(appName, url, schedule) {
        const key = `hc:${appName}`;
        if (this.cronJobs.has(key)) { this.cronJobs.get(key).stop(); this.cronJobs.delete(key); }
        if (url && schedule && cron.validate(schedule)) {
            this._setCron(appName, schedule, url);
        }
    }

    removeCheck(appName) {
        const key = `hc:${appName}`;
        if (this.cronJobs.has(key)) { this.cronJobs.get(key).stop(); this.cronJobs.delete(key); }
    }

    _setCron(appName, schedule, url) {
        const key = `hc:${appName}`;
        if (this.cronJobs.has(key)) this.cronJobs.get(key).stop();
        const job = cron.schedule(schedule, () => this._ping(appName, url));
        this.cronJobs.set(key, job);
    }

    async _ping(appName, url) {
        try {
            const ok = await this._httpGet(url, 10000);
            if (!ok) {
                await this._alert(appName, url, "Endpoint tidak merespon atau status bukan 2xx");
            }
        } catch (err) {
            await this._alert(appName, url, err.message);
        }
    }

    _httpGet(url, timeout) {
        return new Promise((resolve) => {
            const proto = url.startsWith("https") ? https : http;
            const req = proto.get(url, { timeout }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
        });
    }

    async _alert(appName, url, reason) {
        const msg = [
            `🔍 <b>HEALTH CHECK ALERT</b>`,
            `App: <b>${escapeHtml(appName)}</b>`,
            `URL: <code>${escapeHtml(url)}</code>`,
            `Reason: ${escapeHtml(reason)}`
        ].join("\n");

        const allAdmins = [...this.ADMIN_IDS];
        const dbSettings = this.db.getSettings();
        if (dbSettings.admins) { for (const id of dbSettings.admins) { if (!allAdmins.includes(id)) allAdmins.push(id); } }

        // Check mute
        const app = this.db.getApp(appName);
        if (app && app.muteAlerts) return;

        for (const adminId of allAdmins) {
            try { await this.bot.telegram.sendMessage(adminId, msg, { parse_mode: "HTML" }); }
            catch (err) { console.error(`[HealthCheck] alert failed for ${adminId}:`, err.message); }
        }
    }

    async manualCheck(appName) {
        const app = this.db.getApp(appName);
        if (!app || !app.healthCheckUrl) return { ok: false, error: "No health check URL configured" };
        try {
            const ok = await this._httpGet(app.healthCheckUrl, 10000);
            return { ok, url: app.healthCheckUrl };
        } catch (err) {
            return { ok: false, url: app.healthCheckUrl, error: err.message };
        }
    }
}

module.exports = { HealthCheck };
