const { escapeHtml } = require("../utils");
const { clip, getChatIdFromCtx, appRuntime, callbackAppName } = require("./helpers");
const { syncPanelStateWithApps, setPanelState } = require("./state");
const { formatUptime } = require("../services/vpsInfo");

function panelText(state, deps) {
    const { db, ADMIN_IDS } = deps;
    const synced = syncPanelStateWithApps(state, db);
    const apps = db.getApps();
    const names = Object.keys(apps).sort();
    const running = names.filter((name) => appRuntime(apps[name]).status === "running").length;
    const selectedName = synced.selectedApp;
    const selectedApp = selectedName ? apps[selectedName] : null;
    const view = synced.view;

    const lines = [];

    if (view === "main") {
        lines.push(
            "💻 <b>Control Panel Utama</b>",
            "<blockquote>",
            `<b>Total app:</b> ${names.length}`,
            `<b>Running:</b> ${running}`,
            "</blockquote>"
        );
        if (names.length === 0) {
            lines.push("", "Belum ada app terdaftar.", "Klik <b>➕ Add App</b> untuk menyetel bot.");
        } else {
            lines.push("", "Pilih aplikasi di bawah ini untuk mengatur:");
        }
    } else if (view === "app" && selectedApp) {
        const runtime = selectedApp.runtime || {};
        let statusStr = runtime.status || "stopped";
        if (statusStr === "running" && runtime.lastStartAt) {
            const elapsedSeconds = Math.floor((Date.now() - new Date(runtime.lastStartAt).getTime()) / 1000);
            statusStr += ` (uptime: ${formatUptime(elapsedSeconds)})`;
        }

        lines.push(
            `📱 <b>Menu Aplikasi: ${escapeHtml(selectedName)}</b>`,
            "<blockquote>",
            `<b>Status:</b> ${escapeHtml(statusStr)}`,
            `<b>PID:</b> ${escapeHtml(String(runtime.pid || "-"))}`,
            `<b>Branch:</b> ${escapeHtml(selectedApp.branch || "-")}`,
            `<b>Repo:</b> <pre>${escapeHtml(selectedApp.repo || "-")}</pre>`,
            `<b>Deploy Terakhir:</b> ${escapeHtml(selectedApp.lastDeployAt || "-")}`,
            "</blockquote>"
        );
    } else if (view === "settings" && selectedApp) {
        const runtime = selectedApp.runtime || {};
        let statusStr = runtime.status || "stopped";
        if (statusStr === "running" && runtime.lastStartAt) {
            const elapsedSeconds = Math.floor((Date.now() - new Date(runtime.lastStartAt).getTime()) / 1000);
            statusStr += ` (uptime: ${formatUptime(elapsedSeconds)})`;
        }

        lines.push(
            `⚙️ <b>Menu Pengaturan: ${escapeHtml(selectedName)}</b>`,
            `Status saat ini: <b>${escapeHtml(statusStr)}</b>`,
            "",
            "<b>Konfigurasi Aktif:</b>",
            "<blockquote>",
            `<b>cmd install:</b> <pre>${escapeHtml(selectedApp.installCommand || "npm install")}</pre>`,
            `<b>cmd build:</b> <pre>${escapeHtml(selectedApp.buildCommand || "-")}</pre>`,
            `<b>cmd start:</b> <pre>${escapeHtml(selectedApp.startCommand || "npm start")}</pre>`,
            `<b>Auto-Restart:</b> <code>${escapeHtml(selectedApp.cronSchedule || "Mati")}</code>`,
            "</blockquote>"
        );
    } else if (view === "bot_settings") {
        const dbSettings = db.getSettings();
        const dynamicAdminsCount = (dbSettings.admins || []).length;
        const totalAdmins = ADMIN_IDS.length + dynamicAdminsCount;

        lines.push(
            "⚙️ <b>Pengaturan Bot (Global)</b>",
            "<blockquote>",
            `<b>Timezone:</b> ${escapeHtml(process.env.TZ)}`,
            `<b>Node.js:</b> ${escapeHtml(process.version)}`,
            `<b>Bot Uptime:</b> ${escapeHtml(formatUptime(process.uptime()))}`,
            `<b>Total Admin:</b> ${totalAdmins} (${ADMIN_IDS.length} from .env, ${dynamicAdminsCount} from DB)`,
            "</blockquote>",
            "",
            "Pilih menu di bawah ini untuk mengatur bot:"
        );
    } else if (view === "vps") {
        lines.push(state.output);
    }

    // Only show generic output if NOT in vps view
    if (view !== "vps" && synced.output && synced.output.trim()) {
        lines.push("", "💬 <b>Output Terakhir</b>");
        if (synced.outputIsHtml) {
            lines.push(synced.output);
        } else {
            lines.push(`<pre>${escapeHtml(clip(synced.output, 1700))}</pre>`);
        }
    }

    if (synced.confirmRemove && selectedName) {
        lines.push("", `⚠️ <b>Konfirmasi penghapusan app:</b> ${escapeHtml(selectedName)}`);
    }

    const d = new Date(state.updatedAt || new Date());
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
    lines.push("", `🕒 <i>Terakhir diperbarui: ${d.toLocaleString('id-ID', dateOptions)}</i>`);

    return lines.join("\n");
}

