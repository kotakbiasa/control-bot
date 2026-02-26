const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config();
const { Telegraf } = require("telegraf");
const { JsonDb } = require("./db");
const { Deployer, runShell } = require("./deployer");
const { ProcessManager } = require("./processManager");
const {
  ensureDir,
  nowIso,
  appNameValid,
  repoUrlValid,
  parseCommandArgs,
  normalizeLines,
  escapeHtml,
  withinDir
} = require("./utils");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const DEPLOYMENTS_DIR = path.join(ROOT_DIR, "deployments");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

ensureDir(DATA_DIR);
ensureDir(DEPLOYMENTS_DIR);
ensureDir(LOGS_DIR);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN wajib diisi di environment.");
}

if (ADMIN_IDS.length === 0) {
  throw new Error("ADMIN_IDS wajib diisi, contoh: ADMIN_IDS=123456789,987654321");
}

const db = new JsonDb(DB_PATH);
const processManager = new ProcessManager({ db, logsDir: LOGS_DIR });
const deployer = new Deployer({ db, deploymentsDir: DEPLOYMENTS_DIR });
const bot = new Telegraf(BOT_TOKEN);
const busyApps = new Set();
const panelStateByChat = new Map();
const chatInputState = new Map();

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

function basePanelState() {
  return {
    view: "main",
    selectedApp: null,
    output: "",
    outputIsHtml: false,
    confirmRemove: false,
    updatedAt: nowIso()
  };
}

function getPanelState(chatId) {
  const existing = panelStateByChat.get(chatId);
  if (existing) return existing;
  const initial = basePanelState();
  panelStateByChat.set(chatId, initial);
  return initial;
}

function syncPanelStateWithApps(state) {
  const apps = db.getApps();
  const names = Object.keys(apps).sort();
  const selectedApp = state.selectedApp && apps[state.selectedApp] ? state.selectedApp : null;
  const view = selectedApp ? state.view : "main";
  return {
    ...state,
    selectedApp,
    view
  };
}

