const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function appNameValid(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function repoUrlValid(repo) {
  return /^[A-Za-z0-9:@._/\-~%+?=&]+$/.test(repo);
}

function splitArgs(rawText = "") {
  const parts = [];
  let current = "";
  let quote = null;
  let escape = false;

  for (const ch of rawText) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function parseCommandArgs(ctx) {
  const msg = ctx.message && typeof ctx.message.text === "string" ? ctx.message.text : "";
  const firstSpace = msg.indexOf(" ");
  if (firstSpace === -1) {
    return [];
  }
  const payload = msg.slice(firstSpace + 1).trim();
  return splitArgs(payload);
}

function normalizeLines(value, fallback = 80) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

function escapeHtml(text = "") {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function withinDir(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

module.exports = {
  ensureDir,
  nowIso,
  appNameValid,
  repoUrlValid,
  parseCommandArgs,
  normalizeLines,
  escapeHtml,
  withinDir
};
