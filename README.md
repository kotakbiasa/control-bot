# Telegram Deploy Control Bot

Bot Telegram untuk deploy dan kontrol banyak app/bot di server tanpa login VPS manual.
Semua konfigurasi disimpan lokal di file JSON (`data/db.json`).

## Fitur

- Multi app management (bisa tambah beberapa app sekaligus)
- Inline control panel (tombol Telegram, bukan hanya command text)
- Telegram Mini App untuk kontrol via web + file manager
- Monitor spec & usage VPS (CPU, RAM, disk, uptime, usage app running)
- Deploy dari Git repo (clone/pull)
- Auto-detect runtime app: process biasa atau Dockerfile (`docker build` + `docker run`)
- Support app Python dengan virtual environment per app (`.venv`) untuk mode process
- Start, stop, restart proses app
- Update app (pull + install + build + restart jika sebelumnya running)
- Cek status dan PID proses
- Lihat logs `stdout` dan `stderr` langsung dari Telegram
- Kelola environment variable per app
- Jalankan command manual di folder app
- Simpan state runtime ke local JSON DB
- Akses dibatasi hanya untuk `ADMIN_IDS`

## Arsitektur Singkat

- `src/index.js`: command Telegram + orchestration
- `src/deployer.js`: logic clone/pull/install/build
- `src/processManager.js`: start/stop/restart/log/process state
- `src/db.js`: JSON database layer
- `data/db.json`: storage lokal
- `deployments/`: folder source code app yang dideploy
- `logs/`: file log per app (`*.out.log`, `*.err.log`)

## Persiapan

1. Install Node.js 18+.
2. Install dependency:
```bash
npm install
```
3. Buat `.env` dari contoh:
```bash
cp .env.example .env
```
4. Isi `.env`:
```env
BOT_TOKEN=isi_token_botfather
ADMIN_IDS=123456789,987654321
TZ=Asia/Makassar
WEB_PORT=9876
PUBLIC_BASE_URL=https://your-domain.example.com
```

## Menjalankan Bot

Pakai `dotenv` dari shell atau export manual env.

Contoh paling cepat:
```bash
export BOT_TOKEN="ISI_TOKEN"
export ADMIN_IDS="123456789"
npm start
```

Bot akan berjalan via long-polling.

## Menjalankan Dengan Docker

1. Siapkan `.env`:
```bash
cp .env.example .env
```
2. Isi minimal:
```env
BOT_TOKEN=isi_token_botfather
ADMIN_IDS=123456789,987654321
TZ=Asia/Makassar
WEB_PORT=9876
PUBLIC_BASE_URL=https://your-domain.example.com
```
3. Build + jalankan:
```bash
docker compose up -d --build
```
4. Cek log:
```bash
docker compose logs -f control-bot
```
5. Stop:
```bash
docker compose down
```

Data penting tetap persisten lewat volume:
- `./data -> /app/data`
- `./deployments -> /app/deployments`
- `./logs -> /app/logs`

