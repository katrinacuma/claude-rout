// «Claude на rout.my» — окно Electron. Поднимает сервер внутри себя, показывает интерфейс.
import { app, BrowserWindow, shell, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { browser, closeBrowser, setHost } from "./browser.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
let win = null;
let srv = null;

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5",
    title: "Claude на rout.my",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  setHost(win, (st) => srv?.browserState(st));
  win.on("closed", () => {
    win = null;
    closeBrowser();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // ссылки вида file:/// (открыть папку чата) — в Проводник
  win.webContents.on("will-navigate", (e, u) => {
    if (!u.startsWith(url)) {
      e.preventDefault();
      shell.openExternal(u);
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      app.setAppUserModelId("Claude на rout.my");
    } catch {}
    srv = await import("../server/index.mjs");
    srv.setBrowser(browser);
    const url = await srv.startServer();
    createWindow(url);
    app.on("activate", () => {
      if (!win) createWindow(url);
    });
  });

  app.on("window-all-closed", () => {
    try {
      srv?.stopAll();
    } catch {}
    if (process.platform !== "darwin") app.quit();
  });
}
