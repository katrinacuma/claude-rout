/**
 * MCP-сервер «браузер» (stdio, без зависимостей).
 * Claude Code поднимает его через --mcp-config; каждый вызов инструмента уходит
 * POST-ом на сервер окна (http://127.0.0.1:<порт>/browser), а тот — в окно Electron.
 */
import { createInterface } from "node:readline";

const PORT = process.env.CLAUDE_ROUT_PORT || "5179";
const BASE = `http://127.0.0.1:${PORT}/browser`;

const TOOLS = [
  { name: "browser_navigate", description: "Открыть адрес во встроенном браузере (панель «Браузер» в окне, пользователь её видит). Локальные файлы — file:///C:/путь.html, локальные серверы — http://127.0.0.1:порт.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_screenshot", description: "Скриншот текущей страницы (PNG, до 1280 px по ширине). Координаты для browser_click — в пикселях этого скриншота, пересчитанные на pageWidth/pageHeight из ответа.", inputSchema: { type: "object", properties: { maxWidth: { type: "number" } } } },
  { name: "browser_text", description: "Видимый текст страницы (main/article или body).", inputSchema: { type: "object", properties: { maxChars: { type: "number" } } } },
  { name: "browser_click", description: "Кликнуть: по CSS-селектору, по видимому тексту кнопки/ссылки (text) или по координатам страницы x,y.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "browser_type", description: "Ввести текст в поле (selector) или в текущий фокус; submit=true нажмёт Enter.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["text"] } },
  { name: "browser_eval", description: "Выполнить JavaScript на странице и вернуть результат (для проверки computed-стилей, размеров, состояния DOM). Только для отладки, не для правок интерфейса.", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { name: "browser_console", description: "Сообщения консоли страницы с момента последней навигации.", inputSchema: { type: "object", properties: { onlyErrors: { type: "boolean" } } } },
  { name: "browser_resize", description: "Размер окна: preset mobile (390×844) / tablet (820×1180) / desktop (1200×820) или width,height.", inputSchema: { type: "object", properties: { preset: { type: "string", enum: ["mobile", "tablet", "desktop"] }, width: { type: "number" }, height: { type: "number" } } } },
  { name: "browser_scroll", description: "Прокрутить страницу на dy пикселей (по умолчанию 600) или к элементу selector.", inputSchema: { type: "object", properties: { dy: { type: "number" }, dx: { type: "number" }, selector: { type: "string" } } } },
  { name: "browser_back", description: "Назад по истории.", inputSchema: { type: "object", properties: {} } },
];

async function call(name, args) {
  const op = name.replace(/^browser_/, "");
  const r = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...(args || {}) }) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  if (op === "screenshot") {
    return { content: [{ type: "image", data: j.data, mimeType: j.mimeType }, { type: "text", text: `скриншот ${j.width}×${j.height}, страница ${j.pageWidth}×${j.pageHeight}` }] };
  }
  const text = op === "text" ? `${j.title}\n${j.url}\n---\n${j.text}` : op === "eval" ? j.result : JSON.stringify(j);
  return { content: [{ type: "text", text }] };
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return out({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "browser", version: "0.1.0" } } });
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const result = await call(params.name, params.arguments);
      return out({ jsonrpc: "2.0", id, result });
    } catch (e) {
      return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Ошибка браузера: ${e.message}` }], isError: true } });
    }
  }
  if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `неизвестный метод ${method}` } });
});
