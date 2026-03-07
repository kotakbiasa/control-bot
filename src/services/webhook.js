const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { escapeHtml, normalizeLines, withinDir } = require("../utils");
const { removeAppInternal } = require("./appService");
const { formatBytes, formatUptime, getDiskUsage, getPidUsage } = require("./vpsInfo");
const { clip } = require("../panel/helpers");

function normalizePort(value, fallback = 9876) {
    const parsed = Number.parseInt(String(value || ""), 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) return fallback;
    return parsed;
}

function normalizeBaseUrl(value) {
    if (!value || typeof value !== "string") return "";
    return value.trim().replace(/\/+$/, "");
}

function mimeTypeFor(fileName) {
    if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
    if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
    if (fileName.endsWith(".js")) return "application/javascript; charset=utf-8";
    if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
    return "text/plain; charset=utf-8";
}

function parseJsonBody(raw) {
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function isBinaryBuffer(buffer) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
    for (const byte of sample) {
        if (byte === 0) return true;
    }
    return false;
}

class WebhookServer {
    constructor(deps) {
        this.db = deps.db;
        this.bot = deps.bot;
        this.botToken = deps.BOT_TOKEN;
        this.deployer = deps.deployer;
        this.processManager = deps.processManager;
        this.withAppLock = deps.withAppLock;
        this.isAdmin = deps.isAdmin;
        this.ADMIN_IDS = deps.ADMIN_IDS;
        this.ROOT_DIR = deps.ROOT_DIR;
        this.DEPLOYMENTS_DIR = deps.DEPLOYMENTS_DIR;
        this.LOGS_DIR = deps.LOGS_DIR;
        this.server = null;
        this.port = null;
        this.maxInitDataAgeSeconds = 60 * 60 * 24;
        this.miniAppDir = path.join(this.ROOT_DIR, "src", "miniapp");
        this.publicBaseUrl = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
        this.defaultPort = normalizePort(process.env.WEB_PORT, this._getConfiguredPort());
        this.start(this.defaultPort);
    }

    _getConfiguredPort() {
        const settings = this.db.getSettings();
        return normalizePort(settings.webhookPort || 9876);
    }

    getWebAppUrl() {
        if (!this.publicBaseUrl) return null;
        return `${this.publicBaseUrl}/miniapp`;
    }

    getPublicWebhookBase() {
        if (this.publicBaseUrl) {
            return this.publicBaseUrl;
        }
        return `http://YOUR_IP:${this.port || this.defaultPort}`;
    }

    start(port) {
        const nextPort = normalizePort(port, this.defaultPort);
        if (this.server && this.port === nextPort) return;

        if (this.server) {
            this.close();
        }

        this.server = http.createServer((req, res) => {
            this._handleRequest(req, res).catch((err) => {
                console.error("[Web] Request error:", err);
                if (!res.headersSent) {
                    this._json(res, 500, { ok: false, error: err.message || "Internal server error" });
                } else {
                    try { res.end(); } catch { }
                }
            });
        });
        this.port = nextPort;

        this.server.listen(nextPort, () => {
            console.log(`[Web] Server listening on port ${nextPort}`);
        });

        this.server.on("error", (err) => {
            console.error("[Web] Server error:", err.message);
        });
    }

    stop() {
        // The HTTP server stays up for the Mini App. Webhook availability is controlled by settings.
    }

    close() {
        if (!this.server) return;
        this.server.close();
        this.server = null;
        this.port = null;
    }

    async _handleRequest(req, res) {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = url.pathname;

        if (pathname === "/healthz") {
            this._json(res, 200, { ok: true, port: this.port || this.defaultPort });
            return;
        }

        if (pathname === "/" || pathname === "/miniapp" || pathname === "/miniapp/" || pathname === "/miniapp/app.js" || pathname === "/miniapp/styles.css") {
            this._serveMiniAppAsset(pathname, res);
            return;
        }

        if (pathname.startsWith("/api/miniapp/")) {
            await this._handleMiniAppApi(req, res, url);
            return;
        }

        if (pathname.startsWith("/webhook/")) {
            await this._handleWebhookRequest(req, res, url);
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
    }

    _serveMiniAppAsset(pathname, res) {
        const relativePath = pathname === "/" || pathname === "/miniapp" || pathname === "/miniapp/"
            ? "index.html"
            : pathname.replace("/miniapp/", "");
        const safePath = path.resolve(this.miniAppDir, relativePath);

        if (!withinDir(this.miniAppDir, safePath) && safePath !== path.join(this.miniAppDir, "index.html")) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Forbidden");
            return;
        }

        if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
        }

