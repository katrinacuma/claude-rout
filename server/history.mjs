/**
 * История чата — из транскриптов Claude Code (~/.claude/projects/<папка>/<sessionId>.jsonl).
 * Мы ничего своего не храним: заголовок и папка — в data/chats.json, всё остальное читаем отсюда.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/** Как Claude Code кодирует путь папки в имя каталога транскриптов. */
export function projectDirFor(cwd) {
  return path.join(PROJECTS, String(cwd).replace(/[^A-Za-z0-9А-Яа-яЁё]/g, "-"));
}

/** Найти файл транскрипта по id сессии. Сначала — по ожидаемой папке, потом перебором. */
export function findTranscript(sessionId, cwd) {
  if (!sessionId) return null;
  const name = sessionId + ".jsonl";
  if (cwd) {
    const p = path.join(projectDirFor(cwd), name);
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(PROJECTS)) return null;
  for (const d of fs.readdirSync(PROJECTS)) {
    const p = path.join(PROJECTS, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOfToolResult(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[изображение]" : ""))
      .filter(Boolean)
      .join("\n");
  return c == null ? "" : JSON.stringify(c);
}
function imagesOfToolResult(c) {
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b?.type === "image" && b.source?.type === "base64" && b.source.data).map((b) => `data:${b.source.media_type || "image/png"};base64,${b.source.data}`);
}

/**
 * Превратить строки транскрипта в список сообщений для окна:
 *   { role:"user", text, images:[...], ts }
 *   { role:"assistant", blocks:[ {type:"text",text} | {type:"tool_use",id,name,input,result?,isError?} ], ts }
 * Подряд идущие сообщения ассистента одного хода склеиваются.
 */
export function messagesFromTranscript(file) {
  const out = [];
  const toolIndex = new Map(); // tool_use_id → блок
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return out;
  }
  let cur = null; // текущее сообщение ассистента

  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue; // ходы суб-агентов не показываем
    if (e.type !== "user" && e.type !== "assistant") continue;
    const msg = e.message || {};
    const blocks = blocksOf(msg.content);

    if (e.type === "assistant") {
      if (!cur) {
        cur = { role: "assistant", blocks: [], ts: e.timestamp, model: msg.model };
        out.push(cur);
      }
      for (const b of blocks) {
        if (b.type === "text") {
          if (b.text) cur.blocks.push({ type: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const t = { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
          cur.blocks.push(t);
          toolIndex.set(b.id, t);
        } else if (b.type === "thinking" && b.thinking) {
          cur.blocks.push({ type: "thinking", text: b.thinking });
        }
      }
      continue;
    }

    // user
    const results = blocks.filter((b) => b.type === "tool_result");
    for (const r of results) {
      const t = toolIndex.get(r.tool_use_id);
      if (t) {
        t.result = textOfToolResult(r.content).slice(0, 20000);
        t.isError = !!r.is_error;
        const imgs = imagesOfToolResult(r.content);
        if (imgs.length) t.images = imgs;
      }
    }
    const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
    const imagesData = blocks
      .filter((b) => b.type === "image" && b.source?.type === "base64" && b.source.data)
      .map((b) => `data:${b.source.media_type || "image/png"};base64,${b.source.data}`);
    const images = blocks.filter((b) => b.type === "image").length;
    if (texts.length || images) {
      const text = texts.join("\n");
      // служебные вставки (результаты слэш-команд и т. п.) не показываем
      if (/^<(command-name|local-command-stdout|command-message)/.test(text.trim())) continue;
      cur = null;
      out.push({ role: "user", text, images, imagesData, ts: e.timestamp });
    }
  }
  return out;
}

/** Первая реплика пользователя — для заголовка чата. */
export function firstUserText(messages) {
  const m = messages.find((x) => x.role === "user" && x.text);
  return m ? m.text : "";
}