function panelKeyboard(state, deps) {
    const { db } = deps;
    const synced = syncPanelStateWithApps(state, db);
    const apps = db.getApps();
    const names = Object.keys(apps).sort();
    const view = synced.view;
    const rows = [];

    if (view === "main") {
        rows.push([
            { text: "🔄 Refresh", callback_data: "panel:refresh" },
            { text: "🖥️ VPS Info", callback_data: "panel:vps" },
            { text: "🆕 Add App", callback_data: "panel:addapp:start" }
        ]);

        for (let i = 0; i < names.length; i += 2) {
            const chunk = names.slice(i, i + 2).map((name) => {
                const runtime = appRuntime(apps[name]);
                const circle = runtime.status === "running" ? "🟢" : "🔴";
                return {
                    text: `${circle} ${name}`,
                    callback_data: `panel:sel:${callbackAppName(name)}`
                };
            });
            rows.push(chunk);
        }

        rows.push([
            { text: "⚙️ Pengaturan Bot", callback_data: "panel:nav:bot_settings" }
        ]);
    } else if (view === "bot_settings") {
        rows.push([
            { text: "👥 Lihat Admin", callback_data: "panel:bot:admins" },
            { text: "⏰ Set Timezone", callback_data: "panel:bot:settz" }
        ]);
        rows.push([
            { text: "➕ Tambah Admin", callback_data: "panel:bot:addadmin" },
            { text: "➖ Hapus Admin", callback_data: "panel:bot:deladmin" }
        ]);
        rows.push([
            { text: "🤖 Update Bot", callback_data: "panel:bot:update" },
            { text: "⚡ Restart Bot", callback_data: "panel:bot:restart" }
        ]);
        rows.push([
            { text: "🔙 Kembali", callback_data: "panel:nav:main" }
        ]);
    } else if (view === "vps") {
        rows.push([
            { text: "📦 Backup Data", callback_data: "panel:vps:backup" },
            { text: "🧹 Cleanup System", callback_data: "panel:vps:cleanup" }
        ]);
        rows.push([
            { text: "🔄 Refresh VPS", callback_data: "panel:vps" },
            { text: "🔙 Kembali", callback_data: "panel:nav:main" }
        ]);
    } else if (view === "app" && synced.selectedApp) {
        if (synced.confirmRemove) {
            rows.push([
                { text: "⚠️ Hapus DB Saja", callback_data: "panel:run:rmkeep" },
                { text: "⚠️ Hapus DB & File", callback_data: "panel:run:rmfiles" }
            ]);
            rows.push([{ text: "✖️ Batal Hapus", callback_data: "panel:run:rmcancel" }]);
        } else {
            rows.push([
                { text: "▶️ Start", callback_data: "panel:run:start" },
                { text: "⏹️ Stop", callback_data: "panel:run:stop" },
                { text: "🔁 Restart", callback_data: "panel:run:restart" }
            ]);
            rows.push([
                { text: "🚀 Deploy", callback_data: "panel:run:deploy" },
                { text: "📦 Update", callback_data: "panel:run:update" }
            ]);
            rows.push([
                { text: "📋 Logs 80", callback_data: "panel:run:log80" },
                { text: "📋 Logs 200", callback_data: "panel:run:log200" },
                { text: "⚙️ Settings", callback_data: `panel:nav:settings:${callbackAppName(synced.selectedApp)}` }
            ]);
            rows.push([
                { text: "🔙 Kembali", callback_data: "panel:nav:main" },
                { text: "🗑️ Hapus App", callback_data: "panel:run:remove" }
            ]);
        }
    } else if (view === "settings" && synced.selectedApp) {
        rows.push([
            { text: "✏️ Edit Repo", callback_data: "panel:edit:repo" },
            { text: "✏️ Edit Branch", callback_data: "panel:edit:branch" }
        ]);
        rows.push([
            { text: "⏱️ Set Auto-Restart (Cron)", callback_data: "panel:edit:cron" }
        ]);
        rows.push([
            { text: "🛠 Cmd Install", callback_data: "panel:edit:cmd:install" },
            { text: "🛠 Cmd Build", callback_data: "panel:edit:cmd:build" },
            { text: "🛠 Cmd Start", callback_data: "panel:edit:cmd:start" }
        ]);
        rows.push([
            { text: "🔑 Set Env Var", callback_data: "panel:edit:setvar" },
            { text: "📝 Import .env", callback_data: "panel:edit:importenv" }
        ]);
        rows.push([
            { text: "🗑 Del Env Var", callback_data: "panel:edit:delvar" },
            { text: "📜 Lihat Vars", callback_data: "panel:run:vars" }
        ]);
        rows.push([
            { text: "🔙 Kembali ke App", callback_data: `panel:nav:app:${callbackAppName(synced.selectedApp)}` }
        ]);
    }

    // Always at the bottom
    if (synced.output && synced.output.trim()) {
        rows.push([{ text: "✖️ Bersihkan Output", callback_data: "panel:clear" }]);
    }

    return {
        inline_keyboard: rows
    };
}

async function editOrReply(ctx, text, replyMarkup) {
    const payload = {
        parse_mode: "HTML",
        reply_markup: replyMarkup
    };

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(text, payload);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("message is not modified")) return;
            if (msg.includes("message can't be edited")) {
                await ctx.reply(text, payload);
                return;
            }
            throw err;
        }
    }

    await ctx.reply(text, payload);
}

async function renderPanel(ctx, patch, deps) {
    const { db } = deps;
    const chatId = getChatIdFromCtx(ctx);
    if (!chatId) {
        await ctx.reply("Tidak bisa membaca chat ID untuk panel.");
        return;
    }
    const state = setPanelState(chatId, patch, db);
    await editOrReply(ctx, panelText(state, deps), panelKeyboard(state, deps));
}

module.exports = {
    panelText,
    panelKeyboard,
    editOrReply,
    renderPanel
};
