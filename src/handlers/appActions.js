const { clip, getChatIdFromCtx, parseCallbackAppName, answerCallback, replyError } = require("../panel/helpers");
const { selectedAppFromState, resolveSelectedAppForNav } = require("../panel/state");
const { renderPanel } = require("../panel/render");
const { removeAppInternal } = require("../services/appService");

function register(bot, deps) {
    const { db, processManager, deployer, withAppLock } = deps;

    bot.action(/^panel:sel:(.+)$/, async (ctx) => {
        const appName = parseCallbackAppName(ctx.match[1]);
        await answerCallback(ctx);
        await renderPanel(ctx, { view: "app", selectedApp: appName, confirmRemove: false, output: "", outputIsHtml: false }, deps);
    });

    // Backward compatibility for old panel messages
    bot.action(/^panel:app:(.+)$/, async (ctx) => {
        const appName = parseCallbackAppName(ctx.match[1]);
        await answerCallback(ctx);
        await renderPanel(ctx, { view: "app", selectedApp: appName, confirmRemove: false, output: "", outputIsHtml: false }, deps);
    });

    bot.action(/^panel:nav:(app|settings):(.+)$/, async (ctx) => {
        const targetView = ctx.match[1];
        await answerCallback(ctx);
        const selectedApp = resolveSelectedAppForNav(ctx, ctx.match[2], db);
        const patch = {
            view: selectedApp ? targetView : "main",
            selectedApp: selectedApp || null,
            confirmRemove: false, output: "", outputIsHtml: false
        };
        if (!selectedApp) { patch.output = "Sesi app tidak ditemukan. Pilih app dulu dari panel utama."; }
        await renderPanel(ctx, patch, deps);
    });

    bot.action(/^panel:nav:(main|app|settings|bot_settings)$/, async (ctx) => {
        const targetView = ctx.match[1];
        await answerCallback(ctx);
        const patch = { view: targetView, confirmRemove: false, output: "", outputIsHtml: false };
        if (targetView === "main") {
            patch.selectedApp = null;
        } else if (targetView === "app" || targetView === "settings") {
            const selectedApp = resolveSelectedAppForNav(ctx, undefined, db);
            if (selectedApp) { patch.selectedApp = selectedApp; }
            else { patch.view = "main"; patch.selectedApp = null; patch.output = "Sesi app tidak ditemukan. Pilih app dulu dari panel utama."; }
        }
        await renderPanel(ctx, patch, deps);
    });

    bot.action(/^panel:fm:(open|dir|read|page)(?::(.+))?$/, async (ctx) => {
        const action = ctx.match[1];
        const payload = ctx.match[2];
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;

        const selected = selectedAppFromState(chatId, db);
        if (!selected) {
            await answerCallback(ctx, "Pilih app dulu");
            return;
        }

        const appName = selected.name;
        const appDir = selected.app.directory;
        const { setPanelState, getPanelState } = require("../panel/state");
        const currentState = getPanelState(chatId);

        if (action === "open") {
            await answerCallback(ctx);
            await renderPanel(ctx, { view: "file_manager", fmPath: ".", fmPage: 1, output: "", outputIsHtml: false }, deps);
            return;
        }

        if (action === "page") {
            await answerCallback(ctx);
            const newPage = parseInt(payload, 10) || 1;
            await renderPanel(ctx, { fmPage: newPage }, deps);
            return;
        }

        if (action === "dir") {
            const fs = require("fs");
            const path = require("path");
            const { withinDir } = require("../utils");

            let currentPath = currentState.fmPath || ".";
            if (payload === "..") {
                if (currentPath === "." || currentPath === "") {
                    await answerCallback(ctx, "Sudah di root app.");
                    return;
                }
                currentPath = path.dirname(currentPath);
                if (currentPath === ".") currentPath = ".";
            } else {
                currentPath = path.join(currentPath, payload);
            }

            const fullPath = path.resolve(appDir, currentPath);
            if (!withinDir(appDir, fullPath) && appDir !== fullPath) {
                await answerCallback(ctx, "Akses ditolak");
                return;
            }

            if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
                await answerCallback(ctx, "Direktori tidak valid");
                return;
            }

            await answerCallback(ctx);
            await renderPanel(ctx, { fmPath: currentPath, fmPage: 1, output: "", outputIsHtml: false }, deps);
            return;
        }

        if (action === "read") {
            const fs = require("fs");
            const path = require("path");
            const { withinDir, escapeHtml } = require("../utils");
            const { clip } = require("../panel/helpers");

            const currentPath = currentState.fmPath || ".";
            const filePath = path.join(currentPath, payload);
            const fullPath = path.resolve(appDir, filePath);

            if (!withinDir(appDir, fullPath)) {
                await answerCallback(ctx, "Akses ditolak");
                return;
            }

            if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
                await answerCallback(ctx, "File tidak ditemukan");
                return;
            }

            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024 * 2) {
                await answerCallback(ctx, "Terlalu besar (>2MB)", true);
                return;
            }

            await answerCallback(ctx);
            try {
                const content = fs.readFileSync(fullPath, "utf8");
                const safeContent = escapeHtml(clip(content, 3000));
                const output = `📄 <b>Isi File:</b> <code>${escapeHtml(payload)}</code>\n\n<pre>${safeContent}</pre>`;
                await renderPanel(ctx, { output, outputIsHtml: true }, deps);
            } catch (err) {
                await renderPanel(ctx, { output: `Gagal membaca file: ${err.message}`, outputIsHtml: false }, deps);
            }
            return;
        }
    });

    bot.action(
        /^panel:run:(status|vars|log80|log200|logfile|start|stop|restart|deploy|deployr|update|remove|rmkeep|rmfiles|rmcancel|pin)$/,
        async (ctx) => {
            const action = ctx.match[1];
            try {
                const chatId = getChatIdFromCtx(ctx);
                if (!chatId) { await answerCallback(ctx, "Chat tidak valid"); return; }

                const selected = selectedAppFromState(chatId, db);
                if (!selected) {
                    await answerCallback(ctx, "Belum ada app");
                    await renderPanel(ctx, {
                        output: ["<b>Belum ada app</b>", "Tambahkan app dulu dengan:", '<code>/addapp namabot https://github.com/user/repo.git main</code>'].join("\n"),
                        outputIsHtml: true
                    }, deps);
                    return;
                }

                const appName = selected.name;

                if (action === "pin") {
                    await answerCallback(ctx);
                    const app = db.getApp(appName);
                    const newPinned = !(app && app.pinned);
                    await db.upsertApp(appName, (existing) => ({ ...existing, pinned: newPinned }));
                    const output = newPinned
                        ? `📌 <b>${require("../utils").escapeHtml(appName)}</b> dipasang sebagai favorit!`
                        : `📌 <b>${require("../utils").escapeHtml(appName)}</b> dicopot dari favorit.`;
                    await renderPanel(ctx, { output, outputIsHtml: true, confirmRemove: false }, deps);
                    return;
                }
                if (action === "status") {
                    await answerCallback(ctx, "Status updated");
                    const app = db.getApp(appName);
                    const runtime = (app && app.runtime) || {};
                    const statusText = [
                        `App: ${appName}`, `status: ${runtime.status || "stopped"}`, `pid: ${runtime.pid || "-"}`,
                        `lastStartAt: ${runtime.lastStartAt || "-"}`, `lastStopAt: ${runtime.lastStopAt || "-"}`,
                        `lastExitCode: ${runtime.lastExitCode ?? "-"}`
                    ].join("\n");
                    await renderPanel(ctx, { output: statusText, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "vars") {
                    await answerCallback(ctx);
                    const app = db.getApp(appName);
                    const entries = Object.entries((app && app.env) || {});
                    const text = entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join("\n") : "Belum ada env var.";
                    await renderPanel(ctx, { output: `App: ${appName}\n${text}`, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "log80" || action === "log200") {
                    await answerCallback(ctx, "Loading logs...");
                    const lines = action === "log200" ? 200 : 80;
                    const logs = processManager.readLogs(appName, lines);
                    const text = [`App: ${appName}`, `stdout (${lines} lines):`, logs.out || "(kosong)", "", `stderr (${lines} lines):`, logs.err || "(kosong)"].join("\n");
                    await renderPanel(ctx, { output: clip(text, 2600), outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "logfile") {
                    await answerCallback(ctx, "Mengirim file log...");

                    const fs = require("fs");
                    const path = require("path");
                    const outPath = path.join(processManager.logsDir, `${appName}.out.log`);
                    const errPath = path.join(processManager.logsDir, `${appName}.err.log`);

                    if (!fs.existsSync(outPath) && !fs.existsSync(errPath)) {
                        await renderPanel(ctx, { output: `File log tidak ditemukan untuk app ${appName}`, outputIsHtml: false, confirmRemove: false }, deps);
                        return;
                    }

                    let hasSent = false;
                    if (fs.existsSync(outPath)) {
                        await ctx.replyWithDocument({ source: outPath, filename: `${appName}-out.log` }, { caption: `Log output untuk app: ${appName}` });
                        hasSent = true;
                    }
                    if (fs.existsSync(errPath)) {
                        await ctx.replyWithDocument({ source: errPath, filename: `${appName}-err.log` }, { caption: `Log error untuk app: ${appName}` });
                        hasSent = true;
                    }

                    if (hasSent) {
                        await renderPanel(ctx, { output: `File log berhasil dikirim.`, outputIsHtml: false, confirmRemove: false }, deps);
                    }
                    return;
                }

                if (action === "remove") {
                    await answerCallback(ctx);
                    await renderPanel(ctx, { confirmRemove: true, output: `Konfirmasi hapus app "${appName}". Pilih tombol confirm di bawah.`, outputIsHtml: false }, deps);
                    return;
                }

                if (action === "rmcancel") {
                    await answerCallback(ctx, "Batal hapus");
                    await renderPanel(ctx, { confirmRemove: false, output: `Batal hapus app "${appName}".`, outputIsHtml: false }, deps);
                    return;
                }

                if (action === "rmkeep" || action === "rmfiles") {
                    await answerCallback(ctx, "Menghapus app...");
                    const deleteFiles = action === "rmfiles";
                    await withAppLock(appName, async () => { await removeAppInternal(appName, { deleteFiles, force: true }, deps); });
                    await renderPanel(ctx, { selectedApp: null, confirmRemove: false, output: `App "${appName}" dihapus.${deleteFiles ? " File deployment + logs ikut dihapus." : ""}`, outputIsHtml: false }, deps);
                    return;
                }

                if (action === "start") {
                    await answerCallback(ctx, "Start diproses...");
                    let output = "";
                    await withAppLock(appName, async () => { const pid = await processManager.start(appName); output = `App "${appName}" jalan. PID: ${pid}`; });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "stop") {
                    await answerCallback(ctx, "Stop diproses...");
                    let output = "";
                    await withAppLock(appName, async () => { const result = await processManager.stop(appName); output = result.alreadyStopped ? `App "${appName}" sudah berhenti.` : `App "${appName}" dihentikan.`; });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "restart") {
                    await answerCallback(ctx, "Restart diproses...");
                    let output = "";
                    await withAppLock(appName, async () => { const pid = await processManager.restart(appName); output = `App "${appName}" restart sukses. PID: ${pid}`; });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "deploy") {
                    await answerCallback(ctx, "Deploy diproses...");
                    let output = "";
                    await withAppLock(appName, async () => {
                        const summary = await deployer.deploy(appName);
                        const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
                        output = [`Deploy "${appName}" selesai.`, detail ? clip(detail, 2200) : ""].filter(Boolean).join("\n\n");
                    });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "deployr") {
                    await answerCallback(ctx, "Deploy + restart diproses...");
                    let output = "";
                    await withAppLock(appName, async () => {
                        const summary = await deployer.deploy(appName);
                        const pid = await processManager.restart(appName);
                        const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
                        output = [`Deploy + restart "${appName}" selesai. PID baru: ${pid}`, detail ? clip(detail, 2200) : ""].filter(Boolean).join("\n\n");
                    });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                if (action === "update") {
                    await answerCallback(ctx, "Update diproses...");
                    let output = "";
                    await withAppLock(appName, async () => {
                        const app = db.getApp(appName);
                        if (!app) { throw new Error(`App "${appName}" tidak ditemukan.`); }
                        const runtime = app.runtime || {};
                        const wasRunning = runtime.status === "running" && runtime.pid;
                        if (wasRunning) { await processManager.stop(appName); }
                        const summary = await deployer.deploy(appName, { updateOnly: true });
                        let runMessage = "App tetap dalam kondisi stop (status awal tidak running).";
                        if (wasRunning) { const pid = await processManager.start(appName); runMessage = `App dijalankan kembali. PID: ${pid}`; }
                        const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
                        output = [`Update "${appName}" selesai.`, runMessage, detail ? clip(detail, 2000) : ""].filter(Boolean).join("\n\n");
                    });
                    await renderPanel(ctx, { output, outputIsHtml: false, confirmRemove: false }, deps);
                    return;
                }

                await answerCallback(ctx, "Aksi tidak dikenal");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await answerCallback(ctx, "Gagal");
                await renderPanel(ctx, { output: `Error: ${msg}`, outputIsHtml: false, confirmRemove: false }, deps);
            }
        }
    );
}

module.exports = { register };