function setPanelState(chatId, patch = {}) {
  const current = syncPanelStateWithApps(getPanelState(chatId));
  const merged = {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
  const synced = syncPanelStateWithApps(merged);
  panelStateByChat.set(chatId, synced);
  return synced;
}

function adminOnly(ctx, next) {
  const fromId = ctx.from && ctx.from.id ? String(ctx.from.id) : "";
  if (!ADMIN_IDS.includes(fromId)) {
    return ctx.reply("Akses ditolak. ID Telegram kamu belum masuk ADMIN_IDS.");
  }
  return next();
}

async function withAppLock(appName, fn) {
  if (busyApps.has(appName)) {
    throw new Error(`App "${appName}" sedang diproses. Coba lagi sebentar.`);
  }
  busyApps.add(appName);
  try {
    return await fn();
  } finally {
    busyApps.delete(appName);
  }
}

function appSummary(name, app) {
  const runtime = app.runtime || {};
  return [
    `- ${name}`,
    `  status: ${runtime.status || "stopped"}`,
    `  pid: ${runtime.pid || "-"}`,
    `  branch: ${app.branch}`,
    `  repo: ${app.repo}`
  ].join("\n");
}

function formatBytes(bytes = 0) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (value === 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const sized = value / 1024 ** exponent;
  return `${sized.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function formatUptime(totalSeconds = 0) {
  const value = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

async function getDiskUsage() {
  try {
    const { stdout } = await runShell("df -Pk /");
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      return { total: "-", used: "-", avail: "-", percent: "-" };
    }
    const cols = lines[1].trim().split(/\s+/);
    if (cols.length < 5) {
      return { total: "-", used: "-", avail: "-", percent: "-" };
    }
    const total = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    const avail = Number(cols[3]) * 1024;
    const percent = cols[4];
    return {
      total: formatBytes(total),
      used: formatBytes(used),
      avail: formatBytes(avail),
      percent
    };
  } catch {
    return { total: "-", used: "-", avail: "-", percent: "-" };
  }
}

async function getPidUsage(pid) {
  try {
    const { stdout } = await runShell(`ps -p ${Number(pid)} -o %cpu=,%mem=,rss=,etime=,comm=`);
    const line = stdout.trim();
    if (!line) return null;
    const [cpu, mem, rssKb, etime, ...cmdParts] = line.split(/\s+/);
    const command = cmdParts.join(" ") || "-";
    return {
      cpu: cpu || "-",
      mem: mem || "-",
      rss: formatBytes((Number(rssKb) || 0) * 1024),
      etime: etime || "-",
      command
    };
  } catch {
    return null;
  }
}

async function buildVpsInfoText() {
  const hostname = os.hostname();
  const cpus = os.cpus();
  const cpuModel = cpus && cpus[0] ? cpus[0].model : "-";
  const cpuCount = cpus ? cpus.length : 0;
  const load = os.loadavg().map((n) => n.toFixed(2)).join(" / ");
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : "-";
  const disk = await getDiskUsage();
  const apps = db.getApps();
  const appNames = Object.keys(apps).sort();
  const runningApps = [];

  for (const name of appNames) {
    const app = apps[name];
    const runtime = app.runtime || {};
    if (runtime.status === "running" && runtime.pid) {
      runningApps.push({ name, pid: runtime.pid });
    }
  }

  const usageRows = await Promise.all(
    runningApps.map(async ({ name, pid }) => {
      const usage = await getPidUsage(pid);
      if (!usage) {
        return `- ${escapeHtml(name)} (pid ${escapeHtml(String(pid))}) - usage tidak tersedia`;
      }
      return `- ${escapeHtml(name)} (pid ${escapeHtml(String(pid))}) | CPU ${escapeHtml(usage.cpu)}% | MEM ${escapeHtml(usage.mem)}% | RSS ${escapeHtml(usage.rss)} | ET ${escapeHtml(usage.etime)}`;
    })
  );

  const lines = [
    "<b>💻 VPS Spec & Usage</b>",
    "<blockquote>",
    `<b>Host:</b> ${escapeHtml(hostname)}`,
    `<b>OS:</b> ${escapeHtml(`${os.platform()} ${os.release()} (${os.arch()})`)}`,
    `<b>Node:</b> ${escapeHtml(process.version)}`,
    `<b>Uptime:</b> ${escapeHtml(formatUptime(os.uptime()))}`,
    "</blockquote>",
    "",
    `<b>⚙️ CPU</b>`,
    "<blockquote>",
    `<b>Cores:</b> ${escapeHtml(String(cpuCount))}`,
    `<b>Model:</b> ${escapeHtml(cpuModel)}`,
    `<b>Load Avg (1m/5m/15m):</b> ${escapeHtml(load)}`,
    "</blockquote>",
    "",
    "<b>🧠 Memory</b>",
    "<blockquote>",
    `<b>Used:</b> ${escapeHtml(formatBytes(usedMem))} / ${escapeHtml(formatBytes(totalMem))} (${escapeHtml(memPct)}%)`,
    `<b>Free:</b> ${escapeHtml(formatBytes(freeMem))}`,
    "</blockquote>",
    "",
    "<b>💾 Disk (/)</b>",
    "<blockquote>",
    `<b>Used:</b> ${escapeHtml(disk.used)} / ${escapeHtml(disk.total)} (${escapeHtml(disk.percent)})`,
    `<b>Free:</b> ${escapeHtml(disk.avail)}`,
    "</blockquote>",
    "",
    `<b>📦 Managed Apps</b>`,
    "<blockquote>",
    `<b>Total:</b> ${escapeHtml(String(appNames.length))}`,
    `<b>Running:</b> ${escapeHtml(String(runningApps.length))}`,
    "</blockquote>"
  ];

  if (usageRows.length > 0) {
    lines.push("", "<b>📈 Running App Usage</b>", "<blockquote>", ...usageRows, "</blockquote>");
  }

  return lines.join("\n");
}

function makeNewApp({ name, repo, branch }) {
  const now = nowIso();
  return {
    name,
    repo,
    branch,
    directory: path.join(DEPLOYMENTS_DIR, name),
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

async function replyError(ctx, err) {
  const msg = err instanceof Error ? err.message : String(err);
  await ctx.reply(`Error: ${msg}`);
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

function panelText(state) {
  const synced = syncPanelStateWithApps(state);
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
    lines.push(
      `📱 <b>Menu Aplikasi: ${escapeHtml(selectedName)}</b>`,
      "<blockquote>",
      `<b>Status:</b> ${escapeHtml(runtime.status || "stopped")}`,
      `<b>PID:</b> ${escapeHtml(String(runtime.pid || "-"))}`,
      `<b>Branch:</b> ${escapeHtml(selectedApp.branch || "-")}`,
      `<b>Repo:</b> <pre>${escapeHtml(selectedApp.repo || "-")}</pre>`,
      `<b>Deploy Terakhir:</b> ${escapeHtml(selectedApp.lastDeployAt || "-")}`,
      "</blockquote>"
    );
  } else if (view === "settings" && selectedApp) {
    const runtime = selectedApp.runtime || {};
    lines.push(
      `⚙️ <b>Menu Pengaturan: ${escapeHtml(selectedName)}</b>`,
      `Status saat ini: <b>${escapeHtml(runtime.status || "stopped")}</b>`,
      "",
      "<b>Konfigurasi Aktif:</b>",
      "<blockquote>",
      `<b>cmd install:</b> <pre>${escapeHtml(selectedApp.installCommand || "npm install")}</pre>`,
      `<b>cmd build:</b> <pre>${escapeHtml(selectedApp.buildCommand || "-")}</pre>`,
      `<b>cmd start:</b> <pre>${escapeHtml(selectedApp.startCommand || "npm start")}</pre>`,
      "</blockquote>"
    );
  }

  if (synced.output && synced.output.trim()) {
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

  return lines.join("\n");
}

function panelKeyboard(state) {
  const synced = syncPanelStateWithApps(state);
  const apps = db.getApps();
  const names = Object.keys(apps).sort();
  const view = synced.view;
  const rows = [];

  if (view === "main") {
    rows.push([
      { text: "🔄 Refresh", callback_data: "panel:refresh" },
      { text: "🖥️ VPS Info", callback_data: "panel:vps" },
      { text: "➕ Add App", callback_data: "panel:addapp:start" }
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
      { text: "🤖 Update Bot", callback_data: "panel:bot:update" },
      { text: "⚡ Restart Bot", callback_data: "panel:bot:restart" }
    ]);
  } else if (view === "app" && synced.selectedApp) {
    if (synced.confirmRemove) {
      rows.push([
        { text: "⚠️ Hapus DB Saja", callback_data: "panel:run:rmkeep" },
        { text: "⚠️ Hapus DB & File", callback_data: "panel:run:rmfiles" }
      ]);
      rows.push([{ text: "Batal Hapus ✖️", callback_data: "panel:run:rmcancel" }]);
    } else {
      rows.push([
        { text: "🟢 Start", callback_data: "panel:run:start" },
        { text: "🔴 Stop", callback_data: "panel:run:stop" },
        { text: "🔄 Restart", callback_data: "panel:run:restart" }
      ]);
      rows.push([
        { text: "🚀 Deploy", callback_data: "panel:run:deploy" },
        { text: "📦 Update", callback_data: "panel:run:update" }
      ]);
      rows.push([
        { text: "📋 Logs 80", callback_data: "panel:run:log80" },
        { text: "📋 Logs 200", callback_data: "panel:run:log200" },
        { text: "⚙️ Settings", callback_data: "panel:nav:settings" }
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
      { text: "🔙 Kembali ke App", callback_data: "panel:nav:app" }
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

async function answerCallback(ctx, text = "") {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCbQuery(text);
  } catch {
    // Ignore callback query answer errors
  }
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

async function renderPanel(ctx, patch = {}) {
  const chatId = getChatIdFromCtx(ctx);
  if (!chatId) {
    await ctx.reply("Tidak bisa membaca chat ID untuk panel.");
    return;
  }
  const state = setPanelState(chatId, patch);
  await editOrReply(ctx, panelText(state), panelKeyboard(state));
}

function selectedAppFromState(chatId) {
  const state = setPanelState(chatId);
  const name = state.selectedApp;
  if (!name) return null;
  const app = db.getApp(name);
  if (!app) return null;
  return { name, app };
}

async function showVarsMessage(ctx, name) {
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

async function showLogsMessage(ctx, name, lineArg = 80) {
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

async function removeAppInternal(name, { deleteFiles = false, force = false } = {}) {
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

bot.use(adminOnly);

bot.on("text", async (ctx, next) => {
  const chatId = getChatIdFromCtx(ctx);
  if (!chatId) return next();

  const stateInfo = chatInputState.get(chatId);
  if (!stateInfo) return next();

  const text = ctx.message.text.trim();
  const { step, data, originalMessageId } = stateInfo;

  try {
    // We handle routing inside the state check
    if (step === "ADDAPP_NAME") {
      if (!appNameValid(text)) {
        await ctx.reply("Nama app hanya boleh huruf, angka, underscore, dash. Coba lagi atau tekan Cancel ❌.");
        return;
      }
      if (text.length > 32) {
        await ctx.reply("Nama app maksimal 32 karakter. Coba lagi atau tekan Cancel ❌.");
        return;
      }
      if (db.getApp(text)) {
        await ctx.reply(`App "${text}" sudah ada. Ketik nama lain atau Cancel ❌.`);
        return;
      }
      data.name = text;
      chatInputState.set(chatId, { step: "ADDAPP_REPO", data, originalMessageId });
      await ctx.reply(`Sip, nama app:\n<blockquote><b>${escapeHtml(text)}</b></blockquote>\nSekarang balas dengan <b>Repo URL</b> (contoh: https://github.com/user/repo.git):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
      return;
    }

    if (step === "ADDAPP_REPO") {
      if (!repoUrlValid(text)) {
        await ctx.reply("Repo URL tidak valid. Coba ulangi kirim link repo yang benar atau Cancel ❌.");
        return;
      }
      data.repo = text;
      chatInputState.set(chatId, { step: "ADDAPP_BRANCH", data, originalMessageId });
      await ctx.reply(`Repo URL:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>\nSekarang balas dengan <b>Branch</b> (contoh: main):`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
      return;
    }

    if (step === "ADDAPP_BRANCH") {
      if (!text.match(/^[A-Za-z0-9._/-]+$/)) {
        await ctx.reply("Branch tidak valid. Coba ulangi atau Cancel ❌.");
        return;
      }
      data.branch = text;
      const app = makeNewApp({ name: data.name, repo: data.repo, branch: data.branch });
      await db.upsertApp(data.name, app);
      chatInputState.delete(chatId);

      const msg = [
        `✅ App <b>${escapeHtml(data.name)}</b> berhasil ditambahkan!`,
        "<blockquote>",
        `<b>Repo:</b> <pre>${escapeHtml(data.repo)}</pre>`,
        `<b>Branch:</b> ${escapeHtml(data.branch)}`,
        "</blockquote>"
      ].join("\n");

      await ctx.reply(msg, { parse_mode: "HTML" });
      setPanelState(chatId, { selectedApp: data.name, output: msg, outputIsHtml: true });
      if (originalMessageId) {
        try {
          // Attempt to refresh the panel inline
          ctx.callbackQuery = { message: { message_id: originalMessageId } };
          await renderPanel(ctx);
        } catch { /* ignore */ }
      }
      return;
    }

    // Edit Repo
    if (step === "EDIT_REPO") {
      if (!repoUrlValid(text)) {
        await ctx.reply("Repo URL tidak valid. Coba ulangi atau Cancel ❌.");
        return;
      }
      await db.upsertApp(data.name, (existing) => ({
        ...existing,
        repo: text,
        updatedAt: nowIso()
      }));
      chatInputState.delete(chatId);
      const output = `✅ Repo app <b>${escapeHtml(data.name)}</b> diupdate ke:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

    // Edit Branch
    if (step === "EDIT_BRANCH") {
      if (!text.match(/^[A-Za-z0-9._/-]+$/)) {
        await ctx.reply("Branch tidak valid. Coba ulangi atau Cancel ❌.");
        return;
      }
      await db.upsertApp(data.name, (existing) => ({
        ...existing,
        branch: text,
        updatedAt: nowIso()
      }));
      chatInputState.delete(chatId);
      const output = `✅ Branch app <b>${escapeHtml(data.name)}</b> diupdate ke "${escapeHtml(text)}".`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

    // Edit Commands
    if (step.startsWith("EDIT_CMD_")) {
      const type = step.split("_")[2]; // INSTALL, BUILD, START
      let key = "";
      if (type === "INSTALL") key = "installCommand";
      if (type === "BUILD") key = "buildCommand";
      if (type === "START") key = "startCommand";

      await db.upsertApp(data.name, (existing) => ({
        ...existing,
        [key]: text,
        updatedAt: nowIso()
      }));
      chatInputState.delete(chatId);
      const output = `✅ Command ${type.toLowerCase()} untuk "<b>${escapeHtml(data.name)}</b>" diupdate:\n<blockquote><pre>${escapeHtml(text)}</pre></blockquote>`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

    // Set Env Var Step 1 (Key)
    if (step === "SET_ENV_KEY") {
      const key = text.trim();
      if (!key.match(/^[A-Za-z0-9_]+$/)) {
        await ctx.reply("Key env var hanya boleh huruf, angka, underscore. Coba lagi atau Cancel ❌.");
        return;
      }
      data.key = key;
      chatInputState.set(chatId, { step: "SET_ENV_VAL", data, originalMessageId });
      await ctx.reply(`ℹ️ Key Environment Variable:\n<blockquote><b>${escapeHtml(key)}</b></blockquote>\nSekarang balas dengan <b>Value</b>-nya:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
      return;
    }

    // Set Env Var Step 2 (Value)
    if (step === "SET_ENV_VAL") {
      const value = text;
      await db.upsertApp(data.name, (existing) => ({
        ...existing,
        env: { ...(existing.env || {}), [data.key]: value },
        updatedAt: nowIso()
      }));
      chatInputState.delete(chatId);
      const output = `✅ Env var diset untuk <b>${escapeHtml(data.name)}</b>:\n<blockquote><pre>${escapeHtml(data.key)}=${escapeHtml(value)}</pre></blockquote>`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

    // Import Env (.env format)
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
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key) {
            imported[key] = val;
            count++;
          }
        }
      }

      await db.upsertApp(data.name, (existing) => ({
        ...existing,
        env: { ...(existing.env || {}), ...imported },
        updatedAt: nowIso()
      }));

      chatInputState.delete(chatId);
      const output = `✅ <b>${count}</b> env var(s) diimpor untuk <b>${escapeHtml(data.name)}</b>.`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

    // Delete Env Var
    if (step === "DEL_ENV") {
      const key = text.trim();
      await db.upsertApp(data.name, (existing) => {
        const env = { ...(existing.env || {}) };
        delete env[key];
        return {
          ...existing,
          env,
          updatedAt: nowIso()
        };
      });
      chatInputState.delete(chatId);
      const output = `✅ Env var dihapus: ${escapeHtml(data.name)} -> <code>${escapeHtml(key)}</code>`;
      await ctx.reply(output, { parse_mode: "HTML" });
      setPanelState(chatId, { output, outputIsHtml: true });
      if (originalMessageId) { try { ctx.callbackQuery = { message: { message_id: originalMessageId } }; await renderPanel(ctx); } catch { } }
      return;
    }

  } catch (err) {
    chatInputState.delete(chatId);
    await replyError(ctx, err);
  }
});

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
  await renderPanel(ctx, {
    output: "",
    outputIsHtml: false,
    confirmRemove: false
  });
});

