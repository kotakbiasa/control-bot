const { parseCommandArgs, appNameValid, repoUrlValid, escapeHtml, nowIso } = require("../utils");
const { clip, appSummary, replyError } = require("../panel/helpers");
const { renderPanel } = require("../panel/render");
const { formatUptime } = require("../services/vpsInfo");
const { buildVpsInfoText } = require("../services/vpsInfo");
const { makeNewApp, showVarsMessage, showLogsMessage } = require("../services/appService");
const { runShell } = require("../deployer");

function register(bot, deps) {
    const { db, processManager, deployer, withAppLock, DEPLOYMENTS_DIR } = deps;

    bot.start(async (ctx) => {
        await ctx.reply(
            [
                "Control Bot aktif.",
                "Gunakan /panel untuk kontrol via tombol inline.",
                "Ketik /help untuk lihat semua command.",
                `Total app terdaftar: ${Object.keys(db.getApps()).length}`
            ].join("\n"),
            {
                reply_markup: {
                    inline_keyboard: [[{ text: "Buka Panel", callback_data: "panel:home" }]]
                }
            }
        );
    });

    bot.command("help", async (ctx) => {
        await ctx.reply(
            [
                "Daftar command:",
                "/panel - buka control panel inline (tombol)",
                "/settings - buka pengaturan bot",
                "/vps - lihat spec & usage VPS",
                "/apps - list semua app",
                "/status [nama] - status app",
                "/removeapp <nama> [--delete-files] [--force] - hapus app",
                "/deploy <nama> [--restart] - clone/pull + install + build",
                "/update <nama> - pull + install + build + restart jika running",
                "/start <nama> - jalankan app",
                "/stop <nama> - hentikan app",
                "/restart <nama> - restart app",
                "/logs <nama> [lines] - lihat tail log stdout/stderr",
                "/run <nama> <command...> - jalankan command manual di folder app",
                "",
                "Catatan: Tambah app dan edit config (repo, branch, env, dll) sekarang bisa dilakukan langsung melalui tombol di /panel.",
                "Semua data tersimpan di data/db.json"
            ].join("\n")
        );
    });

    bot.command("panel", async (ctx) => {
        await renderPanel(ctx, { output: "", outputIsHtml: false, confirmRemove: false }, deps);
    });

    bot.command("settings", async (ctx) => {
        await renderPanel(ctx, { view: "bot_settings", output: "", outputIsHtml: false, confirmRemove: false }, deps);
    });

    bot.command("vps", async (ctx) => {
        const text = await buildVpsInfoText(db);
        await ctx.reply(text, { parse_mode: "HTML" });
    });

    bot.command("apps", async (ctx) => {
        const apps = db.getApps();
        const names = Object.keys(apps);
        if (names.length === 0) {
            await ctx.reply("Belum ada app. Tambahkan dengan /addapp atau buka /panel.");
            return;
        }
        const lines = names.map((name) => appSummary(name, apps[name], formatUptime));
        await ctx.reply(lines.join("\n\n"), {
            reply_markup: {
                inline_keyboard: [[{ text: "Buka Panel", callback_data: "panel:home" }]]
            }
        });
    });

    bot.command("status", async (ctx) => {
        const args = parseCommandArgs(ctx);
        const [name] = args;
        if (!name) {
            const apps = db.getApps();
            const names = Object.keys(apps);
            if (names.length === 0) { await ctx.reply("Belum ada app."); return; }
            const lines = names.map((appName) => {
                const app = db.getApp(appName);
                const runtime = app.runtime || {};
                return `${appName}: ${runtime.status || "stopped"} (pid: ${runtime.pid || "-"})`;
            });
            await ctx.reply(lines.join("\n"));
            return;
        }
        const app = db.getApp(name);
        if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
        const runtime = app.runtime || {};
        const text = [
            `nama: ${name}`, `status: ${runtime.status || "stopped"}`, `pid: ${runtime.pid || "-"}`,
            `repo: ${app.repo}`, `branch: ${app.branch}`, `directory: ${app.directory}`,
            `install: ${app.installCommand || "-"}`, `build: ${app.buildCommand || "-"}`,
            `start: ${app.startCommand || "-"}`, `lastDeployAt: ${app.lastDeployAt || "-"}`,
            `lastStartAt: ${runtime.lastStartAt || "-"}`, `lastStopAt: ${runtime.lastStopAt || "-"}`,
            `lastExitCode: ${runtime.lastExitCode ?? "-"}`
        ].join("\n");
        await ctx.reply(text);
    });

    bot.command("addapp", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, repo, branchArg] = args;
            const branch = branchArg || "main";
            if (!name || !repo) { await ctx.reply("Format: /addapp <nama> <repo_url> [branch]"); return; }
            if (!appNameValid(name)) { await ctx.reply("Nama app hanya boleh huruf, angka, underscore, dash."); return; }
            if (name.length > 32) { await ctx.reply("Nama app maksimal 32 karakter."); return; }
            if (!/^[A-Za-z0-9._/-]+$/.test(branch)) { await ctx.reply("Branch tidak valid."); return; }
            if (!repoUrlValid(repo)) { await ctx.reply("Repo URL tidak valid."); return; }
            if (db.getApp(name)) { await ctx.reply(`App "${name}" sudah ada.`); return; }

            const app = makeNewApp({ name, repo, branch }, DEPLOYMENTS_DIR);
            await db.upsertApp(name, app);
            await ctx.reply([
                `App "${name}" ditambahkan.`, `Repo: ${repo}`, `Branch: ${branch}`, "",
                "Opsional set command custom:",
                `/setcmd ${name} install "npm ci"`, `/setcmd ${name} build "npm run build"`,
                `/setcmd ${name} start "npm run start"`, "", `Lanjut deploy: /deploy ${name}`
            ].join("\n"));
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("setrepo", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, repo] = args;
            if (!name || !repo) { await ctx.reply("Format: /setrepo <nama> <repo_url>"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            if (!repoUrlValid(repo)) { await ctx.reply("Repo URL tidak valid."); return; }
            await db.upsertApp(name, (existing) => ({ ...existing, repo, updatedAt: nowIso() }));
            await ctx.reply(`Repo app "${name}" diupdate ke:\n${repo}`);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("setbranch", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, branch] = args;
            if (!name || !branch) { await ctx.reply("Format: /setbranch <nama> <branch>"); return; }
            if (!/^[A-Za-z0-9._/-]+$/.test(branch)) { await ctx.reply("Branch tidak valid."); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            await db.upsertApp(name, (existing) => ({ ...existing, branch, updatedAt: nowIso() }));
            await ctx.reply(`Branch app "${name}" diupdate ke "${branch}".`);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("setcmd", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, type, ...rest] = args;
            if (!name || !type || rest.length === 0) { await ctx.reply("Format: /setcmd <nama> <start|install|build> <command...>"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            const command = rest.join(" ").trim();
            let key = "";
            if (type === "start") key = "startCommand";
            if (type === "install") key = "installCommand";
            if (type === "build") key = "buildCommand";
            if (!key) { await ctx.reply("Type harus salah satu: start, install, build"); return; }
            await db.upsertApp(name, (existing) => ({ ...existing, [key]: command, updatedAt: nowIso() }));
            await ctx.reply(`Command ${type} untuk "${name}" diupdate:\n${command}`);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("setvar", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, key, ...valueParts] = args;
            if (!name || !key || valueParts.length === 0) { await ctx.reply("Format: /setvar <nama> <KEY> <VALUE...>"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            const value = valueParts.join(" ");
            await db.upsertApp(name, (existing) => ({ ...existing, env: { ...(existing.env || {}), [key]: value }, updatedAt: nowIso() }));
            await ctx.reply(`Env var diset: ${name} -> ${key}=${value}`);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("delvar", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, key] = args;
            if (!name || !key) { await ctx.reply("Format: /delvar <nama> <KEY>"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            await db.upsertApp(name, (existing) => { const env = { ...(existing.env || {}) }; delete env[key]; return { ...existing, env, updatedAt: nowIso() }; });
            await ctx.reply(`Env var dihapus: ${name} -> ${key}`);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("vars", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name] = args;
            if (!name) { await ctx.reply("Format: /vars <nama>"); return; }
            await showVarsMessage(ctx, name, db);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("deploy", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, flag] = args;
            const restartAfter = flag === "--restart";
            if (!name) { await ctx.reply("Format: /deploy <nama> [--restart]"); return; }
            await withAppLock(name, async () => {
                const app = db.getApp(name);
                if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
                await ctx.reply(`Deploy "${name}" dimulai...`);
                const summary = await deployer.deploy(name);
                if (restartAfter) {
                    const pid = await processManager.restart(name);
                    await ctx.reply([`Deploy selesai dan app direstart.`, `PID baru: ${pid}`, "", `Repo: ${summary.repository}`].join("\n"));
                    return;
                }
                await ctx.reply([`Deploy "${name}" selesai.`, `Repo: ${summary.repository}`, "", "Jika app belum jalan, gunakan /start <nama>."].join("\n"));
            });
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("update", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name] = args;
            if (!name) { await ctx.reply("Format: /update <nama>"); return; }
            await withAppLock(name, async () => {
                const app = db.getApp(name);
                if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
                const runtime = app.runtime || {};
                const wasRunning = runtime.status === "running" && runtime.pid;
                await ctx.reply(`Update "${name}" dimulai...`);
                if (wasRunning) { await processManager.stop(name); }
                const summary = await deployer.deploy(name, { updateOnly: true });
                if (wasRunning) {
                    const pid = await processManager.start(name);
                    await ctx.reply(`Update selesai. App kembali jalan dengan PID ${pid}.`);
                } else {
                    await ctx.reply(`Update selesai. App tidak direstart karena status awal tidak running.`);
                }
                const log = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
                await ctx.reply(clip(log, 3500));
            });
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("start", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name] = args;
            if (!name) { await ctx.reply("Format: /start <nama>"); return; }
            await withAppLock(name, async () => {
                const pid = await processManager.start(name);
                await ctx.reply(`App "${name}" jalan. PID: ${pid}`);
            });
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("stop", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name] = args;
            if (!name) { await ctx.reply("Format: /stop <nama>"); return; }
            await withAppLock(name, async () => {
                const result = await processManager.stop(name);
                if (result.alreadyStopped) { await ctx.reply(`App "${name}" sudah berhenti.`); }
                else { await ctx.reply(`App "${name}" dihentikan.`); }
            });
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("restart", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name] = args;
            if (!name) { await ctx.reply("Format: /restart <nama>"); return; }
            await withAppLock(name, async () => {
                const pid = await processManager.restart(name);
                await ctx.reply(`App "${name}" restart sukses. PID: ${pid}`);
            });
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("logs", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, lineArg] = args;
            if (!name) { await ctx.reply("Format: /logs <nama> [lines]"); return; }
            await showLogsMessage(ctx, name, lineArg, deps);
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("run", async (ctx) => {
        try {
            const fs = require("fs");
            const args = parseCommandArgs(ctx);
            const [name, ...cmdParts] = args;
            if (!name || cmdParts.length === 0) { await ctx.reply("Format: /run <nama> <command...>"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            if (!fs.existsSync(app.directory)) { await ctx.reply(`Folder app belum ada: ${app.directory}`); return; }
            const command = cmdParts.join(" ");
            await ctx.reply(`Menjalankan command di "${name}"...\n${command}`);
            const result = await runShell(command, { cwd: app.directory });
            const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
            await ctx.reply(clip(combined || "(tidak ada output)", 3500));
        } catch (err) { await replyError(ctx, err); }
    });

    bot.command("removeapp", async (ctx) => {
        try {
            const args = parseCommandArgs(ctx);
            const [name, ...flags] = args;
            if (!name) { await ctx.reply("Format: /removeapp <nama> [--delete-files] [--force]"); return; }
            const app = db.getApp(name);
            if (!app) { await ctx.reply(`App "${name}" tidak ditemukan.`); return; }
            const deleteFiles = flags.includes("--delete-files");
            const force = flags.includes("--force");
            await withAppLock(name, async () => {
                const { removeAppInternal } = require("../services/appService");
                await removeAppInternal(name, { deleteFiles, force }, deps);
                await ctx.reply([`App "${name}" dihapus dari database.`, deleteFiles ? "File deployment + log juga dihapus." : "File deployment tidak dihapus."].join("\n"));
            });
        } catch (err) { await replyError(ctx, err); }
    });
}

module.exports = { register };