        const headers = this._miniAppCacheHeaders(mimeTypeFor(safePath));

        if (relativePath === "index.html") {
            const assetVersion = this._getMiniAppAssetVersion();
            const content = fs.readFileSync(safePath, "utf8")
                .replace('href="/miniapp/styles.css"', `href="/miniapp/styles.css?v=${assetVersion}"`)
                .replace('src="/miniapp/app.js"', `src="/miniapp/app.js?v=${assetVersion}"`);

            res.writeHead(200, headers);
            res.end(content);
            return;
        }

        const content = fs.readFileSync(safePath);
        res.writeHead(200, headers);
        res.end(content);
    }

    _getMiniAppAssetVersion() {
        const assetFiles = ["index.html", "styles.css", "app.js"];
        let latestMtime = 0;

        for (const fileName of assetFiles) {
            const fullPath = path.join(this.miniAppDir, fileName);
            if (!fs.existsSync(fullPath)) continue;
            const stats = fs.statSync(fullPath);
            latestMtime = Math.max(latestMtime, Math.floor(stats.mtimeMs));
        }

        return String(latestMtime || Date.now());
    }

    _miniAppCacheHeaders(contentType) {
        return {
            "Content-Type": contentType,
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "Surrogate-Control": "no-store"
        };
    }

    async _handleWebhookRequest(req, res, url) {
        if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Method Not Allowed");
            return;
        }

        const settings = this.db.getSettings();
        if (!settings.webhookEnabled) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
        }

        const match = url.pathname.match(/^\/webhook\/([A-Za-z0-9_-]+)$/);
        if (!match) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not Found");
            return;
        }

        const appName = match[1];
        const secret = url.searchParams.get("secret");
        const app = this.db.getApp(appName);

        if (!app) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("App not found");
            return;
        }

        if (!app.webhookSecret || app.webhookSecret !== secret) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Invalid secret");
            return;
        }

        const body = await this._readBody(req);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, message: "Deploy triggered" }));

        try {
            const payload = parseJsonBody(body);
            if (payload.ref) {
                const branch = String(payload.ref).replace("refs/heads/", "");
                if (app.branch && branch !== app.branch) {
                    console.log(`[Webhook] Ignoring push to ${branch} (configured: ${app.branch})`);
                    return;
                }
            }
        } catch {
            // Ignore body parsing errors and continue with deploy
        }

        try {
            await this._notifyAdmins(`🔗 <b>Webhook Triggered</b>\nApp <b>${escapeHtml(appName)}</b> — memulai auto-deploy...`);

            await this.withAppLock(appName, async () => {
                const latestApp = this.db.getApp(appName);
                const runtime = latestApp?.runtime || {};
                const wasRunning = runtime.status === "running" && runtime.pid;

                if (wasRunning) {
                    await this.processManager.stop(appName);
                }

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
            const message = err instanceof Error ? err.message : String(err);
            await this._notifyAdmins(`❌ <b>Webhook Deploy Gagal</b>\nApp: <b>${escapeHtml(appName)}</b>\nError: ${escapeHtml(message)}`);
        }
    }

    async _handleMiniAppApi(req, res, url) {
        const auth = this._authenticateMiniApp(req);
        if (!auth.ok) {
            this._json(res, auth.status, { ok: false, error: auth.error });
            return;
        }

        try {
            if (req.method === "GET" && url.pathname === "/api/miniapp/bootstrap") {
                const payload = await this._buildBootstrapPayload(auth.user);
                this._json(res, 200, { ok: true, ...payload });
                return;
            }

            const appMatch = url.pathname.match(/^\/api\/miniapp\/apps\/([A-Za-z0-9_-]+)$/);
            if (req.method === "GET" && appMatch) {
                const appName = decodeURIComponent(appMatch[1]);
                const app = this.db.getApp(appName);
                if (!app) {
                    this._json(res, 404, { ok: false, error: `App "${appName}" tidak ditemukan.` });
                    return;
                }
                const detail = await this._buildAppDetail(appName, app);
                this._json(res, 200, { ok: true, app: detail });
                return;
            }

            const actionMatch = url.pathname.match(/^\/api\/miniapp\/apps\/([A-Za-z0-9_-]+)\/actions\/([a-z_]+)$/);
            if (req.method === "POST" && actionMatch) {
                const appName = decodeURIComponent(actionMatch[1]);
                const action = actionMatch[2];
                const body = parseJsonBody(await this._readBody(req));
                const result = await this._runMiniAppAction(appName, action, body);
                this._json(res, 200, { ok: true, ...result });
                return;
            }

            const logsMatch = url.pathname.match(/^\/api\/miniapp\/apps\/([A-Za-z0-9_-]+)\/logs$/);
            if (req.method === "GET" && logsMatch) {
                const appName = decodeURIComponent(logsMatch[1]);
                if (!this.db.getApp(appName)) {
                    this._json(res, 404, { ok: false, error: `App "${appName}" tidak ditemukan.` });
                    return;
                }
                const lines = normalizeLines(url.searchParams.get("lines"), 80);
                const logs = this.processManager.readLogs(appName, lines);
                this._json(res, 200, {
                    ok: true,
                    appName,
                    lines,
                    stdout: logs.out || "",
                    stderr: logs.err || "",
                    outPath: logs.outPath,
                    errPath: logs.errPath
                });
                return;
            }

            const filesMatch = url.pathname.match(/^\/api\/miniapp\/apps\/([A-Za-z0-9_-]+)\/files$/);
            if (req.method === "GET" && filesMatch) {
                const appName = decodeURIComponent(filesMatch[1]);
                const payload = this._listFiles(appName, url.searchParams.get("path") || ".");
                this._json(res, 200, { ok: true, ...payload });
                return;
            }

            const fileMatch = url.pathname.match(/^\/api\/miniapp\/apps\/([A-Za-z0-9_-]+)\/file$/);
            if (req.method === "GET" && fileMatch) {
                const appName = decodeURIComponent(fileMatch[1]);
                const filePath = url.searchParams.get("path") || "";
                const download = url.searchParams.get("download") === "1";
                await this._readFile(appName, filePath, download, res);
                return;
            }

            this._json(res, 404, { ok: false, error: "Route API tidak ditemukan." });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = message.includes("tidak ditemukan") ? 404 : 400;
            this._json(res, status, { ok: false, error: message });
        }
    }

    _authenticateMiniApp(req) {
        const rawInitData = req.headers["x-telegram-init-data"];
        const initData = Array.isArray(rawInitData) ? rawInitData[0] : rawInitData;
        if (!initData) {
            return { ok: false, status: 401, error: "Missing Telegram Mini App init data." };
        }

        try {
            const validated = this._validateTelegramInitData(initData);
            const userId = validated.user && validated.user.id ? String(validated.user.id) : "";
            if (!this.isAdmin(userId)) {
                return { ok: false, status: 403, error: "Akses ditolak. Telegram ID ini bukan admin." };
            }
            return { ok: true, status: 200, user: validated.user };
        } catch (err) {
            return {
                ok: false,
                status: 401,
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }

    _validateTelegramInitData(initData) {
        const params = new URLSearchParams(initData);
        const hash = params.get("hash");
        const authDate = Number.parseInt(params.get("auth_date") || "0", 10);

        if (!hash) throw new Error("Mini App hash tidak ditemukan.");
        if (!authDate) throw new Error("Mini App auth_date tidak valid.");

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - authDate) > this.maxInitDataAgeSeconds) {
            throw new Error("Mini App session kadaluarsa. Buka ulang dari Telegram.");
        }

        params.delete("hash");
        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join("\n");

        const secretKey = crypto.createHmac("sha256", "WebAppData")
            .update(this.botToken)
            .digest();

        const expectedHash = crypto.createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        const left = Buffer.from(expectedHash, "hex");
        const right = Buffer.from(hash, "hex");
        if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
            throw new Error("Mini App hash tidak cocok.");
        }

        const rawUser = params.get("user");
        if (!rawUser) throw new Error("Mini App user tidak ditemukan.");

        let user;
        try {
            user = JSON.parse(rawUser);
        } catch {
            throw new Error("Mini App user tidak valid.");
        }

        return { user, authDate };
    }

    async _buildBootstrapPayload(user) {
        const apps = this.db.getApps();
        const names = Object.keys(apps).sort((a, b) => {
            const ap = apps[a].pinned ? 0 : 1;
            const bp = apps[b].pinned ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return a.localeCompare(b);
        });
        const appList = names.map((name) => this._serializeAppSummary(name, apps[name]));
        const running = appList.filter((item) => item.status === "running").length;
        const vps = await this._buildVpsSnapshot();

        return {
            user: {
                id: user.id,
                first_name: user.first_name || "",
                last_name: user.last_name || "",
                username: user.username || ""
            },
            webAppUrl: this.getWebAppUrl(),
            summary: {
                totalApps: appList.length,
                runningApps: running,
                pinnedApps: appList.filter((item) => item.pinned).length
            },
            vps,
            apps: appList
        };
    }

    async _buildAppDetail(appName, app) {
        const runtime = app.runtime || {};
        const logs = this.processManager.readLogs(appName, 80);
        const currentStatus = runtime.status || "stopped";
        const pidUsage = runtime.pid ? await getPidUsage(runtime.pid) : null;
        return {
            name: appName,
            repo: app.repo || "",
            branch: app.branch || "",
            directory: app.directory || "",
            installCommand: app.installCommand || "",
            buildCommand: app.buildCommand || "",
            startCommand: app.startCommand || "",
            pinned: !!app.pinned,
            tags: Array.isArray(app.tags) ? app.tags : [],
            lastDeployAt: app.lastDeployAt || null,
            runtime: {
                status: currentStatus,
                pid: runtime.pid || null,
                lastStartAt: runtime.lastStartAt || null,
                lastStopAt: runtime.lastStopAt || null,
                lastExitCode: runtime.lastExitCode ?? null,
                lastSignal: runtime.lastSignal || null,
                usage: pidUsage
            },
            logs: {
                stdout: clip(logs.out || "", 2200),
                stderr: clip(logs.err || "", 2200)
            }
        };
    }

    async _buildVpsSnapshot() {
        const cpus = os.cpus();
        const cpuModel = cpus && cpus[0] ? cpus[0].model : "-";
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const disk = await getDiskUsage();
        return {
            host: os.hostname(),
            os: `${os.platform()} ${os.arch()}`,
            node: process.version,
            load: os.loadavg().map((value) => value.toFixed(2)),
            uptime: formatUptime(os.uptime()),
            botUptime: formatUptime(process.uptime()),
            cpuModel,
            cpuCount: cpus ? cpus.length : 0,
            memory: {
                usedBytes: usedMem,
                totalBytes: totalMem,
                usedLabel: formatBytes(usedMem),
                totalLabel: formatBytes(totalMem),
                percent: totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0
            },
            disk
        };
    }

    _serializeAppSummary(name, app) {
        const runtime = app.runtime || {};
        return {
            name,
            status: runtime.status || "stopped",
            pid: runtime.pid || null,
            branch: app.branch || "",
            repo: app.repo || "",
            directory: app.directory || "",
            pinned: !!app.pinned,
            tags: Array.isArray(app.tags) ? app.tags : [],
            lastDeployAt: app.lastDeployAt || null
        };
    }

    async _runMiniAppAction(appName, action, body) {
        const app = this.db.getApp(appName);
        if (!app) {
            throw new Error(`App "${appName}" tidak ditemukan.`);
        }

        let message = "";
        let detail = "";

        if (action === "start") {
            await this.withAppLock(appName, async () => {
                const pid = await this.processManager.start(appName);
                message = `App "${appName}" jalan. PID: ${pid}`;
            });
        } else if (action === "stop") {
            await this.withAppLock(appName, async () => {
                const result = await this.processManager.stop(appName);
                message = result.alreadyStopped
                    ? `App "${appName}" sudah berhenti.`
                    : `App "${appName}" dihentikan.`;
            });
        } else if (action === "restart") {
            await this.withAppLock(appName, async () => {
                const pid = await this.processManager.restart(appName);
                message = `App "${appName}" restart sukses. PID: ${pid}`;
            });
        } else if (action === "deploy") {
            await this.withAppLock(appName, async () => {
                const summary = await this.deployer.deploy(appName);
                message = `Deploy "${appName}" selesai.`;
                detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
            });
        } else if (action === "update") {
            await this.withAppLock(appName, async () => {
                const latestApp = this.db.getApp(appName);
                const runtime = latestApp.runtime || {};
                const wasRunning = runtime.status === "running" && runtime.pid;
                if (wasRunning) {
                    await this.processManager.stop(appName);
                }
                const summary = await this.deployer.deploy(appName, { updateOnly: true });
                if (wasRunning) {
                    const pid = await this.processManager.start(appName);
                    message = `Update "${appName}" selesai. App dijalankan kembali dengan PID ${pid}.`;
                } else {
                    message = `Update "${appName}" selesai. App tetap stop karena sebelumnya tidak running.`;
                }
                detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
            });
        } else if (action === "remove") {
            const deleteFiles = !!body.deleteFiles;
            await this.withAppLock(appName, async () => {
                await removeAppInternal(appName, { deleteFiles, force: true }, {
                    db: this.db,
                    processManager: this.processManager,
                    DEPLOYMENTS_DIR: this.DEPLOYMENTS_DIR,
                    LOGS_DIR: this.LOGS_DIR,
                    withinDir
                });
            });
            message = `App "${appName}" dihapus.${deleteFiles ? " File deployment dan log ikut dihapus." : ""}`;
        } else {
            throw new Error(`Aksi "${action}" tidak didukung.`);
        }

        const nextApp = this.db.getApp(appName);
        const appDetail = nextApp ? await this._buildAppDetail(appName, nextApp) : null;
        return {
            message,
            detail: detail ? clip(detail, 3200) : "",
            app: appDetail
        };
    }

    _listFiles(appName, relativePath) {
        const resolved = this._resolveAppPath(appName, relativePath);
        const items = fs.readdirSync(resolved.fullPath, { withFileTypes: true })
            .sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            })
            .map((entry) => {
                const absolute = path.join(resolved.fullPath, entry.name);
                const stat = fs.statSync(absolute);
                const childPath = resolved.relativePath === "."
                    ? entry.name
                    : path.join(resolved.relativePath, entry.name);
                return {
                    name: entry.name,
                    path: childPath,
                    type: entry.isDirectory() ? "dir" : "file",
                    size: stat.size,
                    sizeLabel: entry.isDirectory() ? "-" : formatBytes(stat.size),
                    modifiedAt: stat.mtime.toISOString()
                };
            });

        return {
            appName,
            path: resolved.relativePath,
            parentPath: resolved.relativePath === "." ? null : path.dirname(resolved.relativePath) || ".",
            items
        };
    }

    async _readFile(appName, filePath, download, res) {
        const resolved = this._resolveAppPath(appName, filePath, false);
        const stat = fs.statSync(resolved.fullPath);
        if (!stat.isFile()) {
            this._json(res, 400, { ok: false, error: "Path bukan file." });
            return;
        }

        const buffer = fs.readFileSync(resolved.fullPath);
        if (download) {
            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="${path.basename(resolved.fullPath)}"`
            });
            res.end(buffer);
            return;
        }

        const tooLarge = buffer.length > 1024 * 1024;
        const binary = isBinaryBuffer(buffer);
        const previewBuffer = tooLarge ? buffer.subarray(0, 1024 * 1024) : buffer;
        const content = binary ? "" : previewBuffer.toString("utf8");

        this._json(res, 200, {
            ok: true,
            appName,
            path: resolved.relativePath,
            size: buffer.length,
            sizeLabel: formatBytes(buffer.length),
            isBinary: binary,
            truncated: tooLarge,
            content
        });
    }

    _resolveAppPath(appName, relativePath, expectDirectory = true) {
        const app = this.db.getApp(appName);
        if (!app) throw new Error(`App "${appName}" tidak ditemukan.`);
        if (!app.directory || !fs.existsSync(app.directory)) {
            throw new Error(`Direktori app "${appName}" belum ada. Deploy dulu sebelum membuka file manager.`);
        }

        const sanitized = relativePath && relativePath !== "" ? relativePath : ".";
        const fullPath = path.resolve(app.directory, sanitized);
        if (!withinDir(app.directory, fullPath) && fullPath !== app.directory) {
            throw new Error("Akses file di luar direktori app ditolak.");
        }

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Path tidak ditemukan: ${sanitized}`);
        }

        const stat = fs.statSync(fullPath);
        if (expectDirectory && !stat.isDirectory()) {
            throw new Error("Path bukan direktori.");
        }

        const relativeResolved = path.relative(app.directory, fullPath) || ".";
        return {
            app,
            appDir: app.directory,
            fullPath,
            relativePath: relativeResolved
        };
    }

    async _readBody(req) {
        const chunks = [];
        let totalSize = 0;
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buffer);
            totalSize += buffer.length;
            if (totalSize > 1024 * 1024 * 8) {
                throw new Error("Request body terlalu besar.");
            }
        }
        return Buffer.concat(chunks).toString("utf8");
    }

    _json(res, status, payload) {
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify(payload));
    }

    async _notifyAdmins(text) {
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
                console.error(`[Webhook] Gagal kirim ke ${adminId}:`, err.message);
            }
        }
    }

    generateSecret() {
        return crypto.randomBytes(16).toString("hex");
    }
}

module.exports = { WebhookServer };