bot.command("vps", async (ctx) => {
  const text = await buildVpsInfoText();
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("apps", async (ctx) => {
  const apps = db.getApps();
  const names = Object.keys(apps);
  if (names.length === 0) {
    await ctx.reply("Belum ada app. Tambahkan dengan /addapp atau buka /panel.");
    return;
  }

  const lines = names.map((name) => appSummary(name, apps[name]));
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
    if (names.length === 0) {
      await ctx.reply("Belum ada app.");
      return;
    }

    const lines = names.map((appName) => {
      const app = db.getApp(appName);
      const runtime = app.runtime || {};
      return `${appName}: ${runtime.status || "stopped"} (pid: ${runtime.pid || "-"})`;
    });
    await ctx.reply(lines.join("\n"));
    return;
  }

  const app = db.getApp(name);
  if (!app) {
    await ctx.reply(`App "${name}" tidak ditemukan.`);
    return;
  }

  const runtime = app.runtime || {};
  const text = [
    `nama: ${name}`,
    `status: ${runtime.status || "stopped"}`,
    `pid: ${runtime.pid || "-"}`,
    `repo: ${app.repo}`,
    `branch: ${app.branch}`,
    `directory: ${app.directory}`,
    `install: ${app.installCommand || "-"}`,
    `build: ${app.buildCommand || "-"}`,
    `start: ${app.startCommand || "-"}`,
    `lastDeployAt: ${app.lastDeployAt || "-"}`,
    `lastStartAt: ${runtime.lastStartAt || "-"}`,
    `lastStopAt: ${runtime.lastStopAt || "-"}`,
    `lastExitCode: ${runtime.lastExitCode ?? "-"}`
  ].join("\n");
  await ctx.reply(text);
});

bot.command("addapp", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, repo, branchArg] = args;
    const branch = branchArg || "main";

    if (!name || !repo) {
      await ctx.reply("Format: /addapp <nama> <repo_url> [branch]");
      return;
    }

    if (!appNameValid(name)) {
      await ctx.reply("Nama app hanya boleh huruf, angka, underscore, dash.");
      return;
    }

    if (name.length > 32) {
      await ctx.reply("Nama app maksimal 32 karakter.");
      return;
    }

    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
      await ctx.reply("Branch tidak valid.");
      return;
    }

    if (!repoUrlValid(repo)) {
      await ctx.reply("Repo URL tidak valid.");
      return;
    }

    if (db.getApp(name)) {
      await ctx.reply(`App "${name}" sudah ada.`);
      return;
    }

    const app = makeNewApp({ name, repo, branch });
    await db.upsertApp(name, app);

    await ctx.reply(
      [
        `App "${name}" ditambahkan.`,
        `Repo: ${repo}`,
        `Branch: ${branch}`,
        "",
        "Opsional set command custom:",
        `/setcmd ${name} install "npm ci"`,
        `/setcmd ${name} build "npm run build"`,
        `/setcmd ${name} start "npm run start"`,
        "",
        `Lanjut deploy: /deploy ${name}`
      ].join("\n")
    );
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("setrepo", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, repo] = args;
    if (!name || !repo) {
      await ctx.reply("Format: /setrepo <nama> <repo_url>");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    if (!repoUrlValid(repo)) {
      await ctx.reply("Repo URL tidak valid.");
      return;
    }

    await db.upsertApp(name, (existing) => ({
      ...existing,
      repo,
      updatedAt: nowIso()
    }));
    await ctx.reply(`Repo app "${name}" diupdate ke:\n${repo}`);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("setbranch", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, branch] = args;
    if (!name || !branch) {
      await ctx.reply("Format: /setbranch <nama> <branch>");
      return;
    }

    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
      await ctx.reply("Branch tidak valid.");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    await db.upsertApp(name, (existing) => ({
      ...existing,
      branch,
      updatedAt: nowIso()
    }));
    await ctx.reply(`Branch app "${name}" diupdate ke "${branch}".`);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("setcmd", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, type, ...rest] = args;
    if (!name || !type || rest.length === 0) {
      await ctx.reply("Format: /setcmd <nama> <start|install|build> <command...>");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    const command = rest.join(" ").trim();
    let key = "";
    if (type === "start") key = "startCommand";
    if (type === "install") key = "installCommand";
    if (type === "build") key = "buildCommand";
    if (!key) {
      await ctx.reply("Type harus salah satu: start, install, build");
      return;
    }

    await db.upsertApp(name, (existing) => ({
      ...existing,
      [key]: command,
      updatedAt: nowIso()
    }));
    await ctx.reply(`Command ${type} untuk "${name}" diupdate:\n${command}`);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("setvar", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, key, ...valueParts] = args;
    if (!name || !key || valueParts.length === 0) {
      await ctx.reply("Format: /setvar <nama> <KEY> <VALUE...>");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    const value = valueParts.join(" ");
    await db.upsertApp(name, (existing) => ({
      ...existing,
      env: { ...(existing.env || {}), [key]: value },
      updatedAt: nowIso()
    }));
    await ctx.reply(`Env var diset: ${name} -> ${key}=${value}`);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("delvar", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, key] = args;
    if (!name || !key) {
      await ctx.reply("Format: /delvar <nama> <KEY>");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    await db.upsertApp(name, (existing) => {
      const env = { ...(existing.env || {}) };
      delete env[key];
      return {
        ...existing,
        env,
        updatedAt: nowIso()
      };
    });
    await ctx.reply(`Env var dihapus: ${name} -> ${key}`);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("vars", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name] = args;
    if (!name) {
      await ctx.reply("Format: /vars <nama>");
      return;
    }
    await showVarsMessage(ctx, name);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("deploy", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, flag] = args;
    const restartAfter = flag === "--restart";
    if (!name) {
      await ctx.reply("Format: /deploy <nama> [--restart]");
      return;
    }

    await withAppLock(name, async () => {
      const app = db.getApp(name);
      if (!app) {
        await ctx.reply(`App "${name}" tidak ditemukan.`);
        return;
      }

      await ctx.reply(`Deploy "${name}" dimulai...`);
      const summary = await deployer.deploy(name);
      if (restartAfter) {
        const pid = await processManager.restart(name);
        await ctx.reply(
          [
            `Deploy selesai dan app direstart.`,
            `PID baru: ${pid}`,
            "",
            `Repo: ${summary.repository}`
          ].join("\n")
        );
        return;
      }

      await ctx.reply(
        [
          `Deploy "${name}" selesai.`,
          `Repo: ${summary.repository}`,
          "",
          "Jika app belum jalan, gunakan /start <nama>."
        ].join("\n")
      );
    });
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("update", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name] = args;
    if (!name) {
      await ctx.reply("Format: /update <nama>");
      return;
    }

    await withAppLock(name, async () => {
      const app = db.getApp(name);
      if (!app) {
        await ctx.reply(`App "${name}" tidak ditemukan.`);
        return;
      }

      const runtime = app.runtime || {};
      const wasRunning = runtime.status === "running" && runtime.pid;
      await ctx.reply(`Update "${name}" dimulai...`);

      if (wasRunning) {
        await processManager.stop(name);
      }

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
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("start", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name] = args;
    if (!name) {
      await ctx.reply("Format: /start <nama>");
      return;
    }

    await withAppLock(name, async () => {
      const pid = await processManager.start(name);
      await ctx.reply(`App "${name}" jalan. PID: ${pid}`);
    });
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("stop", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name] = args;
    if (!name) {
      await ctx.reply("Format: /stop <nama>");
      return;
    }

    await withAppLock(name, async () => {
      const result = await processManager.stop(name);
      if (result.alreadyStopped) {
        await ctx.reply(`App "${name}" sudah berhenti.`);
      } else {
        await ctx.reply(`App "${name}" dihentikan.`);
      }
    });
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("restart", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name] = args;
    if (!name) {
      await ctx.reply("Format: /restart <nama>");
      return;
    }

    await withAppLock(name, async () => {
      const pid = await processManager.restart(name);
      await ctx.reply(`App "${name}" restart sukses. PID: ${pid}`);
    });
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("logs", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, lineArg] = args;
    if (!name) {
      await ctx.reply("Format: /logs <nama> [lines]");
      return;
    }
    await showLogsMessage(ctx, name, lineArg);
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("run", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, ...cmdParts] = args;
    if (!name || cmdParts.length === 0) {
      await ctx.reply("Format: /run <nama> <command...>");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    if (!fs.existsSync(app.directory)) {
      await ctx.reply(`Folder app belum ada: ${app.directory}`);
      return;
    }

    const command = cmdParts.join(" ");
    await ctx.reply(`Menjalankan command di "${name}"...\n${command}`);
    const result = await runShell(command, { cwd: app.directory });
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    await ctx.reply(clip(combined || "(tidak ada output)", 3500));
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.command("removeapp", async (ctx) => {
  try {
    const args = parseCommandArgs(ctx);
    const [name, ...flags] = args;
    if (!name) {
      await ctx.reply("Format: /removeapp <nama> [--delete-files] [--force]");
      return;
    }

    const app = db.getApp(name);
    if (!app) {
      await ctx.reply(`App "${name}" tidak ditemukan.`);
      return;
    }

    const deleteFiles = flags.includes("--delete-files");
    const force = flags.includes("--force");

    await withAppLock(name, async () => {
      await removeAppInternal(name, { deleteFiles, force });
      await ctx.reply(
        [
          `App "${name}" dihapus dari database.`,
          deleteFiles ? "File deployment + log juga dihapus." : "File deployment tidak dihapus."
        ].join("\n")
      );
    });
  } catch (err) {
    await replyError(ctx, err);
  }
});

bot.action("panel:home", async (ctx) => {
  await answerCallback(ctx);
  await renderPanel(ctx, { confirmRemove: false, view: "main", selectedApp: null, output: "", outputIsHtml: false });
});

bot.action("panel:refresh", async (ctx) => {
  await answerCallback(ctx, "Refreshed");
  await renderPanel(ctx, { confirmRemove: false });
});

bot.action("panel:clear", async (ctx) => {
  await answerCallback(ctx, "Output cleared");
  await renderPanel(ctx, {
    output: "",
    outputIsHtml: false,
    confirmRemove: false
  });
});

bot.action("panel:vps", async (ctx) => {
  await answerCallback(ctx, "Loading VPS info...");
  const info = await buildVpsInfoText();
  await renderPanel(ctx, {
    output: info,
    outputIsHtml: true,
    confirmRemove: false
  });
});

bot.action("panel:cancel_input", async (ctx) => {
  const chatId = getChatIdFromCtx(ctx);
  if (chatId) {
    chatInputState.delete(chatId);
  }
  await answerCallback(ctx, "Input dibatalkan.");
  await ctx.editMessageText("Membatalkan input. Silakan kembali ke panel.");
});

bot.action("panel:addapp:start", async (ctx) => {
  await answerCallback(ctx);
  const chatId = getChatIdFromCtx(ctx);
  if (!chatId) return;
  chatInputState.set(chatId, { step: "ADDAPP_NAME", data: {}, originalMessageId: ctx.callbackQuery.message?.message_id });
  const text = "Ayo tambahkan app baru!\n\nBalas pesan ini dengan <b>Nama App</b> (huruf, angka, strip, tanpa spasi):";
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
});

bot.action(/^panel:edit:(repo|branch|cmd:install|cmd:build|cmd:start|setvar|delvar|importenv)$/, async (ctx) => {
  const action = ctx.match[1];
  const chatId = getChatIdFromCtx(ctx);
  if (!chatId) return;

  const selected = selectedAppFromState(chatId);
  if (!selected) {
    await answerCallback(ctx, "Pilih app dulu");
    return;
  }

  await answerCallback(ctx);
  const appName = selected.name;
  let nextStep = "";
  let promptText = "";

  if (action === "repo") {
    nextStep = "EDIT_REPO";
    promptText = `Mengubah Repo untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan Repo URL baru:`;
  } else if (action === "branch") {
    nextStep = "EDIT_BRANCH";
    promptText = `Mengubah Branch untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan nama Branch baru:`;
  } else if (action.startsWith("cmd:")) {
    const type = action.split(":")[1].toUpperCase(); // INSTALL, BUILD, START
    nextStep = `EDIT_CMD_${type}`;
    promptText = `Mengubah Command ${type} untuk <b>${escapeHtml(appName)}</b>.\nBalas dengan command baru:\n<blockquote><pre>npm install</pre></blockquote>`;
  } else if (action === "setvar") {
    nextStep = "SET_ENV_KEY";
    promptText = `Menambah/ubah Environment Variable untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan <b>KEY</b> env var:\n<blockquote><pre>PORT</pre></blockquote>`;
  } else if (action === "delvar") {
    nextStep = "DEL_ENV";
    promptText = `Menghapus Environment Variable untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan <b>KEY</b> env var yang ingin dihapus:`;
  } else if (action === "importenv") {
    nextStep = "IMPORT_ENV";
    promptText = `Mengimpor .env untuk <b>${escapeHtml(appName)}</b>.\nBalas pesan ini dengan teks atau isi dari file <b>.env</b>:\n<blockquote><pre>PORT=8080\nNODE_ENV=production\nTOKEN="abc 123"</pre></blockquote>`;
  }

  if (nextStep) {
    chatInputState.set(chatId, { step: nextStep, data: { name: appName }, originalMessageId: ctx.callbackQuery.message?.message_id });
    await ctx.reply(promptText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Cancel ❌", callback_data: "panel:cancel_input" }]] } });
  }
});

bot.action(/^panel:sel:(.+)$/, async (ctx) => {
  const appName = parseCallbackAppName(ctx.match[1]);
  await answerCallback(ctx);
  await renderPanel(ctx, {
    view: "app",
    selectedApp: appName,
    confirmRemove: false,
    output: "",
    outputIsHtml: false
  });
});

// Backward compatibility for old panel messages
bot.action(/^panel:app:(.+)$/, async (ctx) => {
  const appName = parseCallbackAppName(ctx.match[1]);
  await answerCallback(ctx);
  await renderPanel(ctx, {
    view: "app",
    selectedApp: appName,
    confirmRemove: false,
    output: "",
    outputIsHtml: false
  });
});

bot.action(/^panel:nav:(main|app|settings)$/, async (ctx) => {
  const targetView = ctx.match[1];
  await answerCallback(ctx);

  const patch = {
    view: targetView,
    confirmRemove: false,
    output: "",
    outputIsHtml: false
  };

  if (targetView === "main") {
    patch.selectedApp = null;
  }

  await renderPanel(ctx, patch);
});

bot.action(
  /^panel:run:(status|vars|log80|log200|start|stop|restart|deploy|deployr|update|remove|rmkeep|rmfiles|rmcancel)$/,
  async (ctx) => {
    const action = ctx.match[1];
    try {
      const chatId = getChatIdFromCtx(ctx);
      if (!chatId) {
        await answerCallback(ctx, "Chat tidak valid");
        return;
      }

      const selected = selectedAppFromState(chatId);
      if (!selected) {
        await answerCallback(ctx, "Belum ada app");
        await renderPanel(ctx, {
          output: [
            "<b>Belum ada app</b>",
            "Tambahkan app dulu dengan:",
            "<code>/addapp namabot https://github.com/user/repo.git main</code>"
          ].join("\n"),
          outputIsHtml: true
        });
        return;
      }

      const appName = selected.name;

      if (action === "status") {
        await answerCallback(ctx, "Status updated");
        const app = db.getApp(appName);
        const runtime = (app && app.runtime) || {};
        const statusText = [
          `App: ${appName}`,
          `status: ${runtime.status || "stopped"}`,
          `pid: ${runtime.pid || "-"}`,
          `lastStartAt: ${runtime.lastStartAt || "-"}`,
          `lastStopAt: ${runtime.lastStopAt || "-"}`,
          `lastExitCode: ${runtime.lastExitCode ?? "-"}`
        ].join("\n");
        await renderPanel(ctx, {
          output: statusText,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "vars") {
        await answerCallback(ctx);
        const app = db.getApp(appName);
        const entries = Object.entries((app && app.env) || {});
        const text = entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join("\n") : "Belum ada env var.";
        await renderPanel(ctx, {
          output: `App: ${appName}\n${text}`,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "log80" || action === "log200") {
        await answerCallback(ctx, "Loading logs...");
        const lines = action === "log200" ? 200 : 80;
        const logs = processManager.readLogs(appName, lines);
        const text = [
          `App: ${appName}`,
          `stdout (${lines} lines):`,
          logs.out || "(kosong)",
          "",
          `stderr (${lines} lines):`,
          logs.err || "(kosong)"
        ].join("\n");
        await renderPanel(ctx, {
          output: clip(text, 2600),
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "remove") {
        await answerCallback(ctx);
        await renderPanel(ctx, {
          confirmRemove: true,
          output: `Konfirmasi hapus app "${appName}". Pilih tombol confirm di bawah.`,
          outputIsHtml: false
        });
        return;
      }

      if (action === "rmcancel") {
        await answerCallback(ctx, "Batal hapus");
        await renderPanel(ctx, {
          confirmRemove: false,
          output: `Batal hapus app "${appName}".`,
          outputIsHtml: false
        });
        return;
      }

      if (action === "rmkeep" || action === "rmfiles") {
        await answerCallback(ctx, "Menghapus app...");
        const deleteFiles = action === "rmfiles";
        await withAppLock(appName, async () => {
          await removeAppInternal(appName, { deleteFiles, force: true });
        });
        await renderPanel(ctx, {
          selectedApp: null,
          confirmRemove: false,
          output: `App "${appName}" dihapus.${deleteFiles ? " File deployment + logs ikut dihapus." : ""}`,
          outputIsHtml: false
        });
        return;
      }

      if (action === "start") {
        await answerCallback(ctx, "Start diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const pid = await processManager.start(appName);
          output = `App "${appName}" jalan. PID: ${pid}`;
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "stop") {
        await answerCallback(ctx, "Stop diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const result = await processManager.stop(appName);
          output = result.alreadyStopped ? `App "${appName}" sudah berhenti.` : `App "${appName}" dihentikan.`;
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "restart") {
        await answerCallback(ctx, "Restart diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const pid = await processManager.restart(appName);
          output = `App "${appName}" restart sukses. PID: ${pid}`;
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "deploy") {
        await answerCallback(ctx, "Deploy diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const summary = await deployer.deploy(appName);
          const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
          output = [`Deploy "${appName}" selesai.`, detail ? clip(detail, 2200) : ""].filter(Boolean).join("\n\n");
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "deployr") {
        await answerCallback(ctx, "Deploy + restart diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const summary = await deployer.deploy(appName);
          const pid = await processManager.restart(appName);
          const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
          output = [
            `Deploy + restart "${appName}" selesai. PID baru: ${pid}`,
            detail ? clip(detail, 2200) : ""
          ].filter(Boolean).join("\n\n");
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      if (action === "update") {
        await answerCallback(ctx, "Update diproses...");
        let output = "";
        await withAppLock(appName, async () => {
          const app = db.getApp(appName);
          if (!app) {
            throw new Error(`App "${appName}" tidak ditemukan.`);
          }
          const runtime = app.runtime || {};
          const wasRunning = runtime.status === "running" && runtime.pid;
          if (wasRunning) {
            await processManager.stop(appName);
          }
          const summary = await deployer.deploy(appName, { updateOnly: true });
          let runMessage = "App tetap dalam kondisi stop (status awal tidak running).";
          if (wasRunning) {
            const pid = await processManager.start(appName);
            runMessage = `App dijalankan kembali. PID: ${pid}`;
          }
          const detail = [summary.repository, summary.install, summary.build].filter(Boolean).join("\n\n");
          output = [`Update "${appName}" selesai.`, runMessage, detail ? clip(detail, 2000) : ""]
            .filter(Boolean)
            .join("\n\n");
        });
        await renderPanel(ctx, {
          output,
          outputIsHtml: false,
          confirmRemove: false
        });
        return;
      }

      await answerCallback(ctx, "Aksi tidak dikenal");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await answerCallback(ctx, "Gagal");
      await renderPanel(ctx, {
        output: `Error: ${msg}`,
        outputIsHtml: false,
        confirmRemove: false
      });
    }
  }
);

bot.action("panel:bot:update", async (ctx) => {
  await answerCallback(ctx, "Updating bot...");
  try {
    const pullProcess = await runShell("git pull origin main", { cwd: ROOT_DIR });
    const installProcess = await runShell("npm install", { cwd: ROOT_DIR });

    const output = [
      "<b>Bot Update Status</b>",
      "<u>Git Pull:</u>",
      `<pre>${escapeHtml(clip(pullProcess.stdout + pullProcess.stderr, 1000))}</pre>`,
      "<u>NPM Install:</u>",
      `<pre>${escapeHtml(clip(installProcess.stdout + installProcess.stderr, 1000))}</pre>`,
      "",
      "Disarankan menekan <b>Restart Bot</b> setelah update bila ada pembaruan."
    ].join("\n");

    await renderPanel(ctx, {
      output,
      outputIsHtml: true,
      confirmRemove: false
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await renderPanel(ctx, {
      output: `Gagal menjalankan update bot: ${escapeHtml(msg)}`,
      outputIsHtml: true,
      confirmRemove: false
    });
  }
});

bot.action("panel:bot:restart", async (ctx) => {
  await answerCallback(ctx, "Restarting bot...");
  await editOrReply(ctx, "<b>Bot is restarting...</b>\n\nJika anda menggunakan PM2 atau Systemd, bot akan aktif kembali sesaat lagi. Silakan /panel ulang.", { parse_mode: "HTML" });
  setTimeout(() => process.exit(0), 1000);
});

bot.catch(async (err, ctx) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error("[bot.catch]", msg);
  try {
    await ctx.reply(`Unhandled error: ${err.message || String(err)}`);
  } catch (inner) {
    console.error("[bot.catch.reply]", inner);
  }
});

async function main() {
  await processManager.recoverState();
  await bot.launch();
  console.log("Telegram control bot running...");
}

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
