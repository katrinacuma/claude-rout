// Встроенный браузер для Claude — панель справа в главном окне (WebContentsView), как панель
// артефактов в настольном Claude. Claude управляет ею через MCP-инструменты
// (server/mcp-browser.mjs → HTTP /browser → сюда); пользователь видит всё и может открыть панель сам.
import { WebContentsView, shell } from "electron";

let host = null; // главное окно
let view = null;
let visible = false;
let onState = () => {};
const consoleBuf = [];
const HEAD = 44; // высота шапки панели, которую рисует интерфейс
const MAX_W = 1280;

export function setHost(win, stateCb) {
  host = win;
  onState = stateCb || onState;
  win.on("resize", layout);
  win.on("closed", () => {
    host = null;
    view = null;
  });
}

function paneWidth() {
  const [w] = host.getContentSize();
  return Math.max(420, Math.round(w * 0.46));
}

function ensure() {
  if (view) return view;
  view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  view.setBackgroundColor("#ffffff");
  view.webContents.on("console-message", (_e, level, message, line, source) => {
    consoleBuf.push({ level: ["debug", "info", "warn", "error"][level] || String(level), message, line, source, at: Date.now() });
    if (consoleBuf.length > 300) consoleBuf.shift();
  });
  view.webContents.on("did-navigate", emit);
  view.webContents.on("did-navigate-in-page", emit);
  view.webContents.on("page-title-updated", emit);
  view.webContents.setWindowOpenHandler(({ url }) => {
    view.webContents.loadURL(url);
    return { action: "deny" };
  });
  return view;
}

export function state() {
  return {
    open: visible,
    width: visible && host ? paneWidth() : 0,
    head: HEAD,
    url: view ? view.webContents.getURL() : "",
    title: view ? view.webContents.getTitle() : "",
  };
}
const emit = () => onState(state());

function layout() {
  if (!host || !view || !visible) return;
  const [w, h] = host.getContentSize();
  const pw = paneWidth();
  view.setBounds({ x: w - pw, y: HEAD, width: pw, height: h - HEAD });
  emit();
}

export function open() {
  if (!host) throw new Error("нет окна");
  ensure();
  if (!visible) {
    host.contentView.addChildView(view);
    visible = true;
  }
  layout();
  return state();
}

export function close() {
  if (view && visible && host) host.contentView.removeChildView(view);
  visible = false;
  emit();
  return state();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function loaded(v, timeout = 20000) {
  if (!v.webContents.isLoading()) return;
  await Promise.race([new Promise((r) => v.webContents.once("did-stop-loading", r)), wait(timeout)]);
}
const js = (v, code) => v.webContents.executeJavaScript(code, true);

export const browser = {
  async open() {
    return open();
  },
  async close() {
    return close();
  },
  async state() {
    return state();
  },
  async navigate({ url }) {
    open();
    consoleBuf.length = 0;
    if (!/^[a-z]+:/i.test(url)) url = "http://" + url;
    await view.webContents.loadURL(url).catch((e) => {
      throw new Error(`не открылось: ${e.message}`);
    });
    await loaded(view);
    await wait(300);
    emit();
    return { ok: true, url: view.webContents.getURL(), title: view.webContents.getTitle() };
  },
  async reload() {
    open();
    view.webContents.reload();
    await loaded(view);
    return { ok: true };
  },
  async external() {
    if (view?.webContents.getURL()) shell.openExternal(view.webContents.getURL());
    return { ok: true };
  },
  async screenshot({ maxWidth } = {}) {
    open();
    await loaded(view);
    const img = await view.webContents.capturePage();
    const size = img.getSize();
    const scaled = size.width > (maxWidth || MAX_W) ? img.resize({ width: maxWidth || MAX_W }) : img;
    return { data: scaled.toPNG().toString("base64"), mimeType: "image/png", width: scaled.getSize().width, height: scaled.getSize().height, pageWidth: size.width, pageHeight: size.height };
  },
  async click({ selector, x, y, text }) {
    open();
    if (selector || text) {
      const ok = await js(
        view,
        `(() => { let el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "null"};
          if (!el && ${JSON.stringify(text || "")}) { const t = ${JSON.stringify(text || "")}.toLowerCase();
            const all = [...document.querySelectorAll('a,button,[role=button],input[type=submit],label,summary,li,span,div')];
            el = all.find(e => e.children.length < 3 && (e.innerText||e.value||'').trim().toLowerCase() === t)
              || all.find(e => (e.innerText||e.value||'').toLowerCase().includes(t)); }
          if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`
      );
      if (!ok) throw new Error("элемент не найден");
      await wait(300);
      return { ok: true };
    }
    if (typeof x !== "number" || typeof y !== "number") throw new Error("нужны selector, text или x,y");
    view.webContents.sendInputEvent({ type: "mouseMove", x, y });
    view.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    view.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await wait(300);
    return { ok: true };
  },
  async type({ selector, text, submit }) {
    open();
    if (selector) {
      const ok = await js(view, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ('value' in el) el.value = ''; return true; })()`);
      if (!ok) throw new Error("поле не найдено");
    }
    await view.webContents.insertText(String(text ?? ""));
    if (submit) {
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      view.webContents.sendInputEvent({ type: "char", keyCode: "Return" });
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    }
    await wait(200);
    return { ok: true };
  },
  async eval({ code }) {
    open();
    const v = await js(view, `(async () => { try { return await (${code}); } catch (e) { return "ОШИБКА: " + (e && e.message || e); } })()`);
    let out;
    try {
      out = typeof v === "string" ? v : JSON.stringify(v, null, 1);
    } catch {
      out = String(v);
    }
    return { result: String(out ?? "").slice(0, 20000) };
  },
  async text({ maxChars } = {}) {
    open();
    await loaded(view);
    const t = await js(view, `(document.querySelector('main,article')||document.body).innerText`);
    return { url: view.webContents.getURL(), title: view.webContents.getTitle(), text: String(t || "").slice(0, maxChars || 30000) };
  },
  async console({ onlyErrors } = {}) {
    const list = onlyErrors ? consoleBuf.filter((c) => c.level === "error") : consoleBuf;
    return { messages: list.slice(-100) };
  },
  async resize({ width, preset }) {
    // ширина панели ограничена окном; эмулируем узкий экран через CSS-зум страницы не будем —
    // просто сообщаем реальные размеры, а mobile делаем зумом 0.5 для взгляда на мобильную вёрстку
    open();
    const sizes = { mobile: 0.5, tablet: 0.75, desktop: 1 };
    const z = preset && sizes[preset] ? sizes[preset] : width ? Math.min(1, paneWidth() / width) : 1;
    view.webContents.setZoomFactor(z);
    await wait(300);
    const b = view.getBounds();
    return { ok: true, viewport: { width: Math.round(b.width / z), height: Math.round(b.height / z) }, zoom: z };
  },
  async scroll({ dy, dx, selector }) {
    open();
    await js(view, selector ? `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})` : `window.scrollBy(${dx || 0}, ${dy || 600})`);
    await wait(250);
    return { ok: true };
  },
  async back() {
    open();
    if (view.webContents.canGoBack()) view.webContents.goBack();
    await loaded(view);
    return { ok: true, url: view.webContents.getURL() };
  },
};

export function closeBrowser() {
  try {
    close();
    view?.webContents.close();
  } catch {}
  view = null;
}
