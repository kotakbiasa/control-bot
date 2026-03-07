(function () {
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    const MOBILE_MEDIA = "(max-width: 980px)";
    const PRIMARY_VIEWS = new Set(["app", "status", "vps", "user"]);
    const DETAIL_VIEWS = new Set(["overview", "logs", "files"]);

    const state = {
        initData: tg && tg.initData ? tg.initData : "",
        apps: [],
        selectedApp: null,
        appDetail: null,
        currentView: "app",
        detailView: "overview",
        appFilter: "all",
        appQuery: "",
        filePath: ".",
        currentFilePath: null,
        currentFileDownloadPath: null,
        logs: { stdout: "", stderr: "" },
        activeLogTab: "stdout",
        logLines: 80,
        summary: {},
        vps: {},
        user: null,
        webAppUrl: ""
    };

    const els = {};

    document.addEventListener("DOMContentLoaded", init);

    async function init() {
        bindElements();
        bindEvents();
        initTelegramUi();
        applyTelegramColors();
        updateFilterButtons();
        updateLogLineButtons();
        renderSummary({ summary: {}, vps: {}, apps: [], user: null, webAppUrl: "" });
        renderEmptyState();
        state.currentView = "app";
        state.detailView = "overview";
        renderNavigationState();

        if (!state.initData) {
            els.authNotice.classList.remove("hidden");
            els.userBadge.textContent = "Telegram auth required";
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
        els.appsPanel = document.getElementById("appsPanel");
        els.detailShell = document.getElementById("detailShell");
        els.emptySelectionNotice = document.getElementById("emptySelectionNotice");
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
        els.statusPanel = document.getElementById("statusPanel");
        els.statusCards = document.getElementById("statusCards");
        els.runningAppsList = document.getElementById("runningAppsList");
        els.vpsPanel = document.getElementById("vpsPanel");
        els.vpsCards = document.getElementById("vpsCards");
        els.vpsInfoGrid = document.getElementById("vpsInfoGrid");
        els.userPanel = document.getElementById("userPanel");
        els.userInfoGrid = document.getElementById("userInfoGrid");
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
                updateFilterButtons();
                renderApps();
            });
        });

        els.contentTabs.forEach((button) => {
            button.addEventListener("click", () => {
                handleDetailTabPress(button.dataset.viewTarget || "overview");
            });
        });

        els.bottomTabs.forEach((button) => {
            button.addEventListener("click", () => {
                handleBottomTabPress(button.dataset.viewTarget || "app");
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
            if (typeof tg.onEvent === "function") {
                tg.onEvent("themeChanged", applyTelegramColors);
                tg.onEvent("viewportChanged", handleViewportChange);
            }
            if (tg.BackButton && typeof tg.BackButton.onClick === "function") {
                tg.BackButton.onClick(() => {
                    if (!isMobileView()) return;
                    if (state.currentView !== "app") {
                        setCurrentView("app", { scroll: false, silent: true });
                        return;
                    }
                    if (state.detailView !== "overview") {
                        setDetailView("overview", { scroll: false, silent: true });
                    }
                });
            }
        } catch {
            return;
        }
    }

    function applyTelegramColors() {
        if (!tg || !tg.themeParams) return;

        const root = document.documentElement;
        const theme = tg.themeParams;
        const themeColor = document.querySelector('meta[name="theme-color"]');

        if (theme.button_color) root.style.setProperty("--tg-button", theme.button_color);
        if (theme.button_text_color) root.style.setProperty("--tg-button-text", theme.button_text_color);
        if (theme.text_color) root.style.setProperty("--tg-text", theme.text_color);
        if (theme.hint_color) root.style.setProperty("--tg-hint", theme.hint_color);
        if (theme.bg_color) root.style.setProperty("--tg-bg", theme.bg_color);
        if (theme.secondary_bg_color) root.style.setProperty("--tg-secondary-bg", theme.secondary_bg_color);

        try {
            if (typeof tg.setHeaderColor === "function") tg.setHeaderColor(theme.bg_color || "#10131a");
            if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor(theme.bg_color || "#10131a");
        } catch {
            // ignore theme bridge errors
        }

        if (themeColor) {
            themeColor.setAttribute("content", theme.bg_color || "#10131a");
        }
    }

    function handleViewportChange() {
        if (!PRIMARY_VIEWS.has(state.currentView)) state.currentView = "app";
        if (!DETAIL_VIEWS.has(state.detailView)) state.detailView = "overview";

        renderNavigationState();
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

            const selectedStillExists = state.selectedApp && state.apps.some((app) => app.name === state.selectedApp);
            if (selectedStillExists) {
                await selectApp(state.selectedApp, { focus: false });
                return;
            }

            if (!isMobileView() && state.apps[0]) {
                await selectApp(state.apps[0].name, { focus: false });
                return;
            }

            clearSelectedState();
            renderEmptyState();
            setCurrentView("app", { scroll: false, silent: true });
        } catch (err) {
            showToast(extractError(err), "error");
        } finally {
            clearBusy();
        }
    }

    function renderSummary(payload) {
        const summary = payload.summary || {};
        const vps = payload.vps || {};
        const memory = vps.memory || {};
        const disk = vps.disk || {};

        state.summary = summary;
        state.vps = vps;
        state.user = payload.user || state.user;
        state.webAppUrl = payload.webAppUrl || state.webAppUrl || "";

        els.totalApps.textContent = String(summary.totalApps || 0);
        els.pinnedApps.textContent = `${summary.pinnedApps || 0} pinned`;
        els.runningApps.textContent = String(summary.runningApps || 0);
        els.botUptime.textContent = `Bot uptime ${vps.botUptime || "-"}`;
        els.memoryStat.textContent = `${memory.usedLabel || "-"} / ${memory.totalLabel || "-"}`;
        els.cpuStat.textContent = `${vps.cpuCount || 0} cores`;
        els.diskStat.textContent = `${disk.used || "-"} / ${disk.total || "-"}`;
        els.hostStat.textContent = `${vps.host || "-"} | ${vps.os || "-"}`;
        els.appCountPill.textContent = String(state.apps.length);

        renderStatusPanel();
        renderVpsPanel();
        renderUserPanel();
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
            const activeClass = state.selectedApp === app.name ? "active" : "";
            const statusClass = app.status === "running" ? "running" : "stopped";
            const branch = app.branch || "main";
            const pinnedTag = app.pinned ? '<span class="app-tag pinned">Pinned</span>' : "";
            return `
                <button class="app-card ${activeClass}" data-app-name="${escapeAttr(app.name)}" type="button">
                    <div class="app-card-head">
                        <span class="status-inline"><span class="status-dot ${statusClass}"></span><span class="app-card-name">${escapeHtml(app.name)}</span></span>
                        <span class="app-tag">${escapeHtml(branch)}</span>
                    </div>
                    <div class="app-card-meta">
                        <span>${escapeHtml(app.status || "stopped")}</span>
                        ${pinnedTag}
                    </div>
                </button>
            `;
        }).join("");

        els.appList.querySelectorAll("[data-app-name]").forEach((button) => {
            button.addEventListener("click", () => {
                selectApp(button.dataset.appName, { focus: true });
            });
        });
    }

    async function selectApp(appName, options) {
        const { focus = true } = options || {};
        if (!appName) return;

        state.selectedApp = appName;
        resetFileState();
        renderApps();

        try {
            setBusy(`Loading ${appName}...`);
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(appName)}`);
            state.appDetail = payload.app || null;
            renderSelectedApp();
            await Promise.all([refreshLogs(), refreshFiles()]);
            if (focus && isMobileView()) {
                setCurrentView("app", { scroll: true, silent: true });
                setDetailView("overview", { scroll: false, silent: true });
            } else {
                renderNavigationState();
            }
        } catch (err) {
            showToast(extractError(err), "error");
        } finally {
            clearBusy();
        }
    }

    async function refreshSelectedApp() {
        if (!state.selectedApp) {
            showToast("Select an app first.", "error");
            return;
        }

        await selectApp(state.selectedApp, { focus: false });
    }

    function renderSelectedApp() {
        const app = state.appDetail;
        if (!app) {
            renderEmptyState();
            return;
        }

        const runtime = app.runtime || {};
        const usage = runtime.usage || {};
        const summaryItems = [
            {
                label: "Status",
                value: runtime.status || "stopped",
                tone: runtime.status === "running" ? "success" : "danger"
            },
            { label: "Branch", value: app.branch || "-" },
            { label: "PID", value: runtime.pid || "-" },
            { label: "CPU", value: usage.cpu ? `${usage.cpu}%` : "-" },
            { label: "Deploy", value: app.lastDeployAt || "-", layout: "wide" },
            app.pinned ? { label: "Mode", value: "Pinned", tone: "warm", layout: "wide" } : null
        ].filter(Boolean);

        els.appTitle.textContent = app.name || "Unnamed app";
        els.appSubtitle.textContent = app.repo || app.directory || "No repository configured.";
        els.appStatusBadge.textContent = runtime.status || "stopped";
        els.appStatusBadge.className = `status-badge ${runtime.status === "running" ? "running" : "stopped"}`;
        els.summaryChips.innerHTML = summaryItems.map((item) => summaryCard(item.label, item.value, item.tone, item.layout)).join("");

        els.appMeta.innerHTML = [
            infoCard("Repository", app.repo || "-"),
            infoCard("Directory", app.directory || "-"),
            infoCard("Branch", app.branch || "-"),
            infoCard("PID", runtime.pid || "-"),
            infoCard("Last Start", runtime.lastStartAt || "-"),
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

        renderNavigationState();
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
        state.logs.stdout = "";
        state.logs.stderr = "";
        paintLogViewer();
        els.filePathLabel.textContent = "No folder loaded";
        els.fileBreadcrumbs.innerHTML = "";
        els.fileList.innerHTML = '<div class="empty-note">Choose an app to open the file manager.</div>';
        els.previewTitle.textContent = "No file selected";
        els.filePreview.textContent = "Select a file to preview it here.";
        els.downloadFileBtn.classList.add("hidden");
        renderNavigationState();
    }

    async function runAction(action) {
        if (!state.selectedApp) {
            showToast("Select an app first.", "error");
            setCurrentView("app", { scroll: true, silent: true });
            return;
        }

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

            els.actionOutput.textContent = [payload.message, payload.detail].filter(Boolean).join("\n\n") || "Action completed.";
            els.actionOutput.classList.remove("empty");
            showToast(payload.message || "Action completed.", "success");

            if (action === "remove") {
                clearSelectedState();
                renderEmptyState();
                await refreshAllSilently();
                setCurrentView("app", { scroll: false, silent: true });
                setDetailView("overview", { scroll: false, silent: true });
                return;
            }

            if (payload.app) {
                state.appDetail = payload.app;
                renderSelectedApp();
            }

            await Promise.all([refreshAllSilently(), refreshLogs(), refreshFiles()]);
        } catch (err) {
            showToast(extractError(err), "error");
        } finally {
            clearBusy();
        }
    }

    async function refreshAllSilently() {
        const payload = await api("/api/miniapp/bootstrap");
        state.apps = Array.isArray(payload.apps) ? payload.apps : [];
        renderSummary(payload);
        renderApps();

        if (state.selectedApp && !state.apps.some((app) => app.name === state.selectedApp)) {
            clearSelectedState();
            renderEmptyState();
            setCurrentView("app", { scroll: false, silent: true });
            setDetailView("overview", { scroll: false, silent: true });
        }
    }

    async function refreshLogs() {
        if (!state.selectedApp) {
            paintLogViewer();
            return;
        }

        try {
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/logs?lines=${state.logLines}`);
            state.logs.stdout = payload.stdout || "";
            state.logs.stderr = payload.stderr || "";
            paintLogViewer();
        } catch (err) {
            showToast(extractError(err), "error");
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
        const content = state.selectedApp
            ? (state.activeLogTab === "stdout" ? state.logs.stdout : state.logs.stderr)
            : "";
        const isEmpty = !content;
        const fallback = state.selectedApp
            ? `No ${state.activeLogTab} output yet.`
            : "Choose an app to load logs.";

        els.logViewer.textContent = content || fallback;
        els.logViewer.classList.toggle("empty", isEmpty);
    }

    async function refreshFiles() {
        if (!state.selectedApp) {
            els.fileList.innerHTML = '<div class="empty-note">Choose an app to open the file manager.</div>';
            return;
        }

        try {
            const payload = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/files?path=${encodeURIComponent(state.filePath)}`);
            state.filePath = payload.path || ".";
            renderBreadcrumbs(state.filePath);
            renderFileList(payload);
        } catch (err) {
            showToast(extractError(err), "error");
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
        const currentPathLabel = payload.path === "." ? state.selectedApp : `${state.selectedApp}/${payload.path}`;
        const items = Array.isArray(payload.items) ? [...payload.items] : [];
        items.sort((left, right) => {
            if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
            return String(left.name || "").localeCompare(String(right.name || ""), undefined, {
                numeric: true,
                sensitivity: "base"
            });
        });

        els.filePathLabel.textContent = currentPathLabel;
        els.fileUpBtn.disabled = !payload.parentPath;

        if (!items.length && !payload.parentPath) {
            els.fileList.innerHTML = '<div class="empty-note">This folder is empty.</div>';
            return;
        }

        const rows = [];

        if (payload.parentPath) {
            rows.push(`
                <button class="file-row file-row-parent" data-path="${escapeAttr(payload.parentPath)}" data-type="dir" type="button">
                    <span class="file-icon up" aria-hidden="true"></span>
                    <span class="file-main">
                        <span class="file-name">..</span>
                        <span class="file-subtitle">Parent folder</span>
                    </span>
                    <span class="file-kind">Up</span>
                </button>
            `);
        }

        rows.push(...items.map((item) => `
            <button class="file-row ${item.type === "dir" ? "is-dir" : "is-file"}" data-path="${escapeAttr(item.path)}" data-type="${escapeAttr(item.type)}" type="button">
                <span class="file-icon ${item.type === "dir" ? "dir" : "file"}" aria-hidden="true"></span>
                <span class="file-main">
                    <span class="file-name">${escapeHtml(item.name)}${item.type === "dir" ? "/" : ""}</span>
                    <span class="file-subtitle">${escapeHtml(item.modifiedAt || "-")}</span>
                </span>
                <span class="file-kind">${escapeHtml(item.type === "dir" ? "Folder" : item.sizeLabel || "-")}</span>
            </button>
        `));

        els.fileList.innerHTML = `
            <div class="file-table-head">
                <span>Name</span>
                <span>Modified</span>
                <span>Type / Size</span>
            </div>
            <div class="file-rows">${rows.join("")}</div>
        `;

        els.fileList.querySelectorAll("[data-path]").forEach((button) => {
            button.addEventListener("click", () => {
                if (button.dataset.type === "dir") {
                    openDir(button.dataset.path);
                    return;
                }
                openFile(button.dataset.path);
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

        await refreshFiles();
        if (isMobileView()) {
            setCurrentView("app", { scroll: false, silent: true });
            setDetailView("files", { scroll: false, silent: true });
        }
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

            if (isMobileView()) {
                setCurrentView("app", { scroll: false, silent: true });
                setDetailView("files", { scroll: false, silent: true });
            }
        } catch (err) {
            showToast(extractError(err), "error");
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
            showToast(extractError(err), "error");
        } finally {
            clearBusy();
        }
    }

    function handleBottomTabPress(view) {
        setCurrentView(view, { scroll: true });
    }

    function handleDetailTabPress(view) {
        if (!state.selectedApp) {
            showToast("Select an app first.", "error");
            setCurrentView("app", { scroll: false, silent: true });
            return;
        }
        setCurrentView("app", { scroll: false, silent: true });
        setDetailView(view, { scroll: false, silent: true });
    }

    function setCurrentView(view, options) {
        const { scroll = true, silent = false } = options || {};
        let nextView = PRIMARY_VIEWS.has(view) ? view : "app";
        if (!isMobileView()) nextView = "app";

        state.currentView = nextView;
        renderNavigationState();

        if (scroll && isMobileView()) {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    function setDetailView(view, options) {
        const { scroll = true, silent = false } = options || {};
        let nextView = DETAIL_VIEWS.has(view) ? view : "overview";

        if (!state.selectedApp && nextView !== "overview") {
            if (!silent) showToast("Select an app first.", "error");
            nextView = "overview";
        }

        state.detailView = nextView;
        renderNavigationState();

        if (scroll && isMobileView()) {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    function renderNavigationState() {
        const mobile = isMobileView();
        const bodyView = mobile
            ? (state.currentView === "app" ? state.detailView : state.currentView)
            : state.detailView;

        document.body.dataset.view = bodyView;

        const showAppWorkspace = mobile ? state.currentView === "app" : true;
        els.appsPanel.classList.toggle("is-active", showAppWorkspace);
        els.detailShell.classList.toggle("is-active", showAppWorkspace);
        if (els.statusPanel) els.statusPanel.classList.toggle("is-active", mobile && state.currentView === "status");
        if (els.vpsPanel) els.vpsPanel.classList.toggle("is-active", mobile && state.currentView === "vps");
        if (els.userPanel) els.userPanel.classList.toggle("is-active", mobile && state.currentView === "user");

        els.contentTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.detailView);
        });
        els.bottomTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.currentView);
        });

        els.overviewPanel.classList.toggle("is-active", state.detailView === "overview");
        els.logsPanel.classList.toggle("is-active", state.detailView === "logs");
        els.filesPanel.classList.toggle("is-active", state.detailView === "files");

        els.emptySelectionNotice.classList.toggle("hidden", !(mobile && state.currentView === "app" && !state.selectedApp));
        syncBackButton();
    }

    function syncBackButton() {
        if (!tg || !tg.BackButton) return;

        try {
            if (!isMobileView()) {
                tg.BackButton.hide();
                return;
            }

            if (state.currentView !== "app" || state.detailView !== "overview") {
                tg.BackButton.show();
            } else {
                tg.BackButton.hide();
            }
        } catch {
            // ignore bridge errors
        }
    }

    function isMobileView() {
        return window.matchMedia(MOBILE_MEDIA).matches;
    }

    function clearSelectedState() {
        state.selectedApp = null;
        state.appDetail = null;
        state.logs.stdout = "";
        state.logs.stderr = "";
        resetFileState();
        renderApps();
    }

    function resetFileState() {
        state.filePath = ".";
        state.currentFilePath = null;
        state.currentFileDownloadPath = null;
    }

    function renderStatusPanel() {
        if (!els.statusCards || !els.runningAppsList) return;

        const summary = state.summary || {};
        const runningApps = state.apps.filter((app) => app.status === "running");
        const stoppedApps = Math.max((summary.totalApps || 0) - (summary.runningApps || 0), 0);
        const selectedLabel = state.selectedApp || "No app selected";

        els.statusCards.innerHTML = [
            metricPanelCard("Apps", String(summary.totalApps || 0), `${summary.pinnedApps || 0} pinned`, "warm"),
            metricPanelCard("Running", String(summary.runningApps || 0), `${stoppedApps} stopped`, "success"),
            metricPanelCard("Selected", selectedLabel, state.appDetail ? (state.appDetail.branch || "-") : "Choose from App", "accent")
        ].join("");

        if (!runningApps.length) {
            els.runningAppsList.innerHTML = '<div class="empty-note">No apps are running right now.</div>';
            return;
        }

        els.runningAppsList.innerHTML = runningApps.map((app) => `
            <article class="status-row">
                <div class="status-row-main">
                    <strong>${escapeHtml(app.name)}</strong>
                    <span>${escapeHtml(app.branch || "main")}</span>
                </div>
                <span class="status-badge running">running</span>
            </article>
        `).join("");
    }

    function renderVpsPanel() {
        if (!els.vpsCards || !els.vpsInfoGrid) return;

        const vps = state.vps || {};
        const memory = vps.memory || {};
        const disk = vps.disk || {};

        els.vpsCards.innerHTML = [
            metricPanelCard("Memory", `${memory.usedLabel || "-"} / ${memory.totalLabel || "-"}`, `${memory.percent ?? "-"}% used`, "accent"),
            metricPanelCard("Disk", `${disk.used || "-"} / ${disk.total || "-"}`, disk.percent || "-", "warm"),
            metricPanelCard("CPU", String(vps.cpuCount || 0), vps.cpuModel || "-", "success"),
            metricPanelCard("Bot", vps.botUptime || "-", `Host uptime ${vps.uptime || "-"}`, "")
        ].join("");

        els.vpsInfoGrid.innerHTML = [
            infoCard("Host", vps.host || "-"),
            infoCard("OS", vps.os || "-"),
            infoCard("Node", vps.node || "-"),
            infoCard("Load", Array.isArray(vps.load) ? vps.load.join(" / ") : "-")
        ].join("");
    }

    function renderUserPanel() {
        if (!els.userInfoGrid) return;

        const user = state.user || {};
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

        els.userInfoGrid.innerHTML = [
            infoCard("Name", fullName || "-"),
            infoCard("Username", user.username ? `@${user.username}` : "-"),
            infoCard("Telegram ID", user.id ? String(user.id) : "-"),
            infoCard("Role", user.id ? "Admin" : "Telegram auth required"),
            infoCard("Mini App URL", state.webAppUrl || "-")
        ].join("");
    }

    function metricPanelCard(label, value, hint, tone) {
        const classes = tone ? ` ${escapeAttr(tone)}` : "";
        return `
            <article class="aux-card${classes}">
                <span class="aux-card-label">${escapeHtml(label)}</span>
                <strong class="aux-card-value">${escapeHtml(value || "-")}</strong>
                <small class="aux-card-hint">${escapeHtml(hint || "-")}</small>
            </article>
        `;
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
    function showToast(text, tone) {
        els.toast.textContent = text;
        els.toast.classList.remove("hidden");
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);

        if (tg && tg.HapticFeedback && typeof tg.HapticFeedback.notificationOccurred === "function") {
            try {
                tg.HapticFeedback.notificationOccurred(tone === "error" ? "error" : "success");
            } catch {
                // ignore haptic errors
            }
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

    function summaryCard(label, value, tone, layout) {
        const classes = [tone, layout].filter(Boolean).map((item) => ` ${escapeAttr(item)}`).join("");
        return `
            <div class="summary-card${classes}">
                <span class="summary-card-label">${escapeHtml(label)}</span>
                <strong class="summary-card-value">${escapeHtml(value || "-")}</strong>
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
