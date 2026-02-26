const http = require("http");
const crypto = require("crypto");
const { escapeHtml } = require("../utils");

class WebhookServer {
    constructor(deps) {
        this.db = deps.db;
        this.bot = deps.bot;
        this.deployer = deps.deployer;
        this.processManager = deps.processManager;
        this.withAppLock = deps.withAppLock;
        this.ADMIN_IDS = deps.ADMIN_IDS;
        this.server = null;
        this._initFromSettings();
    }

    _initFromSettings() {
        const settings = this.db.getSettings();
        if (settings.webhookEnabled) {
            const port = settings.webhookPort || 9876;
            this.start(port);
        }
    }

    start(port) {
        if (this.server) { this.stop(); }
        this.server = http.createServer((req, res) => this._handleRequest(req, res));
        this.server.listen(port, () => {
            console.log(`[Webhook] Server listening on port ${port}`);
        });
        this.server.on("error", (err) => {
            console.error("[Webhook] Server error:", err.message);
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    async _handleRequest(req, res) {
        if (req.method !== "POST") {
            res.writeHead(405); res.end("Method Not Allowed"); return;
        }

        const urlParts = req.url.split("?");
        const pathname = urlParts[0];
        const query = new URLSearchParams(urlParts[1] || "");

        // URL format: /webhook/:appName
        const match = pathname.match(/^\/webhook\/([A-Za-z0-9_-]+)$/);
        if (!match) {
            res.writeHead(404); res.end("Not Found"); return;
        }

        const appName = match[1];
        const secret = query.get("secret");
        const app = this.db.getApp(appName);

        if (!app) {
            res.writeHead(404); res.end("App not found"); return;
        }

        if (!app.webhookSecret || app.webhookSecret !== secret) {
            res.writeHead(403); res.end("Invalid secret"); return;
        }

        // Collect body (for GitHub webhook payload)
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, message: "Deploy triggered" }));

            // Check branch if GitHub payload
            try {
                const payload = JSON.parse(body);
                if (payload.ref) {
                    const branch = payload.ref.replace("refs/heads/", "");
                    if (app.branch && branch !== app.branch) {
                        console.log(`[Webhook] Ignoring push to ${branch} (configured: ${app.branch})`);
                        return;
                    }
                }
            } catch { /* not JSON, deploy anyway */ }

            // Trigger deploy + restart
            try {
                await this._notifyAdmins(`🔗 <b>Webhook Triggered</b>\nApp <b>${escapeHtml(appName)}</b> — memulai auto-deploy...`);

                await this.withAppLock(appName, async () => {
                    const latestApp = this.db.getApp(appName);
                    const runtime = latestApp?.runtime || {};
                    const wasRunning = runtime.status === "running" && runtime.pid;

                    if (wasRunning) { await this.processManager.stop(appName); }
                    const summary = await this.deployer.deploy(appName, { updateOnly: true });

                    let runMsg = "";
                    if (wasRunning) {
                        const pid = await this.processManager.start(appName);
                        runMsg = `\nApp restarted. PID: ${pid}`;
                    }

                    const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n");
                    await this._notifyAdmins([
                        `✅ <b>Webhook Deploy Selesai</b>`,
                        `App: <b>${escapeHtml(appName)}</b>${runMsg}`,
                        detail ? `<pre>${escapeHtml(detail.slice(-800))}</pre>` : ""
                    ].filter(Boolean).join("\n"));
                });
            } catch (err) {
                await this._notifyAdmins(`❌ <b>Webhook Deploy Gagal</b>\nApp: <b>${escapeHtml(appName)}</b>\nError: ${escapeHtml(err.message)}`);
            }
        });
    }

    async _notifyAdmins(text) {
        const allAdmins = [...this.ADMIN_IDS];
        const dbSettings = this.db.getSettings();
        if (dbSettings.admins) {
            for (const id of dbSettings.admins) { if (!allAdmins.includes(id)) allAdmins.push(id); }
        }
        for (const adminId of allAdmins) {
            try { await this.bot.telegram.sendMessage(adminId, text, { parse_mode: "HTML" }); }
            catch (err) { console.error(`[Webhook] Gagal kirim ke ${adminId}:`, err.message); }
        }
    }

    generateSecret() {
        return crypto.randomBytes(16).toString("hex");
    }
}

module.exports = { WebhookServer };