Catatan:
- App yang kamu `deploy/start` dari bot akan dijalankan di dalam container ini.
- Untuk dukungan app Dockerfile dari dalam container bot, mount juga `docker.sock` host:
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```
- Port `9876` diekspos untuk Mini App web dan webhook internal bot.

### Script Install + Jalankan Otomatis

Sekali jalan:
```bash
bash scripts/install-and-run.sh --bot-token "ISI_BOT_TOKEN" --admin-ids "123456789"
```

Mode background:
```bash
bash scripts/install-and-run.sh --background
```

Output background:
- PID file: `data/control-bot.pid`
- stdout log: `logs/control-bot.stdout.log`
- stderr log: `logs/control-bot.stderr.log`

## Command Lengkap

- `/panel` (menu inline)
- `/web` (buka Telegram Mini App)
- `/vps` (spec + usage VPS)
- `/help`
- `/apps`
- `/status [nama]`
- `/addapp <nama> <repo_url> [branch]`
- `/removeapp <nama> [--delete-files] [--force]`
- `/setrepo <nama> <repo_url>`
- `/setbranch <nama> <branch>`
- `/setcmd <nama> <start|install|build> <command...>`
- `/setvar <nama> <KEY> <VALUE...>`
- `/delvar <nama> <KEY>`
- `/vars <nama>`
- `/deploy <nama> [--restart]`
- `/update <nama>`
- `/start <nama>`
- `/stop <nama>`
- `/restart <nama>`
- `/logs <nama> [lines]`
- `/run <nama> <command...>`

## Inline Panel

Mode terbaru: semua kontrol inline berjalan dalam **satu pesan** (message di-edit terus).

1. Kirim `/panel`
2. Pilih app dari daftar tombol
3. Klik aksi: `start`, `stop`, `restart`, `deploy`, `deploy + restart`, `update`, `logs`, `vars`, `remove`
4. Klik `VPS Info` untuk lihat resource server real-time

Di menu **Settings app**, sekarang tersedia juga:
- Toggle `Python Venv` + tombol `Rebuild Python Venv`
- Pengaturan Docker runtime per app: `Docker Mode (auto/on/off)`, `Docker Ports`, `Docker Volumes`, `Docker Extra Args`

## Mini App Web

Mini App tersedia di path:
```text
/miniapp
```

Agar tombol `Mini App` muncul di bot dan bisa dibuka dari Telegram:
1. Pastikan server ini bisa diakses publik via HTTPS.
2. Set `PUBLIC_BASE_URL` ke base URL publik server.
3. Jalankan bot, lalu buka `/start` atau `/web`.
4. Jika URL valid, bot juga akan mencoba set menu button Telegram ke `Mini App` otomatis saat startup.

Contoh:
```env
PUBLIC_BASE_URL=https://bot.example.com
WEB_PORT=9876
```

Fitur Mini App:
- Dashboard daftar app dan status runtime
- Kontrol `start`, `stop`, `restart`, `deploy`, `update`, `remove`
- Konfigurasi app langsung dari web: command install/build/start, env var, Python venv, dan Docker mode/ports/volumes/args
- Preview logs stdout/stderr
- File manager browse folder, preview file teks, dan download file

Keamanan:
- Mini App hanya menerima request dengan `initData` Telegram yang valid
- User Telegram tetap dicek ke daftar `ADMIN_IDS` dan admin DB

## Contoh Style Tombol

Helper `buildInlineKeyboard(buttons)` menerima format `buttons` 2 dimensi dan optional `style`:
- `primary`
- `success`
- `danger`

Contoh penggunaan di handler:
```js
const { buildInlineKeyboard, buildMiniAppButton, buildMiniAppKeyboard, appControlTemplateButtons } = require("../utils");
```

1. Satu tombol per style
```js
const buttons = [
  [{ text: "Primary", callback_data: "btn_primary", style: "primary" }],
  [{ text: "Success", callback_data: "btn_success", style: "success" }],
  [{ text: "Danger", callback_data: "btn_danger", style: "danger" }]
];
```

2. Semua style dalam satu baris
```js
const buttons = [[
  { text: "Primary", callback_data: "p1", style: "primary" },
  { text: "Success", callback_data: "s1", style: "success" },
  { text: "Danger", callback_data: "d1", style: "danger" }
]];
```

3. Campuran multi-row
```js
const buttons = [
  [
    { text: "Start", callback_data: "start", style: "primary" },
    { text: "OK", callback_data: "ok", style: "success" }
  ],
  [
    { text: "Hapus", callback_data: "delete", style: "danger" }
  ]
];
```

4. Tanpa style (default)
```js
const buttons = [[
  { text: "Default", callback_data: "default_btn" }
]];
```

Kirim ke Telegram:
```js
await ctx.reply("Pilih aksi:", {
  reply_markup: buildInlineKeyboard(buttons)
});
```

Contoh tombol inline khusus Mini App:
```js
const webAppUrl = "https://bot.example.com/miniapp";

await ctx.reply("Buka Mini App:", {
  reply_markup: buildMiniAppKeyboard(webAppUrl, { text: "Buka Mini App" })
});

const rows = [[
  { text: "Buka Panel", callback_data: "panel:home" },
  buildMiniAppButton(webAppUrl, { text: "Mini App" })
].filter(Boolean)];

await ctx.reply("Pilih menu:", {
  reply_markup: buildInlineKeyboard(rows)
});
```

Template siap pakai `Start / Status / Restart / Hapus`:
```js
const buttons = appControlTemplateButtons({
  startCallback: "panel:run:start",
  statusCallback: "panel:run:status",
  restartCallback: "panel:run:restart",
  deleteCallback: "panel:run:remove",
  startText: "▶️ Start",
  statusText: "ℹ️ Status",
  restartText: "🔁 Restart",
  deleteText: "🗑️ Hapus App"
});

await ctx.reply("Menu kontrol app:", {
  reply_markup: buildInlineKeyboard(buttons)
});
```

## Alur Pakai Cepat

1. Tambah app:
```text
/addapp mybot https://github.com/user/repo.git main
```
2. Set command (opsional):
```text
/setcmd mybot install npm ci
/setcmd mybot build npm run build
/setcmd mybot start npm run start
```
3. Tambah env:
```text
/setvar mybot BOT_TOKEN 123:abc
```
4. Deploy:
```text
/deploy mybot
```
5. Start:
```text
/start mybot
```
6. Lihat logs:
```text
/logs mybot 120
```

## Catatan Penting

- Bot ini menjalankan shell command di server, jadi pastikan hanya admin yang dipercaya ada di `ADMIN_IDS`.
- Untuk production, jalankan bot utama ini dengan process manager (contoh: systemd/pm2/supervisor) agar auto-restart.
- `deployments/` dan `logs/` bisa membesar, siapkan cleanup berkala.
