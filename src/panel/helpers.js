const { escapeHtml } = require("../utils");

function clip(text = "", max = 3500) {
    if (text.length <= max) return text;
    return `[dipotong, tampil ${max} char terakhir]\n${text.slice(-max)}`;
}

function getChatIdFromCtx(ctx) {
    if (ctx.chat && typeof ctx.chat.id !== "undefined") {
        return String(ctx.chat.id);
    }
    const cbMessage = ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message : null;
    if (cbMessage && cbMessage.chat && typeof cbMessage.chat.id !== "undefined") {
        return String(cbMessage.chat.id);
    }
    return null;
}

function callbackAppName(name) {
    return encodeURIComponent(name);
}

function parseCallbackAppName(raw) {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function appRuntime(app) {
    const runtime = app.runtime || {};
    return {
        status: runtime.status || "stopped",
        pid: runtime.pid || "-"
    };
}

function appSummary(name, app, formatUptime) {
    const runtime = app.runtime || {};
    let statusStr = runtime.status || "stopped";
    if (statusStr === "running" && runtime.lastStartAt) {
        const elapsedSeconds = Math.floor((Date.now() - new Date(runtime.lastStartAt).getTime()) / 1000);
        statusStr += ` (uptime: ${formatUptime(elapsedSeconds)})`;
    }

    return [
        `- ${name}`,
        `  status: ${statusStr}`,
        `  pid: ${runtime.pid || "-"}`,
        `  branch: ${app.branch}`,
        `  repo: ${app.repo}`
    ].join("\n");
}

async function answerCallback(ctx, text = "") {
    if (!ctx.callbackQuery) return;
    try {
        await ctx.answerCbQuery(text);
    } catch {
        // Ignore callback query answer errors
    }
}

async function replyError(ctx, err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error: ${msg}`);
}

module.exports = {
    clip,
    getChatIdFromCtx,
    callbackAppName,
    parseCallbackAppName,
    appRuntime,
    appSummary,
    answerCallback,
    replyError
};
