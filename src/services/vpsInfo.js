const os = require("os");
const { escapeHtml } = require("../utils");
const { runShell } = require("../deployer");

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

async function buildVpsInfoText(db) {
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
        `<b>Host:</b> ${escapeHtml(hostname)} | <b>OS:</b> ${escapeHtml(`${os.platform()} ${os.arch()}`)}`,
        `<b>Node:</b> ${escapeHtml(process.version)} | <b>Load:</b> ${escapeHtml(load)}`,
        `<b>Uptime:</b> ${escapeHtml(formatUptime(os.uptime()))} | <b>Bot:</b> ${escapeHtml(formatUptime(process.uptime()))}`,
        "</blockquote>",
        "",
        `<b>⚙️ CPU & RAM</b>`,
        "<blockquote>",
        `<b>CPU:</b> ${escapeHtml(String(cpuCount))} Cores (${escapeHtml(cpuModel)})`,
        `<b>RAM:</b> ${escapeHtml(formatBytes(usedMem))} / ${escapeHtml(formatBytes(totalMem))} (${escapeHtml(memPct)}%)`,
        "</blockquote>",
        "",
        "<b>💾 Storage & Apps</b>",
        "<blockquote>",
        `<b>Disk:</b> ${escapeHtml(disk.used)} / ${escapeHtml(disk.total)} (${escapeHtml(disk.percent)})`,
        `<b>Apps:</b> ${escapeHtml(String(runningApps.length))} running / ${escapeHtml(String(appNames.length))} total`,
        "</blockquote>"
    ];

    if (usageRows.length > 0) {
        lines.push("", "<b>📈 Running App Usage</b>", "<blockquote>", ...usageRows, "</blockquote>");
    }

    return lines.join("\n");
}

module.exports = {
    formatBytes,
    formatUptime,
    getDiskUsage,
    getPidUsage,
    buildVpsInfoText
};
