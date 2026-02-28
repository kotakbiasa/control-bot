const { nowIso } = require("../utils");
const { getChatIdFromCtx, parseCallbackAppName } = require("./helpers");

const panelStateByChat = new Map();

function basePanelState() {
    return {
        view: "main",
        selectedApp: null,
        output: "",
        outputIsHtml: false,
        confirmRemove: false,
        fmPath: ".",
        fmPage: 1,
        updatedAt: nowIso()
    };
}

function getPanelState(chatId) {
    const existing = panelStateByChat.get(chatId);
    if (existing) return existing;
    const initial = basePanelState();
    panelStateByChat.set(chatId, initial);
    return initial;
}

function syncPanelStateWithApps(state, db) {
    const apps = db.getApps();
    const selectedApp = state.selectedApp && apps[state.selectedApp] ? state.selectedApp : null;
    // Views that don't require a selected app
    const globalViews = ["main", "bot_settings", "vps"];
    let view = selectedApp || globalViews.includes(state.view) ? state.view : "main";
    if (view === "file_manager" && !selectedApp) view = "main";
    return {
        ...state,
        selectedApp,
        view
    };
}

function setPanelState(chatId, patch, db) {
    const current = syncPanelStateWithApps(getPanelState(chatId), db);
    const merged = {
        ...current,
        ...patch,
        updatedAt: nowIso()
    };
    const synced = syncPanelStateWithApps(merged, db);
    panelStateByChat.set(chatId, synced);
    return synced;
}

function selectedAppFromState(chatId, db) {
    const state = setPanelState(chatId, {}, db);
    const name = state.selectedApp;
    if (!name) return null;
    const app = db.getApp(name);
    if (!app) return null;
    return { name, app };
}

function appNameFromPanelMessage(ctx, db) {
    const message = ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message : null;
    if (!message || typeof message.text !== "string") {
        return null;
    }

    const match = message.text.match(/Menu (?:Aplikasi|Pengaturan):\s*([A-Za-z0-9_-]+)/i);
    if (!match) {
        return null;
    }

    const appName = match[1];
    return db.getApp(appName) ? appName : null;
}

function resolveSelectedAppForNav(ctx, explicitRaw, db) {
    if (explicitRaw) {
        const explicitName = parseCallbackAppName(explicitRaw);
        if (db.getApp(explicitName)) {
            return explicitName;
        }
    }

    const chatId = getChatIdFromCtx(ctx);
    if (chatId) {
        const state = syncPanelStateWithApps(getPanelState(chatId), db);
        if (state.selectedApp && db.getApp(state.selectedApp)) {
            return state.selectedApp;
        }
    }

    return appNameFromPanelMessage(ctx, db);
}

module.exports = {
    basePanelState,
    getPanelState,
    syncPanelStateWithApps,
    setPanelState,
    selectedAppFromState,
    appNameFromPanelMessage,
    resolveSelectedAppForNav
};
