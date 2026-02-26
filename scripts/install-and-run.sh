#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-and-run.sh [options]

Options:
  --bot-token <token>     Set BOT_TOKEN into .env
  --admin-ids <ids>       Set ADMIN_IDS into .env (comma-separated)
  --background            Run bot in background (nohup)
  -h, --help              Show this help

Examples:
  bash scripts/install-and-run.sh --bot-token "123:ABC" --admin-ids "123456789"
  bash scripts/install-and-run.sh --background
EOF
}

BOT_TOKEN_ARG=""
ADMIN_IDS_ARG=""
BACKGROUND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-token)
      BOT_TOKEN_ARG="${2:-}"
      shift 2
      ;;
    --admin-ids)
      ADMIN_IDS_ARG="${2:-}"
      shift 2
      ;;
    --background)
      BACKGROUND=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node tidak ditemukan. Install Node.js 18+ dulu." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm tidak ditemukan. Install npm dulu." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Error: Node.js minimal versi 18. Versi saat ini: $(node -v)" >&2
  exit 1
fi

mkdir -p data deployments logs .npm-cache

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print key "=" value
      }
    }
  ' .env >"$tmp_file"
  mv "$tmp_file" .env
}

if [[ -n "$BOT_TOKEN_ARG" ]]; then
  set_env_value "BOT_TOKEN" "$BOT_TOKEN_ARG"
fi

if [[ -n "$ADMIN_IDS_ARG" ]]; then
  set_env_value "ADMIN_IDS" "$ADMIN_IDS_ARG"
fi

BOT_TOKEN_VAL="$(awk -F= '/^BOT_TOKEN=/{sub(/^BOT_TOKEN=/, ""); print; exit}' .env)"
ADMIN_IDS_VAL="$(awk -F= '/^ADMIN_IDS=/{sub(/^ADMIN_IDS=/, ""); print; exit}' .env)"

if [[ -z "${BOT_TOKEN_VAL// }" ]]; then
  echo "Error: BOT_TOKEN kosong. Isi di .env atau pakai --bot-token." >&2
  exit 1
fi

if [[ -z "${ADMIN_IDS_VAL// }" ]]; then
  echo "Error: ADMIN_IDS kosong. Isi di .env atau pakai --admin-ids." >&2
  exit 1
fi

echo "Installing dependencies..."
npm install --cache ./.npm-cache

echo "Running syntax checks..."
npm run check

if [[ "$BACKGROUND" -eq 1 ]]; then
  echo "Starting bot in background..."
  nohup npm start >logs/control-bot.stdout.log 2>logs/control-bot.stderr.log </dev/null &
  BOT_PID="$!"
  echo "$BOT_PID" >data/control-bot.pid
  echo "Bot running in background. PID: $BOT_PID"
  echo "stdout log: logs/control-bot.stdout.log"
  echo "stderr log: logs/control-bot.stderr.log"
  exit 0
fi

echo "Starting bot in foreground..."
exec npm start
