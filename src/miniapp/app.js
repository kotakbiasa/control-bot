(function () {
    const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    const MOBILE_MEDIA = "(max-width: 980px)";
    const PRIMARY_VIEWS = new Set(["app", "status", "vps", "user"]);
    const DETAIL_VIEWS = new Set(["overview", "settings", "logs", "files"]);

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
        els.settingsPanel = document.getElementById("settingsPanel");
        els.logsPanel = document.getElementById("logsPanel");
        els.filesPanel = document.getElementById("filesPanel");
        els.appMeta = document.getElementById("appMeta");
        els.overviewInsights = document.getElementById("overviewInsights");
        els.runtimeProfileList = document.getElementById("runtimeProfileList");
        els.runtimeActions = document.getElementById("runtimeActions");
        els.deployActions = document.getElementById("deployActions");
        els.dangerActions = document.getElementById("dangerActions");
        els.actionOutput = document.getElementById("actionOutput");
        els.settingsStatusRail = document.getElementById("settingsStatusRail");
        els.commandForm = document.getElementById("commandForm");
        els.commandInstallInput = document.getElementById("commandInstallInput");
        els.commandBuildInput = document.getElementById("commandBuildInput");
        els.commandStartInput = document.getElementById("commandStartInput");
        els.resetCommandsBtn = document.getElementById("resetCommandsBtn");
        els.pythonStateCard = document.getElementById("pythonStateCard");
        els.togglePythonBtn = document.getElementById("togglePythonBtn");
        els.rebuildPythonBtn = document.getElementById("rebuildPythonBtn");
        els.dockerForm = document.getElementById("dockerForm");
        els.dockerModeSwitch = document.getElementById("dockerModeSwitch");
        els.dockerModeButtons = Array.from(document.querySelectorAll("[data-docker-mode]"));
        els.dockerModeInput = document.getElementById("dockerModeInput");
        els.dockerPortsInput = document.getElementById("dockerPortsInput");
        els.dockerVolumesInput = document.getElementById("dockerVolumesInput");
        els.dockerArgsInput = document.getElementById("dockerArgsInput");
        els.resetDockerBtn = document.getElementById("resetDockerBtn");
        els.envForm = document.getElementById("envForm");
        els.envKeyInput = document.getElementById("envKeyInput");
        els.envValueInput = document.getElementById("envValueInput");
        els.envVarList = document.getElementById("envVarList");
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
        els.userHub = document.getElementById("userHub");
        els.userHubAvatar = document.getElementById("userHubAvatar");
        els.userHubName = document.getElementById("userHubName");
        els.userHubMeta = document.getElementById("userHubMeta");
        els.userSectionContent = document.getElementById("userSectionContent");
        els.settingsSectionContent = document.getElementById("settingsSectionContent");
        els.infoSectionContent = document.getElementById("infoSectionContent");
        els.busyOverlay = document.getElementById("busyOverlay");
        els.busyText = document.getElementById("busyText");
        els.toast = document.getElementById("toast");
    }

    function bindEvents() {
        els.refreshAllBtn.addEventListener("click", () => refreshAll());
        els.refreshSelectedBtn.addEventListener("click", () => refreshSelectedApp());
        els.userBadge.addEventListener("click", () => {
            if (!isMobileView()) return;
            setCurrentView(state.currentView === "user" ? "app" : "user", { scroll: true, silent: true });
        });

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

        [els.runtimeActions, els.deployActions, els.dangerActions].forEach((container) => {
            if (!container) return;
            container.addEventListener("click", (event) => {
                const button = event.target.closest("[data-action]");
                if (!button) return;
                runAction(button.dataset.action);
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
        els.commandForm.addEventListener("submit", handleCommandSubmit);
        els.resetCommandsBtn.addEventListener("click", () => populateCommandForm(state.appDetail));
        els.togglePythonBtn.addEventListener("click", () => runAction("toggle_python_venv"));
        els.rebuildPythonBtn.addEventListener("click", () => runAction("rebuild_python_venv"));
        els.dockerModeButtons.forEach((button) => {
            button.addEventListener("click", () => {
                if (!ensureSelectedApp({ silent: true })) return;
                renderDockerModeSwitch(button.dataset.dockerMode || "auto");
            });
        });
        els.dockerForm.addEventListener("submit", handleDockerSubmit);
        els.resetDockerBtn.addEventListener("click", () => populateDockerForm(state.appDetail));
        els.envForm.addEventListener("submit", handleEnvSubmit);
        els.envVarList.addEventListener("click", handleEnvListClick);
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
        const chromeColor = "#f1e2cf";

        if (theme.button_color) root.style.setProperty("--tg-button", theme.button_color);
        if (theme.button_text_color) root.style.setProperty("--tg-button-text", theme.button_text_color);
        if (theme.text_color) root.style.setProperty("--tg-text", theme.text_color);
        if (theme.hint_color) root.style.setProperty("--tg-hint", theme.hint_color);
        if (theme.bg_color) root.style.setProperty("--tg-bg", theme.bg_color);
        if (theme.secondary_bg_color) root.style.setProperty("--tg-secondary-bg", theme.secondary_bg_color);

        try {
            if (typeof tg.setHeaderColor === "function") tg.setHeaderColor(chromeColor);
            if (typeof tg.setBackgroundColor === "function") tg.setBackgroundColor(chromeColor);
        } catch {
            // ignore theme bridge errors
        }

        if (themeColor) {
            themeColor.setAttribute("content", chromeColor);
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
        renderUserHub();
    }

    function renderApps() {
        const filteredApps = state.apps.filter((app) => {
            if (state.appFilter === "running" && app.status !== "running") return false;
            if (state.appFilter === "pinned" && !app.pinned) return false;
            if (state.appQuery && !String(app.name || "").toLowerCase().includes(state.appQuery)) return false;
            return true;
        }).sort((left, right) => {
            const runningDelta = Number(right.status === "running") - Number(left.status === "running");
            if (runningDelta) return runningDelta;
            const pinnedDelta = Number(right.pinned) - Number(left.pinned);
            if (pinnedDelta) return pinnedDelta;
            return String(left.name || "").localeCompare(String(right.name || ""));
        });

        if (!filteredApps.length) {
            els.appList.innerHTML = '<div class="empty-note">No apps match the current filter.</div>';
            return;
        }

        els.appList.innerHTML = filteredApps.map((app) => {
            const activeClass = state.selectedApp === app.name ? "active" : "";
            const statusClass = app.status === "running" ? "running" : "stopped";
            const branch = app.branch || "main";
            const runtimeMode = String(app.mode || "auto").toUpperCase();
            const pinnedTag = app.pinned ? '<span class="app-tag pinned">Pinned</span>' : "";
            return `
                <button class="app-card ${activeClass}" data-app-name="${escapeAttr(app.name)}" type="button">
                    <div class="app-card-head">
                        <span class="status-inline"><span class="status-dot ${statusClass}"></span><span class="app-card-name">${escapeHtml(app.name)}</span></span>
                        <div class="app-card-tags">
                            <span class="app-tag">${escapeHtml(branch)}</span>
                            <span class="app-tag subtle">${escapeHtml(runtimeMode)}</span>
                        </div>
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
        const python = app.python || {};
        const docker = app.docker || {};
        const env = app.env || {};
        const envEntries = Object.entries(env).sort((left, right) => left[0].localeCompare(right[0]));
        const usage = runtime.usage || {};
        const isRunning = runtime.status === "running";
        const runtimeMode = String(runtime.mode || "auto").toUpperCase();
        const pythonState = python.detected
            ? (python.venvEnabled === false ? "Detected, venv off" : `Detected${python.entrypoint ? ` | ${python.entrypoint}` : ""}`)
            : "Not detected";
        const dockerState = docker.detected
            ? `${String(docker.enabled || "auto").toUpperCase()} | Dockerfile`
            : `${String(docker.enabled || "auto").toUpperCase()} | Manual`;
        const subtitle = [
            app.repo || app.directory || "No repository configured.",
            `Mode ${runtimeMode}`,
            python.detected ? `Python ${python.entrypoint || python.venvDir || "detected"}` : "",
            docker.detected ? "Dockerfile detected" : ""
        ].filter(Boolean).join(" | ");
        const summaryItems = [
            {
                label: "Status",
                value: isRunning ? "Running" : "Stopped",
                tone: isRunning ? "success" : "danger"
            },
            { label: "Runtime", value: runtimeMode, tone: runtimeMode === "DOCKER" ? "warm" : "accent" },
            { label: "Branch", value: app.branch || "-" },
            { label: "Env", value: `${envEntries.length} vars`, tone: envEntries.length ? "accent" : "" },
            { label: "Python", value: pythonState, layout: "wide" },
            { label: "Docker", value: dockerState, layout: "wide" }
        ].filter(Boolean);

        els.appTitle.textContent = app.name || "Unnamed app";
        els.appSubtitle.textContent = subtitle;
        els.appStatusBadge.textContent = isRunning ? "Running" : "Stopped";
        els.appStatusBadge.className = `status-badge ${isRunning ? "running" : "stopped"}`;
        els.summaryChips.innerHTML = summaryItems.map((item) => summaryCard(item.label, item.value, item.tone, item.layout)).join("");

        els.appMeta.innerHTML = [
            infoCard("Repository", app.repo || "-"),
            infoCard("Directory", app.directory || "-"),
            infoCard("Branch", app.branch || "-"),
            infoCard("Runtime Mode", runtimeMode),
            infoCard("Status", isRunning ? "Running" : "Stopped"),
            infoCard("PID", runtime.pid ? String(runtime.pid) : "-"),
            infoCard("CPU", usage.cpu ? `${usage.cpu}%` : "-"),
            infoCard("Memory", usage.rss || "-"),
            infoCard("Last Start", runtime.lastStartAt || "-"),
            infoCard("Last Stop", runtime.lastStopAt || "-"),
            infoCard("Last Deploy", app.lastDeployAt || "-"),
            infoCard("Active Command", usage.command || app.startCommand || "-"),
            infoCard("Python", pythonState),
            infoCard("Docker", dockerState),
            infoCard("Env Vars", String(envEntries.length))
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
        renderOverviewSnapshot(app, envEntries);
        renderSettingsStatus(app, envEntries);
        populateCommandForm(app);
        populateDockerForm(app);
        renderPythonState(app);
        renderEnvList(envEntries);
        setSettingsDisabled(false);

        renderNavigationState();
    }

    function renderEmptyState() {
        els.appTitle.textContent = "Select an app";
        els.appSubtitle.textContent = "Choose an app from the radar to inspect its runtime and configuration.";
        els.appStatusBadge.textContent = "Idle";
        els.appStatusBadge.className = "status-badge idle";
        els.summaryChips.innerHTML = "";
        els.appMeta.innerHTML = '<div class="empty-note">No app selected.</div>';
        els.overviewInsights.innerHTML = '<div class="empty-note">Runtime signal will appear here after you select an app.</div>';
        els.runtimeProfileList.innerHTML = '<div class="empty-note">Current runtime profile will appear here.</div>';
        els.runtimeActions.innerHTML = "";
        els.deployActions.innerHTML = "";
        els.dangerActions.innerHTML = "";
        els.actionOutput.textContent = "No action has been run yet.";
        els.actionOutput.classList.add("empty");
        els.settingsStatusRail.innerHTML = '<span class="status-pill">Select an app to unlock runtime settings.</span>';
        populateCommandForm(null);
        populateDockerForm(null);
        renderPythonState(null);
        renderEnvList([]);
        setSettingsDisabled(true);
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

    async function runAction(action, options) {
        if (!ensureSelectedApp()) return null;

        const config = options || {};
        let body = config.body ? { ...config.body } : {};

        if (action === "remove" && !config.skipConfirm) {
            if (!window.confirm(`Remove app "${state.selectedApp}"?`)) return null;
            body.deleteFiles = window.confirm("Delete deployment files and logs too?");
        }

        try {
            setBusy(config.busyText || `Running ${action}...`);
            const payload = await postAction(action, body);
            els.actionOutput.textContent = [payload.message, payload.detail].filter(Boolean).join("\n\n") || "Action completed.";
            els.actionOutput.classList.remove("empty");

            if (action === "remove") {
                clearSelectedState();
                renderEmptyState();
                await refreshAllSilently();
                setCurrentView("app", { scroll: false, silent: true });
                setDetailView("overview", { scroll: false, silent: true });
                showToast(config.successMessage || payload.message || "App removed.", "success");
                return payload;
            }

            await refreshSelectedWorkspace({
                refreshLogs: config.refreshLogs !== false,
                refreshFiles: config.refreshFiles !== false
            });
            showToast(config.successMessage || payload.message || "Action completed.", "success");
            return payload;
        } catch (err) {
            showToast(extractError(err), "error");
            return null;
        } finally {
            clearBusy();
        }
    }

    async function runBatchActions(steps, options) {
        if (!ensureSelectedApp()) return;

        const filteredSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
        if (!filteredSteps.length) {
            showToast((options && options.emptyMessage) || "No changes to save.", "error");
            return;
        }

        try {
            setBusy((options && options.busyText) || "Saving changes...");
            const outputs = [];

            for (const step of filteredSteps) {
                const payload = await postAction(step.action, step.body || {});
                outputs.push([payload.message, payload.detail].filter(Boolean).join("\n\n") || `${step.action} completed.`);
            }

            els.actionOutput.textContent = outputs.join("\n\n---\n\n");
            els.actionOutput.classList.remove("empty");
            await refreshSelectedWorkspace({
                refreshLogs: options && options.refreshLogs !== false,
                refreshFiles: options && options.refreshFiles !== false
            });
            showToast((options && options.successMessage) || "Changes applied.", "success");
        } catch (err) {
            showToast(extractError(err), "error");
        } finally {
            clearBusy();
        }
    }

    async function refreshSelectedWorkspace(options) {
        if (!state.selectedApp) return;

        const detail = await api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}`);
        state.appDetail = detail.app || null;
        renderSelectedApp();

        const tasks = [refreshAllSilently()];
        if (!options || options.refreshLogs !== false) tasks.push(refreshLogs());
        if (!options || options.refreshFiles !== false) tasks.push(refreshFiles());
        await Promise.all(tasks);
    }

    async function handleCommandSubmit(event) {
        event.preventDefault();
        if (!ensureSelectedApp()) return;

        const app = state.appDetail || {};
        const runtime = app.runtime || {};
        const installValue = String(els.commandInstallInput.value || "").trim();
        const buildValue = String(els.commandBuildInput.value || "").trim();
        const startValue = String(els.commandStartInput.value || "").trim();

        if (String(runtime.mode || "").toLowerCase() !== "docker" && !startValue) {
            showToast("Start command tidak boleh kosong untuk runtime process.", "error");
            return;
        }

        const steps = [
            normalizeCommandValue(installValue) !== normalizeCommandValue(app.installCommand) ? { action: "set_cmd_install", body: { value: installValue } } : null,
            normalizeCommandValue(buildValue) !== normalizeCommandValue(app.buildCommand) ? { action: "set_cmd_build", body: { value: buildValue } } : null,
            normalizeCommandValue(startValue) !== normalizeCommandValue(app.startCommand) ? { action: "set_cmd_start", body: { value: startValue } } : null
        ];

        await runBatchActions(steps, {
            busyText: "Saving command profile...",
            successMessage: "Commands updated.",
            refreshLogs: false,
            refreshFiles: false,
            emptyMessage: "Commands are already up to date."
        });
    }

    async function handleDockerSubmit(event) {
        event.preventDefault();
        if (!ensureSelectedApp()) return;

        const mode = String(els.dockerModeInput.value || "auto").trim().toLowerCase();
        if (!["auto", "on", "off"].includes(mode)) {
            showToast("Docker mode harus auto, on, atau off.", "error");
            return;
        }

        await runBatchActions([
            { action: "set_docker_mode", body: { value: mode } },
            { action: "set_docker_ports", body: { value: String(els.dockerPortsInput.value || "").trim() || "off" } },
            { action: "set_docker_volumes", body: { value: String(els.dockerVolumesInput.value || "").trim() || "off" } },
            { action: "set_docker_args", body: { value: String(els.dockerArgsInput.value || "").trim() || "off" } }
        ], {
            busyText: "Applying docker runtime settings...",
            successMessage: "Docker settings updated.",
            refreshLogs: false,
            refreshFiles: false
        });
    }

    async function handleEnvSubmit(event) {
        event.preventDefault();
        if (!ensureSelectedApp()) return;

        const key = String(els.envKeyInput.value || "").trim();
        const value = String(els.envValueInput.value || "");

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            showToast("Env key harus berupa huruf, angka, atau underscore dan tidak boleh diawali angka.", "error");
            return;
        }

        const payload = await runAction("set_env_var", {
            body: { key, value },
            busyText: `Saving ${key}...`,
            successMessage: `Env ${key} updated.`,
            refreshLogs: false,
            refreshFiles: false
        });

        if (payload) {
            els.envKeyInput.value = "";
            els.envValueInput.value = "";
        }
    }

    async function handleEnvListClick(event) {
        const button = event.target.closest("[data-env-fill], [data-env-delete]");
        if (!button) return;
        if (!ensureSelectedApp()) return;

        const fillKey = button.dataset.envFill;
        if (fillKey) {
            const env = (state.appDetail && state.appDetail.env) || {};
            els.envKeyInput.value = fillKey;
            els.envValueInput.value = env[fillKey] == null ? "" : String(env[fillKey]);
            setDetailView("settings", { scroll: true, silent: true });
            return;
        }

        const deleteKey = button.dataset.envDelete;
        if (!deleteKey) return;
        if (!window.confirm(`Delete env "${deleteKey}"?`)) return;

        await runAction("del_env_var", {
            body: { key: deleteKey },
            busyText: `Removing ${deleteKey}...`,
            successMessage: `Env ${deleteKey} deleted.`,
            refreshLogs: false,
            refreshFiles: false
        });
    }

    function populateCommandForm(app) {
        els.commandInstallInput.value = app && app.installCommand ? app.installCommand : "";
        els.commandBuildInput.value = app && app.buildCommand ? app.buildCommand : "";
        els.commandStartInput.value = app && app.startCommand ? app.startCommand : "";
    }

    function populateDockerForm(app) {
        const docker = app && app.docker ? app.docker : {};
        renderDockerModeSwitch(String(docker.enabled || "auto").toLowerCase());
        els.dockerPortsInput.value = Array.isArray(docker.ports) ? docker.ports.join("\n") : "";
        els.dockerVolumesInput.value = Array.isArray(docker.volumes) ? docker.volumes.join("\n") : "";
        els.dockerArgsInput.value = docker.extraArgs || "";
    }

    function renderDockerModeSwitch(mode) {
        const nextMode = ["auto", "on", "off"].includes(String(mode || "").toLowerCase())
            ? String(mode || "").toLowerCase()
            : "auto";
        els.dockerModeInput.value = nextMode;
        els.dockerModeButtons.forEach((button) => {
            button.classList.toggle("active", button.dataset.dockerMode === nextMode);
        });
    }

    function renderPythonState(app) {
        const python = app && app.python ? app.python : {};
        const hasApp = !!app;
        if (!hasApp) {
            els.pythonStateCard.innerHTML = '<div class="empty-note">Select an app to inspect Python runtime.</div>';
            els.togglePythonBtn.textContent = "Toggle Python Venv";
            els.togglePythonBtn.className = "action-btn primary";
            els.rebuildPythonBtn.disabled = true;
            return;
        }
        els.pythonStateCard.innerHTML = [
            statusPill("Detected", python.detected ? "Yes" : "No", python.detected ? "success" : ""),
            statusPill("Venv", python.venvEnabled === false ? "Disabled" : "Enabled", python.venvEnabled === false ? "" : "accent"),
            statusPill("Entrypoint", python.entrypoint || "-", ""),
            statusPill("Folder", python.venvDir || ".venv", "")
        ].join("");
        els.togglePythonBtn.textContent = python.venvEnabled === false ? "Enable Python Venv" : "Disable Python Venv";
        els.togglePythonBtn.className = `action-btn ${python.venvEnabled === false ? "primary" : "success"}`;
        els.rebuildPythonBtn.disabled = !python.detected;
    }

    function renderEnvList(envEntries) {
        if (!envEntries.length) {
            els.envVarList.innerHTML = '<div class="empty-note">No environment variables configured yet.</div>';
            return;
        }

        els.envVarList.innerHTML = envEntries.map(([key, value]) => `
            <article class="env-row">
                <div class="env-row-main">
                    <strong>${escapeHtml(key)}</strong>
                    <code class="env-row-value">${escapeHtml(value == null ? "" : String(value))}</code>
                </div>
                <div class="env-row-actions">
                    <button class="ghost-btn mini-btn" data-env-fill="${escapeAttr(key)}" type="button">Load</button>
                    <button class="ghost-btn mini-btn danger-outline" data-env-delete="${escapeAttr(key)}" type="button">Delete</button>
                </div>
            </article>
        `).join("");
    }

    function renderSettingsStatus(app, envEntries) {
        const runtime = app.runtime || {};
        const python = app.python || {};
        const docker = app.docker || {};
        const runtimeMode = String(runtime.mode || "auto").toUpperCase();
        els.settingsStatusRail.innerHTML = [
            statusPill("Runtime", runtimeMode, runtimeMode === "DOCKER" ? "warm" : "accent"),
            statusPill("Python", python.detected ? (python.venvEnabled === false ? "Detected, venv off" : "Detected") : "Not detected", python.detected ? "success" : ""),
            statusPill("Dockerfile", docker.detected ? "Detected" : "Not detected", docker.detected ? "warm" : ""),
            statusPill("Env", `${envEntries.length} vars`, envEntries.length ? "accent" : "")
        ].join("");
    }

    function renderOverviewSnapshot(app, envEntries) {
        const runtime = app.runtime || {};
        const python = app.python || {};
        const docker = app.docker || {};
        const usage = runtime.usage || {};
        const runtimeMode = String(runtime.mode || "auto").toUpperCase();

        els.overviewInsights.innerHTML = [
            insightCard(
                "Execution Path",
                runtimeMode === "DOCKER" ? "Container runtime" : "Managed process",
                runtimeMode === "DOCKER" ? (docker.containerName || docker.imageTag || "Docker lifecycle") : (usage.command || "Managed by bot"),
                runtimeMode === "DOCKER" ? "warm" : "accent"
            ),
            insightCard(
                "Deploy Signal",
                app.lastDeployAt || "No deploy yet",
                app.branch ? `Branch ${app.branch}` : "No branch configured",
                "success"
            ),
            insightCard(
                "Resource Pulse",
                usage.cpu ? `${usage.cpu}% CPU` : "CPU n/a",
                usage.rss || (runtime.pid ? `PID ${runtime.pid}` : "No active process"),
                runtime.status === "running" ? "success" : ""
            ),
            insightCard(
                "Config Surface",
                `${envEntries.length} env vars`,
                python.detected ? `Python ${python.entrypoint || python.venvDir || "detected"}` : (docker.detected ? "Dockerfile detected" : "Manual runtime"),
                "warm"
            )
        ].join("");

        els.runtimeProfileList.innerHTML = [
            profileRow("Install", app.installCommand || "-"),
            profileRow("Build", app.buildCommand || "-"),
            profileRow("Start", app.startCommand || "-"),
            profileRow("Ports", listToDisplay(docker.ports)),
            profileRow("Volumes", listToDisplay(docker.volumes)),
            profileRow("Extra Args", docker.extraArgs || "-"),
            profileRow("Uptime", usage.etime || "-"),
            profileRow("Last Exit", runtime.lastExitCode == null ? "-" : String(runtime.lastExitCode))
        ].join("");
    }

    function setSettingsDisabled(disabled) {
        [
            els.commandInstallInput,
            els.commandBuildInput,
            els.commandStartInput,
            els.resetCommandsBtn,
            els.togglePythonBtn,
            els.rebuildPythonBtn,
            els.dockerPortsInput,
            els.dockerVolumesInput,
            els.dockerArgsInput,
            els.resetDockerBtn,
            els.envKeyInput,
            els.envValueInput
        ].forEach((element) => {
            if (element) element.disabled = disabled;
        });
        els.dockerModeButtons.forEach((button) => {
            button.disabled = disabled;
        });
        els.commandForm.querySelector('button[type="submit"]').disabled = disabled;
        els.dockerForm.querySelector('button[type="submit"]').disabled = disabled;
        els.envForm.querySelector('button[type="submit"]').disabled = disabled;
    }

    function ensureSelectedApp(options) {
        if (state.selectedApp) return true;
        if (!options || !options.silent) showToast("Select an app first.", "error");
        setCurrentView("app", { scroll: true, silent: true });
        setDetailView("overview", { scroll: false, silent: true });
        return false;
    }

    async function postAction(action, body) {
        return api(`/api/miniapp/apps/${encodeURIComponent(state.selectedApp)}/actions/${action}`, {
            method: "POST",
            body: JSON.stringify(body || {})
        });
    }

    function normalizeCommandValue(value) {
        return String(value || "").trim();
    }

    function listToDisplay(value) {
        return Array.isArray(value) && value.length ? value.join(", ") : "-";
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
        if (els.userHub) els.userHub.classList.toggle("is-active", mobile && state.currentView === "user");

        els.contentTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.detailView);
        });
        els.bottomTabs.forEach((button) => {
            button.classList.toggle("active", button.dataset.viewTarget === state.currentView);
        });

        els.overviewPanel.classList.toggle("is-active", state.detailView === "overview");
        els.settingsPanel.classList.toggle("is-active", state.detailView === "settings");
        els.logsPanel.classList.toggle("is-active", state.detailView === "logs");
        els.filesPanel.classList.toggle("is-active", state.detailView === "files");

        els.emptySelectionNotice.classList.toggle("hidden", !(mobile && state.currentView === "app" && !state.selectedApp));
        renderUserHub();
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

    function renderUserHub() {
        if (!els.userHubName) return;

        const user = state.user || {};
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
        const username = user.username ? `@${user.username}` : "-";
        const role = user.id ? "Admin" : "Telegram auth required";
        const accountName = fullName || (user.username ? `@${user.username}` : (user.id ? `ID ${user.id}` : "Telegram session"));
        const accountMeta = user.id
            ? [username !== "-" ? username : "", `ID ${user.id}`].filter(Boolean).join(" | ")
            : "Open this Mini App from Telegram to load account data.";
        const initials = accountName
            .replace(/^@/, "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part.charAt(0).toUpperCase())
            .join("") || "TG";
        const activeScreen = state.currentView === "app"
            ? `App / ${capitalizeWord(state.detailView)}`
            : capitalizeWord(state.currentView);
        const layoutMode = isMobileView() ? "Mobile" : "Desktop";

        els.userHubAvatar.textContent = initials;
        els.userHubName.textContent = accountName;
        els.userHubMeta.textContent = accountMeta;
        els.userSectionContent.innerHTML = kvList([
            { label: "Name", value: fullName || "-" },
            { label: "Username", value: username },
            { label: "Telegram ID", value: user.id ? String(user.id) : "-" },
            { label: "Role", value: role }
        ]);
        els.settingsSectionContent.innerHTML = kvList([
            { label: "Layout", value: layoutMode },
            { label: "Active Screen", value: activeScreen },
            { label: "Selected App", value: state.selectedApp || "No app selected" },
            { label: "Theme", value: tg && tg.colorScheme ? `Telegram ${capitalizeWord(tg.colorScheme)}` : "Telegram synced" }
        ]);
        els.infoSectionContent.innerHTML = kvList([
            { label: "Mini App URL", value: state.webAppUrl || "-" },
            { label: "Auth", value: user.id ? "Signed in via Telegram" : "Telegram auth required" },
            { label: "Refresh", value: "Use Refresh in the header to reload app, VPS, and status data." }
        ]);
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

    function insightCard(label, value, hint, tone) {
        const classes = tone ? ` ${escapeAttr(tone)}` : "";
        return `
            <article class="spotlight-card${classes}">
                <span class="spotlight-label">${escapeHtml(label)}</span>
                <strong class="spotlight-value">${escapeHtml(value || "-")}</strong>
                <small class="spotlight-hint">${escapeHtml(hint || "-")}</small>
            </article>
        `;
    }

    function profileRow(label, value) {
        return `
            <div class="profile-row">
                <span class="profile-label">${escapeHtml(label)}</span>
                <span class="profile-value">${escapeHtml(value || "-")}</span>
            </div>
        `;
    }

    function statusPill(label, value, tone) {
        const classes = tone ? ` ${escapeAttr(tone)}` : "";
        return `
            <div class="status-pill${classes}">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(value || "-")}</strong>
            </div>
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

    function kvList(items) {
        return `
            <div class="kv-list">
                ${items.map((item) => `
                    <div class="kv-row">
                        <span class="kv-row-label">${escapeHtml(item.label)}</span>
                        <span class="kv-row-value">${escapeHtml(item.value || "-")}</span>
                    </div>
                `).join("")}
            </div>
        `;
    }

    function capitalizeWord(value) {
        const text = String(value || "").trim();
        return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "-";
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
