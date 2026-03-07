(function () {
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    const state = {
        initData: tg && tg.initData ? tg.initData : "",
        apps: [],
        selectedApp: null,
        appDetail: null,
        currentView: "overview",
        appFilter: "all",
        appQuery: "",
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
        initTelegramUi();
        setView(isCompactViewport() ? "apps" : "overview", { scroll: false });

        if (!state.initData) {
            els.authNotice.classList.remove("hidden");
            els.userBadge.textContent = "Telegram auth required";
            renderEmptyState();
            return;
        }

        await refreshAll();
    }

    function bindElements() {
        els.authNotice = document.getElementById("authNotice");
        els.userBadge = document.getElementById("userBadge");
        els.refreshAllBtn = document.getElementById("refreshAllBtn");
        els.refreshSelectedBtn = document.getElementById("refreshSelectedBtn");
        els.totalApps = document.getElementById("totalApps");
        els.pinnedApps = document.getElementById("pinnedApps");
        els.runningApps = document.getElementById("runningApps");
        els.botUptime = document.getElementById("botUptime");
        els.memoryStat = document.getElementById("memoryStat");
        els.cpuStat = document.getElementById("cpuStat");
        els.diskStat = document.getElementById("diskStat");
        els.hostStat = document.getElementById("hostStat");
        els.appCountPill = document.getElementById("appCountPill");
        els.appSearchInput = document.getElementById("appSearchInput");
        els.filterChips = Array.from(document.querySelectorAll(".filter-chip"));
        els.appList = document.getElementById("appList");
        els.contentTabs = Array.from(document.querySelectorAll(".content-tab"));
        els.bottomTabs = Array.from(document.querySelectorAll(".bottom-tab"));
        els.appTitle = document.getElementById("appTitle");
        els.appSubtitle = document.getElementById("appSubtitle");
        els.appStatusBadge = document.getElementById("appStatusBadge");
        els.summaryChips = document.getElementById("summaryChips");
        els.overviewPanel = document.getElementById("overviewPanel");
        els.logsPanel = document.getElementById("logsPanel");
        els.filesPanel = document.getElementById("filesPanel");
        els.appMeta = document.getElementById("appMeta");
        els.runtimeActions = document.getElementById("runtimeActions");
        els.deployActions = document.getElementById("deployActions");
        els.dangerActions = document.getElementById("dangerActions");
        els.actionOutput = document.getElementById("actionOutput");
        els.logLineButtons = Array.from(document.querySelectorAll(".log-line-btn"));
        els.refreshLogsBtn = document.getElementById("refreshLogsBtn");
        els.stdoutTab = document.getElementById("stdoutTab");
        els.stderrTab = document.getElementById("stderrTab");
        els.logViewer = document.getElementById("logViewer");
        els.filePathLabel = document.getElementById("filePathLabel");
        els.fileUpBtn = document.getElementById("fileUpBtn");
        els.refreshFilesBtn = document.getElementById("refreshFilesBtn");
        els.fileBreadcrumbs = document.getElementById("fileBreadcrumbs");
        els.fileList = document.getElementById("fileList");
        els.previewTitle = document.getElementById("previewTitle");
        els.filePreview = document.getElementById("filePreview");
        els.downloadFileBtn = document.getElementById("downloadFileBtn");
        els.busyOverlay = document.getElementById("busyOverlay");
        els.busyText = document.getElementById("busyText");
        els.toast = document.getElementById("toast");
    }

    function bindEvents() {
        els.refreshAllBtn.addEventListener("click", () => refreshAll());
        els.refreshSelectedBtn.addEventListener("click", () => refreshSelectedApp());
        els.appSearchInput.addEventListener("input", (event) => {
            state.appQuery = String(event.target.value || "").trim().toLowerCase();
            renderApps();
        });

        els.filterChips.forEach((button) => {
            button.addEventListener("click", () => {
                state.appFilter = button.dataset.filter || "all";
                renderApps();
                updateFilterButtons();
            });
        });

        [...els.contentTabs, ...els.bottomTabs].forEach((button) => {
            button.addEventListener("click", () => {
                const nextView = button.dataset.viewTarget || "overview";
                setView(nextView);
            });
        });

        els.logLineButtons.forEach((button) => {
            button.addEventListener("click", () => {
                state.logLines = Number.parseInt(button.dataset.lines || "80", 10) || 80;
                updateLogLineButtons();
                refreshLogs();
            });
        });

        els.refreshLogsBtn.addEventListener("click", () => refreshLogs());
        els.stdoutTab.addEventListener("click", () => switchLogTab("stdout"));
        els.stderrTab.addEventListener("click", () => switchLogTab("stderr"));
        els.fileUpBtn.addEventListener("click", () => goUp());
        els.refreshFilesBtn.addEventListener("click", () => refreshFiles());
        els.downloadFileBtn.addEventListener("click", () => downloadCurrentFile());

        window.addEventListener("resize", handleViewportChange);
    }

    function initTelegramUi() {
        if (!tg) return;

        try {
            tg.ready();
            tg.expand();
            if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#10141f");
            if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor("#10141f");
            if (typeof tg.onEvent === "function") {
                tg.onEvent("themeChanged", applyTelegramColors);
                tg.onEvent("viewportChanged", handleViewportChange);
            }
            if (tg.BackButton && typeof tg.BackButton.onClick === "function") {
                tg.BackButton.onClick(() => {
                    if (!isCompactViewport()) return;
                    if (state.currentView === "apps") return;
                    setView("apps");
                });
            }
        } catch { }

        applyTelegramColors();
    }

    function applyTelegramColors() {
        if (!tg || !tg.themeParams) return;
        const root = document.documentElement;
        const theme = tg.themeParams;

        if (theme.button_color) root.style.setProperty("--tg-button", theme.button_color);
        if (theme.button_text_color) root.style.setProperty("--tg-button-text", theme.button_text_color);
        if (theme.text_color) root.style.setProperty("--tg-text", theme.text_color);
        if (theme.hint_color) root.style.setProperty("--tg-hint", theme.hint_color);
        if (theme.bg_color) root.style.setProperty("--tg-bg", theme.bg_color);
        if (theme.secondary_bg_color) root.style.setProperty("--tg-secondary-bg", theme.secondary_bg_color);
    }

    function handleViewportChange() {
        if (isCompactViewport()) {
            if (!state.selectedApp && state.currentView !== "apps") {
                setView("apps", { scroll: false });
            }
        } else if (state.currentView === "apps") {
            setView("overview", { scroll: false });
        } else {
            syncViewState();
        }
    }

    async function refreshAll() {
        try {
            setBusy("Loading dashboard...");
            const payload = await api("/api/miniapp/bootstrap");
            state.apps = Array.isArray(payload.apps) ? payload.apps : [];
            renderSummary(payload);
            renderApps();

            if (payload.user) {
                const fullName = [payload.user.first_name, payload.user.last_name].filter(Boolean).join(" ").trim();
                els.userBadge.textContent = fullName || (payload.user.username ? `@${payload.user.username}` : String(payload.user.id));
            }

            const targetApp = state.selectedApp && state.apps.some((item) => item.name === state.selectedApp)
                ? state.selectedApp
                : state.apps[0] && state.apps[0].name;

            if (targetApp) {
                await selectApp(targetApp, { focus: false });
            } else {
                state.selectedApp = null;
                state.appDetail = null;
                renderEmptyState();
            }
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    function renderSummary(payload) {
        const summary = payload.summary || {};
        const vps = payload.vps || {};
        const memory = vps.memory || {};
        const disk = vps.disk || {};

        els.totalApps.textContent = String(summary.totalApps || 0);
        els.pinnedApps.textContent = `${summary.pinnedApps || 0} pinned`;
        els.runningApps.textContent = String(summary.runningApps || 0);
        els.botUptime.textContent = `Bot uptime ${vps.botUptime || "-"}`;
        els.memoryStat.textContent = `${memory.usedLabel || "-"} / ${memory.totalLabel || "-"}`;
        els.cpuStat.textContent = `${vps.cpuCount || 0} cores`;
        els.diskStat.textContent = `${disk.used || "-"} / ${disk.total || "-"}`;
        els.hostStat.textContent = `${vps.host || "-"} | ${vps.os || "-"}`;
        els.appCountPill.textContent = String((payload.apps || []).length);
    }

    function renderApps() {
        const filteredApps = state.apps.filter((app) => {
            if (state.appFilter === "running" && app.status !== "running") return false;
            if (state.appFilter === "pinned" && !app.pinned) return false;
            if (state.appQuery && !String(app.name || "").toLowerCase().includes(state.appQuery)) return false;
            return true;
        });

        if (!filteredApps.length) {
            els.appList.innerHTML = '<div class="empty-note">No apps match the current filter.</div>';
            return;
        }

        els.appList.innerHTML = filteredApps.map((app) => {
            const statusClass = app.status === "running" ? "running" : "stopped";
            const activeClass = state.selectedApp === app.name ? "active" : "";
            const pin = app.pinned ? "Pinned" : "Normal";
            const branch = app.branch || "main";
            return `
                <button class="app-card ${activeClass}" data-app-name="${escapeAttr(app.name)}" type="button">
                    <div class="app-card-head">
                        <span class="app-name"><span class="status-dot ${statusClass}"></span>${escapeHtml(app.name)}</span>
                        <span class="chip">${escapeHtml(branch)}</span>
                    </div>
                    <div class="app-card-meta">${escapeHtml(app.status || "stopped")} | ${escapeHtml(pin)}</div>
                </button>
            `;
        }).join("");

        els.appList.querySelectorAll("[data-app-name]").forEach((button) => {
            button.addEventListener("click", () => selectApp(button.dataset.appName, { focus: true }));
        });
    }

    async function selectApp(appName, options) {
        const { focus = true } = options || {};
        if (!appName) return;

        state.selectedApp = appName;
        state.filePath = ".";
        state.currentFilePath = null;
        state.currentFileDownloadPath = null;
        renderApps();

        try {
            setBusy(`Loading ${appName}...`);
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(appName)}`);
            state.appDetail = payload.app || null;
            renderSelectedApp();
            await Promise.all([refreshLogs(), refreshFiles()]);
            if (focus) {
                setView("overview");
            }
        } catch (err) {
            showToast(extractError(err));
        } finally {
            clearBusy();
        }
    }

    async function refreshSelectedApp() {
        if (!state.selectedApp) return;
        await selectApp(state.selectedApp, { focus: false });
    }

    function renderSelectedApp() {
        const app = state.appDetail;
        if (!app) {
            renderEmptyState();
            return;
        }

        const usage = app.runtime && app.runtime.usage ? app.runtime.usage : null;
        const chips = [
            `Status: ${app.runtime.status || "stopped"}`,
            app.branch ? `Branch: ${app.branch}` : null,
            app.runtime.pid ? `PID: ${app.runtime.pid}` : "PID: -",
            app.pinned ? "Pinned" : null,
            app.lastDeployAt ? `Deploy: ${app.lastDeployAt}` : null,
            usage && usage.cpu ? `CPU: ${usage.cpu}%` : null
        ].filter(Boolean);

        els.appTitle.textContent = app.name;
        els.appSubtitle.textContent = app.repo || app.directory || "No repository configured.";
        els.appStatusBadge.textContent = app.runtime.status || "stopped";
        els.appStatusBadge.className = `status-badge ${app.runtime.status === "running" ? "running" : "stopped"}`;
        els.summaryChips.innerHTML = chips.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");

        els.appMeta.innerHTML = [
            infoCard("Repository", app.repo || "-"),
            infoCard("Directory", app.directory || "-"),
            infoCard("Branch", app.branch || "-"),
            infoCard("PID", app.runtime.pid || "-"),
            infoCard("Last Start", app.runtime.lastStartAt || "-"),
            infoCard("Last Deploy", app.lastDeployAt || "-"),
            infoCard("Install Command", app.installCommand || "-"),
            infoCard("Build Command", app.buildCommand || "-"),
            infoCard("Start Command", app.startCommand || "-")
        ].join("");

        els.runtimeActions.innerHTML = [
            actionButton("Start", "start", "success"),
            actionButton("Stop", "stop", "danger"),
            actionButton("Restart", "restart", "primary")
        ].join("");

        els.deployActions.innerHTML = [
            actionButton("Deploy", "deploy", "primary"),
            actionButton("Update", "update", "primary")
        ].join("");

        els.dangerActions.innerHTML = actionButton("Remove App", "remove", "danger");

        [
            ...els.runtimeActions.querySelectorAll("[data-action]"),
            ...els.deployActions.querySelectorAll("[data-action]"),
            ...els.dangerActions.querySelectorAll("[data-action]")
        ].forEach((button) => {
            button.addEventListener("click", () => runAction(button.dataset.action));
        });
    }

    function renderEmptyState() {
        els.appTitle.textContent = "Select an app";
        els.appSubtitle.textContent = "Choose an app from the list to inspect its state.";
        els.appStatusBadge.textContent = "Idle";
        els.appStatusBadge.className = "status-badge idle";
        els.summaryChips.innerHTML = "";
        els.appMeta.innerHTML = '<div class="empty-note">No app selected.</div>';
        els.runtimeActions.innerHTML = "";
        els.deployActions.innerHTML = "";
        els.dangerActions.innerHTML = "";
        els.actionOutput.textContent = "No action has been run yet.";
        els.actionOutput.classList.add("empty");
        els.logViewer.textContent = "Choose an app to load logs.";
        els.filePathLabel.textContent = "No folder loaded";
        els.fileBreadcrumbs.innerHTML = "";
        els.fileList.innerHTML = '<div class="empty-note">Choose an app to open the file manager.</div>';
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
                if (isCompactViewport()) setView("apps", { scroll: false });
                return;
            }

            if (payload.app) {
                state.appDetail = payload.app;
                renderSelectedApp();
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
        state.apps = Array.isArray(payload.apps) ? payload.apps : [];
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

    function updateLogLineButtons() {
        els.logLineButtons.forEach((button) => {
            const value = Number.parseInt(button.dataset.lines || "80", 10) || 80;
            button.classList.toggle("active", value === state.logLines);
        });
    }

    function paintLogViewer() {
        const content = state.activeLogTab === "stdout" ? state.logs.stdout : state.logs.stderr;
        els.logViewer.textContent = content || `No ${state.activeLogTab} output yet.`;
    }

    async function refreshFiles() {
        if (!state.selectedApp) return;

        try {
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/files?path=${encodeURIComponent(state.filePath)}`);
            state.filePath = payload.path || ".";
            renderBreadcrumbs(state.filePath);
            renderFileList(payload);
        } catch (err) {
            showToast(extractError(err));
        }
    }

    function renderBreadcrumbs(currentPath) {
        const parts = currentPath === "." ? [] : currentPath.split("/").filter(Boolean);
        const crumbs = [{ label: state.selectedApp || "Root", path: "." }];
        let acc = "";
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            crumbs.push({ label: part, path: acc });
        }

        els.fileBreadcrumbs.innerHTML = crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return `<button class="crumb${current ? " current" : ""}" data-crumb-path="${escapeAttr(crumb.path)}" type="button">${escapeHtml(crumb.label)}</button>`;
        }).join("");

        els.fileBreadcrumbs.querySelectorAll("[data-crumb-path]").forEach((button) => {
            button.addEventListener("click", () => openDir(button.dataset.crumbPath));
        });
    }

    function renderFileList(payload) {
        els.filePathLabel.textContent = `${state.selectedApp}:${payload.path}`;
        els.fileUpBtn.disabled = !payload.parentPath;

        if (!payload.items || payload.items.length === 0) {
            els.fileList.innerHTML = '<div class="empty-note">This folder is empty.</div>';
            return;
        }

        els.fileList.innerHTML = payload.items.map((item) => `
            <button class="file-row" data-path="${escapeAttr(item.path)}" data-type="${escapeAttr(item.type)}" type="button">
                <div class="file-row-head">
                    <span class="file-name">${escapeHtml(item.name)}${item.type === "dir" ? "/" : ""}</span>
                    <span class="chip">${escapeHtml(item.type)}</span>
                </div>
                <div class="file-meta">${escapeHtml(item.sizeLabel || "-")} | ${escapeHtml(item.modifiedAt || "-")}</div>
            </button>
        `).join("");

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
        if (!state.selectedApp) return;

        state.filePath = nextPath || ".";
        state.currentFilePath = null;
        state.currentFileDownloadPath = null;
        els.previewTitle.textContent = "No file selected";
        els.filePreview.textContent = "Select a file to preview it here.";
        els.downloadFileBtn.classList.add("hidden");

        if (isCompactViewport()) {
            setView("files", { scroll: false });
        }

        await refreshFiles();
    }

    async function goUp() {
        if (state.filePath === "." || !state.selectedApp) return;
        const parts = state.filePath.split("/").filter(Boolean);
        parts.pop();
        await openDir(parts.length ? parts.join("/") : ".");
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

            if (isCompactViewport()) {
                setView("files", { scroll: false });
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

    function setView(view, options) {
        const { scroll = true } = options || {};
        const allowed = new Set(["apps", "overview", "logs", "files"]);
        let nextView = allowed.has(view) ? view : "overview";

        if (!state.selectedApp && nextView !== "apps" && isCompactViewport()) {
            nextView = "apps";
        }
        if (!isCompactViewport() && nextView === "apps") {
            nextView = "overview";
        }

        state.currentView = nextView;
        syncViewState();

        if (scroll && isCompactViewport()) {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    function syncViewState() {
        document.body.dataset.view = state.currentView;

        els.contentTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.currentView);
        });
        els.bottomTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.currentView);
        });

        els.overviewPanel.classList.toggle("is-active", state.currentView === "overview");
        els.logsPanel.classList.toggle("is-active", state.currentView === "logs");
        els.filesPanel.classList.toggle("is-active", state.currentView === "files");

        if (tg && tg.BackButton) {
            try {
                if (isCompactViewport() && state.currentView !== "apps") tg.BackButton.show();
                else tg.BackButton.hide();
            } catch { }
        }
    }

    function isCompactViewport() {
        return window.matchMedia("(max-width: 980px)").matches;
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

        if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.notificationOccurred === "function") {
            try { tg.HapticFeedback.notificationOccurred("success"); } catch { }
        }
    }

    function updateFilterButtons() {
        els.filterChips.forEach((button) => {
            button.classList.toggle("active", button.dataset.filter === state.appFilter);
        });
    }

    function infoCard(label, value) {
        return `
            <div class="info-card">
                <span class="info-card-label">${escapeHtml(label)}</span>
                <span class="info-card-value">${escapeHtml(value || "-")}</span>
            </div>
        `;
    }

    function actionButton(label, action, tone) {
        return `<button class="action-btn ${escapeAttr(tone || "")}" data-action="${escapeAttr(action)}" type="button">${escapeHtml(label)}</button>`;
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
})();
