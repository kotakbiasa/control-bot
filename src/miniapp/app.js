(function () {
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    const state = {
        initData: tg && tg.initData ? tg.initData : "",
        apps: [],
        appMap: new Map(),
        selectedApp: null,
        appDetail: null,
        filePath: ".",
        currentFilePath: null,
        currentFileDownloadPath: null,
        logs: { stdout: "", stderr: "" },
        activeLogTab: "stdout",
        logLines: 80
    };

    const els = {};

    document.addEventListener("DOMContentLoaded", init);

    async function init() {
        bindElements();
        bindEvents();
        applyTelegramTheme();

        if (tg) {
            try {
                tg.ready();
                tg.expand();
                if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#d7ecff");
                if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#d9ecff");
            } catch { }
        }

        if (!state.initData) {
            els.authNotice.classList.remove("hidden");
            els.userBadge.textContent = "Telegram auth required";
            return;
        }

        await refreshAll();
    }

    function bindElements() {
        els.authNotice = document.getElementById("authNotice");
        els.refreshAllBtn = document.getElementById("refreshAllBtn");
        els.userBadge = document.getElementById("userBadge");
        els.totalApps = document.getElementById("totalApps");
        els.pinnedApps = document.getElementById("pinnedApps");
        els.runningApps = document.getElementById("runningApps");
        els.botUptime = document.getElementById("botUptime");
        els.memoryStat = document.getElementById("memoryStat");
        els.cpuStat = document.getElementById("cpuStat");
        els.diskStat = document.getElementById("diskStat");
        els.hostStat = document.getElementById("hostStat");
        els.appCountPill = document.getElementById("appCountPill");
        els.appList = document.getElementById("appList");
        els.appTitle = document.getElementById("appTitle");
        els.appStatusBadge = document.getElementById("appStatusBadge");
        els.appMeta = document.getElementById("appMeta");
        els.controlButtons = document.getElementById("controlButtons");
        els.actionOutput = document.getElementById("actionOutput");
        els.logViewer = document.getElementById("logViewer");
        els.stdoutTab = document.getElementById("stdoutTab");
        els.stderrTab = document.getElementById("stderrTab");
        els.refreshLogsBtn = document.getElementById("refreshLogsBtn");
        els.filePathLabel = document.getElementById("filePathLabel");
        els.fileUpBtn = document.getElementById("fileUpBtn");
        els.refreshFilesBtn = document.getElementById("refreshFilesBtn");
        els.fileList = document.getElementById("fileList");
        els.previewTitle = document.getElementById("previewTitle");
        els.downloadFileBtn = document.getElementById("downloadFileBtn");
        els.filePreview = document.getElementById("filePreview");
        els.busyOverlay = document.getElementById("busyOverlay");
        els.busyText = document.getElementById("busyText");
        els.toast = document.getElementById("toast");
    }

    function bindEvents() {
        els.refreshAllBtn.addEventListener("click", () => refreshAll());
        els.refreshLogsBtn.addEventListener("click", () => refreshLogs());
        els.refreshFilesBtn.addEventListener("click", () => refreshFiles());
        els.fileUpBtn.addEventListener("click", () => goUp());
        els.stdoutTab.addEventListener("click", () => switchLogTab("stdout"));
        els.stderrTab.addEventListener("click", () => switchLogTab("stderr"));
        els.downloadFileBtn.addEventListener("click", () => downloadCurrentFile());

        document.querySelectorAll("[data-lines]").forEach((button) => {
            button.addEventListener("click", () => {
                state.logLines = Number.parseInt(button.dataset.lines || "80", 10) || 80;
                refreshLogs();
            });
        });
    }

    function applyTelegramTheme() {
        if (!tg || !tg.themeParams) return;
        const root = document.documentElement;
        const theme = tg.themeParams;
        if (theme.button_color) root.style.setProperty("--accent", theme.button_color);
        if (theme.text_color) root.style.setProperty("--text", theme.text_color);
        if (theme.hint_color) root.style.setProperty("--muted", theme.hint_color);
        if (theme.secondary_bg_color) root.style.setProperty("--surface-soft", hexToRgba(theme.secondary_bg_color, 0.36));
    }

    async function refreshAll() {
        try {
            setBusy("Loading dashboard...");
            const payload = await api("/api/miniapp/bootstrap");
            state.apps = payload.apps || [];
            state.appMap = new Map(state.apps.map((item) => [item.name, item]));
            renderSummary(payload);
            renderApps();

            if (payload.user) {
                const fullName = [payload.user.first_name, payload.user.last_name].filter(Boolean).join(" ").trim();
                const userLabel = fullName || (payload.user.username ? `@${payload.user.username}` : String(payload.user.id));
                els.userBadge.textContent = userLabel;
            }

            const targetApp = state.selectedApp && state.appMap.has(state.selectedApp)
                ? state.selectedApp
                : state.apps[0] && state.apps[0].name;

            if (targetApp) {
                await selectApp(targetApp);
            } else {
                renderEmptyState();
            }
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    function renderSummary(payload) {
        els.totalApps.textContent = String(payload.summary.totalApps || 0);
        els.pinnedApps.textContent = `${payload.summary.pinnedApps || 0} pinned`;
        els.runningApps.textContent = String(payload.summary.runningApps || 0);
        els.botUptime.textContent = `Bot uptime ${payload.vps.botUptime || "-"}`;
        els.memoryStat.textContent = `${payload.vps.memory.usedLabel || "-"} / ${payload.vps.memory.totalLabel || "-"}`;
        els.cpuStat.textContent = `${payload.vps.cpuCount || 0} cores`;
        els.diskStat.textContent = `${payload.vps.disk.used || "-"} / ${payload.vps.disk.total || "-"}`;
        els.hostStat.textContent = `${payload.vps.host || "-"} | ${payload.vps.os || "-"}`;
        els.appCountPill.textContent = String((payload.apps || []).length);
    }

    function renderApps() {
        if (!state.apps.length) {
            els.appList.innerHTML = '<div class="tile-meta">No apps registered yet.</div>';
            return;
        }

        els.appList.innerHTML = state.apps.map((app) => {
            const dotClass = app.status === "running" ? "status-running" : "status-stopped";
            const activeClass = state.selectedApp === app.name ? "active" : "";
            const pin = app.pinned ? "Pinned" : "Normal";
            return `
                <button class="app-tile ${activeClass}" data-app-name="${escapeAttr(app.name)}" type="button">
                    <div class="app-line">
                        <span class="app-name"><span class="status-dot ${dotClass}"></span>${escapeHtml(app.name)}</span>
                        <span class="pill">${escapeHtml(app.branch || "main")}</span>
                    </div>
                    <span class="tile-meta">${escapeHtml(app.status)} | ${escapeHtml(pin)}</span>
                </button>
            `;
        }).join("");

        els.appList.querySelectorAll("[data-app-name]").forEach((button) => {
            button.addEventListener("click", () => selectApp(button.dataset.appName));
        });
    }

    async function selectApp(appName) {
        if (!appName) return;
        state.selectedApp = appName;
        state.filePath = ".";
        state.currentFilePath = null;
        state.currentFileDownloadPath = null;
        renderApps();

        try {
            setBusy(`Loading ${appName}...`);
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(appName)}`);
            state.appDetail = payload.app;
            renderAppDetail();
            await Promise.all([refreshLogs(), refreshFiles()]);
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    function renderAppDetail() {
        const app = state.appDetail;
        if (!app) {
            renderEmptyState();
            return;
        }

        els.appTitle.textContent = app.name;
        els.appStatusBadge.textContent = app.runtime.status || "stopped";
        els.appStatusBadge.className = `badge ${app.runtime.status === "running" ? "status-running" : "status-stopped"}`;
        els.appMeta.innerHTML = [
            metaCard("Repo", app.repo || "-"),
            metaCard("Branch", app.branch || "-"),
            metaCard("PID", app.runtime.pid || "-"),
            metaCard("Last Deploy", app.lastDeployAt || "-"),
            metaCard("Directory", app.directory || "-"),
            metaCard("Start Command", app.startCommand || "-")
        ].join("");

        const buttons = [
            actionButton("Start", "start", "positive"),
            actionButton("Stop", "stop", "danger"),
            actionButton("Restart", "restart", ""),
            actionButton("Deploy", "deploy", ""),
            actionButton("Update", "update", ""),
            actionButton("Remove", "remove", "danger")
        ];
        els.controlButtons.innerHTML = buttons.join("");
        els.controlButtons.querySelectorAll("[data-action]").forEach((button) => {
            button.addEventListener("click", () => runAction(button.dataset.action));
        });
    }

    function renderEmptyState() {
        els.appTitle.textContent = "Select an app";
        els.appStatusBadge.textContent = "Idle";
        els.appStatusBadge.className = "badge";
        els.appMeta.innerHTML = "";
        els.controlButtons.innerHTML = "";
        els.actionOutput.textContent = "No app selected.";
        els.actionOutput.classList.add("empty");
        els.logViewer.textContent = "Choose an app to load logs.";
        els.filePathLabel.textContent = "No folder loaded";
        els.fileList.innerHTML = "";
        els.previewTitle.textContent = "No file selected";
        els.filePreview.textContent = "Select a file to preview it here.";
        els.downloadFileBtn.classList.add("hidden");
    }

    async function runAction(action) {
        if (!state.selectedApp) return;

        let body = {};
        if (action === "remove") {
            if (!window.confirm(`Remove app "${state.selectedApp}"?`)) return;
            body.deleteFiles = window.confirm("Delete deployment files and logs too?");
        }

        try {
            setBusy(`Running ${action}...`);
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/actions/${action}`, {
                method: "POST",
                body: JSON.stringify(body)
            });
            els.actionOutput.textContent = [payload.message, payload.detail].filter(Boolean).join("\n\n");
            els.actionOutput.classList.remove("empty");
            showToast(payload.message || "Action completed.");
            if (action === "remove") {
                state.selectedApp = null;
                state.appDetail = null;
                await refreshAll();
                return;
            }
            if (payload.app) {
                state.appDetail = payload.app;
                renderAppDetail();
            }
            await Promise.all([refreshAllSilently(), refreshLogs(), refreshFiles()]);
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    async function refreshAllSilently() {
        const payload = await api("/api/miniapp/bootstrap");
        state.apps = payload.apps || [];
        state.appMap = new Map(state.apps.map((item) => [item.name, item]));
        renderSummary(payload);
        renderApps();
    }

    async function refreshLogs() {
        if (!state.selectedApp) return;
        try {
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/logs?lines=${state.logLines}`);
            state.logs.stdout = payload.stdout || "";
            state.logs.stderr = payload.stderr || "";
            paintLogViewer();
        } catch (err) {
            showToast(extractError(err));
        }
    }

    function switchLogTab(tabName) {
        state.activeLogTab = tabName;
        els.stdoutTab.classList.toggle("active", tabName === "stdout");
        els.stderrTab.classList.toggle("active", tabName === "stderr");
        paintLogViewer();
    }

    function paintLogViewer() {
        const text = state.activeLogTab === "stdout" ? state.logs.stdout : state.logs.stderr;
        els.logViewer.textContent = text || `No ${state.activeLogTab} output yet.`;
    }

    async function refreshFiles() {
        if (!state.selectedApp) return;
        try {
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/files?path=${encodeURIComponent(state.filePath)}`);
            state.filePath = payload.path || ".";
            renderFileList(payload);
        } catch (err) {
            showToast(extractError(err));
        }
    }

    function renderFileList(payload) {
        els.filePathLabel.textContent = `${state.selectedApp}:${payload.path}`;
        els.fileUpBtn.disabled = !payload.parentPath;

        const rows = [];
        if (payload.parentPath) {
            rows.push(`
                <button class="file-row" data-path="${escapeAttr(payload.parentPath)}" data-type="dir" type="button">
                    <div class="file-line">
                        <span class="file-name">..</span>
                        <span class="pill">up</span>
                    </div>
                    <span class="file-meta">Go to parent folder</span>
                </button>
            `);
        }

        for (const item of payload.items || []) {
            rows.push(`
                <button class="file-row" data-path="${escapeAttr(item.path)}" data-type="${item.type}" type="button">
                    <div class="file-line">
                        <span class="file-name">${escapeHtml(item.name)}${item.type === "dir" ? "/" : ""}</span>
                        <span class="pill">${escapeHtml(item.type)}</span>
                    </div>
                    <span class="file-meta">${escapeHtml(item.sizeLabel || "-")} | ${escapeHtml(item.modifiedAt || "-")}</span>
                </button>
            `);
        }

        els.fileList.innerHTML = rows.join("") || '<div class="tile-meta">This folder is empty.</div>';
        els.fileList.querySelectorAll("[data-path]").forEach((button) => {
            button.addEventListener("click", () => {
                if (button.dataset.type === "dir") {
                    openDir(button.dataset.path);
                } else {
                    openFile(button.dataset.path);
                }
            });
        });
    }

    async function openDir(nextPath) {
        state.filePath = nextPath || ".";
        state.currentFilePath = null;
        state.currentFileDownloadPath = null;
        els.previewTitle.textContent = "No file selected";
        els.filePreview.textContent = "Select a file to preview it here.";
        els.downloadFileBtn.classList.add("hidden");
        await refreshFiles();
    }

    async function goUp() {
        if (state.filePath === "." || !state.selectedApp) return;
        const parts = state.filePath.split("/").filter(Boolean);
        parts.pop();
        state.filePath = parts.length ? parts.join("/") : ".";
        await refreshFiles();
    }

    async function openFile(filePath) {
        if (!state.selectedApp) return;
        try {
            setBusy("Opening file...");
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/file?path=${encodeURIComponent(filePath)}`);
            state.currentFilePath = payload.path;
            state.currentFileDownloadPath = `/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/file?path=${encodeURIComponent(filePath)}&download=1`;
            els.previewTitle.textContent = payload.path;
            els.downloadFileBtn.classList.remove("hidden");

            if (payload.isBinary) {
                els.filePreview.textContent = `Binary file. Size ${payload.sizeLabel}. Download it instead of previewing.`;
            } else {
                const suffix = payload.truncated ? "\n\n[preview truncated at 1 MB]" : "";
                els.filePreview.textContent = `${payload.content || ""}${suffix}`;
            }
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    async function downloadCurrentFile() {
        if (!state.currentFileDownloadPath) return;
        try {
            setBusy("Downloading file...");
            const response = await fetch(state.currentFileDownloadPath, {
                headers: { "X-Telegram-Init-Data": state.initData },
                cache: "no-store"
            });
            if (!response.ok) {
                const payload = await safeJson(response);
                throw new Error((payload && payload.error) || "Failed to download file.");
            }

            const blob = await response.blob();
            const href = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = href;
            anchor.download = state.currentFilePath ? state.currentFilePath.split("/").pop() : "download";
            anchor.click();
            URL.revokeObjectURL(href);
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    async function api(url, options) {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            ...options,
            headers: {
                "X-Telegram-Init-Data": state.initData,
                "Content-Type": "application/json",
                ...(options && options.headers ? options.headers : {})
            }
        });

        const payload = await safeJson(response);
        if (!response.ok || (payload && payload.ok === false)) {
            throw new Error((payload && payload.error) || `Request failed with status ${response.status}`);
        }
        return payload;
    }

    async function safeJson(response) {
        const text = await response.text();
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            return { error: text };
        }
    }

    function setBusy(text) {
        els.busyText.textContent = text || "Loading...";
        els.busyOverlay.classList.remove("hidden");
    }

    function clearBusy() {
        els.busyOverlay.classList.add("hidden");
    }

    let toastTimer = null;
    function showToast(text) {
        els.toast.textContent = text;
        els.toast.classList.remove("hidden");
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
        if (tg && typeof tg.HapticFeedback === "object" && tg.HapticFeedback.notificationOccurred) {
            try { tg.HapticFeedback.notificationOccurred("success"); } catch { }
        }
    }

    function metaCard(label, value) {
        const safeValue = escapeHtml(value || "-");
        return `<div class="meta-card"><span>${escapeHtml(label)}</span><strong>${safeValue}</strong></div>`;
    }

    function actionButton(label, action, tone) {
        const toneClass = tone ? ` ${tone}` : "";
        return `<button class="action-button${toneClass}" data-action="${escapeAttr(action)}" type="button">${escapeHtml(label)}</button>`;
    }

    function escapeHtml(value) {
        return String(value || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
    }

    function escapeAttr(value) {
        return escapeHtml(value).replaceAll('"', "&quot;");
    }

    function extractError(err) {
        return err instanceof Error ? err.message : String(err);
    }

    function hexToRgba(hex, alpha) {
        const clean = String(hex || "").replace("#", "");
        if (clean.length !== 6) return `rgba(255,255,255,${alpha})`;
        const r = Number.parseInt(clean.slice(0, 2), 16);
        const g = Number.parseInt(clean.slice(2, 4), 16);
        const b = Number.parseInt(clean.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
})();
