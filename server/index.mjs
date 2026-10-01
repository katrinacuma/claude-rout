/**
 * Сервер окна «Claude на rout.my».
 *
 * - раздаёт public/ по HTTP,
 * - держит WebSocket с окном,
 * - ведёт список чатов (data/chats.json) — сами транскрипты пишет Claude Code в ~/.claude/projects,
 * - держит по одному процессу Claude Code на открытый чат (server/claude.mjs),
 * - поднимает мост Anthropic→rout.my, если тот не поднят.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ClaudeProcess } from "./claude.mjs";
import { findTranscript, messagesFromTranscript } from "./history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");
const CFG_FILE = path.join(DATA, "config.json");
const CHATS_FILE = path.join(DATA, "chats.json");

/* ───────────── конфиг и список чатов ───────────── */

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

const CFG = readJson(CFG_FILE, {});
CFG.port ||= 5179;
CFG.engine ||= "subscription"; // "rout" — через мост (bridgeUrl), "subscription" — обычный вход Claude Code
CFG.bridgeUrl ||= "http://127.0.0.1:8787";
CFG.bridgeDir ||= "../anthropic-bridge"; // мост — отдельный локальный проект, в этот репозиторий не входит
CFG.bridgeScript ||= "bridge.mjs";
CFG.permissionMode ||= "default";
CFG.idleKillMinutes ||= 15;
CFG.defaultCwd ||= os.homedir();
CFG.recentCwds ||= [CFG.defaultCwd];
function saveCfg() {
  writeJson(CFG_FILE, CFG);
}

const expandEnv = (s) => String(s).replace(/%([^%]+)%/g, (_, n) => process.env[n] ?? "");
const CLAUDE_EXE = expandEnv(CFG.claudeExe || "%APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");

let chats = readJson(CHATS_FILE, []);
function saveChats() {
  writeJson(CHATS_FILE, chats);
}
const chatById = (id) => chats.find((c) => c.id === id);

/* ───────────── мост ───────────── */

