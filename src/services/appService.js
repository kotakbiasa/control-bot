const fs = require("fs");
const path = require("path");
const { nowIso, escapeHtml, normalizeLines } = require("../utils");
const { clip } = require("../panel/helpers");

function makeNewApp({ name, repo, branch }, deploymentsDir) {
    const now = nowIso();
    return {
        name,
        repo,
        branch,
        directory: path.join(deploymentsDir, name),
        installCommand: "npm install",
        buildCommand: "",
        startCommand: "npm start",
        env: {},
        runtime: {
            status: "stopped",
            pid: null,
            lastStartAt: null,
            lastStopAt: null,
            lastExitCode: null,
            lastSignal: null
        },
        createdAt: now,
        updatedAt: now,
        lastDeployAt: null
    };
}

async function removeAppInternal(name, opts, deps) {
    const { deleteFiles = false, force = false } = opts || {};
    const { db, processManager, DEPLOYMENTS_DIR, LOGS_DIR, withinDir } = deps;

    const app = db.getApp(name);
    if (!app) {
        throw new Error(`App "${name}" tidak ditemukan.`);
    }

    const runtime = app.runtime || {};
    const isRunning = runtime.status === "running" && runtime.pid;
    if (isRunning && !force) {
        throw new Error('App masih running. Gunakan --force atau stop dulu dengan /stop <nama>.');
    }

    if (isRunning && force) {
        await processManager.stop(name);
    }

    if (deleteFiles) {
        if (app.directory && withinDir(DEPLOYMENTS_DIR, app.directory)) {
            fs.rmSync(app.directory, { recursive: true, force: true });
        }
        const outLog = path.join(LOGS_DIR, `${name}.out.log`);
        const errLog = path.join(LOGS_DIR, `${name}.err.log`);
        if (fs.existsSync(outLog)) fs.rmSync(outLog, { force: true });
        if (fs.existsSync(errLog)) fs.rmSync(errLog, { force: true });
    }

    await db.deleteApp(name);
    return { deleteFiles };
}

async function showVarsMessage(ctx, name, db) {
    const app = db.getApp(name);
    if (!app) {
        await ctx.reply(`App "${name}" tidak ditemukan.`);
        return;
    }

    const entries = Object.entries(app.env || {});
    if (entries.length === 0) {
        await ctx.reply(`Belum ada env var untuk "${name}".`);
        return;
    }

    const text = entries.map(([k, v]) => `${k}=${v}`).join("\n");
    await ctx.reply(text);
}

async function showLogsMessage(ctx, name, lineArg, deps) {
    const { db, processManager } = deps;
    const app = db.getApp(name);
    if (!app) {
        await ctx.reply(`App "${name}" tidak ditemukan.`);
        return;
    }

    const lines = normalizeLines(lineArg, 80);
    const logs = processManager.readLogs(name, lines);
    const stdoutPart = clip(logs.out || "(kosong)", 1500);
    const stderrPart = clip(logs.err || "(kosong)", 1500);
    const text = [
        `<b>Logs ${escapeHtml(name)}</b>`,
        `<b>stdout</b>`,
        `<pre>${escapeHtml(stdoutPart)}</pre>`,
        `<b>stderr</b>`,
        `<pre>${escapeHtml(stderrPart)}</pre>`
    ].join("\n");
    await ctx.reply(text, { parse_mode: "HTML" });
}

module.exports = {
    makeNewApp,
    removeAppInternal,
    showVarsMessage,
    showLogsMessage
};
