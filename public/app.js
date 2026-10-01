/* Окно «Claude на rout.my» — логика */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ───────── состояние ───────── */
  let ws;
  let config = {};
  let bridge = null;
  let info = null; // что подключено у Claude Code (скиллы, плагины, агенты)
  let catalog = null; // { big, small, models:[{id,mult}] }
  let chats = [];
  let cur = null; // { chat, messages, turn, msgStart, blockByIndex, streaming }
  let images = [];
  document.documentElement.dataset.theme = localStorage.getItem("theme") || "dark";

  /* ───────── markdown (минимальный, без зависимостей) ───────── */
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    // картинки: ![подпись](C:\путь.png) / (file:///…) / (http…) / (data:…)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      let u = src.replace(/&amp;/g, "&");
      if (/^file:\/\/\//i.test(u)) u = decodeURIComponent(u.replace(/^file:\/\/\//i, "")).replace(/\//g, "\\");
      if (!/^(https?:|data:)/i.test(u)) u = "/file?p=" + encodeURIComponent(u);
      return `<img src="${u}" alt="${alt}" loading="lazy">`;
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|obsidian:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return s;
  }
  function md(src) {
    const lines = String(src ?? "").replace(/\r/g, "").split("\n");
    let out = "";
    let i = 0;
    const para = [];
    const flush = () => {
      if (para.length) {
        out += `<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`;
        para.length = 0;
      }
    };
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^```(\w*)/))) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out += `<pre><code class="lang-${esc(m[1])}">${esc(buf.join("\n"))}</code></pre>`;
        continue;
      }
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) {
        flush();
        out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
        flush();
        out += "<hr>";
        i++;
        continue;
      }
      if (/^\s*>/.test(l)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out += `<blockquote>${md(buf.join("\n"))}</blockquote>`;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
        let t = "<table><thead><tr>" + cells(l).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t += "<tr>" + cells(lines[i++]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
        out += t + "</tbody></table>";
        continue;
      }
      if ((m = l.match(/^(\s*)([-*+]|\d+[.)])\s+/))) {
        flush();
        const ordered = /\d/.test(m[2]);
        const base = m[1].length;
        let list = `<${ordered ? "ol" : "ul"}>`;
        while (i < lines.length) {
          const lm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
          if (lm && lm[1].length === base) {
            const item = lm[3];
            i++;
            const sub = [];
            while (i < lines.length && lines[i].trim() && !(lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/)?.[1].length <= base)) sub.push(lines[i++]);
            let inner = inline(item);
            if (sub.length) {
              const nested = sub.filter((s) => /^\s*([-*+]|\d+[.)])\s+/.test(s));
              const plain = sub.filter((s) => !/^\s*([-*+]|\d+[.)])\s+/.test(s));
              if (plain.length) inner += "<br>" + inline(plain.map((s) => s.trim()).join("\n")).replace(/\n/g, "<br>");
              if (nested.length) inner += md(nested.map((s) => s.slice(Math.min(...nested.map((n) => n.match(/^\s*/)[0].length)))).join("\n"));
            }
            list += `<li>${inner}</li>`;
          } else if (lines[i].trim() === "" && i + 1 < lines.length && lines[i + 1].match(/^(\s*)([-*+]|\d+[.)])\s+/)?.[1].length === base) {
            i++;
          } else break;
        }
        out += list + `</${ordered ? "ol" : "ul"}>`;
        continue;
      }
      if (l.trim() === "") {
        flush();
        i++;
        continue;
      }
      para.push(l);
      i++;
    }
    flush();
    return out;
  }

  // Разбить текст на верхнеуровневые куски (по пустой строке, не ломая ```-блоки и списки),
  // чтобы при потоке перерисовывать только последний кусок — так текст появляется плавно.
  function chunks(text) {
    const lines = String(text ?? "").replace(/\r/g, "").split("\n");
    const out = [];
    let buf = [];
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^```/.test(l)) fence = !fence;
      if (!fence && l.trim() === "" && buf.length) {
        // пустая строка внутри списка не рвёт список
        const next = lines[i + 1] || "";
        const inList = /^\s*([-*+]|\d+[.)])\s+/.test(buf[buf.length - 1]) && /^\s*([-*+]|\d+[.)])\s+/.test(next);
        if (inList) {
          buf.push(l);
          continue;
        }
        out.push(buf.join("\n"));
        buf = [];
        continue;
      }
      buf.push(l);
    }
    if (buf.length) out.push(buf.join("\n"));
    return out.filter((c) => c.trim() !== "");
  }

  /* ───────── связь ───────── */
  function connect() {
    ws = new WebSocket(`ws://${location.host}/`);
    ws.onopen = () => send({ type: "hello" });
    ws.onclose = () => {
      setStatus('<span class="bad">●</span> нет связи с сервером');
      setTimeout(connect, 1500);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  }
  const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

  function onMessage(m) {
    switch (m.type) {
      case "config":
        config = m.config;
        bridge = m.bridge;
        if (m.info) info = m.info;
        if (m.browser !== undefined) $("btnBrowser").hidden = !m.browser;
        renderStatus(m.claudeExe);
        renderModels();
        renderTop();
        break;
      case "catalog":
        catalog = m;
        renderModels();
        renderTop();
        break;
      case "chats":
        chats = m.list;
        renderChats();
        if (cur) {
          const c = chats.find((x) => x.id === cur.chat.id);
          if (c) cur.chat = c;
          renderTop();
        }
        break;
      case "chat.opened":
        openChat(m);
        break;
      case "chat.event":
        if (cur && m.id === cur.chat.id) onEvent(m.ev);
        break;
      case "browser.used":
        break;
      case "browser.state":
        paneState(m.state);
        break;
      case "error":
        toast(m.message);
        break;
    }
  }

  function renderStatus(exeOk) {
    const b = bridge ? `<span class="ok">●</span> мост поднят` : `<span class="bad">●</span> мост не поднят`;
    const e = exeOk === false ? ' · <span class="bad">claude.exe не найден</span>' : "";
    const s = info ? ` · скиллов ${info.skills.length}` : "";
    setStatus(b + e + s);
  }
  const setStatus = (html) => ($("status").innerHTML = html);

  /* ───────── модели ───────── */
  const SUB_MODELS = [
    ["", "По умолчанию"],
    ["sonnet", "Sonnet"],
    ["opus", "Opus"],
    ["haiku", "Haiku"],
  ];
  const FAMILY = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "z-ai": "Z.ai", moonshotai: "Moonshot", deepseek: "DeepSeek", "x-ai": "xAI", qwen: "Qwen", mistralai: "Mistral", "meta-llama": "Meta" };
  const shortModel = (id) => String(id || "").replace(/^[^/]+\//, "");

  function currentEngine() {
    return cur ? cur.chat.engine || config.engine || "rout" : config.engine || "rout";
  }
  function currentModel() {
    if (cur) return cur.chat.model || "";
    return (currentEngine() === "rout" ? config.model : config.subscriptionModel) || "";
  }

  function renderModels() {
    const sel = $("model");
    const eng = currentEngine();
    const val = currentModel();
    sel.innerHTML = "";
    if (eng === "subscription") {
      for (const [v, t] of SUB_MODELS) sel.appendChild(new Option(t, v));
    } else {
      const dflt = new Option(`Как в мосте (${shortModel(bridge?.big || "…")})`, "");
      sel.appendChild(dflt);
      if (catalog?.models?.length) {
        const groups = new Map();
        for (const m of catalog.models) {
          const fam = m.id.split("/")[0];
          if (!groups.has(fam)) groups.set(fam, []);
          groups.get(fam).push(m);
        }
        const order = ["anthropic", "openai", "google", "z-ai", "moonshotai", "deepseek", "x-ai", "qwen"];
        const fams = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
        for (const fam of fams) {
          const og = document.createElement("optgroup");
          og.label = FAMILY[fam] || fam;
          for (const m of groups.get(fam)) og.appendChild(new Option(`${shortModel(m.id)}${m.mult != null ? `  ×${m.mult}` : ""}`, m.id));
          sel.appendChild(og);
        }
      } else if (val) sel.appendChild(new Option(shortModel(val), val));
    }
    sel.value = val;
    if (sel.value !== val) {
      sel.appendChild(new Option(shortModel(val) || "—", val));
      sel.value = val;
    }
  }

  function modelLabel() {
    const eng = currentEngine();
    const m = currentModel();
    if (eng === "subscription") return m ? m[0].toUpperCase() + m.slice(1) + " · подписка" : "Подписка";
    const id = m || bridge?.big || "";
    const entry = catalog?.models?.find((x) => x.id === id);
    return `${shortModel(id) || "rout.my"}${entry?.mult != null ? ` ×${entry.mult}` : ""} · rout.my`;
  }

  /* ───────── список чатов ───────── */
  function renderChats() {
    const q = $("search").value.trim().toLowerCase();
    const list = $("chatlist");
    list.innerHTML = "";
    for (const c of chats) {
      if (q && !c.title.toLowerCase().includes(q)) continue;
      const it = el("div", "chatitem" + (cur?.chat.id === c.id ? " active" : "") + (c.busy ? " busy" : c.running ? " running" : ""));
      it.appendChild(el("span", "dot"));
      it.appendChild(el("span", "t", c.title));
      const more = el("button", "more", "⋯");
      more.title = "Ещё";
      more.onclick = (e) => {
        e.stopPropagation();
        chatMenu(c, e.clientX, e.clientY);
      };
      it.appendChild(more);
      it.onclick = () => send({ type: "chat.open", id: c.id });
      it.oncontextmenu = (e) => {
        e.preventDefault();
        chatMenu(c, e.clientX, e.clientY);
      };
      list.appendChild(it);
    }
  }

  function chatMenu(c, x, y) {
    closeMenu();
    const m = el("div", "menu");
    m.id = "menu";
    const b1 = el("button", "", "Переименовать");
    b1.onclick = () => {
      closeMenu();
      const t = prompt("Название чата", c.title);
      if (t != null && t.trim()) send({ type: "chat.rename", id: c.id, title: t.trim() });
    };
    const b2 = el("button", "", "Открыть папку чата");
    b2.onclick = () => {
      closeMenu();
      window.open("file:///" + c.cwd.replace(/\\/g, "/"));
    };
    const b3 = el("button", "danger", "Удалить из списка");
    b3.onclick = () => {
      closeMenu();
      if (confirm("Убрать чат из списка? Сам транскрипт Claude Code останется на диске.")) {
        send({ type: "chat.delete", id: c.id });
        if (cur?.chat.id === c.id) {
          cur = null;
          showEmpty();
        }
      }
    };
    m.append(b1, b2, b3);
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
    setTimeout(() => document.addEventListener("click", closeMenu, { once: true }));
  }
  const closeMenu = () => $("menu")?.remove();

  /* ───────── открытие чата ───────── */
  function openChat(m) {
    cur = { chat: m.chat, messages: m.messages || [], turn: null, msgStart: 0, blockByIndex: new Map(), streaming: !!m.busy, turnStart: Date.now() };
    $("mode").value = m.chat.mode || config.permissionMode || "default";
    $("engine").value = m.chat.engine || config.engine || "rout";
    renderModels();
    renderThread();
    for (const p of m.pending || []) showPermission(p);
    renderChats();
    renderTop();
    updateSendBtn();
    thinking(cur.streaming, "Ход продолжается…", "wait");
    $("input").focus();
  }

  function renderTop() {
    $("modelChip").textContent = modelLabel();
    if (!cur) {
      $("title").textContent = "Claude";
      $("cwd").textContent = "";
      return;
    }
    $("title").textContent = cur.chat.title;
    $("cwd").textContent = cur.chat.cwd;
  }

  function showEmpty() {
    $("empty").hidden = false;
    $("thread").hidden = true;
    thinking(false);
    renderTop();
    renderChats();
  }

  function renderThread() {
    const th = $("thread");
    th.innerHTML = "";
    if (!cur.messages.length) {
      $("empty").hidden = false;
      th.hidden = true;
      return;
    }
    $("empty").hidden = true;
    th.hidden = false;
    for (const msg of cur.messages) th.appendChild(renderMsg(msg, true));
    scrollBottom(true);
  }

  function renderMsg(msg, silent) {
    let w;
    if (msg.role === "user") {
      w = el("div", "msg user");
      const b = el("div", "bubble");
      if (msg.imagesData?.length) {
        const im = el("div", "imgs");
        for (const src of msg.imagesData) {
          const img = el("img");
          img.src = src;
          im.appendChild(img);
        }
        b.appendChild(im);
      } else if (msg.images) b.appendChild(el("div", "imgs", `📎 изображений: ${msg.images}`));
      b.appendChild(document.createTextNode(msg.text || ""));
      const re = el("button", "resend", "↻");
      re.title = "Отправить это сообщение ещё раз";
      re.onclick = () => {
        if (cur?.streaming) return toast("Дождитесь ответа или остановите ход");
        sendMessage({ text: msg.text || "", images: (msg.imagesData || []).map(dataUrlToImage).filter(Boolean) }, false);
      };
      w.append(re, b);
    } else if (msg.role === "note") {
      w = el("div", "sysnote" + (msg.err ? " err" : ""), msg.text);
      if (msg.retry) {
        const b = el("button", "btn retry", "↻ Попробовать снова");
        b.onclick = retryLast;
        w.appendChild(b);
      }
    } else {
      w = el("div", "msg assistant");
      const body = el("div", "body");
      w.appendChild(body);
      msg.el = body;
      for (const b of msg.blocks) body.appendChild(renderBlock(b, msg));
      if (msg.meta) body.appendChild(metaEl(msg.meta));
    }
    if (!silent) w.classList.add("fade");
    return w;
  }

  function metaEl(meta) {
    const parts = [];
    if (meta.turns) parts.push(`ходов: ${meta.turns}`);
    if (meta.durationMs) parts.push(`${(meta.durationMs / 1000).toFixed(1)} с`);
    if (meta.usage) parts.push(`вход ${fmt(meta.usage.input_tokens)} · выход ${fmt(meta.usage.output_tokens)}`);
    if (meta.model) parts.push(shortModel(meta.model));
    return el("div", "meta", parts.join("  ·  "));
  }
  const fmt = (n) => (n == null ? "?" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

  function renderBlock(b, msg) {
    if (b.type === "text") {
      const d = el("div", "md");
      renderText(b, d, false);
      b.el = d;
      return d;
    }
    if (b.type === "thinking") {
      const t = el("details", "think");
      const s = el("summary");
      s.innerHTML = b.streaming ? '<span class="shimmer">Размышляет…</span>' : "Размышления";
      const body = el("div", "think-body", b.text || "");
      t.append(s, body);
      b.el = t;
      return t;
    }
    if (b.type === "tool_use") {
      const t = el("div", "tool " + (b.result != null ? (b.isError ? "error" : "done") : "running"));
      const head = el("div", "head");
      head.innerHTML = `<span class="ic">${toolIcon(b.name)}</span><span class="name">${esc(toolTitle(b.name))}</span><span class="desc">${esc(toolDesc(b))}</span><span class="st">${b.result != null ? (b.isError ? "ошибка" : "готово") : '<span class="shimmer">выполняется</span>'}</span><span class="chev">›</span>`;
      head.onclick = () => t.classList.toggle("open");
      const det = el("div", "detail");
      const imgs = (b.images || []).map((src) => `<img src="${src}" class="tool-img">`).join("");
      det.innerHTML = `<div class="lbl">Вход</div><pre>${esc(prettyInput(b))}</pre>` + (b.result != null ? `<div class="lbl">Результат</div>${imgs ? `<div class="tool-imgs">${imgs}</div>` : ""}<pre>${esc(String(b.result).slice(0, 12000))}</pre>` : "");
      t.append(head, det);
      if (imgs) t.classList.add("open");
      b.el = t;
      return t;
    }
    return el("div");
  }

  // Текст блока — по кускам: старые куски не трогаем, последний перерисовываем.
  function renderText(b, container, streaming) {
    const parts = chunks(b.text);
    const kids = container.children;
    // если кусков стало меньше (перенос строки исчез) — перерисовать всё
    if (kids.length > parts.length) container.innerHTML = "";
    for (let k = 0; k < parts.length; k++) {
      const html = md(parts[k]);
      let node = container.children[k];
      if (!node) {
        node = el("div", "chunk" + (streaming ? " fade" : ""));
        node.innerHTML = html;
        node.dataset.src = parts[k];
        container.appendChild(node);
      } else if (node.dataset.src !== parts[k]) {
        node.innerHTML = html;
        node.dataset.src = parts[k];
      }
      node.classList.toggle("cursor", streaming && k === parts.length - 1);
    }
    if (!parts.length && streaming) {
      container.innerHTML = '<div class="chunk cursor"></div>';
    }
  }

  function updateToolEl(b) {
    const old = b.el;
    if (!old) return;
    const fresh = renderBlock(b);
    if (old.classList.contains("open")) fresh.classList.add("open");
    old.replaceWith(fresh);
  }

  const ICONS = {
    AskUserQuestion: "?",
    Read: "▤", Write: "✎", Edit: "✎", MultiEdit: "✎", Bash: "›_", PowerShell: "›_", Glob: "⌕", Grep: "⌕", WebFetch: "⌂", WebSearch: "⌕", Task: "⚇", Agent: "⚇", Skill: "✦", TodoWrite: "☑", NotebookEdit: "▤",
  };
  const BROWSER_OPS = { navigate: "открывает", screenshot: "скриншот", text: "читает страницу", click: "кликает", type: "печатает", eval: "выполняет JS", console: "консоль", resize: "размер окна", scroll: "прокручивает", back: "назад" };
  const toolIcon = (n) => (String(n).startsWith("mcp__browser__") ? "⌂" : ICONS[n] || (String(n).startsWith("mcp__") ? "⚭" : "⚙"));
  const toolTitle = (n) => {
    if (String(n).startsWith("mcp__browser__")) return "Браузер · " + (BROWSER_OPS[n.replace("mcp__browser__browser_", "")] || n.replace("mcp__browser__", ""));
    return { Read: "Читает", Write: "Пишет", Edit: "Правит", MultiEdit: "Правит", Bash: "Bash", PowerShell: "PowerShell", Glob: "Ищет файлы", Grep: "Ищет в файлах", WebFetch: "Загружает", WebSearch: "Ищет в сети", Task: "Агент", Agent: "Агент", Skill: "Скилл", TodoWrite: "Список дел", AskUserQuestion: "Спрашивает вас" }[n] || n;
  };
  function toolDesc(b) {
    const i = b.input || {};
    if (b.name === "AskUserQuestion" && Array.isArray(i.questions)) return i.questions.map((q) => q.question).join(" · ").slice(0, 160);
    const d = i.command || i.file_path || (i.pattern ? i.pattern + (i.path ? "  в " + i.path : "") : "") || i.url || i.query || i.description || i.skill || i.prompt || i.selector || i.text || i.code || i.preset || "";
    if (d) return String(d).replace(/\s+/g, " ").slice(0, 160);
    if (b.partial) return b.partial.replace(/^\{"\w+":\s*"?/, "").slice(0, 120);
    const s = JSON.stringify(i);
    return s === "{}" ? "" : s.slice(0, 140);
  }
  const prettyInput = (b) => (b.partial && !Object.keys(b.input || {}).length ? b.partial : JSON.stringify(b.input || {}, null, 2));

  /* ───────── панель браузера ───────── */
  let pane = { open: false, width: 0, url: "" };
  function paneState(st) {
    pane = st || pane;
    const head = $("paneHead");
    head.hidden = !pane.open;
    document.documentElement.style.setProperty("--pane-w", (pane.open ? pane.width : 0) + "px");
    document.documentElement.style.setProperty("--pane-h", (pane.head || 44) + "px");
    $("btnBrowser").classList.toggle("on", !!pane.open);
    if (document.activeElement !== $("paneUrl")) $("paneUrl").value = pane.url || "";
    $("paneUrl").title = pane.title || "";
  }
  $("btnBrowser").onclick = () => send({ type: "browser", op: pane.open ? "close" : "open" });
  $("paneClose").onclick = () => send({ type: "browser", op: "close" });
  $("paneReload").onclick = () => send({ type: "browser", op: "reload" });
  $("paneBack").onclick = () => send({ type: "browser", op: "back" });
  $("paneExternal").onclick = () => send({ type: "browser", op: "external" });
  $("paneUrl").onkeydown = (e) => {
    if (e.key === "Enter" || e.keyCode === 13) {
      let u = e.target.value.trim();
      if (!u) return;
      if (/^[a-z]:\\/i.test(u)) u = "file:///" + u.replace(/\\/g, "/");
      send({ type: "browser", op: "navigate", url: u });
    }
  };

  /* ───────── кнопка «вниз» ───────── */
  $("scroll").addEventListener("scroll", () => {
    const s = $("scroll");
    $("jump").hidden = s.scrollHeight - s.scrollTop - s.clientHeight < 240;
  });
  $("jump").onclick = () => {
    $("scroll").scrollTo({ top: $("scroll").scrollHeight, behavior: "smooth" });
  };

  /* ───────── строка состояния хода ─────────
     Стадии: отправлено → ждёт модель → размышляет → отвечает → инструмент → ждёт модель → готово.
     Секундомер — от начала хода и от начала стадии; если стадия «ждёт модель» тянется
     дольше SLOW секунд — говорим об этом прямо, чтобы зависание не путалось с раздумьями. */
  const SLOW = 25;
  let phase = { text: "", since: 0, kind: "" };
  let timer = null;
  function thinking(on, text, kind) {
    const t = $("thinking");
    t.hidden = !on;
    if (!on) {
      clearInterval(timer);
      timer = null;
      $("phaseNote").textContent = "";
      return;
    }
    const label = text || "Ждёт ответа модели…";
    if (phase.text !== label) phase = { text: label, since: Date.now(), kind: kind || "" };
    $("thinkingText").textContent = label;
    tick();
    if (!timer) timer = setInterval(tick, 1000);
    scrollBottom();
  }
  function tick() {
    if (!cur?.streaming) return;
    const total = Math.round((Date.now() - (cur.turnStart || Date.now())) / 1000);
    const inPhase = Math.round((Date.now() - phase.since) / 1000);
    $("elapsed").textContent = total >= 60 ? `${Math.floor(total / 60)} мин ${total % 60} с` : `${total} с`;
    const waiting = phase.kind === "wait";
    $("phaseNote").textContent = waiting && inPhase > SLOW ? `модель молчит уже ${inPhase} с — сеть или rout.my тормозят; мост сам попробует запасную модель` : cur.lastStderr || "";
    $("thinking").classList.toggle("slow", waiting && inPhase > SLOW);
  }

  /* ───────── события хода ───────── */
  function onEvent(ev) {
    switch (ev.t) {
      case "sent":
        break;
      case "init":
        if (ev.model) cur.model = ev.model;
        if (ev.info) {
          info = ev.info;
          renderStatus();
        }
        if (cur.streaming) thinking(true, "Claude Code запущен, ждёт ответа модели…", "wait");
        break;
      case "stream":
        onStream(ev.event);
        break;
      case "assistant":
        onAssistant(ev.message);
        break;
      case "user":
        onToolResults(ev.message);
        thinking(true, "Результат получен, ждёт ответа модели…", "wait");
        break;
      case "perm":
        thinking(true, "Ждёт вашего разрешения", "user");
        showPermission(ev.request);
        break;
      case "result":
        finishTurn(ev);
        break;
      case "stderr": {
        const line = String(ev.text || "").trim().split("\n").filter(Boolean).pop() || "";
        if (/retry|Retrying|error|Error|failed|429|5\d\d|timeout|ECONN|overloaded/i.test(line)) {
          cur.lastStderr = line.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 160);
          console.warn("[claude stderr]", line);
        }
        break;
      }
      case "exit":
        if (cur.streaming) {
          cur.streaming = false;
          thinking(false);
          updateSendBtn();
          note(`Процесс Claude завершился (код ${ev.code}). ${ev.stderr ? ev.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) : ""}`, true, true);
        }
        break;
      case "error":
        cur.streaming = false;
        thinking(false);
        updateSendBtn();
        note(ev.message, true, true);
        break;
    }
  }

  function ensureTurn() {
    if (!cur.turn) {
      cur.turn = { role: "assistant", blocks: [] };
      cur.messages.push(cur.turn);
      $("empty").hidden = true;
      $("thread").hidden = false;
      $("thread").appendChild(renderMsg(cur.turn));
    }
    return cur.turn;
  }

  function onStream(e) {
    const turn = ensureTurn();
    if (e.type === "message_start") {
      cur.msgStart = turn.blocks.length;
      cur.blockByIndex = new Map();
      cur.lastStderr = "";
      thinking(true, "Модель отвечает…", "gen");
      return;
    }
    if (e.type === "content_block_start") {
      const cb = e.content_block || {};
      let b;
      if (cb.type === "text") b = { type: "text", text: cb.text || "" };
      else if (cb.type === "tool_use") b = { type: "tool_use", id: cb.id, name: cb.name, input: cb.input || {}, partial: "" };
      else if (cb.type === "thinking") b = { type: "thinking", text: cb.thinking || "", streaming: true };
      else return;
      if (b.type === "text") thinking(false);
      else if (b.type === "thinking") thinking(true, "Размышляет…", "gen");
      else thinking(true, `Готовит инструмент: ${toolTitle(b.name)}…`, "gen");
      turn.blocks.push(b);
      cur.blockByIndex.set(e.index, b);
      const node = renderBlock(b, turn);
      node.classList.add("fade");
      if (b.type === "text") renderText(b, node, true);
      turn.el.appendChild(node);
      scrollBottom();
      return;
    }
    if (e.type === "content_block_delta") {
      const b = cur.blockByIndex.get(e.index);
      if (!b) return;
      if (e.delta?.type === "text_delta") {
        b.text += e.delta.text;
        renderText(b, b.el, true);
      } else if (e.delta?.type === "thinking_delta") {
        b.text += e.delta.thinking;
        const body = b.el.querySelector(".think-body");
        if (body) body.textContent = b.text;
      } else if (e.delta?.type === "input_json_delta") {
        b.partial += e.delta.partial_json;
        const d = b.el.querySelector(".desc");
        if (d) d.textContent = toolDesc(b);
      }
      scrollBottom();
      return;
    }
    if (e.type === "content_block_stop") {
      const b = cur.blockByIndex.get(e.index);
      if (!b) return;
      if (b.type === "text") renderText(b, b.el, false);
      if (b.type === "thinking") {
        b.streaming = false;
        const s = b.el.querySelector("summary");
        if (s) s.textContent = "Размышления";
        thinking(true, "Подумал, формулирует ответ…", "gen");
      }
      if (b.type === "tool_use") {
        if (b.partial) {
          try {
            b.input = JSON.parse(b.partial);
            updateToolEl(b);
          } catch {}
        }
        thinking(true, `Выполняет: ${toolTitle(b.name)} ${toolDesc(b)}`.slice(0, 120), "tool");
      }
    }
  }

  function onAssistant(message) {
    const turn = ensureTurn();
    const content = Array.isArray(message?.content) ? message.content : [];
    const fresh = content.filter((c) => c.type === "text" || c.type === "tool_use" || (c.type === "thinking" && c.thinking));
    const old = turn.blocks.slice(cur.msgStart);
    if (old.length === fresh.length && old.every((b, k) => b.type === fresh[k].type)) {
      fresh.forEach((c, k) => {
        const b = old[k];
        if (c.type === "text" && b.type === "text") {
          b.text = c.text;
          renderText(b, b.el, false);
        } else if (c.type === "thinking") {
          b.text = c.thinking;
          b.streaming = false;
          const body = b.el.querySelector(".think-body");
          if (body) body.textContent = b.text;
          const s = b.el.querySelector("summary");
          if (s) s.textContent = "Размышления";
        } else if (c.type === "tool_use" && b.type === "tool_use") {
          b.id = c.id;
          b.name = c.name;
          b.input = c.input || {};
          b.partial = "";
          updateToolEl(b);
        }
      });
    } else {
      for (const b of old) b.el?.remove();
      turn.blocks.length = cur.msgStart;
      for (const c of fresh) {
        const b = c.type === "text" ? { type: "text", text: c.text } : c.type === "thinking" ? { type: "thinking", text: c.thinking } : { type: "tool_use", id: c.id, name: c.name, input: c.input || {} };
        turn.blocks.push(b);
        turn.el.appendChild(renderBlock(b, turn));
      }
    }
    if (message?.model) cur.model = message.model;
    scrollBottom();
  }

  function onToolResults(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    // инструмент выполнился — значит, разрешение по нему уже не ждёт ответа
    if (content.some((r) => r.type === "tool_result")) document.querySelectorAll(".perm").forEach((p) => p.remove());
    for (const r of content) {
      if (r.type !== "tool_result") continue;
      const b = findTool(r.tool_use_id);
      if (!b) continue;
      b.result = typeof r.content === "string" ? r.content : (r.content || []).map((x) => (x.type === "text" ? x.text : x.type === "image" ? "[изображение]" : "")).join("\n");
      b.isError = !!r.is_error;
      if (Array.isArray(r.content)) {
        const imgs = r.content.filter((x) => x.type === "image" && x.source?.data).map((x) => `data:${x.source.media_type || "image/png"};base64,${x.source.data}`);
        if (imgs.length) b.images = imgs;
      }
      updateToolEl(b);
    }
    scrollBottom();
  }
  function findTool(id) {
    for (let i = cur.messages.length - 1; i >= 0; i--) {
      const m = cur.messages[i];
      if (m.role !== "assistant") continue;
      const b = m.blocks.find((x) => x.type === "tool_use" && x.id === id);
      if (b) return b;
    }
    return null;
  }

  function finishTurn(ev) {
    thinking(false);
    const turn = cur.turn;
    if (turn) {
      for (const b of turn.blocks) if (b.type === "text") renderText(b, b.el, false);
      if (!turn.blocks.some((b) => b.type === "text" && b.text.trim()) && ev.text) {
        const b = { type: "text", text: ev.text };
        turn.blocks.push(b);
        turn.el.appendChild(renderBlock(b, turn));
      }
      const eng = currentEngine();
      turn.meta = { turns: ev.turns, durationMs: ev.durationMs, usage: ev.usage, model: eng === "rout" ? currentModel() || bridge?.big : cur.model };
      turn.el.appendChild(metaEl(turn.meta));
    }
    const empty = !turn || !turn.blocks.some((b) => (b.type === "text" && b.text.trim()) || b.type === "tool_use");
    cur.turn = null;
    cur.streaming = false;
    if (ev.isError) note(ev.text || "Ход завершился ошибкой", true, true);
    else if (empty && !ev.text) note("Модель вернула пустой ответ — обычно это сбой провайдера или сети.", true, true);
    cur.streaming = false;
    document.querySelectorAll(".perm").forEach((p) => p.remove());
    updateSendBtn();
    scrollBottom();
  }

  function note(text, err, retry) {
    const m = { role: "note", text, err, retry: retry && !!cur.lastSent };
    cur.messages.push(m);
    $("empty").hidden = true;
    $("thread").hidden = false;
    $("thread").appendChild(renderMsg(m));
    scrollBottom(true);
  }

  // повторить последний ход (после ошибки) — тем же текстом и картинками
  function retryLast() {
    if (!cur?.lastSent || cur.streaming) return;
    document.querySelectorAll(".sysnote .btn").forEach((b) => b.remove());
    sendMessage(cur.lastSent, true);
  }

  /* ───────── опросник (AskUserQuestion) ───────── */
  function showQuestions(req) {
    document.querySelector(`.perm[data-id="${req.requestId}"]`)?.remove();
    const p = el("div", "perm ask fade");
    p.dataset.id = req.requestId;
    const qs = Array.isArray(req.input?.questions) ? req.input.questions : [];
    const forms = [];
    qs.forEach((q, qi) => {
      const box = el("div", "q-box");
      if (q.header) box.appendChild(el("div", "q-chip", q.header));
      box.appendChild(el("div", "q", q.question || ""));
      const opts = el("div", "q-opts");
      const name = `q${qi}-${req.requestId.slice(0, 6)}`;
      const inputs = [];
      for (const o of q.options || []) {
        const lab = el("label", "q-opt");
        const inp = el("input");
        inp.type = q.multiSelect ? "checkbox" : "radio";
        inp.name = name;
        inp.value = o.label;
        const t = el("div", "q-text");
        t.appendChild(el("div", "q-label", o.label));
        if (o.description) t.appendChild(el("div", "q-desc", o.description));
        lab.append(inp, t);
        opts.appendChild(lab);
        inputs.push(inp);
      }
      // «Другое» — свободный ответ
      const other = el("label", "q-opt");
      const oi = el("input");
      oi.type = q.multiSelect ? "checkbox" : "radio";
      oi.name = name;
      oi.value = "__other";
      const ot = el("div", "q-text");
      ot.appendChild(el("div", "q-label", "Другое"));
      const otext = el("input", "q-other");
      otext.type = "text";
      otext.placeholder = "свой вариант…";
      otext.onfocus = () => (oi.checked = true);
      ot.appendChild(otext);
      other.append(oi, ot);
      opts.appendChild(other);
      box.appendChild(opts);
      p.appendChild(box);
      forms.push({ q, inputs, oi, otext });
    });
    const btns = el("div", "btns");
    const ok = el("button", "btn primary", "Ответить");
    ok.onclick = () => {
      const answers = {};
      for (const f of forms) {
        const chosen = f.inputs.filter((i) => i.checked).map((i) => i.value);
        if (f.oi.checked && f.otext.value.trim()) chosen.push(f.otext.value.trim());
        if (!chosen.length) {
          toast("Выберите ответ на каждый вопрос");
          return;
        }
        answers[f.q.question] = chosen.join(", ");
      }
      send({ type: "perm.answer", id: cur.chat.id, requestId: req.requestId, behavior: "allow", updatedInput: { ...req.input, answers } });
      // на месте опросника оставляем компактную запись выбора
      const done = el("div", "q-answer");
      for (const [q, a] of Object.entries(answers)) {
        const row = el("div", "q-answer-row");
        row.appendChild(el("span", "q-answer-q", q));
        row.appendChild(el("span", "q-answer-a", a));
        done.appendChild(row);
      }
      p.replaceWith(done);
      thinking(true, "Ответ передан, ждёт модель…", "wait");
    };
    const no = el("button", "btn", "Пропустить");
    no.onclick = () => {
      send({ type: "perm.answer", id: cur.chat.id, requestId: req.requestId, behavior: "deny", message: "Пользователь пропустил вопросы — действуй по своему усмотрению." });
      p.remove();
      thinking(true, "Ждёт модель…", "wait");
    };
    btns.append(ok, no);
    p.appendChild(btns);
    ensureTurn().el.appendChild(p);
    scrollBottom(true);
  }

  /* ───────── запрос прав ───────── */
  function showPermission(req) {
    if (req.tool_name === "AskUserQuestion") return showQuestions(req);
    document.querySelector(`.perm[data-id="${req.requestId}"]`)?.remove();
    const p = el("div", "perm fade");
    p.dataset.id = req.requestId;
    const what = toolTitle(req.tool_name) + (req.description ? " — " + req.description : "");
    p.appendChild(el("div", "q", `Claude просит разрешение: ${what}`));
    p.appendChild(el("pre", "", prettyInput({ name: req.tool_name, input: req.input })));
    const btns = el("div", "btns");
    const yes = el("button", "btn primary", "Разрешить");
    const always = el("button", "btn", "Разрешить и не спрашивать в этой сессии");
    const no = el("button", "btn", "Отклонить");
    const answer = (behavior, alw, message) => {
      send({ type: "perm.answer", id: cur.chat.id, requestId: req.requestId, behavior, always: alw, message });
      p.remove();
      thinking(true, behavior === "allow" ? `Выполняет: ${toolTitle(req.tool_name)}` : "Отклонено, ждёт ответа модели…", behavior === "allow" ? "tool" : "wait");
    };
    yes.onclick = () => answer("allow", false);
    always.onclick = () => answer("allow", true);
    no.onclick = () => {
      const msg = prompt("Что передать Claude вместо этого? (можно пусто)", "");
      answer("deny", false, msg || undefined);
    };
    if (!req.permission_suggestions?.length) always.hidden = true;
    btns.append(yes, always, no);
    p.appendChild(btns);
    ensureTurn().el.appendChild(p);
    scrollBottom(true);
  }

  /* ───────── отправка ───────── */
  function dataUrlToImage(u) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(u || "");
    return m ? { media_type: m[1], data: m[2] } : null;
  }

  function submit() {
    if (!cur) return newChat();
    if (cur.streaming) return;
    const text = $("input").value.trim();
    if (!text && !images.length) return;
    const payload = { text, images: images.map(({ media_type, data }) => ({ media_type, data })) };
    images = [];
    renderThumbs();
    $("input").value = "";
    autosize();
    sendMessage(payload, false);
  }

  // silent=true — повтор после ошибки: пузырь пользователя не дублируем
  function sendMessage(payload, silent) {
    if (!silent) {
      const msg = { role: "user", text: payload.text, images: payload.images.length, imagesData: payload.images.map((i) => `data:${i.media_type};base64,${i.data}`) };
      cur.messages.push(msg);
      $("empty").hidden = true;
      $("thread").hidden = false;
      $("thread").appendChild(renderMsg(msg));
    }
    send({ type: "chat.send", id: cur.chat.id, text: payload.text, images: payload.images });
    cur.lastSent = payload;
    cur.streaming = true;
    cur.turn = null;
    cur.turnStart = Date.now();
    cur.lastStderr = "";
    cur.stopAt = 0;
    updateSendBtn();
    thinking(true, "Отправлено, ждёт ответа модели…", "wait");
    scrollBottom(true);
  }

  // первый раз — вежливое прерывание (как Esc в терминале); второй в течение 8 с — убить процесс
  function stop() {
    if (!cur?.streaming) return;
    if (cur.stopAt && Date.now() - cur.stopAt < 8000) {
      send({ type: "chat.kill", id: cur.chat.id });
      toast("Процесс Claude остановлен принудительно");
      return;
    }
    cur.stopAt = Date.now();
    send({ type: "chat.stop", id: cur.chat.id });
    thinking(true, "Останавливаю… (нажмите ещё раз, чтобы убить процесс)", "user");
  }

  function updateSendBtn() {
    const b = $("btnSend");
    const busy = !!cur?.streaming;
    b.className = "send" + (busy ? " stop" : "");
    b.title = busy ? "Остановить (Esc)" : "Отправить (Enter)";
    b.innerHTML = busy
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  }

  function scrollBottom(force) {
    const s = $("scroll");
    const near = s.scrollHeight - s.scrollTop - s.clientHeight < 200;
    if (force || near) s.scrollTop = s.scrollHeight;
  }

  function autosize() {
    const t = $("input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 240) + "px";
  }

  /* ───────── вложения ───────── */
  function addImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const r = new FileReader();
    r.onload = () => {
      images.push({ media_type: file.type, data: String(r.result).split(",")[1] });
      renderThumbs();
    };
    r.readAsDataURL(file);
  }
  function renderThumbs() {
    const t = $("thumbs");
    t.innerHTML = "";
    t.hidden = !images.length;
    images.forEach((im, k) => {
      const w = el("div", "th");
      const img = el("img");
      img.src = `data:${im.media_type};base64,${im.data}`;
      const x = el("button", "x", "×");
      x.onclick = () => {
        images.splice(k, 1);
        renderThumbs();
      };
      w.append(img, x);
      t.appendChild(w);
    });
  }

  /* ───────── диалоги ───────── */
  function modal(html) {
    const bg = el("div", "modal-bg");
    const m = el("div", "modal");
    m.innerHTML = html;
    bg.appendChild(m);
    document.body.appendChild(bg);
    bg.onclick = (e) => e.target === bg && bg.remove();
    return { bg, m, q: (s) => m.querySelector(s) };
  }

  function newChat() {
    const { bg, m, q } = modal(`<h2>Новый чат</h2>
      <label>Папка проекта — Claude Code берёт из неё CLAUDE.md и память</label>
      <input type="text" id="nc-cwd" value="${esc(config.defaultCwd || "")}" />
      <div class="recent" id="nc-recent"></div>
      <div class="foot"><button class="btn" id="nc-cancel">Отмена</button><button class="btn primary" id="nc-ok">Создать</button></div>`);
    for (const c of config.recentCwds || []) {
      const b = el("button", "", c);
      b.onclick = () => (q("#nc-cwd").value = c);
      q("#nc-recent").appendChild(b);
    }
    const ok = () => {
      send({ type: "chat.new", cwd: q("#nc-cwd").value.trim() });
      bg.remove();
    };
    q("#nc-ok").onclick = ok;
    q("#nc-cancel").onclick = () => bg.remove();
    q("#nc-cwd").onkeydown = (e) => e.key === "Enter" && ok();
    q("#nc-cwd").focus();
  }

  function settings() {
    const list = (a) => (a?.length ? a.map((x) => `<span class="tag">${esc(x)}</span>`).join("") : "<span class=\"muted\">—</span>");
    const { bg, m, q } = modal(`<h2>Настройки</h2>
      <label>Через что идут новые чаты</label>
      <select id="st-engine"><option value="rout">rout.my — мост, ваш ключ</option><option value="subscription">Подписка Anthropic</option></select>
      <label>Модель для новых чатов на rout.my</label>
      <select id="st-model"></select>
      <label>Права инструментов по умолчанию</label>
      <select id="st-mode"><option value="default">Спрашивать</option><option value="acceptEdits">Правки без вопросов</option><option value="plan">Только план</option><option value="bypassPermissions">Всё без вопросов</option></select>
      <label>Папка по умолчанию</label>
      <input type="text" id="st-cwd" />
      <div class="note">Мост: ${bridge ? `поднят, по умолчанию <b>${esc(shortModel(bridge.big))}</b>, мелкие задачи — <b>${esc(shortModel(bridge.small))}</b>` : "<b>не поднят</b>"}.</div>
      <div class="connected">
        <div class="lbl">Подключено у Claude Code${info?.version ? ` · ${esc(info.version)}` : ""}</div>
        ${info ? `<div class="row"><b>Скиллы (${info.skills.length})</b>${list(info.skills)}</div>
        <div class="row"><b>Плагины (${info.plugins.length})</b>${list(info.plugins)}</div>
        <div class="row"><b>Агенты (${info.agents.length})</b>${list(info.agents)}</div>` : '<div class="muted">Появится после первого сообщения в любом чате.</div>'}
      </div>
      <div class="foot"><button class="btn" id="st-bridge">Проверить мост</button><span style="flex:1"></span><button class="btn" id="st-cancel">Закрыть</button><button class="btn primary" id="st-ok">Сохранить</button></div>`);
    q("#st-engine").value = config.engine || "rout";
    q("#st-mode").value = config.permissionMode || "default";
    q("#st-cwd").value = config.defaultCwd || "";
    const sm = q("#st-model");
    sm.appendChild(new Option(`Как в мосте (${shortModel(bridge?.big || "…")})`, ""));
    for (const x of catalog?.models || []) sm.appendChild(new Option(`${x.id}${x.mult != null ? `  ×${x.mult}` : ""}`, x.id));
    sm.value = config.model || "";
    q("#st-ok").onclick = () => {
      send({ type: "config.set", engine: q("#st-engine").value, permissionMode: q("#st-mode").value, defaultCwd: q("#st-cwd").value.trim(), model: sm.value });
      bg.remove();
    };
    q("#st-bridge").onclick = () => {
      send({ type: "bridge.check" });
      send({ type: "catalog" });
      toast("Проверяю мост…");
    };
    q("#st-cancel").onclick = () => bg.remove();
  }

  let toastT;
  function toast(text) {
    document.querySelector(".toast")?.remove();
    const t = el("div", "toast", text);
    document.body.appendChild(t);
    clearTimeout(toastT);
    toastT = setTimeout(() => t.remove(), 3500);
  }

  /* ───────── привязка ───────── */
  $("btnNew").onclick = newChat;
  $("btnSettings").onclick = settings;
  $("btnSide").onclick = () => $("app").classList.toggle("side-hidden");
  $("btnTheme").onclick = () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    localStorage.setItem("theme", t);
  };
  $("btnSend").onclick = () => (cur?.streaming ? stop() : submit());
  $("btnAttach").onclick = () => $("file").click();
  $("file").onchange = (e) => {
    for (const f of e.target.files) addImageFile(f);
    e.target.value = "";
  };
  $("search").oninput = renderChats;
  $("mode").onchange = (e) => cur && send({ type: "mode.set", id: cur.chat.id, mode: e.target.value });
  $("engine").onchange = (e) => {
    if (cur) {
      send({ type: "engine.set", id: cur.chat.id, engine: e.target.value });
      cur.chat.engine = e.target.value;
      cur.chat.model = "";
    } else send({ type: "config.set", engine: e.target.value });
    renderModels();
    renderTop();
  };
  $("model").onchange = (e) => {
    const v = e.target.value;
    if (cur) {
      cur.chat.model = v;
      send({ type: "model.set", id: cur.chat.id, model: v });
      if (cur.streaming) toast("Модель сменится со следующего хода");
    } else send({ type: "config.set", ...(currentEngine() === "rout" ? { model: v } : { subscriptionModel: v }) });
    renderTop();
  };
  $("title").ondblclick = () => {
    if (!cur) return;
    const t = prompt("Название чата", cur.chat.title);
    if (t != null && t.trim()) send({ type: "chat.rename", id: cur.chat.id, title: t.trim() });
  };
  const input = $("input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.keyCode === 13) && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") stop();
  });
  input.addEventListener("paste", (e) => {
    for (const it of e.clipboardData?.items || []) if (it.type.startsWith("image/")) addImageFile(it.getAsFile());
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer?.files || []) addImageFile(f);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cur?.streaming) stop();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
    }
  });

  const hours = new Date().getHours();
  $("greeting").textContent = hours < 5 ? "Не спится?" : hours < 12 ? "Доброе утро" : hours < 18 ? "Чем займёмся?" : "Добрый вечер";

  updateSendBtn();
  connect();
})();
