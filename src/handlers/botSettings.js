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

    // === Webhook ===
    bot.action("panel:bot:webhook", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const settings = db.getSettings();
        const port = settings.webhookPort || 9876;
        const enabled = settings.webhookEnabled || false;
        const output = [
            `🔗 <b>Webhook Server</b>`,
            `<blockquote>`,
            `<b>Status:</b> ${enabled ? "✅ Aktif" : "🔴 Mati"}`,
            `<b>Port:</b> ${port}`,
            `</blockquote>`,
            "",
            `URL Format: <code>POST http://YOUR_IP:${port}/webhook/APP_NAME?secret=SECRET</code>`,
            "",
            "Aktifkan webhook per app melalui menu Settings tiap app."
        ].join("\n");
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    bot.action("panel:bot:webhooktoggle", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const settings = db.getSettings();
        const newState = !(settings.webhookEnabled);
        const port = settings.webhookPort || 9876;
        await db.updateSettings({ webhookEnabled: newState, webhookPort: port });
        const { webhookServer } = deps;
        if (newState) { webhookServer.start(port); } else { webhookServer.stop(); }
        const output = newState
            ? `✅ Webhook server <b>diaktifkan</b> di port ${port}`
            : "🔴 Webhook server <b>dimatikan</b>";
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    // === Auto-Backup ===
    bot.action("panel:bot:setbackup", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const settings = db.getSettings();
        const current = settings.autoBackupSchedule || "off";
        const text = `💾 <b>Auto-Backup</b>\n\nJadwal saat ini: <code>${escapeHtml(current)}</code>\n\nPilih jadwal:`;
        await ctx.reply(text, {
            parse_mode: "HTML", reply_markup: {
                inline_keyboard: [
                    [{ text: "📅 Tiap Hari", callback_data: "panel:autobackup:0 0 * * *" }, { text: "📅 Tiap Minggu", callback_data: "panel:autobackup:0 0 * * 0" }],
                    [{ text: "✖️ Matikan", callback_data: "panel:autobackup:off" }, { text: "Cancel ❌", callback_data: "panel:cancel_input" }]
                ]
            }
        });
    });

    bot.action(/^panel:autobackup:(.+)$/, async (ctx) => {
        const val = ctx.match[1].trim();
        const chatId = getChatIdFromCtx(ctx);
        const schedule = (val === "off" || val === "mati") ? null : val;
        await db.updateSettings({ autoBackupSchedule: schedule });
        const { monitor } = deps;
        monitor.setBackupSchedule(schedule);
        const output = schedule
            ? `✅ Auto-Backup diatur ke <code>${escapeHtml(schedule)}</code>`
            : "✅ Auto-Backup dimatikan.";
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    // === Webhook per app ===
    bot.action("panel:app:webhooktoggle", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const { selectedAppFromState } = require("../panel/state");
        const selected = selectedAppFromState(chatId, db);
        if (!selected) { return; }
        const appName = selected.name;
        const app = selected.app;
        const { webhookServer } = deps;
        let output;
        if (app.webhookSecret) {
            // Disable webhook
            await db.upsertApp(appName, (existing) => ({ ...existing, webhookSecret: null }));
            output = `🔴 Webhook untuk <b>${escapeHtml(appName)}</b> dinonaktifkan.`;
        } else {
            // Enable webhook
            const secret = webhookServer.generateSecret();
            await db.upsertApp(appName, (existing) => ({ ...existing, webhookSecret: secret }));
            const settings = db.getSettings();
            const port = settings.webhookPort || 9876;
            output = [
                `✅ Webhook untuk <b>${escapeHtml(appName)}</b> diaktifkan!`,
                "",
                `<b>URL:</b>`,
                `<code>POST http://YOUR_IP:${port}/webhook/${escapeHtml(appName)}?secret=${escapeHtml(secret)}</code>`,
                "",
                "Tambahkan URL ini di GitHub → Settings → Webhooks.",
                "Content type: <code>application/json</code>"
            ].join("\n");
        }
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    // === Audit Log ===
    bot.action("panel:bot:auditlog", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const { auditLog } = deps;
        const recent = auditLog.getRecent(25);
        let output;
        if (recent.length === 0) {
            output = "📝 <b>Audit Log</b>\n\n<i>Belum ada log.</i>";
        } else {
            output = "📝 <b>Audit Log (25 terakhir)</b>\n\n<pre>" + escapeHtml(recent.join("\n")) + "</pre>";
        }
        setPanelState(chatId, { output, outputIsHtml: true }, db);
        await renderPanel(ctx, {}, deps);
    });

    // === Restore trigger ===
    bot.action("panel:bot:restore", async (ctx) => {
        await answerCallback(ctx);
        await ctx.reply("📦 <b>Restore Backup</b>\n\nKirim file <code>.zip</code> backup ke chat ini untuk memulai proses restore.\n\nFile backup yang valid berisi: db.json, .env, dan/atau app-specific .env files.", { parse_mode: "HTML" });
    });

    // === PIN Security ===
    bot.action("panel:bot:setpin", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        const settings = db.getSettings();
        const hasPin = !!settings.pin;
        if (hasPin) {
            await ctx.reply("🔒 <b>PIN sudah diset.</b>\n\nPilih aksi:", {
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Ganti PIN", callback_data: "panel:pin:change" }, { text: "🗑 Hapus PIN", callback_data: "panel:pin:remove" }],
                        [{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]
                    ]
                }
            });
        } else {
            chatInputState.set(chatId, { step: "SET_PIN", data: {} });
            await ctx.reply("🔒 <b>Set PIN Keamanan</b>\n\nBalas dengan PIN (4-8 digit angka):\n\n<i>PIN akan diminta saat aksi berbahaya (hapus app, restore, restart bot).</i>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
        }
    });

    bot.action("panel:pin:change", async (ctx) => {
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        chatInputState.set(chatId, { step: "SET_PIN", data: {} });
        await ctx.reply("🔒 Balas dengan PIN baru (4-8 digit angka):", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
    });

    bot.action("panel:pin:remove", async (ctx) => {
        await answerCallback(ctx);
        await db.updateSettings({ pin: null });
        const chatId = getChatIdFromCtx(ctx);
        const output = "✅ PIN keamanan telah dihapus.";
        setPanelState(chatId, { output, outputIsHtml: false }, db);
        await renderPanel(ctx, {}, deps);
    });

    // PIN confirmation flow for dangerous actions
    bot.action(/^panel:pinconfirm:(.+)$/, async (ctx) => {
        const targetAction = ctx.match[1];
        await answerCallback(ctx);
        const chatId = getChatIdFromCtx(ctx);
        chatInputState.set(chatId, { step: "VERIFY_PIN", data: { targetAction } });
        await ctx.reply("🔒 Masukkan PIN untuk melanjutkan:", { reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
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
