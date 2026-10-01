/**
 * Обёртка над процессом Claude Code CLI.
 *
 * Один живой процесс на чат:  claude -p --input-format stream-json --output-format stream-json
 * Сообщения пользователя уходят в stdin, события приходят из stdout построчно (JSON).
 * Запросы прав (control_request / can_use_tool) отдаём наружу и ждём ответа.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class ClaudeProcess extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.exe          путь к claude.exe
   * @param {string} o.cwd          рабочая папка чата
   * @param {string=} o.sessionId   если есть — возобновляем (--resume)
   * @param {string} o.mode         default | acceptEdits | bypassPermissions | plan
   * @param {object} o.env          переменные окружения (мост или подписка)
   */
  constructor(o) {
    super();
    this.o = o;
    this.sessionId = o.sessionId || null;
    this.busy = false;
    this.pending = new Map(); // request_id → control_request (ждём ответа окна)
    this.lastActivity = Date.now();
    this.buf = "";
    this.stderrTail = "";
    this.start();
  }

  start() {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", this.o.mode || "default",
    ];
    if (this.o.mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    if (this.o.model) args.push("--model", this.o.model);
    if (this.o.mcpConfig) args.push("--mcp-config", this.o.mcpConfig, "--allowedTools", "mcp__browser");
    if (this.sessionId) args.push("--resume", this.sessionId);

    this.p = spawn(this.o.exe, args, {
      cwd: this.o.cwd,
      env: this.o.env,
      windowsHide: true,
    });
    this.p.stdout.setEncoding("utf8");
    this.p.stdout.on("data", (d) => this.onData(d));
    this.p.stderr.setEncoding("utf8");
    this.p.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      this.emit("stderr", d);
    });
    this.p.on("exit", (code, sig) => {
      this.alive = false;
      this.busy = false;
      this.emit("exit", { code, sig, stderr: this.stderrTail });
    });
    this.p.on("error", (e) => this.emit("error", e));
    this.alive = true;
  }

  onData(d) {
    this.lastActivity = Date.now();
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        this.emit("raw", line);
        continue;
      }
      this.handle(j);
    }
  }

  handle(j) {
    if (process.env.CLAUDE_ROUT_TRACE) console.log("[ev]", JSON.stringify(j).slice(0, 400));
    if (j.type === "system" && j.subtype === "init") {
      if (j.session_id) this.sessionId = j.session_id;
      this.emit("init", j);
      return;
    }
    if (j.type === "control_request") {
      const req = j.request || {};
      if (req.subtype === "can_use_tool") {
        this.pending.set(j.request_id, j);
        this.emit("permission", { requestId: j.request_id, ...req });
      } else {
        // прочее (hook_callback, mcp_message и т. п.) — вежливо отказываем
        this.writeControlResponse(j.request_id, { subtype: "error", error: "unsupported" });
      }
      return;
    }
    if (j.type === "control_response") {
      this.emit("control_response", j);
      return;
    }
    if (j.type === "result") {
      this.busy = false;
      this.emit("result", j);
      return;
    }
    if (j.type === "stream_event") return this.emit("stream", j.event, j);
    if (j.type === "assistant") return this.emit("assistant", j);
    if (j.type === "user") return this.emit("user", j);
    this.emit("other", j);
  }

  write(obj) {
    if (!this.alive) throw new Error("процесс Claude не запущен");
    this.p.stdin.write(JSON.stringify(obj) + "\n");
  }

  writeControlResponse(requestId, response) {
    this.write({ type: "control_response", response: { request_id: requestId, ...response } });
  }

  /** Отправить ход пользователя. content — строка или массив блоков (текст + картинки). */
  send(content) {
    this.busy = true;
    this.lastActivity = Date.now();
    this.write({ type: "user", message: { role: "user", content } });
  }

  /** Ответ на запрос прав. behavior: allow | deny. */
  answerPermission(requestId, { behavior, message, updatedInput, updatedPermissions }) {
    const req = this.pending.get(requestId);
    this.pending.delete(requestId);
    const resp =
      behavior === "allow"
        ? { behavior: "allow", updatedInput: updatedInput ?? req?.request?.input ?? {}, ...(updatedPermissions ? { updatedPermissions } : {}) }
        : { behavior: "deny", message: message || "Отклонено пользователем" };
    this.writeControlResponse(requestId, { subtype: "success", response: resp });
  }

  /** Прервать текущий ход (как Esc в терминале). */
  interrupt() {
    if (!this.alive) return;
    this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  setModel(model) {
    this.o.model = model;
    if (!this.alive) return;
    this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "set_model", model } });
  }

  setPermissionMode(mode) {
    if (!this.alive) return;
    this.o.mode = mode;
    this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "set_permission_mode", mode } });
  }

  kill() {
    if (!this.alive) return;
    try {
      this.p.stdin.end();
    } catch {}
    const p = this.p;
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 1500);
  }
}
