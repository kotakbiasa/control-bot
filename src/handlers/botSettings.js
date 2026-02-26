const { escapeHtml } = require("../utils");
const { clip, getChatIdFromCtx, answerCallback } = require("../panel/helpers");
const { setPanelState } = require("../panel/state");
const { renderPanel, editOrReply } = require("../panel/render");
const { runShell } = require("../deployer");

function register(bot, deps) {
    const { db, ADMIN_IDS, ROOT_DIR, chatInputState } = deps;

    bot.action("panel:bot:settz", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        await answerCallback(ctx);
        chatInputState.set(chatId, { step: "SET_TZ", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        const text = '⚙️ <b>Pengaturan Timezone</b>\n\nBalas pesan ini dengan timezone yang diinginkan (contoh: <code>Asia/Makassar</code>, <code>Asia/Jakarta</code>, atau <code>UTC</code>):';
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action("panel:bot:admins", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        await answerCallback(ctx);
        const dbSettings = db.getSettings();
        const dynamicAdmins = dbSettings.admins || [];
        let output = "👥 <b>Daftar Administrator Bot</b>\n\n";
        output += "<b>Dari .env (Permanent):</b>\n";
        if (ADMIN_IDS.length > 0) { ADMIN_IDS.forEach(id => output += `• <code>${escapeHtml(id)}</code>\n`); }
        else { output += "<i>(Tidak ada)</i>\n"; }
        output += "\n<b>Dari Database (Dinamic):</b>\n";
        if (dynamicAdmins.length > 0) { dynamicAdmins.forEach(id => output += `• <code>${escapeHtml(id)}</code>\n`); }
        else { output += "<i>(Belum ada admin tambahan)</i>\n"; }
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    bot.action("panel:bot:addadmin", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        await answerCallback(ctx);
        chatInputState.set(chatId, { step: "SET_ADD_ADMIN", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        const text = "➕ <b>Tambah Admin Baru</b>\n\nBalas pesan ini dengan <b>Telegram ID</b> admin baru (hanya angka):";
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action("panel:bot:deladmin", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        await answerCallback(ctx);
        const dbSettings = db.getSettings();
        const dynamicAdmins = dbSettings.admins || [];
        if (dynamicAdmins.length === 0) { await ctx.reply("Tidak ada admin tambahan yang bisa dihapus (Admin dari .env tidak bisa dihapus dari sini)."); return; }
        chatInputState.set(chatId, { step: "SET_DEL_ADMIN", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        const text = "➖ <b>Hapus Admin</b>\n\nBalas pesan ini dengan <b>Telegram ID</b> admin yang ingin dihapus:\n\nCatatan: Admin bawaan dari .env tidak dapat dihapus dari sini.";
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action("panel:bot:setmonitor", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        const settings = db.getSettings();
        const current = settings.monitorSchedule || "off";
        const text = `📊 <b>Pengaturan Monitoring</b>\n\nInterval monitoring saat ini: <code>${escapeHtml(current)}</code>\n\nPilih interval di bawah, atau balas dengan cron manual:`;
        chatInputState.set(chatId, { step: "SET_MONITOR", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
        await ctx.reply(text, {
            parse_mode: "HTML", reply_markup: {
                inline_keyboard: [
                    [{ text: "⏰ Tiap 1 Jam", callback_data: "panel:monitor:0 * * * *" }, { text: "🕕 Tiap 6 Jam", callback_data: "panel:monitor:0 */6 * * *" }],
                    [{ text: "🕛 Tiap 12 Jam", callback_data: "panel:monitor:0 */12 * * *" }, { text: "📅 Tiap 24 Jam", callback_data: "panel:monitor:0 0 * * *" }],
                    [{ text: "✖️ Matikan", callback_data: "panel:monitor:off" }, { text: "Cancel ❌", callback_data: "panel:cancel_input" }]
                ]
            }
        });
    });

    bot.action(/^panel:monitor:(.+)$/, async (ctx) => {
        const val = ctx.match[1].trim();
        const chatId = getChatIdFromCtx(ctx);
        chatInputState.delete(chatId);
        const schedule = (val === "off" || val === "mati") ? null : val;
        await db.updateSettings({ monitorSchedule: schedule });
        const { monitor } = deps;
        monitor.setSchedule(schedule);
        const output = schedule
            ? `✅ Monitoring diatur ke <code>${escapeHtml(schedule)}</code>`
            : "✅ Monitoring dimatikan.";
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    bot.action("panel:bot:setdiskalert", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        const settings = db.getSettings();
        const current = settings.diskAlertThreshold || 85;
        const text = `📈 <b>Disk Space Alert</b>\n\nThreshold saat ini: <b>${current}%</b>\n\nPilih threshold baru:`;
        await ctx.reply(text, {
            parse_mode: "HTML", reply_markup: {
                inline_keyboard: [
                    [{ text: "70%", callback_data: "panel:diskalert:70" }, { text: "80%", callback_data: "panel:diskalert:80" }, { text: "85%", callback_data: "panel:diskalert:85" }],
                    [{ text: "90%", callback_data: "panel:diskalert:90" }, { text: "95%", callback_data: "panel:diskalert:95" }],
                    [{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]
                ]
            }
        });
    });

    bot.action(/^panel:diskalert:(\d+)$/, async (ctx) => {
        const threshold = parseInt(ctx.match[1], 10);
        const chatId = getChatIdFromCtx(ctx);
        await db.updateSettings({ diskAlertThreshold: threshold });
        const output = `✅ Disk alert threshold diatur ke <b>${threshold}%</b>`;
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    bot.action("panel:bot:report", async (ctx) => {
        await answerCallback(ctx, "Generating report...");
        const { monitor } = deps;
        const report = await monitor.getReport();
        const chatId = getChatIdFromCtx(ctx);
        setPanelState(chatId, { output: report, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    bot.action("panel:bot:update", async (ctx) => {
        await answerCallback(ctx, "Updating bot...");
        try {
            const pullProcess = await runShell("git pull origin main", { cwd: ROOT_DIR });
            const installProcess = await runShell("npm install", { cwd: ROOT_DIR });
            const output = [
                "<b>Bot Update Status</b>", "<u>Git Pull:</u>",
                `<pre>${escapeHtml(clip(pullProcess.stdout + pullProcess.stderr, 1000))}</pre>`,
                "<u>NPM Install:</u>",
                `<pre>${escapeHtml(clip(installProcess.stdout + installProcess.stderr, 1000))}</pre>`,
                "", "Disarankan menekan <b>Restart Bot</b> setelah update bila ada pembaruan."
            ].join("\n");
            await renderPanel(ctx, { output, outputIsHtml: true, confirmRemove: false }, deps);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await renderPanel(ctx, { output: `Gagal menjalankan update bot: ${escapeHtml(msg)}`, outputIsHtml: true, confirmRemove: false }, deps);
        }
    });

    bot.action("panel:bot:restart", async (ctx) => {
        await answerCallback(ctx, "Restarting bot...");
        await editOrReply(ctx, "<b>Bot is restarting...</b>\n\nJika anda menggunakan PM2 atau Systemd, bot akan aktif kembali sesaat lagi. Silakan /panel ulang.", { parse_mode: "HTML" });
        setTimeout(() => process.exit(0), 1000);
    });
}

module.exports = { register };
