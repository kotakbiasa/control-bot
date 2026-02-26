const fs = require("fs");
const path = require("path");
require("dotenv").config();
process.env.TZ = process.env.TZ || "Asia/Makassar";
const { Telegraf } = require("telegraf");
const { JsonDb } = require("./db");
const { Deployer } = require("./deployer");
const { ProcessManager } = require("./processManager");
const { Monitor } = require("./services/monitor");
const { WebhookServer } = require("./services/webhook");
const { ensureDir, escapeHtml, withinDir } = require("./utils");

// --- Directories ---
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const DEPLOYMENTS_DIR = path.join(ROOT_DIR, "deployments");
const LOGS_DIR = path.join(ROOT_DIR, "logs");

ensureDir(DATA_DIR);
ensureDir(DEPLOYMENTS_DIR);
ensureDir(LOGS_DIR);

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) { throw new Error("BOT_TOKEN wajib diisi di environment."); }
if (ADMIN_IDS.length === 0) { throw new Error("ADMIN_IDS wajib diisi, contoh: ADMIN_IDS=123456789,987654321"); }

// --- Core instances ---
const db = new JsonDb(DB_PATH);
const settings = db.getSettings();
if (settings.timezone) { process.env.TZ = settings.timezone; }

const processManager = new ProcessManager({ db, logsDir: LOGS_DIR });
const deployer = new Deployer({ db, deploymentsDir: DEPLOYMENTS_DIR });
const bot = new Telegraf(BOT_TOKEN);
const busyApps = new Set();
const chatInputState = new Map();

// --- Helpers ---
function isAdmin(id) {
  if (!id) return false;
  if (ADMIN_IDS.includes(id)) return true;
  const dbSettings = db.getSettings();
  if (dbSettings.admins && dbSettings.admins.includes(id)) return true;
  return false;
}

function adminOnly(ctx, next) {
  const fromId = ctx.from && ctx.from.id ? String(ctx.from.id) : "";
  if (!isAdmin(fromId)) {
    return ctx.reply("Akses ditolak. ID Telegram kamu bukan Admin.");
  }
  return next();
}

async function withAppLock(appName, fn) {
  if (busyApps.has(appName)) {
    throw new Error(`App "${appName}" sedang diproses. Coba lagi sebentar.`);
  }
  busyApps.add(appName);
  try { return await fn(); }
  finally { busyApps.delete(appName); }
}

// --- Crash alert with log streaming ---
processManager.on("crash", async (appName) => {
  // Read last 30 lines of logs for context
  const logs = processManager.readLogs(appName, 30);
  const logSnippet = [];
  if (logs.err && logs.err.trim()) {
    logSnippet.push("<b>stderr (last 30 lines):</b>", `<pre>${escapeHtml(logs.err.slice(-1500))}</pre>`);
  } else if (logs.out && logs.out.trim()) {
    logSnippet.push("<b>stdout (last 30 lines):</b>", `<pre>${escapeHtml(logs.out.slice(-1500))}</pre>`);
  }

  const msg = [
    `⚠️ <b>CRASH ALERT</b> ⚠️`,
    `App <b>${escapeHtml(appName)}</b> telah mati secara paksa atau berhenti karena error (crash)!`,
    "",
    ...logSnippet,
    "",
    'Silakan buka /panel dan periksa "Logs" untuk detail selengkapnya.'
  ].join("\n");

  const allAdmins = [...ADMIN_IDS];
  const dbSettings = db.getSettings();
  if (dbSettings.admins) { for (const id of dbSettings.admins) { if (!allAdmins.includes(id)) allAdmins.push(id); } }
  for (const adminId of allAdmins) {
    try { await bot.telegram.sendMessage(adminId, msg, { parse_mode: "HTML" }); }
    catch (err) { console.error(`Gagal mengirim crash alert ke admin ${adminId}:`, err); }
  }
});

// --- Monitor & Webhook ---
const monitor = new Monitor({ db, bot, ADMIN_IDS });

// --- Shared deps for all handlers ---
const deps = {
  db, bot, processManager, deployer, monitor,
  ADMIN_IDS, ROOT_DIR, DATA_DIR, DB_PATH, DEPLOYMENTS_DIR, LOGS_DIR,
  chatInputState, busyApps,
  isAdmin, withAppLock, withinDir
};

// Webhook needs deps for withAppLock etc, so init after deps
const webhookServer = new WebhookServer(deps);
deps.webhookServer = webhookServer;

// --- Middleware & Handlers ---
bot.use(adminOnly);

// Register all handlers
require("./handlers/inputFlow").register(bot, deps);
require("./handlers/commands").register(bot, deps);
require("./handlers/panelActions").register(bot, deps);
require("./handlers/appActions").register(bot, deps);
require("./handlers/botSettings").register(bot, deps);

// --- Error handler ---
bot.catch(async (err, ctx) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error("[bot.catch]", msg);
  try { await ctx.reply(`Unhandled error: ${err.message || String(err)}`); }
  catch (inner) { console.error("[bot.catch.reply]", inner); }
});

// --- Launch ---
async function main() {
  await processManager.recoverState();
  processManager.recoverScheduledCommands();
  await bot.launch();
  console.log("Telegram control bot running...");
}

process.once("SIGINT", () => { bot.stop("SIGINT"); });
process.once("SIGTERM", () => { bot.stop("SIGTERM"); });

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
