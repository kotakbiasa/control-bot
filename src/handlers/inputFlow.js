const { nowIso, escapeHtml, appNameValid, repoUrlValid, adminIdValid } = require("../utils");
const { getChatIdFromCtx, answerCallback, replyError } = require("../panel/helpers");
const { setPanelState, selectedAppFromState } = require("../panel/state");
const { renderPanel } = require("../panel/render");
const { makeNewApp } = require("../services/appService");
const { parseListInput } = require("../services/runtimeMode");

function register(bot, deps) {
    const { db, processManager, deployer, chatInputState, isAdmin, DEPLOYMENTS_DIR } = deps;

    bot.action("panel:addapp:start", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        chatInputState.set(chatId, { step: "ADDAPP_NAME", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        const text = "Ayo tambahkan app baru!\n\nBalas pesan ini dengan <b>Nama App</b> (huruf, angka, strip, tanpa spasi):";
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action(/^panel:edit:(repo|branch|cmd:install|cmd:build|cmd:start|setvar|delvar|importenv|cron|addsched|listsched|delsched|healthcheck|reslimit|mutealert|pythonvenv|pythonrebuild|dockermode|dockerports|dockervolumes|dockerargs)$/, async (ctx) => {
        const action = ctx.match[1];
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        const selected = selectedAppFromState(chatId, db);
        if (!selected) { await answerCallback(ctx, "Pilih app dulu"); return; }
        await answerCallback(ctx);
        const appName = selected.name;
        let nextStep = "";
        let promptText = "";
        let customKeyboard = [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]];

        if (action === "repo") { nextStep = "EDIT_REPO"; promptText = `Mengubah Repo untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan Repo URL baru:`; }
        else if (action === "branch") { nextStep = "EDIT_BRANCH"; promptText = `Mengubah Branch untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan nama Branch baru:`; }
        else if (action.startsWith("cmd:")) { const type = action.split(":")[1].toUpperCase(); nextStep = `EDIT_CMD_${type}`; promptText = `Mengubah Command ${type} untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan command baru:\n<blockquote><pre>npm install</pre></blockquote>`; }
        else if (action === "setvar") { nextStep = "SET_ENV_KEY"; promptText = `Menambah/ubah Environment Variable untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan <b>KEY</b> env var:\n<blockquote><pre>PORT</pre></blockquote>`; }
        else if (action === "delvar") { nextStep = "DEL_ENV"; promptText = `Menghapus Environment Variable untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan <b>KEY</b> env var yang ingin dihapus:`; }
        else if (action === "importenv") { nextStep = "IMPORT_ENV"; promptText = `Mengimpor .env untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan teks atau isi dari file <b>.env</b>:\n<blockquote><pre>PORT=8080\nNODE_ENV=production\nTOKEN="abc 123"</pre></blockquote>`; }
        else if (action === "cron") {
            nextStep = "EDIT_CRON";
            promptText = `Pengaturan Auto-Restart (Cron) untuk <b>${escapeHtml(appName)}</b>\n\nPilih jadwal yang tersedia di bawah, atau balas pesan ini dengan format cron manual (misal: <code>0 0 * * *</code>) atau ketik <b>off</b>/<b>mati</b> untuk mematikan.`;
            customKeyboard = [
                [{ text: "⏰ Tiap Tengah Malam", callback_data: "panel:cron:0 0 * * *" }, { text: "⏱️ Tiap Jam", callback_data: "panel:cron:0 * * * *" }],
                [{ text: "📅 Tiap Senin Pagi", callback_data: "panel:cron:0 6 * * 1" }, { text: "✖️ Matikan", callback_data: "panel:cron:off" }],
                [{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]
            ];
        }
        else if (action === "addsched") {
            nextStep = "SCHED_LABEL";
            promptText = `⏰ <b>Tambah Scheduled Command</b> untuk <b>${escapeHtml(appName)}</b>\n\nBalas dengan <b>Label/Nama</b> untuk schedule ini (contoh: <code>cleanup</code>, <code>cache-clear</code>):`;
        }
        else if (action === "listsched") {
            const { setPanelState } = require("../panel/state");
            const app = db.getApp(appName);
            const schedules = (app && app.scheduledCommands) || [];
            let output;
            if (schedules.length === 0) {
                output = `Belum ada scheduled command untuk <b>${escapeHtml(appName)}</b>.`;
            } else {
                output = `📋 <b>Scheduled Commands untuk ${escapeHtml(appName)}:</b>\n\n` +
                    schedules.map((sc, i) => `${i + 1}. <b>${escapeHtml(sc.label)}</b>\n   <code>${escapeHtml(sc.schedule)}</code> → <code>${escapeHtml(sc.command)}</code>`).join("\n\n");
            }
            await answerCallback(ctx);
            setPanelState(chatId, { output, outputIsHtml: true }, db);
            const { renderPanel } = require("../panel/render");
            await renderPanel(ctx, {}, deps);
            return;
        }
        else if (action === "delsched") {
            nextStep = "DEL_SCHED";
            const app = db.getApp(appName);
            const schedules = (app && app.scheduledCommands) || [];
            const list = schedules.map((sc, i) => `${i + 1}. <b>${escapeHtml(sc.label)}</b> — <code>${escapeHtml(sc.schedule)}</code>`).join("\n");
            promptText = `🗑 <b>Hapus Scheduled Command</b> untuk <b>${escapeHtml(appName)}</b>\n\n${list || "(kosong)"}\n\nBalas dengan <b>Label</b> yang ingin dihapus:`;
        }
        else if (action === "healthcheck") {
            nextStep = "HC_URL";
            const app = db.getApp(appName);
            const currentUrl = (app && app.healthCheckUrl) || "belum diset";
            promptText = `🔍 <b>Health Check</b> untuk <b>${escapeHtml(appName)}</b>\n\nURL saat ini: <code>${escapeHtml(currentUrl)}</code>\n\nBalas dengan <b>URL</b> endpoint (contoh: <code>http://localhost:3000/health</code>)\nAtau ketik <b>off</b> untuk mematikan.`;
        }
        else if (action === "reslimit") {
            nextStep = "RES_LIMIT";
            const app = db.getApp(appName);
            const ram = (app && app.maxMemoryMB) || "none";
            const cpu = (app && app.maxCpuPercent) || "none";
            promptText = `📊 <b>Resource Limit</b> untuk <b>${escapeHtml(appName)}</b>\n\nSaat ini:\n• Max RAM: <code>${ram}</code> MB\n• Max CPU: <code>${cpu}</code>%\n\nBalas dengan format:\n<code>RAM_MB CPU_PERCENT</code>\nContoh: <code>256 80</code> → Max 256MB RAM, 80% CPU\nAtau ketik <b>off</b> untuk mematikan.`;
        }
        else if (action === "pythonvenv") {
            const app = db.getApp(appName) || {};
            const python = app.python || {};
            const nextEnabled = python.venvEnabled === false;
            await db.upsertApp(appName, (existing) => ({
                ...existing,
                python: {
                    ...(existing.python || {}),
                    venvEnabled: nextEnabled
                },
                updatedAt: nowIso()
            }));
            try { await deployer.syncRuntimeProfile(appName); } catch { }
            const output = nextEnabled
                ? `✅ Python venv untuk <b>${escapeHtml(appName)}</b> diaktifkan.`
                : `✅ Python venv untuk <b>${escapeHtml(appName)}</b> dimatikan.`;
            setPanelState(chatId, { output, outputIsHtml: true }, db);
            await renderPanel(ctx, {}, deps);
            return;
        }
        else if (action === "pythonrebuild") {
            try {
                const result = await deployer.rebuildPythonVenv(appName);
                const output = [
                    `✅ Rebuild Python venv selesai untuk <b>${escapeHtml(appName)}</b>.`,
                    "",
                    `<pre>${escapeHtml(result.slice(-1600))}</pre>`
                ].join("\n");
                setPanelState(chatId, { output, outputIsHtml: true }, db);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setPanelState(chatId, { output: `❌ Rebuild Python venv gagal: <code>${escapeHtml(msg)}</code>`, outputIsHtml: true }, db);
            }
            await renderPanel(ctx, {}, deps);
            return;
        }
        else if (action === "dockermode") {
            nextStep = "EDIT_DOCKER_MODE";
            const app = db.getApp(appName) || {};
            const docker = app.docker || {};
            promptText = `🐳 <b>Docker Mode</b> untuk <b>${escapeHtml(appName)}</b>\n\nMode saat ini: <code>${escapeHtml(docker.enabled || "auto")}</code>\n\nPilih mode di bawah atau balas teks <b>auto</b>, <b>on</b>, atau <b>off</b>.`;
            customKeyboard = [
                [{ text: "AUTO", callback_data: "panel:dockermode:auto" }, { text: "ON", callback_data: "panel:dockermode:on" }, { text: "OFF", callback_data: "panel:dockermode:off" }],
                [{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]
            ];
        }
        else if (action === "dockerports") {
            nextStep = "EDIT_DOCKER_PORTS";
            const app = db.getApp(appName) || {};
            const ports = ((app.docker || {}).ports || []).join("\n") || "(kosong)";
            promptText = `🐳 <b>Docker Ports</b> untuk <b>${escapeHtml(appName)}</b>\n\nSaat ini:\n<pre>${escapeHtml(ports)}</pre>\nBalas dengan daftar port mapping (pisahkan baris/komma), contoh:\n<pre>8080:8080\n127.0.0.1:3000:3000</pre>\nKetik <b>off</b> untuk kosongkan.`;
        }
        else if (action === "dockervolumes") {
            nextStep = "EDIT_DOCKER_VOLUMES";
            const app = db.getApp(appName) || {};
            const volumes = ((app.docker || {}).volumes || []).join("\n") || "(kosong)";
            promptText = `🐳 <b>Docker Volumes</b> untuk <b>${escapeHtml(appName)}</b>\n\nSaat ini:\n<pre>${escapeHtml(volumes)}</pre>\nBalas dengan daftar volume mapping (baris/komma), contoh:\n<pre>/host/path:/app/data</pre>\nKetik <b>off</b> untuk kosongkan.`;
        }
        else if (action === "dockerargs") {
            nextStep = "EDIT_DOCKER_ARGS";
            const app = db.getApp(appName) || {};
            const args = ((app.docker || {}).extraArgs || "").trim() || "(kosong)";
            promptText = `🐳 <b>Docker Extra Args</b> untuk <b>${escapeHtml(appName)}</b>\n\nSaat ini:\n<pre>${escapeHtml(args)}</pre>\nBalas dengan argumen tambahan untuk <code>docker run</code>.\nKetik <b>off</b> untuk kosongkan.`;
        }
        else if (action === "mutealert") {
            await answerCallback(ctx);
            const app = db.getApp(appName);
            const newMute = !(app && app.muteAlerts);
            await db.upsertApp(appName, (existing) => ({ ...existing, muteAlerts: newMute }));
            const { setPanelState } = require("../panel/state");
            const output = newMute
                ? `🔇 Alert untuk <b>${escapeHtml(appName)}</b> di-mute.`
                : `🔔 Alert untuk <b>${escapeHtml(appName)}</b> diaktifkan.`;
            setPanelState(chatId, { output, outputIsHtml: true }, db);
            const { renderPanel } = require("../panel/render");
            await renderPanel(ctx, {}, deps);
            return;
        }

        if (nextStep) {
            chatInputState.set(chatId, { step: nextStep, data: { name: appName }, originalMessageId: ctx.callbackQuery.message?.message_id });
            await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: { inline_keyboard: customKeyboard } });
        }
    });

    // Health check cron quick buttons
    bot.action(/^panel:hccron:(.+)$/, async (ctx) => {
        const schedule = ctx.match[1].trim();
        const chatId = getChatIdFromCtx(ctx);
        const state = chatInputState.get(chatId) || {};
        if (state.step !== "HC_CRON" || !state.data.name) { return answerCallback(ctx, "Sesi edit kadaluarsa"); }
        const appName = state.data.name;
        const url = state.data.healthCheckUrl;
        await db.upsertApp(appName, (ex) => ({ ...ex, healthCheckUrl: url, healthCheckSchedule: schedule }));
        const { healthCheck } = deps;
        healthCheck.updateCheck(appName, url, schedule);
        chatInputState.delete(chatId);
        await answerCallback(ctx, "Health check aktif");
        const output = `✅ Health check diaktifkan untuk <b>${escapeHtml(appName)}</b>\n<blockquote>URL: <code>${escapeHtml(url)}</code>\nJadwal: <code>${escapeHtml(schedule)}</code></blockquote>`;
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        if (state.originalMessageId) { try { ctx.callbackQuery = { message: { message_id: state.originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
    });

    bot.action(/^panel:cron:(.+)$/, async (ctx) => {
        const cronStr = ctx.match[1].trim();
        const chatId = getChatIdFromCtx(ctx);
        const state = chatInputState.get(chatId) || {};
        if (state.step !== "EDIT_CRON" || !state.data.name) { return answerCallback(ctx, "Sesi edit kadaluarsa"); }
        const appName = state.data.name;
        chatInputState.delete(chatId);
        const finalVal = (cronStr === "off" || cronStr === "mati") ? null : cronStr;
        await db.upsertApp(appName, (existing) => ({ ...existing, cronSchedule: finalVal, updatedAt: nowIso() }));
        processManager.updateCron(appName, finalVal);
        const output = `✅ Auto-Restart untuk <b>${escapeHtml(appName)}</b> diatur ke <code>${escapeHtml(finalVal || "Mati")}</code>.`;
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        if (state.originalMessageId) {
            try { ctx.callbackQuery = { message: { message_id: state.originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { await renderPanel(ctx, {}, deps); }
        } else { await renderPanel(ctx, {}, deps); }
    });

    bot.action(/^panel:dockermode:(auto|on|off)$/, async (ctx) => {
        const dockerMode = ctx.match[1].trim();
        const chatId = getChatIdFromCtx(ctx);
        const state = chatInputState.get(chatId) || {};
        if (state.step !== "EDIT_DOCKER_MODE" || !state.data.name) { return answerCallback(ctx, "Sesi edit kadaluarsa"); }
        const appName = state.data.name;
        chatInputState.delete(chatId);
        await db.upsertApp(appName, (existing) => ({
            ...existing,
            docker: {
                ...(existing.docker || {}),
                enabled: dockerMode
            },
            updatedAt: nowIso()
        }));
        try { await deployer.syncRuntimeProfile(appName); } catch { }
        await answerCallback(ctx, "Docker mode diubah");
        const output = `✅ Docker mode untuk <b>${escapeHtml(appName)}</b> diatur ke <code>${escapeHtml(dockerMode)}</code>.`;
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        if (state.originalMessageId) {
            try { ctx.callbackQuery = { message: { message_id: state.originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { await renderPanel(ctx, {}, deps); }
        } else {
            await renderPanel(ctx, {}, deps);
        }
    });

    // Text input handler
    bot.on("text", async (ctx, next) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return next();
        const stateInfo = chatInputState.get(chatId);
        if (!stateInfo) return next();

        const text = ctx.message.text.trim();
        const { step, data, originalMessageId } = stateInfo;

        try {
            // === File Deploy ===
            if (step === "AWAIT_APP_NAME_FOR_FILE") {
                if (!appNameValid(text)) { await ctx.reply("Nama app hanya boleh huruf, angka, underscore, dash. Coba lagi atau tekan Cancel ❌."); return; }
                if (text.length > 32) { await ctx.reply("Nama app maksimal 32 karakter. Coba lagi atau tekan Cancel ❌."); return; }
                if (db.getApp(text)) { await ctx.reply(`App "${text}" sudah ada. Ketik nama lain atau Cancel ❌.`); return; }

                const appName = text;
                const { fileId, fileName } = data;
                chatInputState.delete(chatId);

                await ctx.reply(`Sedang memproses file untuk app <b>${escapeHtml(appName)}</b>...`, { parse_mode: "HTML" });

                try {
                    const link = await ctx.telegram.getFileLink(fileId);
                    const url = link.href || link;
                    const https = require("https");
                    const http = require("http");
                    const path = require("path");
                    const fs = require("fs");
                    const { ensureDir } = require("../utils");

                    const appDir = path.join(DEPLOYMENTS_DIR, appName);
                    ensureDir(appDir);
                    const tmpFile = path.join(require("os").tmpdir(), `deploy-${Date.now()}-${fileName}`);

                    await new Promise((resolve, reject) => {
                        const proto = url.startsWith("https") ? https : http;
                        proto.get(url, (res) => {
                            const ws = fs.createWriteStream(tmpFile);
                            res.pipe(ws);
                            ws.on("finish", () => { ws.close(); resolve(); });
                            ws.on("error", reject);
                        }).on("error", reject);
                    });

                    let startCmd = "";
                    if (fileName.endsWith(".zip")) {
                        const AdmZip = require("adm-zip");
                        const zip = new AdmZip(tmpFile);
                        zip.extractAllTo(appDir, true);
                        fs.unlinkSync(tmpFile);
                        startCmd = "npm start"; // Default
                    } else if (fileName.endsWith(".py")) {
                        fs.renameSync(tmpFile, path.join(appDir, fileName));
                        startCmd = `python3 ${fileName}`; // Or python
                    }

                    const app = makeNewApp({ name: appName, repo: "local", branch: "main" }, DEPLOYMENTS_DIR);
                    app.installCommand = "";
                    app.buildCommand = "";
                    app.startCommand = startCmd;
                    if (fileName.endsWith(".py")) {
                        app.python = {
                            ...(app.python || {}),
                            detected: true,
                            entrypoint: fileName
                        };
                    }

                    await db.upsertApp(appName, app);

                    const msg = [
                        `✅ App <b>${escapeHtml(appName)}</b> berhasil disiapkan dari file!`,
                        "<blockquote>",
                        `<b>File:</b> ${escapeHtml(fileName)}`,
                        `<b>Start Command:</b> <code>${escapeHtml(startCmd)}</code>`,
                        "</blockquote>",
                        "Gunakan /panel untuk mengubah command atau env jika diperlukan, lalu klik Start."
                    ].join("\n");

                    await ctx.reply(msg, { parse_mode: "HTML" });
                    setPanelState(chatId, { selectedApp: appName, output: msg, outputIsHtml: true }, db);
                    await renderPanel(ctx, {}, deps);
                } catch (err) {
                    await ctx.reply(`❌ Gagal memproses file: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
                }
                return;
            }

            if (step === "ADDAPP_NAME") {
                if (!appNameValid(text)) { await ctx.reply("Nama app hanya boleh huruf, angka, underscore, dash. Coba lagi atau tekan Cancel ❌."); return; }
                if (text.length > 32) { await ctx.reply("Nama app maksimal 32 karakter. Coba lagi atau tekan Cancel ❌."); return; }
                if (db.getApp(text)) { await ctx.reply(`App "${text}" sudah ada. Ketik nama lain atau Cancel ❌.`); return; }
                data.name = text;
                chatInputState.set(chatId, { step: "ADDAPP_REPO", data, originalMessageId });
                await ctx.reply(`Sip, nama app:\n<blockquote><b>${escapeHtml(text)}</b></blockquote>\nSekarang balas dengan <b>Repo URL</b> (contoh: https://github.com/user/repo.git):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
                return;
            }

            if (step === "ADDAPP_REPO") {
                if (!repoUrlValid(text)) { await ctx.reply("Repo URL tidak valid. Coba ulangi kirim link repo yang benar atau Cancel ❌."); return; }
                data.repo = text;
                chatInputState.set(chatId, { step: "ADDAPP_BRANCH", data, originalMessageId });
                await ctx.reply(`Repo URL:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>\nSekarang balas dengan <b>Branch</b> (contoh: main):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
                return;
            }

            if (step === "ADDAPP_BRANCH") {
                if (!text.match(/^[A-Za-z0-9._/-]+$/)) { await ctx.reply("Branch tidak valid. Coba ulangi atau Cancel ❌."); return; }
                data.branch = text;
                const app = makeNewApp({ name: data.name, repo: data.repo, branch: data.branch }, DEPLOYMENTS_DIR);
                await db.upsertApp(data.name, app);
                chatInputState.delete(chatId);
                const msg = [`✅ App <b>${escapeHtml(data.name)}</b> berhasil ditambahkan!`, "<blockquote>", `<b>Repo:</b> <pre>${escapeHtml(data.repo)}</pre>`, `<b>Branch:</b> ${escapeHtml(data.branch)}`, "</blockquote>"].join("\n");
                await ctx.reply(msg, { parse_mode: "HTML" });
                setPanelState(chatId, { selectedApp: data.name, output: msg, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_REPO") {
                if (!repoUrlValid(text)) { await ctx.reply("Repo URL tidak valid. Coba ulangi atau Cancel ❌."); return; }
                await db.upsertApp(data.name, (existing) => ({ ...existing, repo: text, updatedAt: nowIso() }));
                chatInputState.delete(chatId);
                const output = `✅ Repo app <b>${escapeHtml(data.name)}</b> diupdate ke:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_BRANCH") {
                if (!text.match(/^[A-Za-z0-9._/-]+$/)) { await ctx.reply("Branch tidak valid. Coba ulangi atau Cancel ❌."); return; }
                await db.upsertApp(data.name, (existing) => ({ ...existing, branch: text, updatedAt: nowIso() }));
                chatInputState.delete(chatId);
                const output = `✅ Branch app <b>${escapeHtml(data.name)}</b> diupdate ke "${escapeHtml(text)}".`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step.startsWith("EDIT_CMD_")) {
                const type = step.split("_")[2];
                let key = "";
                if (type === "INSTALL") key = "installCommand";
                if (type === "BUILD") key = "buildCommand";
                if (type === "START") key = "startCommand";
                await db.upsertApp(data.name, (existing) => ({ ...existing, [key]: text, updatedAt: nowIso() }));
                chatInputState.delete(chatId);
                const output = `✅ Command ${type.toLowerCase()} untuk "<b>${escapeHtml(data.name)}</b>" diupdate:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "SET_ENV_KEY") {
                const key = text.trim();
                if (!key.match(/^[A-Za-z0-9_]+$/)) { await ctx.reply("Key env var hanya boleh huruf, angka, underscore. Coba lagi atau Cancel ❌."); return; }
                data.key = key;
                chatInputState.set(chatId, { step: "SET_ENV_VAL", data, originalMessageId });
                await ctx.reply(`ℹ️ Key Environment Variable:\n<blockquote><b>${escapeHtml(key)}</b></blockquote>\nSekarang balas dengan <b>Value</b>-nya:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
                return;
            }

            if (step === "SET_ENV_VAL") {
                const value = text;
                await db.upsertApp(data.name, (existing) => ({ ...existing, env: { ...(existing.env || {}), [data.key]: value }, updatedAt: nowIso() }));
                chatInputState.delete(chatId);
                const output = `✅ Env var diset untuk <b>${escapeHtml(data.name)}</b>:\n<blockquote><pre>${escapeHtml(data.key)}=${escapeHtml(value)}</pre></blockquote>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_CRON") {
                let finalVal = text.trim();
                if (finalVal.toLowerCase() === "off" || finalVal.toLowerCase() === "mati") finalVal = null;
                await db.upsertApp(data.name, (existing) => ({ ...existing, cronSchedule: finalVal, updatedAt: nowIso() }));
                processManager.updateCron(data.name, finalVal);
                chatInputState.delete(chatId);
                const output = `✅ Auto-Restart untuk <b>${escapeHtml(data.name)}</b> diatur ke <code>${escapeHtml(finalVal || "Mati")}</code>.`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_DOCKER_MODE") {
                const val = text.trim().toLowerCase();
                if (!["auto", "on", "off"].includes(val)) {
                    await ctx.reply('Nilai tidak valid. Gunakan "auto", "on", atau "off".');
                    return;
                }
                await db.upsertApp(data.name, (existing) => ({
                    ...existing,
                    docker: {
                        ...(existing.docker || {}),
                        enabled: val
                    },
                    updatedAt: nowIso()
                }));
                try { await deployer.syncRuntimeProfile(data.name); } catch { }
                chatInputState.delete(chatId);
                const output = `✅ Docker mode untuk <b>${escapeHtml(data.name)}</b> diatur ke <code>${escapeHtml(val)}</code>.`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_DOCKER_PORTS") {
                const val = text.trim();
                const ports = (val.toLowerCase() === "off" || val.toLowerCase() === "mati") ? [] : parseListInput(val);
                await db.upsertApp(data.name, (existing) => ({
                    ...existing,
                    docker: {
                        ...(existing.docker || {}),
                        ports
                    },
                    updatedAt: nowIso()
                }));
                chatInputState.delete(chatId);
                const output = `✅ Docker ports untuk <b>${escapeHtml(data.name)}</b> diupdate:\n<code>${escapeHtml(ports.join(", ") || "-")}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_DOCKER_VOLUMES") {
                const val = text.trim();
                const volumes = (val.toLowerCase() === "off" || val.toLowerCase() === "mati") ? [] : parseListInput(val);
                await db.upsertApp(data.name, (existing) => ({
                    ...existing,
                    docker: {
                        ...(existing.docker || {}),
                        volumes
                    },
                    updatedAt: nowIso()
                }));
                chatInputState.delete(chatId);
                const output = `✅ Docker volumes untuk <b>${escapeHtml(data.name)}</b> diupdate:\n<code>${escapeHtml(volumes.join(", ") || "-")}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "EDIT_DOCKER_ARGS") {
                const val = text.trim();
                const args = (val.toLowerCase() === "off" || val.toLowerCase() === "mati") ? "" : val;
                await db.upsertApp(data.name, (existing) => ({
                    ...existing,
                    docker: {
                        ...(existing.docker || {}),
                        extraArgs: args
                    },
                    updatedAt: nowIso()
                }));
                chatInputState.delete(chatId);
                const output = `✅ Docker extra args untuk <b>${escapeHtml(data.name)}</b> diupdate:\n<code>${escapeHtml(args || "-")}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "IMPORT_ENV") {
                const lines = text.split(/\r?\n/);
                const imported = {};
                let count = 0;
                for (let line of lines) {
                    line = line.trim();
                    if (!line || line.startsWith("#")) continue;
                    const eqIdx = line.indexOf("=");
                    if (eqIdx > -1) {
                        const key = line.slice(0, eqIdx).trim();
                        let val = line.slice(eqIdx + 1).trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) { val = val.slice(1, -1); }
                        if (key) { imported[key] = val; count++; }
                    }
                }
                await db.upsertApp(data.name, (existing) => ({ ...existing, env: { ...(existing.env || {}), ...imported }, updatedAt: nowIso() }));
                chatInputState.delete(chatId);
                const output = `✅ <b>${count}</b> env var(s) diimpor untuk <b>${escapeHtml(data.name)}</b>.`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "SET_TZ") {
                const tz = text.trim();
                if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) { await ctx.reply("Format timezone tidak valid. Coba lagi atau Cancel ❌."); return; }
                try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); } catch (e) { await ctx.reply(`Timezone "${tz}" tidak dikenali oleh sistem. Coba lagi (contoh: Asia/Makassar) atau Cancel ❌.`); return; }
                await db.updateSettings({ timezone: tz });
                process.env.TZ = tz;
                chatInputState.delete(chatId);
                const output = `✅ Timezone bot berhasil diubah menjadi <b>${escapeHtml(tz)}</b>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "SET_ADD_ADMIN") {
                const newAdminId = text.trim();
                if (!adminIdValid(newAdminId)) { await ctx.reply("Telegram ID tidak valid (hanya boleh angka). Coba lagi atau Cancel ❌."); return; }
                if (isAdmin(newAdminId)) { await ctx.reply(`ID <code>${escapeHtml(newAdminId)}</code> sudah menjadi admin. Cancel ❌.`, { parse_mode: "HTML" }); return; }
                const currentSettings = db.getSettings();
                const currentAdmins = currentSettings.admins || [];
                await db.updateSettings({ admins: [...currentAdmins, newAdminId] });
                chatInputState.delete(chatId);
                const output = `✅ Admin baru berhasil ditambahkan: <code>${escapeHtml(newAdminId)}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "SET_DEL_ADMIN") {
                const delAdminId = text.trim();
                const { ADMIN_IDS } = deps;
                if (ADMIN_IDS.includes(delAdminId)) { await ctx.reply(`ID <code>${escapeHtml(delAdminId)}</code> adalah admin bawaan (.env) dan tidak bisa dihapus dari sini. Cancel ❌.`, { parse_mode: "HTML" }); return; }
                const currentSettings = db.getSettings();
                const currentAdmins = currentSettings.admins || [];
                if (!currentAdmins.includes(delAdminId)) { await ctx.reply(`ID <code>${escapeHtml(delAdminId)}</code> tidak ditemukan dalam daftar admin tambahan. Coba lagi atau Cancel ❌.`, { parse_mode: "HTML" }); return; }
                const newAdmins = currentAdmins.filter(id => id !== delAdminId);
                await db.updateSettings({ admins: newAdmins });
                chatInputState.delete(chatId);
                const output = `✅ Admin berhasil dihapus: <code>${escapeHtml(delAdminId)}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "SET_MONITOR") {
                const val = text.trim();
                const schedule = (val.toLowerCase() === "off" || val.toLowerCase() === "mati") ? null : val;
                await db.updateSettings({ monitorSchedule: schedule });
                const { monitor } = deps;
                monitor.setSchedule(schedule);
                chatInputState.delete(chatId);
                const output = schedule
                    ? `✅ Monitoring diatur ke <code>${escapeHtml(schedule)}</code>`
                    : "✅ Monitoring dimatikan.";
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "DEL_ENV") {
                const key = text.trim();
                await db.upsertApp(data.name, (existing) => { const env = { ...(existing.env || {}) }; delete env[key]; return { ...existing, env, updatedAt: nowIso() }; });
                chatInputState.delete(chatId);
                const output = `✅ Env var dihapus: ${escapeHtml(data.name)} -> <code>${escapeHtml(key)}</code>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            // === Scheduled Commands 3-step flow ===
            if (step === "SCHED_LABEL") {
                const label = text.trim().replace(/[^A-Za-z0-9_-]/g, "");
                if (!label) { await ctx.reply("Label hanya boleh huruf, angka, underscore, dash. Coba lagi atau Cancel ❌."); return; }
                const app = db.getApp(data.name);
                const existing = (app && app.scheduledCommands) || [];
                if (existing.find(sc => sc.label === label)) { await ctx.reply(`Label "${label}" sudah ada. Gunakan label lain atau Cancel ❌.`); return; }
                data.label = label;
                chatInputState.set(chatId, { step: "SCHED_CRON", data, originalMessageId });
                await ctx.reply(`Label: <b>${escapeHtml(label)}</b>\n\nSekarang balas dengan <b>jadwal cron</b> (contoh: <code>0 0 * * *</code> untuk tiap tengah malam):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
                return;
            }

            if (step === "SCHED_CRON") {
                data.schedule = text.trim();
                chatInputState.set(chatId, { step: "SCHED_CMD", data, originalMessageId });
                await ctx.reply(`Jadwal: <code>${escapeHtml(data.schedule)}</code>\n\nSekarang balas dengan <b>command</b> yang ingin dijalankan (contoh: <code>npm run cleanup</code>):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
                return;
            }

            if (step === "SCHED_CMD") {
                const command = text.trim();
                const schedItem = { label: data.label, schedule: data.schedule, command };
                await db.upsertApp(data.name, (existing) => ({
                    ...existing,
                    scheduledCommands: [...(existing.scheduledCommands || []), schedItem],
                    updatedAt: nowIso()
                }));
                processManager.addScheduledCommand(data.name, data.label, data.schedule, command);
                chatInputState.delete(chatId);
                const output = `✅ Scheduled command ditambahkan untuk <b>${escapeHtml(data.name)}</b>:\n<blockquote><b>${escapeHtml(data.label)}</b>\n<code>${escapeHtml(data.schedule)}</code> → <code>${escapeHtml(command)}</code></blockquote>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            if (step === "DEL_SCHED") {
                const label = text.trim();
                const app = db.getApp(data.name);
                const existing = (app && app.scheduledCommands) || [];
                const found = existing.find(sc => sc.label === label);
                if (!found) { await ctx.reply(`Label "${label}" tidak ditemukan. Coba lagi atau Cancel ❌.`); return; }
                await db.upsertApp(data.name, (ex) => ({
                    ...ex,
                    scheduledCommands: (ex.scheduledCommands || []).filter(sc => sc.label !== label),
                    updatedAt: nowIso()
                }));
                processManager.removeScheduledCommand(data.name, label);
                chatInputState.delete(chatId);
                const output = `✅ Scheduled command <b>${escapeHtml(label)}</b> dihapus dari <b>${escapeHtml(data.name)}</b>.`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            // === Health Check 2-step flow ===
            if (step === "HC_URL") {
                const val = text.trim();
                if (val.toLowerCase() === "off" || val.toLowerCase() === "mati") {
                    await db.upsertApp(data.name, (ex) => ({ ...ex, healthCheckUrl: null, healthCheckSchedule: null }));
                    const { healthCheck } = deps;
                    healthCheck.removeCheck(data.name);
                    chatInputState.delete(chatId);
                    const output = `✅ Health check untuk <b>${escapeHtml(data.name)}</b> dimatikan.`;
                    await ctx.reply(output, { parse_mode: "HTML" });
                    setPanelState(chatId, { output, outputIsHtml: true }, db);
                    if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                    return;
                }
                if (!val.startsWith("http")) { await ctx.reply("URL harus dimulai dengan http:// atau https://. Coba lagi."); return; }
                data.healthCheckUrl = val;
                chatInputState.set(chatId, { step: "HC_CRON", data, originalMessageId });
                await ctx.reply(`URL: <code>${escapeHtml(val)}</code>\n\nSekarang balas dengan <b>jadwal cron</b> untuk pengecekan (contoh: <code>*/5 * * * *</code> = setiap 5 menit):`, {
                    parse_mode: "HTML", reply_markup: {
                        inline_keyboard: [
                            [{ text: "⏱ Tiap 5 Menit", callback_data: "panel:hccron:*/5 * * * *" }, { text: "⏰ Tiap 15 Menit", callback_data: "panel:hccron:*/15 * * * *" }],
                            [{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]
                        ]
                    }
                });
                return;
            }

            if (step === "HC_CRON") {
                const schedule = text.trim();
                await db.upsertApp(data.name, (ex) => ({ ...ex, healthCheckUrl: data.healthCheckUrl, healthCheckSchedule: schedule }));
                const { healthCheck } = deps;
                healthCheck.updateCheck(data.name, data.healthCheckUrl, schedule);
                chatInputState.delete(chatId);
                const output = `✅ Health check diaktifkan untuk <b>${escapeHtml(data.name)}</b>\n<blockquote>URL: <code>${escapeHtml(data.healthCheckUrl)}</code>\nJadwal: <code>${escapeHtml(schedule)}</code></blockquote>`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            // === Resource Limit ===
            if (step === "RES_LIMIT") {
                const val = text.trim();
                if (val.toLowerCase() === "off" || val.toLowerCase() === "mati") {
                    await db.upsertApp(data.name, (ex) => ({ ...ex, maxMemoryMB: null, maxCpuPercent: null }));
                    chatInputState.delete(chatId);
                    const output = `✅ Resource limit untuk <b>${escapeHtml(data.name)}</b> dimatikan.`;
                    await ctx.reply(output, { parse_mode: "HTML" });
                    setPanelState(chatId, { output, outputIsHtml: true }, db);
                    if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                    return;
                }
                const parts = val.split(/\s+/);
                const ram = parseInt(parts[0], 10);
                const cpu = parseInt(parts[1], 10);
                if (isNaN(ram) || isNaN(cpu) || ram <= 0 || cpu <= 0) {
                    await ctx.reply("Format salah. Gunakan: <code>RAM_MB CPU_PERCENT</code> (contoh: <code>256 80</code>) atau ketik <b>off</b>.", { parse_mode: "HTML" });
                    return;
                }
                await db.upsertApp(data.name, (ex) => ({ ...ex, maxMemoryMB: ram, maxCpuPercent: cpu }));
                chatInputState.delete(chatId);
                const output = `✅ Resource limit untuk <b>${escapeHtml(data.name)}</b>:\n• Max RAM: <code>${ram}</code> MB\n• Max CPU: <code>${cpu}</code>%`;
                await ctx.reply(output, { parse_mode: "HTML" });
                setPanelState(chatId, { output, outputIsHtml: true }, db);
                if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx, {}, deps); } catch { } }
                return;
            }

            // === PIN Security ===
            if (step === "SET_PIN") {
                const pin = text.trim();
                if (!/^\d{4,8}$/.test(pin)) { await ctx.reply("PIN harus 4-8 digit angka. Coba lagi."); return; }
                const crypto = require("crypto");
                const hash = crypto.createHash("sha256").update(pin).digest("hex");
                await db.updateSettings({ pin: hash });
                chatInputState.delete(chatId);
                const output = "✅ PIN keamanan berhasil diset!";
                await ctx.reply(output);
                return;
            }

            if (step === "VERIFY_PIN") {
                const pin = text.trim();
                const crypto = require("crypto");
                const hash = crypto.createHash("sha256").update(pin).digest("hex");
                const settings = db.getSettings();
                if (hash !== settings.pin) { await ctx.reply("❌ PIN salah. Coba lagi atau Cancel ❌."); return; }
                chatInputState.delete(chatId);
                // Replay the target action
                const targetAction = data.targetAction;
                if (targetAction) {
                    ctx.callbackQuery = ctx.callbackQuery || {};
                    ctx.callbackQuery.data = targetAction;
                    ctx.match = [targetAction, targetAction.split(":").pop()];
                    await ctx.reply("✅ PIN verified. Melanjutkan aksi...");
                    // Re-emit the callback
                    try { await bot.handleUpdate({ callback_query: { ...ctx.callbackQuery, data: targetAction, from: ctx.from, message: ctx.callbackQuery.message } }); }
                    catch (e) { console.error("[PIN verify]", e); }
                }
                return;
            }

        } catch (err) {
            chatInputState.delete(chatId);
            await replyError(ctx, err);
        }
    });
}

module.exports = { register };