async function bridgeHealth() {
  try {
    const r = await fetch(CFG.bridgeUrl + "/health", { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function ensureBridge() {
  let h = await bridgeHealth();
  if (h) return h;
  const dir = path.resolve(ROOT, CFG.bridgeDir);
  const script = path.join(dir, CFG.bridgeScript);
  if (!fs.existsSync(script)) {
    console.log("[мост] не найден:", script);
    return null;
  }
  console.log("[мост] поднимаю", script);
  const child = spawn(process.execPath, [script], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    h = await bridgeHealth();
    if (h) return h;
  }
  return null;
}

function engineEnv(engine) {
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "MAX_THINKING_TOKENS"]) delete env[k];
  if (engine === "rout") {
    env.ANTHROPIC_BASE_URL = CFG.bridgeUrl;
    env.ANTHROPIC_AUTH_TOKEN = "rout";
    env.ANTHROPIC_API_KEY = "rout";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    // размышления: Claude Code шлёт thinking.budget_tokens, мост переводит в reasoning
    const tt = CFG.thinkingTokens ?? 8000;
    if (tt > 0) env.MAX_THINKING_TOKENS = String(tt);
  }
  env.CLAUDE_ROUT_PORT = String(CFG.port);
  return env;
}

/* ───────────── встроенный браузер (MCP) ───────────── */

let browser = null; // контроллер из Electron (electron/browser.mjs); в безголовом режиме — null
let browserSt = { open: false, width: 0, head: 44, url: "", title: "" };
export function setBrowser(b) {
  browser = b;
}
export function browserState(st) {
  browserSt = st;
  broadcast({ type: "browser.state", state: st });
}
const MCP_FILE = path.join(DATA, "mcp.json");
function writeMcpConfig() {
  writeJson(MCP_FILE, {
    mcpServers: {
      browser: { command: process.execPath.endsWith("node.exe") ? process.execPath : "node", args: [path.join(HERE, "mcp-browser.mjs")], env: { CLAUDE_ROUT_PORT: String(CFG.port) } },
    },
  });
  return MCP_FILE;
}

/* ───────────── процессы Claude ───────────── */

const procs = new Map(); // chatId → ClaudeProcess
const sockets = new Set();
let lastInit = null; // что подключено у Claude Code (скиллы, плагины, агенты) — из последнего init

async function bridgeCatalog() {
  try {
    const r = await fetch(CFG.bridgeUrl + "/catalog", { signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
}
const chatEvent = (id, ev) => broadcast({ type: "chat.event", id, ev });

function publicChats() {
  return [...chats].sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((c) => ({ ...c, running: procs.has(c.id), busy: !!procs.get(c.id)?.busy }));
}
const pushChats = () => broadcast({ type: "chats", list: publicChats() });

async function getProc(chat) {
  let p = procs.get(chat.id);
  if (p?.alive) return p;
  if (chat.engine !== "subscription" && CFG.engine !== "subscription") {
    const h = await ensureBridge();
    if (!h) throw new Error("Мост не поднялся. Проверьте bridgeDir и bridgeScript в data/config.json или переключитесь на подписку.");
  }
  const engine = chat.engine || CFG.engine;
  const model = chat.model || (engine === "rout" ? CFG.model : CFG.subscriptionModel) || undefined;
  p = new ClaudeProcess({
    exe: CLAUDE_EXE,
    cwd: chat.cwd,
    sessionId: chat.sessionId,
    mode: chat.mode || CFG.permissionMode,
    model,
    mcpConfig: CFG.browserTool === false ? null : writeMcpConfig(),
    env: engineEnv(engine),
  });
  procs.set(chat.id, p);
  wire(chat, p);
  pushChats();
  return p;
}

function wire(chat, p) {
  p.on("init", (j) => {
    if (j.session_id && chat.sessionId !== j.session_id) {
      chat.sessionId = j.session_id;
      saveChats();
    }
    lastInit = { skills: j.skills || [], plugins: (j.plugins || []).map((p) => p.name), agents: j.agents || [], mcp: (j.mcp_servers || []).map((s) => s.name || s), tools: j.tools?.length || 0, version: j.claude_code_version };
    chatEvent(chat.id, { t: "init", sessionId: j.session_id, model: j.model, tools: j.tools?.length, cwd: j.cwd, info: lastInit });
  });
  p.on("stream", (event) => chatEvent(chat.id, { t: "stream", event }));
  p.on("assistant", (j) => chatEvent(chat.id, { t: "assistant", message: j.message }));
  p.on("user", (j) => chatEvent(chat.id, { t: "user", message: j.message }));
  p.on("permission", (req) => chatEvent(chat.id, { t: "perm", request: req }));
  p.on("result", (j) => {
    chat.updated = Date.now();
    saveChats();
    chatEvent(chat.id, {
      t: "result",
      subtype: j.subtype,
      isError: !!j.is_error,
      text: j.result,
      turns: j.num_turns,
      durationMs: j.duration_ms,
      costUsd: j.total_cost_usd,
      usage: j.usage,
      modelUsage: j.modelUsage,
    });
    pushChats();
  });
  p.on("stderr", (text) => chatEvent(chat.id, { t: "stderr", text }));
  p.on("exit", ({ code, stderr }) => {
    procs.delete(chat.id);
    chatEvent(chat.id, { t: "exit", code, stderr });
    pushChats();
  });
  p.on("error", (e) => chatEvent(chat.id, { t: "error", message: e.message }));
}

// гасим простаивающие процессы
setInterval(() => {
  const limit = CFG.idleKillMinutes * 60_000;
  for (const [id, p] of procs) {
    if (!p.busy && Date.now() - p.lastActivity > limit) {
      p.kill();
      procs.delete(id);
    }
  }
}, 60_000).unref();

/* ───────────── обработка команд окна ───────────── */

function titleFrom(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 64 ? t.slice(0, 61) + "…" : t || "Новый чат";
}

function rememberCwd(cwd) {
  CFG.recentCwds = [cwd, ...(CFG.recentCwds || []).filter((c) => c !== cwd)].slice(0, 12);
  saveCfg();
}

async function handle(ws, m) {
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  switch (m.type) {
    case "hello": {
      send({ type: "config", config: CFG, bridge: await bridgeHealth(), claudeExe: fs.existsSync(CLAUDE_EXE), info: lastInit, browser: !!browser });
      send({ type: "chats", list: publicChats() });
      send({ type: "browser.state", state: browserSt });
      bridgeCatalog().then((c) => c && send({ type: "catalog", ...c }));
      return;
    }
    case "browser": {
      // команды панели из интерфейса: open / close / navigate / reload / external / back
      if (!browser) return send({ type: "error", message: "Браузер есть только в окне приложения." });
      try {
        const out = await browser[m.op]?.(m);
        if (m.op === "navigate" || m.op === "open" || m.op === "close") browserState(await browser.state());
        return out && send({ type: "browser.result", op: m.op, out });
      } catch (e) {
        return send({ type: "error", message: e.message });
      }
    }
    case "catalog": {
      const c = await bridgeCatalog();
      send(c ? { type: "catalog", ...c } : { type: "error", message: "Каталог моделей не получен (мост или сеть)." });
      return;
    }
    case "model.set": {
      // модель чата; для новых чатов — config.set { model }
      const chat = chatById(m.id);
      if (!chat) return;
      chat.model = m.model || null;
      saveChats();
      const p = procs.get(m.id);
      if (p?.alive) {
        if (p.busy) p.setModel(chat.model || "");
        else p.kill(); // следующий ход поднимет процесс заново с --model
      }
      pushChats();
      return;
    }
    case "bridge.check": {
      send({ type: "config", config: CFG, bridge: await ensureBridge(), claudeExe: fs.existsSync(CLAUDE_EXE) });
      return;
    }
    case "config.set": {
      for (const k of ["engine", "permissionMode", "theme", "defaultCwd", "model", "subscriptionModel"]) if (m[k] !== undefined) CFG[k] = m[k];
      saveCfg();
      broadcast({ type: "config", config: CFG, bridge: await bridgeHealth(), claudeExe: fs.existsSync(CLAUDE_EXE) });
      return;
    }
    case "chat.new": {
      const cwd = (m.cwd || CFG.defaultCwd).trim();
      if (!fs.existsSync(cwd)) return send({ type: "error", message: "Папки нет: " + cwd });
      rememberCwd(cwd);
      const chat = { id: randomUUID(), sessionId: null, title: "Новый чат", cwd, created: Date.now(), updated: Date.now(), engine: CFG.engine, mode: CFG.permissionMode, model: (CFG.engine === "rout" ? CFG.model : CFG.subscriptionModel) || null };
      chats.unshift(chat);
      saveChats();
      pushChats();
      send({ type: "chat.opened", chat, messages: [], running: false });
      return;
    }
    case "chat.open": {
      const chat = chatById(m.id);
      if (!chat) return send({ type: "error", message: "Чата нет" });
      const file = findTranscript(chat.sessionId, chat.cwd);
      const messages = file ? messagesFromTranscript(file) : [];
      const p = procs.get(chat.id);
      send({ type: "chat.opened", chat, messages, running: !!p?.alive, busy: !!p?.busy, pending: p ? [...p.pending.values()].map((r) => ({ requestId: r.request_id, ...r.request })) : [] });
      return;
    }
    case "chat.send": {
      const chat = chatById(m.id);
      if (!chat) return send({ type: "error", message: "Чата нет" });
      let p;
      try {
        p = await getProc(chat);
      } catch (e) {
        return chatEvent(chat.id, { t: "error", message: e.message });
      }
      if (p.busy) return send({ type: "error", message: "Claude ещё отвечает — дождитесь или остановите." });
      const text = String(m.text || "");
      const images = Array.isArray(m.images) ? m.images : [];
      const content = images.length
        ? [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text }]
        : text;
      if (chat.title === "Новый чат" && text.trim()) chat.title = titleFrom(text);
      chat.updated = Date.now();
      saveChats();
      p.send(content);
      chatEvent(chat.id, { t: "sent", text, images: images.length });
      pushChats();
      return;
    }
    case "chat.stop": {
      const p = procs.get(m.id);
      if (p?.alive) p.interrupt();
      return;
    }
    case "chat.kill": {
      const p = procs.get(m.id);
      if (p?.alive) p.kill();
      return;
    }
    case "chat.rename": {
      const chat = chatById(m.id);
      if (chat) {
        chat.title = titleFrom(m.title);
        saveChats();
        pushChats();
      }
      return;
    }
    case "chat.delete": {
      const p = procs.get(m.id);
      if (p) p.kill();
      chats = chats.filter((c) => c.id !== m.id);
      saveChats();
      pushChats();
      return;
    }
    case "perm.answer": {
      const p = procs.get(m.id);
      if (!p?.alive) return;
      const req = p.pending.get(m.requestId);
      const updatedPermissions = m.always && req?.request?.permission_suggestions ? req.request.permission_suggestions : undefined;
      // updatedInput — для опросника AskUserQuestion: тот же input плюс answers {вопрос: ответ}
      p.answerPermission(m.requestId, { behavior: m.behavior, message: m.message, updatedPermissions, updatedInput: m.updatedInput });
      return;
    }
    case "mode.set": {
      const chat = chatById(m.id);
      if (!chat) return;
      chat.mode = m.mode;
      saveChats();
      const p = procs.get(m.id);
      if (p?.alive) p.setPermissionMode(m.mode);
      pushChats();
      return;
    }
    case "engine.set": {
      // движок чата (rout / subscription) — действует со следующего запуска процесса
      const chat = chatById(m.id);
      if (!chat) return;
      chat.engine = m.engine;
      chat.model = (m.engine === "rout" ? CFG.model : CFG.subscriptionModel) || null;
      saveChats();
      const p = procs.get(m.id);
      if (p?.alive && !p.busy) p.kill();
      pushChats();
      return;
    }
    default:
      send({ type: "error", message: "Неизвестная команда: " + m.type });
  }
}

/* ───────────── HTTP + WS ───────────── */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  // Локальные картинки для чата: ![](C:\путь.png) → /file?p=C:\путь.png
  if (req.method === "GET" && url.pathname === "/file") {
    const p = url.searchParams.get("p") || "";
    const ext = path.extname(p).toLowerCase();
    if (!IMG_EXT.has(ext) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end("нет");
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "image/" + ext.slice(1), "Cache-Control": "no-cache" });
    return fs.createReadStream(p).pipe(res);
  }

  // Встроенный браузер: MCP-сервер шлёт сюда команды
  if (req.method === "POST" && url.pathname === "/browser") {
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "кривой JSON" }));
    }
    const { op, ...args } = body;
    if (!browser) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Браузер доступен только в окне Electron (Запустить Claude.bat), не в безголовом режиме." }));
    }
    if (typeof browser[op] !== "function") {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "нет такой операции: " + op }));
    }
    try {
      const out = await browser[op](args);
      broadcast({ type: "browser.used", op, args: op === "navigate" ? { url: args.url } : undefined });
      if (["navigate", "open", "close", "back"].includes(op)) browserState(await browser.state());
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  let file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("нет");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("message", async (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      await handle(ws, m);
    } catch (e) {
      console.error(e);
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  });
  ws.on("close", () => sockets.delete(ws));
});

export function startServer() {
  return new Promise((resolve) => {
    server.listen(CFG.port, "127.0.0.1", () => {
      console.log(`claude-rout: http://127.0.0.1:${CFG.port}`);
      console.log(`claude.exe: ${CLAUDE_EXE} ${fs.existsSync(CLAUDE_EXE) ? "✓" : "НЕ НАЙДЕН"}`);
      if (CFG.engine === "rout") ensureBridge().then((h) => console.log("[мост]", h ? `ок, крупная ${h.big}` : "не поднялся"));
      resolve(`http://127.0.0.1:${CFG.port}`);
    });
  });
}

export function stopAll() {
  for (const p of procs.values()) p.kill();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
