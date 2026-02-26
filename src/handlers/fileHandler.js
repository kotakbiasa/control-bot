const fs = require("fs");
const path = require("path");
const { escapeHtml } = require("../utils");
const { getChatIdFromCtx, answerCallback } = require("../panel/helpers");

function register(bot, deps) {
    const { db, chatInputState, DB_PATH, ROOT_DIR, DEPLOYMENTS_DIR } = deps;

    bot.on("document", async (ctx, next) => {
        const doc = ctx.message && ctx.message.document;
        if (!doc) return next();

        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return next();

        const stateInfo = chatInputState.get(chatId);

        // Only handle if user is in CONFIRM_RESTORE flow or file is a zip
        if (!stateInfo || stateInfo.step !== "AWAIT_RESTORE") {
            // Auto-detect backup zip
            if (doc.file_name && doc.file_name.endsWith(".zip") && doc.file_name.includes("backup")) {
                chatInputState.set(chatId, { step: "CONFIRM_RESTORE", data: { fileId: doc.file_id, fileName: doc.file_name } });
                await ctx.reply(
                    `📦 Terdeteksi file backup: <b>${escapeHtml(doc.file_name)}</b>\n\nApakah anda ingin merestore data dari file ini?\n\n⚠️ <b>PERINGATAN:</b> Ini akan menimpa db.json dan .env yang ada saat ini!`,
                    {
                        parse_mode: "HTML",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "✅ Ya, Restore", callback_data: "panel:restore:confirm" }, { text: "❌ Batal", callback_data: "panel:cancel_input" }]
                            ]
                        }
                    }
                );
                return;
            }
            return next();
        }
    });

    bot.action("panel:restore:confirm", async (ctx) => {
        const chatId = getChatIdFromCtx(ctx);
        if (!chatId) return;
        const stateInfo = chatInputState.get(chatId);
        if (!stateInfo || stateInfo.step !== "CONFIRM_RESTORE") {
            await answerCallback(ctx, "Sesi restore kadaluarsa");
            return;
        }

        await answerCallback(ctx, "Restoring...");
        chatInputState.delete(chatId);
        const { fileId, fileName } = stateInfo.data;

        try {
            // Download the file
            const link = await ctx.telegram.getFileLink(fileId);
            const url = link.href || link;
            const https = require("https");
            const http = require("http");
            const tmpZip = path.join(require("os").tmpdir(), `restore-${Date.now()}.zip`);

            await new Promise((resolve, reject) => {
                const proto = url.startsWith("https") ? https : http;
                proto.get(url, (res) => {
                    const ws = fs.createWriteStream(tmpZip);
                    res.pipe(ws);
                    ws.on("finish", () => { ws.close(); resolve(); });
                    ws.on("error", reject);
                }).on("error", reject);
            });

            // Extract and restore
            const AdmZip = require("adm-zip");
            const zip = new AdmZip(tmpZip);
            const entries = zip.getEntries();
            const restored = [];

            for (const entry of entries) {
                if (entry.isDirectory) continue;
                const name = entry.entryName;

                if (name === "db.json") {
                    // Validate JSON before restore
                    const content = zip.readAsText(entry);
                    JSON.parse(content); // throws if invalid
                    fs.writeFileSync(DB_PATH, content, "utf8");
                    restored.push("db.json");
                } else if (name === "control-bot.env") {
                    fs.writeFileSync(path.join(ROOT_DIR, ".env"), zip.readAsText(entry), "utf8");
                    restored.push(".env (control-bot)");
                } else if (name.startsWith("apps/") && name.endsWith("/.env")) {
                    const appName = name.split("/")[1];
                    const appDir = path.join(DEPLOYMENTS_DIR, appName);
                    if (fs.existsSync(appDir)) {
                        fs.writeFileSync(path.join(appDir, ".env"), zip.readAsText(entry), "utf8");
                        restored.push(`.env (${appName})`);
                    }
                }
            }

            fs.unlinkSync(tmpZip);

            const output = [
                `✅ <b>Restore Berhasil!</b>`,
                `File: <code>${escapeHtml(fileName)}</code>`,
                "",
                "<b>File yang direstore:</b>",
                ...restored.map(r => `• ${escapeHtml(r)}`),
                "",
                "⚠️ Disarankan <b>restart bot</b> agar perubahan db.json berlaku."
            ].join("\n");

            await ctx.reply(output, { parse_mode: "HTML" });

        } catch (err) {
            await ctx.reply(`❌ Restore gagal: ${escapeHtml(err.message)}`, { parse_mode: "HTML" });
        }
    });
}

module.exports = { register };
