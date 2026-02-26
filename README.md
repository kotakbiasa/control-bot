# Telegram Deploy Control Bot

Bot Telegram untuk deploy dan kontrol banyak app/bot di server tanpa login VPS manual.
Semua konfigurasi disimpan lokal di file JSON (`data/db.json`).

## Fitur

- Multi app management (bisa tambah beberapa app sekaligus)
- Inline control panel (tombol Telegram, bukan hanya command text)
- Monitor spec & usage VPS (CPU, RAM, disk, uptime, usage app running)
- Deploy dari Git repo (clone/pull)
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
