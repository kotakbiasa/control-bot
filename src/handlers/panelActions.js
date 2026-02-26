const fs = require("fs");
const os = require("os");
const path = require("path");
const archiver = require("archiver");
const { escapeHtml } = require("../utils");
const { clip, getChatIdFromCtx, answerCallback } = require("../panel/helpers");
const { setPanelState } = require("../panel/state");
const { renderPanel } = require("../panel/render");
const { buildVpsInfoText } = require("../services/vpsInfo");
const { runShell } = require("../deployer");

function register(bot, deps) {
    const { db, ROOT_DIR, DB_PATH, DEPLOYMENTS_DIR, LOGS_DIR, chatInputState } = deps;

    bot.action("panel:home", async (ctx) => {
        await answerCallback(ctx);
        await renderPanel(ctx, { confirmRemove: false, view: "main", selectedApp: null, output: "", outputIsHtml: false }, deps);
    });

    bot.action("panel:refresh", async (ctx) => {
        await answerCallback(ctx, "Refreshed");
        await renderPanel(ctx, { confirmRemove: false }, deps);
    });

    bot.action("panel:clear", async (ctx) => {
        await answerCallback(ctx, "Output cleared");
        await renderPanel(ctx, { output: "", outputIsHtml: false, confirmRemove: false }, deps);
    });

    bot.action("panel:vps", async (ctx) => {
        await answerCallback(ctx, "Loading VPS info...");
        const info = await buildVpsInfoText(db);
        await renderPanel(ctx, { view: "vps", output: info, outputIsHtml: true, confirmRemove: false }, deps);
    });

    bot.action("panel:vps:backup", async (ctx) => {
        await answerCallback(ctx, "Membuat backup...");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFilename = `control-bot-backup-${timestamp}.zip`;
        const backupPath = path.join(os.tmpdir(), backupFilename);

        const output = fs.createWriteStream(backupPath);
        const archive = archiver("zip", { zlib: { level: 9 } });

        output.on("close", async () => {
            try {
                await ctx.replyWithDocument({ source: backupPath, filename: backupFilename }, { caption: "📦 Backup Data (db.json & .env)" });
                fs.unlinkSync(backupPath);
            } catch (err) {
                console.error(err);
                await ctx.reply(`Gagal mengirim backup: ${err.message}`);
            }
        });

        archive.on("error", async (err) => {
            await ctx.reply(`Gagal membuat zip: ${err.message}`);
        });

        archive.pipe(output);
        if (fs.existsSync(DB_PATH)) archive.file(DB_PATH, { name: "db.json" });
        const mainEnv = path.join(ROOT_DIR, ".env");
        if (fs.existsSync(mainEnv)) archive.file(mainEnv, { name: "control-bot.env" });
        const apps = db.getApps();
        for (const name of Object.keys(apps)) {
            const appEnv = path.join(DEPLOYMENTS_DIR, name, ".env");
            if (fs.existsSync(appEnv)) {
                archive.file(appEnv, { name: `apps/${name}/.env` });
            }
        }
        archive.finalize();
    });

    bot.action("panel:vps:cleanup", async (ctx) => {
        await answerCallback(ctx, "Membersihkan VPS...");
        try {
            const result = await runShell("npm cache clean --force", { cwd: ROOT_DIR });
            let logMsg = "";
            if (fs.existsSync(LOGS_DIR)) {
                const files = fs.readdirSync(LOGS_DIR);
                let deleted = 0;
                for (const file of files) {
                    const full = path.join(LOGS_DIR, file);
                    const stat = fs.statSync(full);
                    if (stat.size === 0) { fs.unlinkSync(full); deleted++; }
                }
                if (deleted > 0) logMsg = `\nDihapus ${deleted} file log kosong.`;
            }
            const output = [
                "🧹 <b>System Cleanup Selesai!</b>",
                "<u>NPM Cache:</u>",
                `<pre>${escapeHtml(clip(result.stdout + result.stderr, 1000) || "OK")}</pre>`,
                logMsg
            ].join("\n");
            setPanelState(getChatIdFromCtx(ctx), { output, outputIsHtml: true }, db);
            await renderPanel(ctx, {}, deps);
        } catch (err) {
            console.error(err);
            setPanelState(getChatIdFromCtx(ctx), { output: `Gagal cleanup: ${err.message}`, outputIsHtml: false }, db);
            await renderPanel(ctx, {}, deps);
        }
    });

    bot.action("panel:cancel_input", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (chatId) { chatInputState.delete(chatId); }
        await answerCallback(ctx, "Input dibatalkan.");
        await ctx.editMessageText("Membatalkan input. Silakan kembali ke panel.");
    });
}

module.exports = { register };
