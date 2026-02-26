const { nowIso, escapeHtml, appNameValid, repoUrlValid, adminIdValid } = require("../utils");
const { getChatIdFromCtx, answerCallback, replyError } = require("../panel/helpers");
const { setPanelState, selectedAppFromState } = require("../panel/state");
const { renderPanel } = require("../panel/render");
const { makeNewApp } = require("../services/appService");

function register(bot, deps) {
    const { db, processManager, chatInputState, isAdmin, DEPLOYMENTS_DIR } = deps;

    bot.action("panel:addapp:start", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        chatInputState.set(chatId, { step: "ADDAPP_NAME", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        const text = "Ayo tambahkan app baru!\n\nBalas pesan ini dengan <b>Nama App</b> (huruf, angka, strip, tanpa spasi):";
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action(/^panel:edit:(repo|branch|cmd:install|cmd:build|cmd:start|setvar|delvar|importenv|cron)$/, async (ctx) => {
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

        if (nextStep) {
            chatInputState.set(chatId, { step: nextStep, data: { name: appName }, originalMessageId: ctx.callbackQuery.message?.message_id });
            await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: { inline_keyboard: customKeyboard } });
        }
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

    // Text input handler
    bot.on("text", async (ctx, next) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return next();
        const stateInfo = chatInputState.get(chatId);
        if (!stateInfo) return next();

        const text = ctx.message.text.trim();
        const { step, data, originalMessageId } = stateInfo;

        try {
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

        } catch (err) {
            chatInputState.delete(chatId);
            await replyError(ctx, err);
        }
    });
}

module.exports = { register };
