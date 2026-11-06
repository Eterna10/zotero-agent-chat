/*
 * Agent Chat for Zotero
 * 选中 PDF 文字 → 在悬浮窗口或侧边栏中提问 → 回车发给本机 agent CLI（Claude Code / Codex / 自定义）→ 回复显示在同一处
 *
 * 结构：
 *   AgentChat      插件对象：生命周期、三个入口、调用子进程
 *   ZacSession     每个 Zotero 窗口一个：对话记录、选中原文、运行状态（悬浮窗和侧边栏共享）
 *   ZacChatView    界面：mode = "floating"（悬浮窗）或 "embedded"（侧边栏区块）
 */
/* global Zotero, Cc, Ci, ChromeUtils */

const ZAC_NS = "http://www.w3.org/1999/xhtml";
const ZAC_AGENTS = { claude: "Claude Code", codex: "Codex", agy: "Antigravity", custom: "自定义" };
// 下拉框里的预设；不在列表里的可以选「自定义…」手动输入
const ZAC_MODELS = {
  claude: ["sonnet", "opus", "haiku", "fable"],
  codex: ["gpt-5.4", "gpt-5.4-mini"],
  agy: [],
  custom: [],
};
const ZAC_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"], // claude --effort
  codex: ["minimal", "low", "medium", "high", "xhigh"], // codex -c model_reasoning_effort=
  agy: ["low", "medium", "high"], // agy --effort
  custom: [],
};
const ZAC_DEFAULT_SYSTEM =
  "你是科研论文阅读助手。用户正在 Zotero 中阅读论文，会提供选中的原文片段和问题。" +
  "请用与用户提问相同的语言，准确、简洁地回答；必要时解释公式中各符号的含义并给出直观理解。" +
  "数学公式使用 LaTeX：行内公式写成 $...$，独立公式写成 $$...$$。" +
  "只读取文件，不要修改或创建任何文件。";

function zacClip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function zacTail(s, n) {
  s = String(s || "");
  return s.length > n ? "…" + s.slice(-n) : s;
}
function zacSplitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s || ""))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// "claude-opus-5-5" → "Opus 5.5"；"claude-3-5-sonnet-20241022" → "Sonnet 3.5"；"claude-opus-4-6[1m]" → "Opus 4.6 (1M)"
function zacPrettyModelId(id) {
  let s = String(id || "").trim();
  if (!s) return "";
  let suffix = "";
  const br = /\[([^\]]+)\]$/.exec(s);
  if (br) {
    suffix = ` (${br[1].toUpperCase()})`;
    s = s.slice(0, br.index);
  }
  const parts = s.replace(/^claude-/i, "").split(/[-_]/).filter((x) => x && !/^\d{8}$/.test(x)); // 去掉日期
  const names = parts.filter((x) => !/^\d+$/.test(x));
  const nums = parts.filter((x) => /^\d+$/.test(x));
  if (!names.length || !nums.length) return "";
  const name = names.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
  return `${name} ${nums.join(".")}${suffix}`;
}

// 带版本号的模型显示名：优先用本身就带版本号的名字，否则由完整模型 ID 推出
function zacModelLabel({ value, display, resolved, description }) {
  // 要求有版本号；"1M"、"200K" 这类上下文长度不算版本号
  const hasVersion = (x) =>
    !!x && /[A-Za-z]/.test(x) && /\d/.test(x.replace(/\b\d+\s*[kKmM]\b/g, "")) && x.length <= 32 && !/^default/i.test(x);
  const head = String(description || "").split(" · ")[0].trim();
  const candidates = [display, zacPrettyModelId(resolved), head, zacPrettyModelId(value), value];
  for (const c of candidates) {
    const t = String(c || "").trim();
    if (hasVersion(t)) return t;
  }
  return String(display || value || "").trim();
}

// 显示名相同的条目（如别名和完整 ID 指向同一模型）在后面注明取值
function zacDisambiguate(models) {
  const count = {};
  for (const m of models) if (m.value !== "default") count[m.label] = (count[m.label] || 0) + 1;
  for (const m of models) if (m.value !== "default" && count[m.label] > 1) m.label += `（${m.value}）`;
  return models;
}

// effort 的显示名，与各 CLI 自己界面上的叫法一致；未知档位首字母大写
const ZAC_EFFORT_NAMES = {
  claude: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max", ultracode: "Ultracode" },
  codex: { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" },
  agy: { low: "Low", medium: "Medium", high: "High" },
};
function zacEffortLabel(agent, v) {
  if (!v) return "";
  const names = ZAC_EFFORT_NAMES[agent] || {};
  return names[v] || String(v).charAt(0).toUpperCase() + String(v).slice(1);
}

// 行内公式：$...$（首尾不能是空格、结尾 $ 后不能紧跟数字，避免把 "$5 和 $10" 当成公式）或 \(...\)
const ZAC_INLINE_MATH = /\\\((.+?)\\\)|\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g;

// 存为 Zotero 笔记时把公式转成笔记编辑器认识的格式：<pre class="math">$$..$$</pre> 和 <span class="math">$..$</span>
function zacNoteHtml(text, esc) {
  const out = [];
  const parts = String(text || "").split(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\])/);
  for (const part of parts) {
    if (!part) continue;
    const dm = /^\$\$([\s\S]+)\$\$$/.exec(part) || /^\\\[([\s\S]+)\\\]$/.exec(part);
    if (dm) {
      out.push(`<pre class="math">$$${esc(dm[1].trim())}$$</pre>`);
      continue;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const html = esc(para.replace(/^\n+|\n+$/g, "")).replace(new RegExp(ZAC_INLINE_MATH.source, "g"), (m, a, b) => `<span class="math">$${a ?? b}$</span>`);
      out.push(`<p>${html.replace(/\n/g, "<br/>")}</p>`);
    }
  }
  return out.join("");
}

// 选中的文字是否像公式（PDF 文本层里的公式会变成乱序的字符，需要截图辅助识别）
function zacLooksLikeFormula(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  const greek = (t.match(/[Ͱ-Ͽᴀ-ᶿ]/g) || []).length;
  const ops = (t.match(/[=≠≈≤≥<>±×÷∑∏∫∮√∞∂∇∈∉⊂⊆⊃∪∩∀∃→←↔⇒⇔⟨⟩‖|^_]/g) || []).length;
  const accents = (t.match(/[̀-ͯˆ˜¯ˇ˙¨′″]/g) || []).length;
  const mathAlnum = (t.match(/[\u{1D400}-\u{1D7FF}]/gu) || []).length; // 数学字母（𝑥、𝜙 等）
  const eqNo = /\(\s*\d{1,3}[a-z]?\s*\)\s*[,.]?\s*$/m.test(t) ? 2 : 0; // 行尾的公式编号 "(13)"
  const shortTokens = (t.match(/(?:^|\s)[A-Za-z](?=\s|$)/g) || []).length; // 散落的单个字母（上下标被拆开）
  const score = greek * 2 + ops * 1.5 + accents * 2 + mathAlnum * 2 + eqNo + (shortTokens >= 3 ? 2 : 0);
  return score >= 4 && score / Math.max(t.length, 1) > 0.025;
}

// 去掉终端颜色等控制字符
function zacStripAnsi(t) {
  return String(t || "").replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g, "");
}

// 解析 `agy models` 的输出：兼容 JSON、表格、带编号或符号的列表；标出当前 / 默认模型
function zacParseModelList(text) {
  const raw = zacStripAnsi(text).trim();
  if (!raw) return [];
  if (/^[\[{]/.test(raw)) {
    try {
      let j = JSON.parse(raw);
      if (!Array.isArray(j)) j = j.models || j.data || j.items || [];
      return j
        .map((m) => {
          if (typeof m === "string") return { value: m, label: m };
          const value = String(m.id ?? m.model ?? m.name ?? m.value ?? "");
          return { value, label: String(m.displayName ?? m.display_name ?? m.name ?? value), description: m.description || "", isDefault: !!(m.default || m.isDefault || m.current) };
        })
        .filter((m) => m.value);
    } catch (e) {}
  }
  const out = [];
  const seen = new Set();
  for (let line of raw.split("\n")) {
    line = line.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/^[\s\-=─━═│┃|+_.·*]+$/.test(line)) continue; // 分隔线
    if (/^\s*(available models|models?|model\s+(name|id)|name|id)\b/i.test(line) && !/\d/.test(line)) continue;
    if (/^\s*(use|run|tip|hint|try|see|type|note|usage)\b/i.test(line) || /\s--[a-z]|<[^>]+>/i.test(line)) continue; // 用法提示
    if (/:\s*$/.test(line)) continue; // 小标题
    let cur = false;
    if (/^\s*[*✓✔●►>→]\s+/.test(line) || /\((current|default|selected|active|当前|默认)\)/i.test(line)) cur = true;
    line = line
      .replace(/^\s*(?:[*•\-–●○►>→✓✔]|\d+[.)])\s+/, "")
      .replace(/\s*\((current|default|selected|active|当前|默认)\)\s*/gi, " ")
      .trim();
    let cols = line.includes("│") || line.includes("|") ? line.split(/[│|]/).map((c) => c.trim()).filter(Boolean) : line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (!cols.length) continue;
    if (cols.slice(1).some((c) => /^(default|current|selected|默认|当前)$/i.test(c))) cur = true;
    const value = cols[0];
    if (value.length > 80 || /^(model|name|id)$/i.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: value, description: cols.slice(1).join(" · "), isDefault: cur });
  }
  return out;
}

// 解析 `/usage` 的文本输出：找出带百分比的行作为额度窗口
function zacParseUsageText(text) {
  const lines = zacStripAnsi(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const windows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(l);
    if (!m) continue;
    let pct = parseFloat(m[1]);
    if (/remain|left|available|剩余|可用/i.test(l)) pct = 100 - pct;
    let label = l.replace(m[0], "").replace(/\b(used|consumed)\b|已用|已使用/gi, "").replace(/[█▓▒░■□▏▎▍▌▋▊▉\[\]#=\-]{3,}/g, "").replace(/\s{2,}/g, " ").replace(/[:：·|]\s*$/, "").trim();
    if (!label && i > 0 && !/%/.test(lines[i - 1])) label = lines[i - 1];
    const resetLine = [l, lines[i + 1] || ""].find((x) => /reset|refresh|renew|重置|刷新/i.test(x)) || "";
    windows.push({ label: label || "额度", usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: 0, resetText: resetLine && resetLine !== l ? resetLine : "" });
  }
  return windows;
}

// 时间：ISO 字符串、Unix 秒或毫秒 → 毫秒
function zacParseTime(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}
function zacWindowLabel(mins) {
  const m = Number(mins) || 0;
  if (!m) return "额度";
  if (m === 10080) return "每周";
  if (m === 1440) return "每天";
  if (m >= 40320 && m <= 44640) return "每月";
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}
// 元素是否真的显示在屏幕上：尺寸足够、自身及祖先没有被隐藏 / 折叠、确实位于窗口可见区域内
function zacIsShown(el, minSize = 1) {
  if (!el || !el.isConnected) return false;
  const win = el.ownerDocument && el.ownerDocument.defaultView;
  if (!win) return false;
  const r = el.getBoundingClientRect();
  if (r.width < minSize || r.height < minSize) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) return false;
  if (typeof el.checkVisibility === "function") {
    try {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    } catch (e) {}
  }
  for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
    const cs = win.getComputedStyle(n);
    if (!cs) continue;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0") return false;
    if (n.hasAttribute && (n.hasAttribute("hidden") || n.getAttribute("collapsed") === "true")) return false;
  }
  return true;
}

function zacUsageLevel(pct) {
  return pct >= 90 ? "zac-u-hi" : pct >= 70 ? "zac-u-mid" : "zac-u-lo";
}
function zacFmtReset(ms) {
  if (!ms) return "";
  const d = ms - Date.now();
  const pad = (x) => String(x).padStart(2, "0");
  const t = new Date(ms);
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const abs = sameDay ? `今天 ${pad(t.getHours())}:${pad(t.getMinutes())}` : `${t.getMonth() + 1}月${t.getDate()}日 ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  if (d <= 0) return "即将重置";
  const m = Math.ceil(d / 60000);
  const rel = m < 60 ? `${m} 分钟` : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
  return `${rel}后重置 · ${abs}`;
}

// 根据 CLI 的错误输出给出可能原因
function zacHint(agent, text) {
  const t = String(text || "");
  const name = ZAC_AGENTS[agent] || agent;
  const rules = [
    [/'node' is not recognized|node: not found|env: node|node\.exe/i,
      "找不到 Node.js。npm 安装的 CLI 需要 node，请把 node.exe 所在目录填到设置的「额外 PATH 目录」。"],
    [/找不到命令|在 PATH 中找不到|not recognized as an internal or external command|ENOENT/i,
      agent === "codex"
        ? "这台电脑上没有找到 Codex CLI（也没有找到编辑器扩展自带的 codex.exe）。安装：npm install -g @openai/codex（需要 Node.js 22 及以上），然后运行 codex login 登录；装好后在设置里点「诊断连接」。"
        : agent === "claude"
          ? "没有找到 Claude Code。安装后（官方安装脚本或 npm install -g @anthropic-ai/claude-code）在终端运行 claude 完成登录，再点「诊断连接」。"
          : agent === "agy"
            ? "没有找到 Antigravity CLI（agy）。可以在设置里点「安装 / 更新」，或在 PowerShell 运行 irm https://antigravity.google/cli/install.ps1 | iex；装好后运行 agy 用 Google 账号登录，再点「诊断连接」。"
          : `找不到命令。请在终端运行 where.exe <命令> 查出完整路径（.exe 或 .cmd），填到设置里的「命令」。`],
    [/not logged in|log ?in required|please (run )?.*login|unauthori[sz]ed|\b401\b|invalid api key|authentication/i,
      agent === "codex" ? "Codex 尚未登录或登录已过期：在终端运行 codex login。" : `${name} 尚未登录或登录已过期，请在终端里登录后重试。`],
    [/unexpected argument|unrecognized (option|argument)|unknown (option|argument|flag)|found argument .* which wasn't expected/i,
      `${name} 版本可能过旧，不认识插件使用的参数。请更新：` +
        (agent === "codex" ? "在设置里点「安装 / 更新」，或 npm i -g @openai/codex@latest" : agent === "agy" ? "在设置里点「安装 / 更新」，或运行 agy update" : "claude update")],
    // 注意 codex 的 stderr 抬头会打印 "reasoning effort: xxx"、"sandbox: read-only"，规则必须带上错误字样
    [/(unsupported|invalid|not supported|unknown variant|not allowed).{0,60}effort|effort.{0,60}(unsupported|invalid|not supported|unknown variant|not allowed)/i,
      "所选 Effort 不被当前模型支持，改为「默认」或刷新模型列表后重试。"],
    [/model .*(not (found|supported|available|exist))|does not exist|unsupported model|invalid model|model_not_found/i,
      "所选模型不可用，改选「默认」，或在设置里从本机刷新模型列表。"],
    [/sandbox.{0,60}(fail|error|denied|not supported|unavailable)|(fail|error).{0,60}sandbox|landlock|seatbelt|AppContainer/i,
      "Codex 的沙箱在这台电脑上启动失败。可以先在终端运行 codex exec --sandbox read-only \"hi\" 确认；Windows 上需要较新的 Codex 版本。"],
    [/\b429\b|rate limit|quota|usage limit|exceeded/i, "额度或频率限制，稍后再试，或换用其他模型。"],
    [/network|ECONNRESET|ETIMEDOUT|ENOTFOUND|getaddrinfo|proxy|certificate|stream disconnected/i,
      "网络连接失败。如果平时在终端需要代理才能使用，请确认 Zotero 启动时也能用到代理（例如设置系统代理或 HTTPS_PROXY 环境变量）。"],
    [/无法启动进程|Failed to create process/i, "进程启动失败：命令路径需要指向 .exe 或 .cmd，请运行设置里的「诊断」查看实际执行的命令。"],
  ];
  for (const [re, msg] of rules) if (re.test(t)) return msg;
  return "";
}

var AgentChat = {
  id: null,
  version: null,
  rootURI: null,
  PREF: "extensions.zotero-agent-chat.",
  sessions: new Map(),
  sectionViews: new WeakMap(),
  sectionID: null,

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  log(msg) {
    Zotero.debug("[AgentChat] " + msg);
  },
  getPref(k) {
    return Zotero.Prefs.get(this.PREF + k, true);
  },
  setPref(k, v) {
    Zotero.Prefs.set(this.PREF + k, v, true);
  },

  // 当前 agent 及其模型 / effort
  currentAgent() {
    const a = this.getPref("agent");
    return ZAC_AGENTS[a] ? a : "claude";
  },
  // 返回实际会用到的配置：所选模型不支持的 effort 会被忽略
  agentConfig(agent = this.currentAgent()) {
    if (agent === "custom") return { agent, model: "", effort: "" };
    const model = String(this.getPref(agent + "Model") || "").trim();
    let effort = String(this.getPref(agent + "Effort") || "").trim();
    const allowed = this.allowedEfforts(agent, model);
    if (effort && allowed.known && !allowed.list.some((e) => e.value === effort)) effort = "";
    return { agent, model, effort };
  },

  // 某个模型可选的 effort；known=true 表示列表来自本机 CLI 且能对上这个模型
  allowedEfforts(agent, model) {
    const info = this.modelInfo(agent);
    if (info.source !== "cli") return { list: info.fallbackEfforts || [], defaultEffort: "", known: false };
    const m = info.models.find((x) => x.value === model) || (!model && info.models.find((x) => x.isDefault));
    if (m) {
      const list = m.efforts || [];
      if (!list.length && m.supportsEffort) {
        return { list: (ZAC_EFFORTS[agent] || []).map((v) => ({ value: v })), defaultEffort: "", known: false };
      }
      return { list, defaultEffort: m.defaultEffort || "", known: true };
    }
    // 自定义的模型名：给出所有模型档位的并集
    const seen = new Map();
    for (const x of info.models) for (const e of x.efforts || []) if (!seen.has(e.value)) seen.set(e.value, e);
    const list = seen.size ? [...seen.values()] : (ZAC_EFFORTS[agent] || []).map((v) => ({ value: v }));
    return { list, defaultEffort: "", known: false };
  },
  // KaTeX（content/lib/katex.min.js，MIT）：只用它把 LaTeX 转成 MathML，由 Zotero（Firefox 内核）原生排版，不需要字体和样式表
  getKatex() {
    if (this._katex !== undefined) return this._katex;
    try {
      if (typeof katex !== "undefined") return (this._katex = katex); // 浏览器预览环境
      const scope = {};
      scope.self = scope;
      Services.scriptloader.loadSubScript(this.rootURI + "content/lib/katex.min.js", scope);
      this._katex = scope.katex || null;
    } catch (e) {
      this.log("load katex failed: " + e);
      this._katex = null;
    }
    return this._katex;
  },

  // 插件界面字号：百分比，80–160
  fontScale() {
    const v = parseInt(this.getPref("fontScale"), 10);
    return Math.min(160, Math.max(80, isNaN(v) ? 100 : v));
  },
  setFontScale(pct) {
    const v = Math.min(160, Math.max(80, Math.round(pct / 5) * 5));
    this.setPref("fontScale", v);
    for (const s of this.sessions.values()) s.emit("font");
    return v;
  },

  // 公式增强：选中公式时截图交给 agent，并让它先还原出准确的 LaTeX
  formulaEnhance() {
    const v = this.getPref("formulaEnhance");
    if (v === undefined || v === null) return this.getPref("autoSnipFormula") !== false;
    return v !== false;
  },

  floatingEnabled() {
    return this.getPref("floatingEnabled") !== false;
  },
  agentLabel({ agent, model, effort }) {
    let modelName = model;
    if (model) {
      const m = this.modelInfo(agent).models.find((x) => x.value === model);
      if (m && m.label) modelName = m.label;
    }
    return [ZAC_AGENTS[agent] || agent, modelName, zacEffortLabel(agent, effort)].filter(Boolean).join(" · ");
  },

  /* ---------------- 生命周期 ---------------- */

  startup() {
    this._onSelectionPopup = (e) => {
      try { this.onSelectionPopup(e); } catch (err) { Zotero.logError(err); }
    };
    this._onToolbar = (e) => {
      try { this.onToolbar(e); } catch (err) { Zotero.logError(err); }
    };
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._onSelectionPopup, this.id);
    Zotero.Reader.registerEventListener("renderToolbar", this._onToolbar, this.id);

    this.sectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "agent-chat",
      pluginID: this.id,
      header: { l10nID: "zotero-agent-chat-section-head", icon: this.rootURI + "icons/chat.svg" },
      sidenav: { l10nID: "zotero-agent-chat-section-sidenav", icon: this.rootURI + "icons/chat.svg" },
      onRender: ({ body, item }) => {
        try { this.renderSection(body, item); } catch (err) { Zotero.logError(err); }
      },
    });
    this.restoreAutoUpdateOnce();
    this.cleanupSnips();
    this.log("started " + this.version);
  },

  // 0.4.3–0.6.x 的更新地址无效，当时把本插件的自动更新默认关掉了；
  // 现在更新文件托管在 GitHub 上，升级到这一版后恢复为「默认」一次（之后尊重用户自己的选择）
  async restoreAutoUpdateOnce() {
    if (this.getPref("autoUpdateRestored")) return;
    try {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(this.id);
      if (!addon) return;
      if (this.getPref("autoUpdateDefaultApplied") && addon.applyBackgroundUpdates === AddonManager.AUTOUPDATE_DISABLE) {
        addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;
      }
      this.setPref("autoUpdateRestored", true);
    } catch (e) {
      this.log("restoreAutoUpdateOnce failed: " + e);
    }
  },

  shutdown() {
    try { Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._onSelectionPopup); } catch (e) {}
    try { Zotero.Reader.unregisterEventListener("renderToolbar", this._onToolbar); } catch (e) {}
    if (this.sectionID) {
      try { Zotero.ItemPaneManager.unregisterSection(this.sectionID); } catch (e) {}
      this.sectionID = null;
    }
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    for (const win of Zotero.getMainWindows()) this.removeFTL(win);
  },

  addToWindow(win) {
    try { win.MozXULElement.insertFTLIfNeeded("zotero-agent-chat.ftl"); } catch (e) { this.log(e); }
  },

  removeFromWindow(win) {
    const session = this.sessions.get(win);
    if (session) {
      session.destroy();
      this.sessions.delete(win);
    }
    this.removeFTL(win);
  },

  removeFTL(win) {
    try { win.document.querySelector('[href="zotero-agent-chat.ftl"]')?.remove(); } catch (e) {}
  },

  getSession(win) {
    let s = this.sessions.get(win);
    if (!s) {
      s = new ZacSession(this, win);
      this.sessions.set(win, s);
    }
    return s;
  },

  readerWindow(reader) {
    const w = reader && reader._window;
    return w && !w.closed ? w : Zotero.getMainWindow();
  },

  /* ---------------- 三个入口 ---------------- */

  // 1. 选中文字后弹出的小菜单
  onSelectionPopup({ reader, doc, params, append }) {
    // PDF、阅读模式（重排视图）、EPUB、网页快照共用这个弹出菜单
    const text = ((params && ((params.annotation && params.annotation.text) || params.text)) || "").trim();
    if (!text) return;
    const session = this.getSession(this.readerWindow(reader));
    let ann = null;
    try { ann = JSON.parse(JSON.stringify(params.annotation)); } catch (e) {}
    session.setSelection(text, reader.itemID, { annotation: ann, reader });

    const btn = doc.createElement("button");
    btn.textContent = "💬 问 Agent";
    btn.title = "把选中内容带到 Agent 对话";
    btn.setAttribute(
      "style",
      "display:block;width:calc(100% - 8px);margin:4px;padding:4px 8px;border:none;border-radius:5px;" +
        "cursor:pointer;background:rgba(127,127,127,.18);color:inherit;font:inherit;"
    );
    btn.addEventListener("click", () => session.focusBest());
    append(btn);

    // 侧边栏里的对话区块正显示着，就用它，不再弹悬浮窗
    if (this.floatingEnabled() && this.getPref("autoOpenOnSelect") && !session.visibleEmbedded()) {
      session.openFloating({ focus: false });
    }
  },

  // 2. 阅读器顶部工具栏按钮：开关悬浮窗
  onToolbar({ reader, doc, append }) {
    const btn = doc.createElement("button");
    btn.className = "toolbar-button";
    btn.title = "Agent 对话";
    btn.textContent = "💬";
    btn.addEventListener("click", () => {
      const session = this.getSession(this.readerWindow(reader));
      if (this.floatingEnabled()) session.toggleFloating({ itemID: reader.itemID });
      else session.revealSidebar();
    });
    append(btn);
  },

  // 3. 右侧条目面板（侧边栏）里的对话区块
  renderSection(body, item) {
    const win = body.ownerDocument.defaultView;
    const session = this.getSession(win);
    let view = this.sectionViews.get(body);
    if (!view || !view.root || !body.contains(view.root)) {
      body.replaceChildren();
      view = new ZacChatView(session, "embedded", body);
      this.sectionViews.set(body, view);
    }
    view.setItem(item ? item.id : null);
  },

  /* ---------------- 调用 agent CLI ---------------- */

  buildCommand(agent, { pdfDir = null, prompt = "", model = "", effort = "", images = [] } = {}) {
    const g = (k) => String(this.getPref(k) ?? "").trim();
    if (agent === "claude") {
      const args = ["-p"]; // 非交互模式，prompt 从 stdin 读入
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort); // low / medium / high / xhigh / max，可用档位取决于模型
      if (pdfDir) args.push("--add-dir", pdfDir); // 允许读取 PDF 所在目录
      return { command: g("claudePath") || "claude", args, stdin: prompt };
    }
    if (agent === "codex") {
      // stdout 只输出最终回答，进度在 stderr；"-" 表示从 stdin 读 prompt
      const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only"];
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort=${effort}`); // minimal ~ xhigh，取决于模型
      for (const img of images) args.push("-i", img); // 选区截图直接作为图片输入
      args.push("-");
      return { command: g("codexPath") || "codex", args, stdin: prompt };
    }
    if (agent === "agy") {
      // agy 的非交互模式只接受 -p 后面的参数作为提示词（文档未说明可从 stdin 读取）
      const args = ["-p", prompt];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (pdfDir) args.push("--add-dir", pdfDir);
      return { command: g("agyPath") || "agy", args, stdin: "", promptAsArg: true };
    }
    const command = g("customCommand");
    if (!command) throw new Error("请先在设置（⚙）中填写自定义命令");
    let args = zacSplitArgs(g("customArgs"));
    const promptAsArg = args.some((a) => a.includes("{prompt}"));
    args = args.map((a) =>
      a.replace(/\{prompt\}/g, () => prompt).replace(/\{pdf_dir\}/g, () => pdfDir || "").replace(/\{image\}/g, () => images[0] || "")
    );
    return { command, args, stdin: promptAsArg ? "" : prompt, promptAsArg };
  },

  envGet(k) {
    try {
      const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
      return env.exists(k) ? env.get(k) : "";
    } catch (e) {
      return "";
    }
  },

  homeDir() {
    return this.envGet("HOME") || this.envGet("USERPROFILE");
  },

  // GUI 启动的 Zotero 拿不到终端里的 PATH（尤其 macOS），这里补上常见安装位置
  buildEnv() {
    const sep = Zotero.isWin ? ";" : ":";
    const home = this.homeDir();
    const extra = String(this.getPref("extraPath") || "").split(new RegExp(`[\\n${sep}]`));
    const common = Zotero.isWin
      ? [
          home + "\\.local\\bin",
          this.envGet("APPDATA") && this.envGet("APPDATA") + "\\npm",
          this.envGet("LOCALAPPDATA") && this.envGet("LOCALAPPDATA") + "\\Programs\\nodejs",
          // Codex 官方独立安装脚本的命令目录（安装时写入用户 PATH，已打开的 Zotero 看不到，所以这里补上）
          this.envGet("LOCALAPPDATA") && this.envGet("LOCALAPPDATA") + "\\Programs\\OpenAI\\Codex\\bin",
          // Antigravity CLI（agy）安装脚本的位置
          this.envGet("LOCALAPPDATA") && this.envGet("LOCALAPPDATA") + "\\agy\\bin",
          this.envGet("LOCALAPPDATA") && this.envGet("LOCALAPPDATA") + "\\Antigravity",
          "C:\\Program Files\\nodejs",
        ]
      : [
          home + "/.local/bin",
          home + "/.claude/local",
          home + "/.agy/bin",
          "/opt/homebrew/bin",
          "/usr/local/bin",
          home + "/.npm-global/bin",
          home + "/.bun/bin",
          home + "/.volta/bin",
          "/usr/bin",
          "/bin",
        ];
    const parts = [...extra, ...common, ...this.envGet("PATH").split(sep)]
      .map((s) => (s || "").trim())
      .filter(Boolean);
    const env = { PATH: [...new Set(parts)].join(sep) };
    if (Zotero.isWin) env.PATHEXT = this.envGet("PATHEXT") || ".COM;.EXE;.BAT;.CMD";
    return env;
  },

  fileExists(path) {
    try {
      return Zotero.File.pathToFile(path).exists();
    } catch (e) {
      return false;
    }
  },

  async resolveCommand(cmd, env, Subprocess) {
    cmd = cmd.replace(/^"(.*)"$/, "$1"); // 去掉复制路径时带的引号
    if (cmd.startsWith("~")) cmd = this.homeDir() + cmd.slice(1);
    let found;
    if (/[\\/]/.test(cmd)) {
      if (Zotero.isWin) cmd = cmd.replace(/\//g, "\\");
      if (!this.fileExists(cmd) && !(Zotero.isWin && this.winFindExecutable(cmd))) {
        throw new Error(`找不到命令文件：${cmd}`);
      }
      found = cmd;
    } else if (Zotero.isWin) {
      found = this.winPathSearch(cmd, env);
    } else {
      try {
        found = await Subprocess.pathSearch(cmd, env);
      } catch (e) {
        found = null;
      }
    }
    // 没装独立 CLI 时，试试 VS Code / Cursor 等编辑器里 Codex 扩展自带的 codex 程序
    if (!found && cmd === "codex") found = await this.findBundledCodex();
    if (!found) {
      const how = Zotero.isWin ? `where.exe ${cmd}` : `which ${cmd}`;
      throw new Error(`在 PATH 中找不到 "${cmd}"。请在终端运行 ${how} 查看完整路径，并填到设置（⚙）里。`);
    }
    if (Zotero.isWin) {
      const exe = this.winFindExecutable(found);
      if (!exe) {
        throw new Error(
          `"${found}" 不是 Windows 能直接启动的程序（需要 .exe 或 .cmd）。\n` +
            `npm 会在同一目录放一个无扩展名的脚本、一个 .cmd 和一个 .ps1，请在设置（⚙）里改填 .cmd 或 .exe 那一个。`
        );
      }
      found = exe;
    }
    return found;
  },

  // OpenAI 的编辑器扩展（openai.chatgpt-<版本>-<平台>）在 bin/<平台>/ 下自带 codex 可执行文件
  async findBundledCodex() {
    const home = this.homeDir();
    if (!home) return null;
    const sep = Zotero.isWin ? "\\" : "/";
    const IOUtils = Zotero.getMainWindow().IOUtils;
    if (!IOUtils) return null;
    const roots = [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".trae", ".vscode-oss"].map((d) => `${home}${sep}${d}${sep}extensions`);
    const exe = Zotero.isWin ? "codex.exe" : "codex";
    const hits = [];
    for (const root of roots) {
      let exts;
      try { exts = await IOUtils.getChildren(root); } catch (e) { continue; }
      for (const ext of exts) {
        const base = ext.split(/[\\/]/).pop();
        if (!/^openai\.chatgpt-/i.test(base)) continue;
        let plats;
        try { plats = await IOUtils.getChildren(`${ext}${sep}bin`); } catch (e) { continue; }
        for (const plat of plats) {
          const f = `${plat}${sep}${exe}`;
          if (this.fileExists(f)) hits.push(f);
        }
      }
    }
    if (!hits.length) return null;
    // 版本号最大的扩展优先
    hits.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    this.log("using bundled codex: " + hits[0]);
    return hits[0];
  },

  // Windows：没有扩展名、或是 .ps1/.sh/.js 这类脚本时，找同目录同名的 .exe/.cmd/.bat
  winFindExecutable(path) {
    if (/\.(exe|com|cmd|bat)$/i.test(path)) return this.fileExists(path) ? path : null;
    const base = path.replace(/\.(ps1|sh|js|mjs)$/i, "");
    for (const ext of [".exe", ".cmd", ".bat", ".com"]) {
      if (this.fileExists(base + ext)) return base + ext;
    }
    return null;
  },

  // 自己在 PATH 里找，只接受可执行扩展名（npm 目录里那个无扩展名的 sh 脚本会让 CreateProcess 失败）
  winPathSearch(name, env) {
    const hasExt = /\.(exe|com|cmd|bat)$/i.test(name);
    const exts = hasExt ? [""] : [".exe", ".cmd", ".bat", ".com"];
    for (let dir of String(env.PATH || "").split(";")) {
      dir = dir.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, "");
      if (!dir) continue;
      for (const ext of exts) {
        const p = `${dir}\\${name}${ext}`;
        if (this.fileExists(p)) return p;
      }
    }
    return null;
  },

  async getWorkdir() {
    const dir = Zotero.DataDirectory.dir + (Zotero.isWin ? "\\" : "/") + "agent-chat";
    await Zotero.File.createDirectoryIfMissingAsync(dir);
    return dir;
  },

  // Windows 下 npm 安装的是 .cmd 脚本，不能直接作为进程启动，借一个 .bat 交给 cmd.exe
  async windowsBatchWrapper(command, args, workdir) {
    const quote = (a) => (a === "" || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const line = [command, ...args].map(quote).join(" ").replace(/%/g, "%%");
    const bat = `${workdir}\\run-${Date.now()}.bat`;
    await Zotero.File.putContentsAsync(bat, "@echo off\r\nchcp 65001 >nul\r\n" + line + "\r\n");
    const sysRoot = this.envGet("SystemRoot") || "C:\\Windows";
    const comspec = [this.envGet("ComSpec"), sysRoot + "\\System32\\cmd.exe"].find((p) => p && this.fileExists(p));
    return {
      command: comspec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", bat],
      cleanup: bat,
    };
  },

  encode(str) {
    const TE = typeof TextEncoder !== "undefined" ? TextEncoder : Zotero.getMainWindow().TextEncoder;
    return new TE().encode(str);
  },

  // 解析命令、准备环境并启动子进程
  async launch(command, args) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const env = this.buildEnv();
    const sep = Zotero.isWin ? ";" : ":";
    const resolved = await this.resolveCommand(command, env, Subprocess);
    // 命令所在目录放到 PATH 最前面（npm 安装的 claude/codex 需要同目录下的 node）
    env.PATH = Zotero.File.pathToFile(resolved).parent.path + sep + env.PATH;
    const workdir = await this.getWorkdir();

    let cmd = resolved;
    let argv = args;
    let cleanup = null;
    if (Zotero.isWin && /\.(cmd|bat)$/i.test(resolved)) {
      ({ command: cmd, args: argv, cleanup } = await this.windowsBatchWrapper(resolved, args, workdir));
    }
    this.log(`spawn: ${cmd} ${argv.join(" ")}`);

    let proc;
    try {
      proc = await Subprocess.call({
        command: cmd,
        arguments: argv,
        environment: env,
        environmentAppend: true,
        workdir,
        stderr: "pipe",
      });
    } catch (e) {
      if (cleanup) { try { await Zotero.File.removeIfExists(cleanup); } catch (e2) {} }
      throw new Error(
        `无法启动进程（${(e && e.message) || e}）\n命令：${cmd}\n参数：${argv.join(" ")}\n工作目录：${workdir}`
      );
    }
    const done = async () => {
      if (cleanup) { try { await Zotero.File.removeIfExists(cleanup); } catch (e) {} }
    };
    return { proc, resolved, done };
  },

  // 一次性运行：写入 stdin、读完 stdout/stderr
  async spawn({ command, args, input = "", onOutput = null, onError = null, state = {} }) {
    const { proc, resolved, done } = await this.launch(command, args);
    state.proc = proc;
    if (state.cancelled) proc.kill();

    const readAll = async (pipe, cb) => {
      let all = "";
      try {
        for (;;) {
          const chunk = await pipe.readString();
          if (!chunk) break;
          all += chunk;
          if (cb) cb(all);
        }
      } catch (e) {
        this.log("read error: " + e);
      }
      return all;
    };
    const outP = readAll(proc.stdout, onOutput);
    const errP = readAll(proc.stderr, onError);
    try {
      if (input) await proc.stdin.write(this.encode(input));
    } catch (e) {
      this.log("stdin write failed: " + e);
    }
    try { await proc.stdin.close(); } catch (e) {}

    const [out, err] = await Promise.all([outP, errP]);
    const { exitCode } = await proc.wait();
    state.proc = null;
    await done();
    return { out, err, exitCode, command: resolved };
  },

  // 与子进程按 JSON Lines 对话：onMessage 返回非 undefined 即结束（可调用 send 继续发消息）
  async jsonlSession({ command, args, first, onMessage, timeoutMs = 45000 }) {
    const { proc, done } = await this.launch(command, args);
    const win = Zotero.getMainWindow();
    let err = "";
    const errP = (async () => {
      try {
        let c;
        while ((c = await proc.stderr.readString())) err += c;
      } catch (e) {}
    })();
    const send = (obj) => proc.stdin.write(this.encode(JSON.stringify(obj) + "\n"));
    let timer;
    const timeout = new Promise((r) => { timer = win.setTimeout(() => r(null), timeoutMs); });
    let result;
    let failure = null;
    try {
      for (const m of first) await send(m);
      let buf = "";
      outer: for (;;) {
        const chunk = await Promise.race([proc.stdout.readString(), timeout]);
        if (!chunk) break;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line || line[0] !== "{") continue;
          let obj;
          try { obj = JSON.parse(line); } catch (e) { continue; }
          const r = await onMessage(obj, send);
          if (r !== undefined) {
            result = r;
            break outer;
          }
        }
      }
    } catch (e) {
      failure = e;
    } finally {
      win.clearTimeout(timer);
      try { proc.kill(); } catch (e) {}
      await Promise.race([errP, new Promise((r) => win.setTimeout(r, 500))]);
      await done();
    }
    if (failure) throw failure;
    if (result === undefined) {
      throw new Error("没有收到回应" + (err.trim() ? "：\n" + zacTail(err.trim(), 500) : "（超时）"));
    }
    return result;
  },

  async testAgent(agent) {
    const { command } = this.buildCommand(agent, {});
    return this.spawn({ command, args: ["--version"] });
  },

  // 逐步诊断：找命令 → 版本 → 登录 → 模型列表 → 真实请求；每一步通过 log(line) 输出
  async diagnose(agent, log) {
    const name = ZAC_AGENTS[agent];
    const step = (ok, title, detail = "") =>
      log(`${ok === null ? "…" : ok ? "✓" : "✗"} ${title}${detail ? "\n    " + String(detail).trim().replace(/\n/g, "\n    ") : ""}`);
    const runWithTimeout = async (opts, ms) => {
      const state = {};
      const win = Zotero.getMainWindow();
      const timer = win.setTimeout(() => { state.cancelled = true; state.timedOut = true; try { state.proc && state.proc.kill(); } catch (e) {} }, ms);
      try { return Object.assign(await this.spawn({ ...opts, state }), { timedOut: !!state.timedOut }); }
      finally { win.clearTimeout(timer); }
    };

    log(`${name} 诊断  ·  ${new Date().toLocaleString()}  ·  ${Zotero.isWin ? "Windows" : Zotero.isMac ? "macOS" : "Linux"}`);
    let command;
    try {
      ({ command } = this.buildCommand(agent, {}));
      const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      const resolved = await this.resolveCommand(command, this.buildEnv(), Subprocess);
      step(true, "找到命令", resolved);
    } catch (e) {
      step(false, "找不到命令", e.message);
      const h = zacHint(agent, e.message);
      if (h) log("→ " + h);
      return { ok: false, missing: agent !== "custom" };
    }

    try {
      const r = await runWithTimeout({ command, args: ["--version"] }, 30000);
      step(r.exitCode === 0, "运行 --version", (r.out || r.err).trim() || `退出码 ${r.exitCode}`);
      if (r.exitCode !== 0) {
        const h = zacHint(agent, r.err + r.out);
        if (h) log("→ " + h);
        return false;
      }
    } catch (e) {
      step(false, "无法运行", e.message);
      const h = zacHint(agent, e.message);
      if (h) log("→ " + h);
      return false;
    }

    if (agent === "codex") {
      try {
        const r = await runWithTimeout({ command, args: ["login", "status"] }, 30000);
        const out = (r.out + "\n" + r.err).trim();
        step(r.exitCode === 0, "登录状态（codex login status）", out || `退出码 ${r.exitCode}`);
        if (r.exitCode !== 0) log("→ 请在终端运行 codex login 登录后重试。");
      } catch (e) {
        step(false, "检查登录状态失败", e.message);
      }
    }

    if (agent !== "custom") {
      try {
        const models = await this.refreshModels(agent, true);
        const list = models.filter((m) => m.value !== "default");
        step(true, `获取模型列表（${list.length} 个）`, list.map((m) => m.label).join("、"));
      } catch (e) {
        step(false, "获取模型列表失败（不影响提问，会使用内置预设）", zacTail(e.message, 600));
      }
    }

    const cfg = this.agentConfig(agent);
    let built;
    try {
      built = this.buildCommand(agent, { prompt: "这是一次连通性测试，请只回复：OK", model: cfg.model, effort: cfg.effort });
    } catch (e) {
      step(false, "生成命令失败", e.message);
      return false;
    }
    step(null, `发送测试请求（${this.agentLabel(cfg)}）`, `${built.command} ${built.args.join(" ")}`);
    const t0 = Date.now();
    try {
      const r = await runWithTimeout({ command: built.command, args: built.args, input: built.stdin }, 180000);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const out = r.out.trim();
      if (r.timedOut) {
        step(false, `测试请求超时（${sec}s）`, zacTail(r.err, 800));
      } else if (r.exitCode === 0 && out) {
        step(true, `收到回复（${sec}s）`, zacClip(out, 200));
        log(`全部通过，${name} 可以正常使用。`);
        return true;
      } else {
        step(false, `测试请求失败（退出码 ${r.exitCode}，${sec}s）`, zacTail(r.err + "\n" + out, 1500));
      }
      const h = zacHint(agent, r.err + "\n" + out);
      if (h) log("→ " + h);
    } catch (e) {
      step(false, "测试请求无法运行", e.message);
    }
    return false;
  },

  /* ---------------- 从本机 CLI 获取模型与 effort 列表 ---------------- */

  // 统一格式：{ value, label, description, efforts: [{value, description}], defaultEffort, isDefault }
  async discoverModels(agent) {
    if (agent === "claude") return this.discoverClaudeModels();
    if (agent === "codex") return this.discoverCodexModels();
    if (agent === "agy") return this.discoverAgyModels();
    return [];
  },

  // Antigravity：`agy models` 列出当前账号可用的模型
  async discoverAgyModels() {
    const { command } = this.buildCommand("agy", {});
    const state = {};
    const win = Zotero.getMainWindow();
    const timer = win.setTimeout(() => { state.cancelled = true; try { state.proc && state.proc.kill(); } catch (e) {} }, 30000);
    let r;
    try {
      r = await this.spawn({ command, args: ["models"], state });
    } finally {
      win.clearTimeout(timer);
    }
    if (state.cancelled) throw new Error("agy models 超时");
    const models = zacParseModelList(r.out);
    if (r.exitCode !== 0 || !models.length) {
      throw new Error(zacTail((r.err || r.out || "").trim(), 600) || `agy models 退出码 ${r.exitCode}`);
    }
    const efforts = ZAC_EFFORTS.agy.map((v) => ({ value: v }));
    return models.map((m) => ({ ...m, efforts, supportsEffort: true }));
  },

  // Claude Code：以 SDK 的 stream-json 模式启动，发 initialize 控制请求，回应里带 models
  async discoverClaudeModels() {
    const { command } = this.buildCommand("claude", {});
    const rid = "zac-init-" + Date.now();
    const findModels = (o, depth = 0) => {
      if (!o || typeof o !== "object" || depth > 5) return null;
      if (Array.isArray(o.models)) return o.models;
      for (const v of Object.values(o)) {
        const r = findModels(v, depth + 1);
        if (r) return r;
      }
      return null;
    };
    const raw = await this.jsonlSession({
      command,
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      first: [{ type: "control_request", request_id: rid, request: { subtype: "initialize" } }],
      onMessage: (obj) => {
        if (obj.type !== "control_response") return undefined;
        const resp = obj.response || {};
        if (resp.subtype === "error") throw new Error("Claude Code 返回错误：" + (resp.error || JSON.stringify(resp)));
        return findModels(resp) || undefined;
      },
    });
    const models = raw
      .map((m) => {
        const value = String(m.value ?? m.id ?? m.model ?? "");
        const levels = m.supportedEffortLevels ?? m.supported_effort_levels ?? [];
        const display = String(m.displayName ?? m.display_name ?? "").trim();
        const resolved = String(m.resolvedModel ?? m.resolved_model ?? "").trim();
        return {
          value,
          label: zacModelLabel({ value, display, resolved, description: m.description }),
          resolved,
          description: [value, resolved, m.description].filter(Boolean).join(" — "),
          efforts: levels.map((e) => (typeof e === "string" ? { value: e } : { value: e.value ?? e.level ?? String(e), description: e.description || "" })),
          supportsEffort: !!(m.supportsEffort ?? m.supports_effort ?? levels.length),
          isDefault: value === "default",
        };
      })
      .filter((m) => m.value);
    return zacDisambiguate(models);
  },

  // Codex：codex app-server（JSON-RPC over stdio）→ initialize → model/list（分页）
  async discoverCodexModels() {
    const { command } = this.buildCommand("codex", {});
    const all = [];
    let nextId = 1;
    const listReq = (cursor) => {
      const params = { limit: 100, includeHidden: false };
      if (cursor) params.cursor = cursor;
      return { method: "model/list", id: ++nextId, params };
    };
    let pending = null;
    const raw = await this.jsonlSession({
      command,
      args: ["app-server"],
      first: [{ method: "initialize", id: 1, params: { clientInfo: { name: "zotero_agent_chat", title: "Agent Chat for Zotero", version: this.version || "0" } } }],
      onMessage: async (obj, send) => {
        if (obj.id === 1 && ("result" in obj || "error" in obj)) {
          if (obj.error) throw new Error("Codex initialize 失败：" + (obj.error.message || JSON.stringify(obj.error)));
          await send({ method: "initialized", params: {} });
          pending = listReq(null);
          await send(pending);
          return undefined;
        }
        if (pending && obj.id === pending.id) {
          if (obj.error) throw new Error("Codex model/list 失败：" + (obj.error.message || JSON.stringify(obj.error)));
          const r = obj.result || {};
          all.push(...(r.data || []));
          if (r.nextCursor) {
            pending = listReq(r.nextCursor);
            await send(pending);
            return undefined;
          }
          return all;
        }
        return undefined;
      },
    });
    return raw
      .filter((m) => !m.hidden)
      .map((m) => ({
        value: String(m.model ?? m.id ?? ""),
        label: zacModelLabel({ value: String(m.model ?? m.id ?? ""), display: m.displayName, resolved: m.model, description: m.description }),
        description: m.description || "",
        efforts: (m.supportedReasoningEfforts || []).map((e) =>
          typeof e === "string" ? { value: e } : { value: e.reasoningEffort ?? e.effort ?? e.value, description: e.description || "" }
        ),
        defaultEffort: m.defaultReasoningEffort || "",
        isDefault: !!m.isDefault,
      }))
      .filter((m) => m.value);
  },

  // 缓存格式版本：显示名规则改变时加 1，旧缓存自动作废并重新获取
  MODEL_CACHE_VERSION: 2,

  readModelCache() {
    let c = {};
    try { c = JSON.parse(this.getPref("modelCache") || "{}") || {}; } catch (e) {}
    for (const k of Object.keys(c)) if (!c[k] || c[k].v !== this.MODEL_CACHE_VERSION) delete c[k];
    return c;
  },

  // 当前可用于界面的模型列表（本机获取的缓存；没有则用内置预设）
  modelInfo(agent) {
    const c = this.readModelCache()[agent];
    if (c && Array.isArray(c.models) && c.models.length) return { models: c.models, source: "cli", ts: c.ts };
    const efforts = (ZAC_EFFORTS[agent] || []).map((v) => ({ value: v }));
    return {
      models: (ZAC_MODELS[agent] || []).map((v) => ({ value: v, label: v, description: "", efforts })),
      fallbackEfforts: efforts,
      source: "builtin",
      ts: 0,
    };
  },

  // 刷新模型列表；force=false 时 24 小时内不重复获取，本次运行失败过也不重试
  refreshModels(agent, force = false) {
    if (agent === "custom") return Promise.resolve(null);
    this._discovering = this._discovering || {};
    this._discoverFailed = this._discoverFailed || {};
    if (this._discovering[agent]) return this._discovering[agent];
    if (!force) {
      const c = this.readModelCache()[agent];
      if (this._discoverFailed[agent]) return Promise.resolve(null);
      if (c && c.ts && Date.now() - c.ts < 24 * 3600 * 1000) return Promise.resolve(c.models);
    }
    const p = (async () => {
      try {
        const models = await this.discoverModels(agent);
        if (!models.length) throw new Error("CLI 没有返回任何模型");
        const cache = this.readModelCache();
        cache[agent] = { v: this.MODEL_CACHE_VERSION, ts: Date.now(), models };
        this.setPref("modelCache", JSON.stringify(cache));
        delete this._discoverFailed[agent];
        for (const s of this.sessions.values()) s.emit("controls");
        return models;
      } catch (e) {
        this._discoverFailed[agent] = String((e && e.message) || e);
        this.log(`discover ${agent} models failed: ${e}`);
        throw e;
      } finally {
        delete this._discovering[agent];
      }
    })();
    this._discovering[agent] = p;
    return p;
  },

  /* ---------------- 选区截图、原文高亮、跳转链接 ---------------- */

  snipDir() {
    return Zotero.DataDirectory.dir + (Zotero.isWin ? "\\" : "/") + "agent-chat" + (Zotero.isWin ? "\\" : "/") + "snips";
  },

  // 把选区在阅读器里已经渲染好的页面画面裁下来（PDF 才有；EPUB / 网页快照返回 null）
  async captureSelection(reader, sel) {
    const pos = sel && sel.position;
    if (!pos || !Number.isInteger(pos.pageIndex) || !Array.isArray(pos.rects) || !pos.rects.length) return null;
    const waive = (o) => (o && o.wrappedJSObject) || o;
    const internal = waive(reader && reader._internalReader);
    const view = waive(internal && internal._primaryView);
    const vwin = waive(view && view._iframeWindow);
    const app = waive(vwin && vwin.PDFViewerApplication);
    const viewer = waive(app && app.pdfViewer);
    if (!viewer || typeof viewer.getPageView !== "function") return null;
    const pv = waive(viewer.getPageView(pos.pageIndex));
    if (!pv) return null;
    const vp = waive(pv.viewport);
    let canvas = waive(pv.canvas);
    if (!canvas && pv.div) canvas = waive(pv.div.querySelector("canvas"));
    if (!vp || !canvas || !canvas.width) return null;

    // PDF 坐标 → 视口坐标（自己按 viewport.transform 计算，避免向页面脚本传对象）
    const T = Array.from(vp.transform);
    const toVp = (x, y) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of pos.rects) {
      for (const [px, py] of [[r[0], r[1]], [r[2], r[3]], [r[0], r[3]], [r[2], r[1]]]) {
        const [vx, vy] = toVp(px, py);
        x1 = Math.min(x1, vx); y1 = Math.min(y1, vy); x2 = Math.max(x2, vx); y2 = Math.max(y2, vy);
      }
    }
    const pad = 6 * (vp.scale || 1);
    x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad);
    x2 = Math.min(vp.width, x2 + pad); y2 = Math.min(vp.height, y2 + pad);
    const cssW = x2 - x1, cssH = y2 - y1;
    if (cssW < 4 || cssH < 4) return null;
    const sx = canvas.width / vp.width, sy = canvas.height / vp.height;
    const outW = Math.round(cssW * sx), outH = Math.round(cssH * sy);
    if (outW * outH > 16e6) return null;

    const win = Zotero.getMainWindow();
    const out = win.document.createElementNS(ZAC_NS, "canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(canvas, x1 * sx, y1 * sy, cssW * sx, cssH * sy, 0, 0, outW, outH);
    const dataURL = out.toDataURL("image/png");

    const dir = this.snipDir();
    await Zotero.File.createDirectoryIfMissingAsync(dir);
    const path = dir + (Zotero.isWin ? "\\" : "/") + `sel-${Date.now()}.png`;
    await win.IOUtils.write(path, this.dataURLBytes(dataURL));
    // 笔记里按 PDF 的原始大小显示（视口尺寸 ÷ 缩放比例）
    const zoom = vp.scale || 1;
    return { path, dataURL, width: outW, height: outH, cssWidth: Math.round(cssW / zoom * 1.3333), cssHeight: Math.round(cssH / zoom * 1.3333) };
  },

  dataURLBytes(dataURL) {
    const win = Zotero.getMainWindow();
    const bin = win.atob(String(dataURL).split(",")[1] || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },

  // 清理 7 天前的截图
  async cleanupSnips() {
    try {
      const IOUtils = Zotero.getMainWindow().IOUtils;
      const dir = this.snipDir();
      if (!(await IOUtils.exists(dir))) return;
      const cutoff = Date.now() - 7 * 86400 * 1000;
      for (const f of await IOUtils.getChildren(dir)) {
        try {
          const st = await IOUtils.stat(f);
          if (st.lastModified < cutoff) await IOUtils.remove(f);
        } catch (e) {}
      }
    } catch (e) {
      this.log("cleanupSnips: " + e);
    }
  },

  // 在原文选区位置建一个高亮注释，笔记里的链接可以精确跳回这里
  async createHighlight(attachment, sel) {
    try {
      const pos = sel.position;
      const top = Math.max(...pos.rects.map((r) => r[3]));
      const left = Math.min(...pos.rects.map((r) => r[0]));
      const sortIndex =
        sel.sortIndex ||
        `${String(pos.pageIndex).padStart(5, "0")}|${String(0).padStart(6, "0")}|${String(Math.max(0, Math.round(10000 - top))).padStart(5, "0")}`;
      const json = {
        key: Zotero.DataObjectUtilities.generateKey(),
        type: "highlight",
        color: this.getPref("highlightColor") || "#a28ae5",
        text: sel.text,
        comment: "Agent 问答",
        pageLabel: sel.pageLabel || String(pos.pageIndex + 1),
        sortIndex,
        position: { pageIndex: pos.pageIndex, rects: pos.rects },
        tags: [],
      };
      void left;
      await Zotero.Annotations.saveFromJSON(attachment, json);
      return json.key;
    } catch (e) {
      this.log("createHighlight failed: " + e);
      return null;
    }
  },

  openPdfURI(attachment, pageIndex, annotationKey) {
    let prefix = "library";
    try {
      const lib = Zotero.Libraries.get(attachment.libraryID);
      if (lib && lib.libraryType === "group") prefix = `groups/${Zotero.Groups.getGroupIDFromLibraryID(attachment.libraryID)}`;
    } catch (e) {}
    let u = `zotero://open-pdf/${prefix}/items/${attachment.key}?page=${pageIndex + 1}`;
    if (annotationKey) u += `&annotation=${annotationKey}`;
    return u;
  },

  /* ---------------- 一键安装与登录 ---------------- */

  // 官方安装方式（Claude Code：code.claude.com/docs/en/setup；Codex：chatgpt.com/codex/install.*）
  installSpec(agent) {
    if (agent === "claude") {
      return Zotero.isWin
        ? { script: "irm https://claude.ai/install.ps1 | iex", manual: "irm https://claude.ai/install.ps1 | iex", loginArgs: [], loginText: "claude" }
        : { script: "curl -fsSL https://claude.ai/install.sh | bash", manual: "curl -fsSL https://claude.ai/install.sh | bash", loginArgs: [], loginText: "claude" };
    }
    if (agent === "agy") {
      return Zotero.isWin
        ? { script: "irm https://antigravity.google/cli/install.ps1 | iex", manual: "irm https://antigravity.google/cli/install.ps1 | iex", loginArgs: [], loginText: "agy" }
        : { script: "curl -fsSL https://antigravity.google/cli/install.sh | bash", manual: "curl -fsSL https://antigravity.google/cli/install.sh | bash", loginArgs: [], loginText: "agy" };
    }
    if (agent === "codex") {
      return Zotero.isWin
        ? { script: "irm https://chatgpt.com/codex/install.ps1 | iex", manual: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', loginArgs: ["login"], loginText: "codex login" }
        : { script: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", manual: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", loginArgs: ["login"], loginText: "codex login" };
    }
    return null;
  },

  powershellPath() {
    const root = this.envGet("SystemRoot") || "C:\\Windows";
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  },

  // PowerShell -EncodedCommand：UTF-16LE + Base64，避开所有引号转义问题
  psEncode(script) {
    let bin = "";
    for (let i = 0; i < script.length; i++) {
      const c = script.charCodeAt(i);
      bin += String.fromCharCode(c & 255, c >> 8);
    }
    const b64 = typeof btoa === "function" ? btoa : Zotero.getMainWindow().btoa.bind(Zotero.getMainWindow());
    return b64(bin);
  },

  async installAgent(agent, log, state = {}) {
    const spec = this.installSpec(agent);
    if (!spec) throw new Error("该 agent 不支持一键安装");
    let command;
    let args;
    if (Zotero.isWin) {
      const ps =
        "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
        "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; " +
        spec.script;
      command = this.powershellPath();
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", this.psEncode(ps)];
    } else {
      command = "/bin/bash";
      args = ["-lc", spec.script];
    }
    log(`$ ${spec.manual}`);
    let printed = 0;
    let printedErr = 0;
    const res = await this.spawn({
      command,
      args,
      state,
      onOutput: (all) => {
        const add = all.slice(printed);
        printed = all.length;
        if (add.trim()) log(add.replace(/\s+$/, ""));
      },
      onError: (all) => {
        const add = all.slice(printedErr);
        printedErr = all.length;
        if (add.trim()) log(add.replace(/\s+$/, ""));
      },
    });
    // 让后续诊断、模型列表、额度重新读取
    if (this._discoverFailed) delete this._discoverFailed[agent];
    if (this._usage) delete this._usage[agent];
    let resolved = null;
    try {
      const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      resolved = await this.resolveCommand(this.buildCommand(agent, {}).command, this.buildEnv(), Subprocess);
    } catch (e) {}
    return { exitCode: res.exitCode, resolved, cancelled: !!state.cancelled };
  },

  // 打开一个可见的终端窗口运行登录命令（登录需要浏览器授权或交互输入）
  async openLoginTerminal(agent) {
    const spec = this.installSpec(agent);
    if (!spec) throw new Error("该 agent 不支持");
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const env = this.buildEnv();
    const exe = await this.resolveCommand(this.buildCommand(agent, {}).command, env, Subprocess);
    const title = `${ZAC_AGENTS[agent]} 登录`;
    if (Zotero.isWin) {
      const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
      const inner =
        `$Host.UI.RawUI.WindowTitle=${q(title)}; Write-Host ${q("按提示在浏览器中完成登录，完成后可以关闭这个窗口。")} -ForegroundColor Cyan; ` +
        `& ${q(exe)} ${spec.loginArgs.map(q).join(" ")}`;
      const outer = `Start-Process -FilePath ${q(this.powershellPath())} -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','${this.psEncode(inner)}'`;
      await this.spawn({ command: this.powershellPath(), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", this.psEncode(outer)] });
      return;
    }
    const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const cmd = [exe, ...spec.loginArgs].map(shq).join(" ");
    if (Zotero.isMac) {
      const as = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await this.spawn({ command: "/usr/bin/osascript", args: ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script "${as}"`] });
      return;
    }
    for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
      try {
        const args = term === "gnome-terminal" ? ["--", "bash", "-lc", `${cmd}; exec bash`] : ["-e", `bash -lc ${shq(cmd + "; exec bash")}`];
        await this.spawn({ command: term, args });
        return;
      } catch (e) {}
    }
    throw new Error(`没有找到可用的终端，请手动运行：${spec.loginText}`);
  },

  /* ---------------- 订阅额度 ---------------- */

  // 统一格式：{ plan, windows: [{ label, usedPercent, resetsAt(ms) }], extras: [文本], note }
  async fetchUsage(agent) {
    if (agent === "claude") return this.fetchClaudeUsage();
    if (agent === "codex") return this.fetchCodexUsage();
    if (agent === "agy") return this.fetchAgyUsage();
    return null;
  },

  // Antigravity：在非交互模式下执行 /usage 斜杠命令，解析文本里的百分比；解析不出来就显示原文
  async fetchAgyUsage() {
    const { command } = this.buildCommand("agy", {});
    const state = {};
    const win = Zotero.getMainWindow();
    const timer = win.setTimeout(() => { state.cancelled = true; try { state.proc && state.proc.kill(); } catch (e) {} }, 45000);
    let r;
    try {
      r = await this.spawn({ command, args: ["-p", "/usage"], state });
    } finally {
      win.clearTimeout(timer);
    }
    if (state.cancelled) throw new Error("读取额度超时");
    const text = zacStripAnsi(r.out || "").trim();
    if (r.exitCode !== 0 && !text) throw new Error(zacTail((r.err || "").trim(), 600) || `退出码 ${r.exitCode}`);
    const windows = zacParseUsageText(text);
    const looksLikeUsage = windows.length || /quota|credit|usage|limit|额度|配额/i.test(text);
    if (!looksLikeUsage) {
      return {
        plan: "",
        windows: [],
        extras: [],
        note: "当前版本的 agy 在非交互模式下不返回额度信息。可以在终端运行 agy，然后输入 /usage 查看。",
      };
    }
    return { plan: "", windows, extras: [], note: windows.length ? "" : "", raw: text };
  },

  // agy 读取额度要单独启动一次 agy，只在用户打开额度面板时读取，不在后台自动刷新
  usageSupported(agent) {
    return agent === "claude" || agent === "codex" || agent === "agy";
  },
  usageAuto(agent) {
    return agent === "claude" || agent === "codex";
  },

  // Claude Code：stream-json 模式下先 initialize，再发 get_usage 控制请求（与 /usage 同源）
  async fetchClaudeUsage() {
    const { command } = this.buildCommand("claude", {});
    const initId = "zac-init-" + Date.now();
    const usageId = "zac-usage-" + Date.now();
    const r = await this.jsonlSession({
      command,
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      first: [{ type: "control_request", request_id: initId, request: { subtype: "initialize" } }],
      timeoutMs: 30000,
      onMessage: async (obj, send) => {
        if (obj.type !== "control_response") return undefined;
        const resp = obj.response || {};
        if (resp.request_id === initId) {
          await send({ type: "control_request", request_id: usageId, request: { subtype: "get_usage" } });
          return undefined;
        }
        if (resp.request_id === usageId) {
          if (resp.subtype === "error") {
            const msg = String(resp.error || "");
            throw new Error(/unknown|unsupported|not supported|invalid/i.test(msg) ? "当前版本的 Claude Code 不支持读取额度，请运行 claude update 更新。" : msg || "读取额度失败");
          }
          return resp.response || {};
        }
        return undefined;
      },
    });
    const PLAN = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };
    const plan = r.subscription_type ? PLAN[r.subscription_type] || r.subscription_type : "";
    if (!r.rate_limits_available || !r.rate_limits) {
      return {
        plan: plan || "API",
        windows: [],
        extras: [],
        note: r.rate_limits_available === false
          ? "当前登录方式（API Key 或第三方平台）没有订阅额度限制，按实际用量计费。"
          : "暂时读不到额度信息，稍后再刷新。",
      };
    }
    const rl = r.rate_limits;
    const windows = [];
    const add = (label, b) => {
      if (b && b.utilization != null) windows.push({ label, usedPercent: Number(b.utilization), resetsAt: zacParseTime(b.resets_at) });
    };
    add("5 小时", rl.five_hour);
    add("每周 · 全部模型", rl.seven_day);
    add("每周 · Opus", rl.seven_day_opus);
    add("每周 · Sonnet", rl.seven_day_sonnet);
    for (const m of rl.model_scoped || []) add(`每周 · ${m.display_name}`, m);
    add("每周 · 第三方应用", rl.seven_day_oauth_apps);
    const extras = [];
    const ex = rl.extra_usage;
    if (ex && ex.is_enabled) {
      if (ex.utilization != null) windows.push({ label: "额外用量（本月）", usedPercent: Number(ex.utilization), resetsAt: 0 });
      else extras.push("已开启额外用量");
    }
    return { plan, windows, extras, note: windows.length ? "" : "暂时没有额度窗口数据。" };
  },

  // Codex：codex app-server → initialize → account/rateLimits/read
  async fetchCodexUsage() {
    const { command } = this.buildCommand("codex", {});
    const r = await this.jsonlSession({
      command,
      args: ["app-server"],
      first: [{ method: "initialize", id: 1, params: { clientInfo: { name: "zotero_agent_chat", title: "Agent Chat for Zotero", version: this.version || "0" } } }],
      timeoutMs: 30000,
      onMessage: async (obj, send) => {
        if (obj.id === 1 && ("result" in obj || "error" in obj)) {
          if (obj.error) throw new Error("Codex initialize 失败：" + (obj.error.message || JSON.stringify(obj.error)));
          await send({ method: "initialized", params: {} });
          await send({ method: "account/rateLimits/read", id: 2, params: {} });
          return undefined;
        }
        if (obj.id === 2) {
          if (obj.error) {
            const msg = obj.error.message || JSON.stringify(obj.error);
            if (/method not found|unknown (variant|method)|-32601/i.test(msg + (obj.error.code || ""))) {
              throw new Error("当前版本的 Codex 不支持读取额度，请更新 Codex。");
            }
            if (/auth|login|sign/i.test(msg)) throw new Error("读取额度需要用 ChatGPT 账号登录 Codex（codex login）；使用 API Key 时按用量计费，没有订阅额度。");
            throw new Error(msg);
          }
          return obj.result || {};
        }
        return undefined;
      },
    });
    const byId = r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === "object" ? Object.entries(r.rateLimitsByLimitId) : [];
    const snaps = byId.length ? byId.map(([id, snap]) => ({ name: (snap && (snap.limitName || snap.limitId)) || id, snap })) : r.rateLimits ? [{ name: "", snap: r.rateLimits }] : [];
    const main = r.rateLimits || (snaps[0] && snaps[0].snap) || {};
    const windows = [];
    for (const { name, snap } of snaps) {
      if (!snap) continue;
      for (const key of ["primary", "secondary"]) {
        const w = snap[key];
        if (!w || w.usedPercent == null) continue;
        const label = zacWindowLabel(w.windowDurationMins) + (snaps.length > 1 && name ? ` · ${name}` : "");
        windows.push({ label, usedPercent: Number(w.usedPercent), resetsAt: zacParseTime(w.resetsAt) });
      }
    }
    const extras = [];
    const c = main.credits;
    if (c) {
      if (c.unlimited) extras.push("额度：不限");
      else if (c.hasCredits && c.balance != null) extras.push(`剩余 credits：${Math.round(Number(c.balance) * 100) / 100}`);
    }
    if (main.rateLimitReachedType) extras.push(`已触发限制：${main.rateLimitReachedType}`);
    const planRaw = main.planType || (snaps.find((x) => x.snap && x.snap.planType) || {}).snap?.planType || "";
    const plan = planRaw ? String(planRaw).replace(/^\w/, (ch) => ch.toUpperCase()) : "";
    return { plan, windows, extras, note: windows.length ? "" : "暂时没有额度窗口数据（可能尚未使用过 Codex）。" };
  },

  usageState(agent) {
    this._usage = this._usage || {};
    return this._usage[agent] || { status: "idle" };
  },

  // force=false 时 5 分钟内用缓存；同一 agent 同时只请求一次
  refreshUsage(agent, force = false, manual = false) {
    if (!this.usageSupported(agent)) return Promise.resolve(null);
    if (!manual && !this.usageAuto(agent)) return Promise.resolve(this._usage && this._usage[agent] ? this._usage[agent].data : null);
    this._usage = this._usage || {};
    this._usageReq = this._usageReq || {};
    const cur = this._usage[agent];
    if (this._usageReq[agent]) return this._usageReq[agent];
    if (!force && cur && cur.ts && Date.now() - cur.ts < 5 * 60 * 1000) return Promise.resolve(cur.data);
    if (force && cur && cur.ts && Date.now() - cur.ts < 10 * 1000) return Promise.resolve(cur.data);
    const emit = () => { for (const s of this.sessions.values()) s.emit("usage", agent); };
    this._usage[agent] = { ...(cur || {}), status: "loading" };
    emit();
    const p = this.fetchUsage(agent)
      .then((data) => {
        this._usage[agent] = { status: "ok", data, ts: Date.now() };
        return data;
      })
      .catch((e) => {
        this._usage[agent] = { status: "error", error: String((e && e.message) || e), ts: Date.now(), data: cur && cur.data };
        this.log(`usage ${agent} failed: ${e}`);
        return null;
      })
      .finally(() => {
        delete this._usageReq[agent];
        emit();
      });
    this._usageReq[agent] = p;
    return p;
  },
};

/* ======================================================================
 * 会话：每个 Zotero 窗口一个，悬浮窗和侧边栏共享
 * ==================================================================== */

class ZacSession {
  constructor(plugin, win) {
    this.p = plugin;
    this.win = win;
    this.views = new Set();
    this.messages = []; // 界面上的消息 {id, role, ...}
    this.turns = []; // 已完成的问答，用于拼历史
    this.quote = "";
    this.itemID = null; // 最近一次选中文字所在的条目
    this.state = null; // 正在运行的请求
    this.floating = null;
    this._seq = 0;
    this._onUnload = () => {
      this.destroy();
      plugin.sessions.delete(win);
    };
    win.addEventListener("unload", this._onUnload);
  }

  /* ---------- 视图管理 ---------- */

  addView(v) {
    this.views.add(v);
  }
  removeView(v) {
    this.views.delete(v);
  }
  liveViews() {
    for (const v of [...this.views]) {
      if (v.mode === "embedded" && (!v.root || !v.root.isConnected)) this.views.delete(v);
    }
    return [...this.views];
  }
  emit(type, data) {
    for (const v of this.liveViews()) {
      try { v.onSessionEvent(type, data); } catch (e) { Zotero.logError(e); }
    }
  }

  getFloating() {
    if (!this.floating || !this.floating.root) this.floating = new ZacChatView(this, "floating", null);
    return this.floating;
  }
  openFloating(opts) {
    this.getFloating().open(opts);
  }
  toggleFloating(opts) {
    this.getFloating().toggle(opts);
  }
  visibleEmbedded() {
    return this.liveViews().find((v) => v.mode === "embedded" && v.isVisible()) || null;
  }
  focusBest() {
    const e = this.visibleEmbedded();
    if (e) e.focusInput();
    else if (this.p.floatingEnabled()) this.openFloating({ focus: true });
    else this.revealSidebar();
  }

  // 悬浮窗关闭时：展开右侧面板和「Agent 对话」区块，滚动过去并聚焦输入框
  revealSidebar() {
    try {
      const cp = this.win.ZoteroContextPane;
      if (cp && cp.collapsed && typeof cp.togglePane === "function") cp.togglePane();
    } catch (e) {}
    const attempt = (n) => {
      for (const v of this.liveViews()) {
        if (v.mode !== "embedded") continue;
        const sec = v.root.closest && v.root.closest("collapsible-section");
        const target = sec || v.root;
        if (!zacIsShown(target, 4)) continue; // 不在当前标签页，或右侧面板已收起
        try { if (sec && !sec.open) sec.open = true; } catch (e) {}
        try { target.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
        v.focusInput();
        return;
      }
      if (n > 0) this.win.setTimeout(() => attempt(n - 1), 150);
      else this.p.log("revealSidebar: 没有找到可见的侧边栏对话区块");
    };
    attempt(4);
  }

  /* ---------- 选中内容、设置 ---------- */

  setSelection(text, itemID, meta = {}) {
    this.quote = text;
    if (itemID) this.itemID = itemID;
    const ann = meta.annotation || null;
    const pos = ann && ann.position && Number.isInteger(ann.position.pageIndex) && Array.isArray(ann.position.rects) ? ann.position : null;
    const sel = (this.selection = {
      text,
      itemID: itemID || null,
      position: pos,
      pageLabel: (ann && ann.pageLabel) || (pos ? String(pos.pageIndex + 1) : ""),
      sortIndex: (ann && ann.sortIndex) || "",
      formula: zacLooksLikeFormula(text),
      image: null,
      useImage: false,
      _reader: meta.reader || null,
    });
    this.emit("quote");
    this.emit("context");
    if (sel.formula && sel.position && sel._reader && this.p.formulaEnhance()) this.snip(sel);
  }

  async snip(sel) {
    try {
      sel.snipping = true;
      this.emit("quote");
      const img = await this.p.captureSelection(sel._reader, sel);
      if (img) {
        sel.image = img;
        sel.useImage = true;
      } else sel.snipFailed = true;
    } catch (e) {
      sel.snipFailed = true;
      this.p.log("snip failed: " + e);
    } finally {
      sel.snipping = false;
      if (this.selection === sel) this.emit("quote");
    }
  }

  // 输入框里引用的「截图」按钮：有截图就切换是否附带，没有就现截一张
  toggleSnip() {
    const sel = this.selection;
    if (!sel) return;
    if (sel.image) {
      sel.useImage = !sel.useImage;
      this.emit("quote");
    } else if (sel.position && sel._reader && !sel.snipping) this.snip(sel);
  }

  clearQuote() {
    this.quote = "";
    this.selection = null;
    this.emit("quote");
  }

  // 打开原文并定位到选区
  async jumpTo(sel) {
    if (!sel || !sel.itemID) return;
    try {
      await Zotero.Reader.open(sel.itemID, sel.position ? { position: sel.position } : undefined);
    } catch (e) {
      Zotero.logError(e);
    }
  }
  setPref(key, value) {
    this.p.setPref(key, value);
    if (key === "agent") this.p.refreshModels(value).catch(() => {});
    if (key === "floatingEnabled" && !value) {
      for (const s of this.p.sessions.values()) if (s.floating) s.floating.close();
    }
    // 所有窗口的视图都要刷新下拉框
    for (const s of this.p.sessions.values()) s.emit("controls");
  }

  /* ---------- 论文上下文 ---------- */

  currentReader() {
    try {
      const tabs = this.win.Zotero_Tabs;
      if (tabs) return Zotero.Reader.getByTabID(tabs.selectedID);
    } catch (e) {}
    return null;
  }

  async getContext(preferredItemID = null) {
    let id = preferredItemID || this.itemID;
    if (!id) {
      const r = this.currentReader();
      if (r) id = r.itemID;
    }
    const item = id ? Zotero.Items.get(id) : null;
    if (!item) return {};
    let attachment = null;
    let parent = null;
    if (item.isAttachment()) {
      attachment = item;
      parent = item.parentItem || null;
    } else if (item.isRegularItem()) {
      parent = item;
      try { attachment = (await item.getBestAttachment()) || null; } catch (e) {}
    } else {
      return {};
    }
    let pdfPath = null;
    if (attachment && attachment.isFileAttachment()) {
      try { pdfPath = attachment.getFilePath() || null; } catch (e) {}
    }
    const titleItem = parent || attachment;
    return {
      title: titleItem ? titleItem.getDisplayTitle() : "",
      pdfPath,
      parentID: parent ? parent.id : null,
      libraryID: item.libraryID,
    };
  }

  buildPrompt(question, quote, ctx, sel = null, historyOverride = null) {
    const parts = [String(this.p.getPref("systemPrompt") || "").trim() || ZAC_DEFAULT_SYSTEM, ""];
    if (ctx.title) parts.push(`【论文】${ctx.title}`);
    if (ctx.pdfPath && this.p.getPref("includePdfPath")) {
      parts.push(`【PDF 本地路径】${ctx.pdfPath}\n（需要更多上下文时可以读取这个文件，但不要修改任何文件。）`);
    }
    const n = historyOverride != null ? historyOverride : Math.max(0, parseInt(this.p.getPref("historyTurns"), 10) || 0);
    const hist = n ? this.turns.slice(-n) : [];
    if (hist.length) {
      parts.push("\n【此前的对话】");
      for (const t of hist) {
        if (t.restored || t.quote) parts.push(`用户选中：「${zacClip(t.restored || t.quote, 600)}」`);
        parts.push(`用户：${t.question}`);
        parts.push(`助手：${zacClip(t.answer, 2000)}`);
      }
    }
    if (quote) {
      const where = sel && sel.pageLabel ? `（第 ${sel.pageLabel} 页）` : "";
      parts.push(`\n【用户当前选中的原文${where}】\n"""\n${quote}\n"""`);
    }
    if (sel && sel.image) {
      parts.push(
        `【选区截图】${sel.image.path}\n上面的文字来自 PDF 文本层，公式、上下标和特殊符号可能错乱或丢失，请先查看这张截图，以截图内容为准。`
      );
    }
    if (sel && sel.enhance && (sel.formula || sel.image)) {
      parts.push(
        "【输出要求】请在回答的最开头，把选中内容准确还原后放在 <restored> 和 </restored> 之间：" +
          "数学公式用 LaTeX（行内 $...$，独立公式 $$...$$），保留公式编号；只还原原文，不要解释。然后另起一段回答问题。"
      );
    }
    parts.push(`\n【用户的问题】\n${question}`);
    return parts.join("\n");
  }

  /* ---------- 发送 ---------- */

  // 同步返回是否接受了这次发送（正在运行 / 内容为空时返回 false）
  send(rawQuestion, ctxItemID = null) {
    if (this.state) return false;
    let question = String(rawQuestion || "").trim();
    const quote = zacClip(this.quote, 12000);
    if (!question && !quote) return false;
    if (!question) question = "请解释这段内容。";
    const cur = this.selection && this.selection.text === this.quote ? this.selection : null;
    const sel = cur
      ? {
          text: cur.text,
          itemID: cur.itemID,
          position: cur.position,
          pageLabel: cur.pageLabel,
          sortIndex: cur.sortIndex,
          formula: cur.formula,
          enhance: this.p.formulaEnhance(),
          image: cur.useImage && this.p.formulaEnhance() ? cur.image : null,
        }
      : null;
    this.quote = "";
    this.selection = null;
    this.emit("quote");

    const userMsg = { id: ++this._seq, role: "user", question, quote, ctxItemID, sel };
    const aMsg = { id: ++this._seq, role: "assistant", status: "pending", text: "" };
    this.messages.push(userMsg, aMsg);
    this.emit("append", userMsg);
    this.emit("append", aMsg);
    this._start(userMsg, aMsg);
    return true;
  }

  // 重新生成最后一条回复（用当前选择的 agent / 模型 / effort）
  regenerate() {
    if (this.state) return false;
    const n = this.messages.length;
    const aMsg = this.messages[n - 1];
    const userMsg = this.messages[n - 2];
    if (!aMsg || aMsg.role !== "assistant" || !userMsg || userMsg.role !== "user") return false;
    if (aMsg.turn) this.turns = this.turns.filter((t) => t !== aMsg.turn);
    Object.assign(aMsg, { status: "pending", text: "", hint: "", detail: "", turn: null });
    this.emit("update", aMsg);
    this._start(userMsg, aMsg);
    return true;
  }

  _start(userMsg, aMsg) {
    const cfg = this.p.agentConfig();
    aMsg.agent = cfg.agent;
    aMsg.label = this.p.agentLabel(cfg);
    const timeoutSec = parseInt(this.p.getPref("timeoutSec"), 10) || 300;
    const state = (this.state = { cancelled: false, timedOut: false, proc: null, start: Date.now(), label: aMsg.label, msgId: aMsg.id });
    const timer = this.win.setTimeout(() => {
      state.timedOut = true;
      this.stop();
    }, timeoutSec * 1000);
    const tick = this.win.setInterval(() => this.emit("status"), 1000);
    this.emit("update", aMsg);
    this.emit("status");

    this._run({ userMsg, cfg, aMsg, state, timeoutSec })
      .catch((e) => {
        Zotero.logError(e);
        const msg = String((e && e.message) || e);
        Object.assign(aMsg, { status: "error", text: "无法运行 agent", hint: zacHint(cfg.agent, msg), detail: msg });
        this.emit("update", aMsg);
      })
      .finally(() => {
        this.win.clearTimeout(timer);
        this.win.clearInterval(tick);
        this.state = null;
        this.emit("status");
        // 用掉了额度，顺手刷新一下
        this.p.refreshUsage(cfg.agent, true);
      });
  }

  async _run({ userMsg, cfg, aMsg, state, timeoutSec }) {
    const { question, quote, ctxItemID, sel } = userMsg;
    const ctx = await this.getContext(ctxItemID);
    let prompt = this.buildPrompt(question, quote, ctx, sel);
    const asArg = cfg.agent === "agy" || (cfg.agent === "custom" && /\{prompt\}/.test(String(this.p.getPref("customArgs") || "")));
    if (asArg && Zotero.isWin) {
      for (let n = parseInt(this.p.getPref("historyTurns"), 10) || 0; prompt.length > 26000 && n > 0; n--) {
        prompt = this.buildPrompt(question, quote, ctx, sel, n - 1);
      }
      if (prompt.length > 26000) prompt = prompt.slice(0, 13000) + "\n…（中间内容过长已省略）…\n" + prompt.slice(-12000);
    }
    const pdfDir =
      this.p.getPref("includePdfPath") && ctx.pdfPath ? Zotero.File.pathToFile(ctx.pdfPath).parent.path : null;
    const { command, args, stdin } = this.p.buildCommand(cfg.agent, {
      pdfDir,
      prompt,
      model: cfg.model,
      effort: cfg.effort,
      images: sel && sel.image ? [sel.image.path] : [],
    });
    const res = await this.p.spawn({
      command,
      args,
      input: stdin,
      state,
      onOutput: (s) => {
        aMsg.status = "stream";
        aMsg.text = s;
        this.emit("update", aMsg);
      },
    });
    let answer = res.out.trim();
    // 拆出 agent 还原的原文：<restored>…</restored>
    let restored = "";
    const rm = /<restored>([\s\S]*?)<\/restored>/i.exec(answer);
    if (rm) {
      restored = rm[1].trim();
      answer = (answer.slice(0, rm.index) + answer.slice(rm.index + rm[0].length)).trim() || "（见上方还原的原文）";
    }
    if (restored && !state.cancelled && res.exitCode === 0) {
      userMsg.restored = restored;
      this.emit("update", userMsg);
    }
    if (state.cancelled) {
      Object.assign(aMsg, {
        status: "error",
        text: state.timedOut ? `超时（${timeoutSec} 秒），已终止` : "已停止",
        hint: state.timedOut ? "可以在设置里调大超时时间，或换用更快的模型 / 更低的 effort。" : "",
        detail: answer,
      });
    } else if (res.exitCode !== 0 || !answer) {
      const detail = [`退出码 ${res.exitCode}`, `命令：${res.command} ${args.join(" ")}`, zacTail((res.err || "") + "\n" + answer, 2500).trim()]
        .filter(Boolean)
        .join("\n");
      Object.assign(aMsg, { status: "error", text: "agent 没有正常返回", hint: zacHint(cfg.agent, res.err + "\n" + answer), detail });
    } else {
      const turn = {
        question,
        quote,
        restored: userMsg.restored || "",
        sel,
        answer,
        agent: cfg.agent,
        label: aMsg.label,
        parentID: ctx.parentID,
        libraryID: ctx.libraryID,
      };
      this.turns.push(turn);
      Object.assign(aMsg, { status: "done", text: answer, turn, hint: "", detail: "" });
    }
    this.emit("update", aMsg);
  }

  stop() {
    const s = this.state;
    if (!s) return;
    s.cancelled = true;
    if (s.proc) {
      try { s.proc.kill(); } catch (e) {}
    }
  }

  reset() {
    this.stop();
    this.messages = [];
    this.turns = [];
    this.emit("reset");
  }

  async saveNote(turn, { answerHtml = null, restoredHtml = null } = {}) {
    const esc = (x) => Zotero.Utilities.htmlSpecialChars(String(x == null ? "" : x));
    const paras = (x) =>
      String(x || "")
        .split(/\n{2,}/)
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
        .join("");
    const sel = turn.sel || null;
    const IMG = "\u0000ZAC_IMG\u0000";
    let html = `<h2>${esc("Agent 问答：" + zacClip(turn.question, 40))}</h2>`;

    // 原文：优先用 agent 对照截图还原的版本，并附原始截图供核对
    if (restoredHtml) {
      html += `<blockquote>${restoredHtml}</blockquote>`;
      html += `<p><em>以上原文由 AI 根据${sel && sel.image ? "选区截图" : "选中文字"}还原${sel && sel.image ? "，请与下方截图核对" : "，请与原文核对"}。</em></p>`;
    } else if (turn.quote) {
      html += `<blockquote>${paras(turn.quote)}</blockquote>`;
    }
    if (sel && sel.image) html += IMG;

    // 跳转到原文：zotero://open-pdf 链接；可选在原文建高亮，链接直达该处
    if (sel && sel.position && sel.itemID) {
      const att = Zotero.Items.get(sel.itemID);
      if (att && att.isAttachment()) {
        let annKey = null;
        const isPDF = typeof att.isPDFAttachment === "function" ? att.isPDFAttachment() : att.attachmentContentType === "application/pdf";
        if (isPDF && this.p.getPref("noteHighlight") !== false) annKey = await this.p.createHighlight(att, sel);
        const href = this.p.openPdfURI(att, sel.position.pageIndex, annKey);
        html += `<p><a href="${esc(href)}">↗ 跳转到原文（第 ${esc(sel.pageLabel || sel.position.pageIndex + 1)} 页）</a></p>`;
      }
    }

    html += `<p><strong>问：</strong>${esc(turn.question)}</p>`;
    html += `<p><strong>答（${esc(turn.label)}）：</strong></p>` + (answerHtml || zacNoteHtml(turn.answer, esc));

    const note = new Zotero.Item("note");
    note.libraryID = turn.libraryID || Zotero.Libraries.userLibraryID;
    if (turn.parentID) note.parentID = turn.parentID;
    note.setNote(html.replace(IMG, ""));
    await note.saveTx();

    // 截图作为笔记内嵌图片（需要先有笔记 ID）
    if (sel && sel.image) {
      try {
        const win = Zotero.getMainWindow();
        const blob = new win.Blob([this.p.dataURLBytes(sel.image.dataURL)], { type: "image/png" });
        const img = await Zotero.Attachments.importEmbeddedImage({ blob, parentItemID: note.id });
        const w = Math.min(sel.image.cssWidth || sel.image.width, 640);
        const h = Math.round(w * (sel.image.height / sel.image.width));
        note.setNote(html.replace(IMG, `<p><img data-attachment-key="${img.key}" width="${w}" height="${h}"/></p>`));
        await note.saveTx();
      } catch (e) {
        this.p.log("embed snip failed: " + e);
      }
    }
    return note;
  }

  destroy() {
    try { this.win.removeEventListener("unload", this._onUnload); } catch (e) {}
    this.stop();
    for (const v of [...this.views]) v.destroy();
    this.views.clear();
    this.floating = null;
  }
}

/* ======================================================================
 * 界面
 * ==================================================================== */

/* ---------- 图标（lucide 风格，线宽 2，24×24） ---------- */
const ZAC_ICONS = {
  sparkles: [["path", { d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" }]],
  newChat: [
    ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }],
    ["path", { d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" }],
  ],
  settings: [
    ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  close: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  arrowUp: [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]],
  stop: [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2", fill: "currentColor", stroke: "none" }]],
  copy: [
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  note: [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
    ["path", { d: "M9 15h6" }],
    ["path", { d: "M12 18v-6" }],
  ],
  retry: [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]],
  quote: [
    ["path", { d: "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" }],
    ["path", { d: "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" }],
  ],
  back: [["path", { d: "m12 19-7-7 7-7" }], ["path", { d: "M19 12H5" }]],
  refresh: [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M8 16H3v5" }],
  ],
  pulse: [["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]],
  download: [["path", { d: "M12 15V3" }], ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "m7 10 5 5 5-5" }]],
  login: [["path", { d: "m10 17 5-5-5-5" }], ["path", { d: "M15 12H3" }], ["path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" }]],
  gauge: [["path", { d: "m12 14 4-4" }], ["path", { d: "M3.34 19a10 10 0 1 1 17.32 0" }]],
  image: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }],
    ["circle", { cx: "9", cy: "9", r: "2" }],
    ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }],
  ],
  link: [["path", { d: "M15 3h6v6" }], ["path", { d: "M10 14 21 3" }], ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]],
  alert: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "12", x2: "12", y1: "8", y2: "12" }],
    ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16" }],
  ],
};

// 选中原文后的快捷操作；以及没有选中文字时针对整篇论文的建议
const ZAC_QUOTE_ACTIONS = [
  ["解释", "请解释这段内容。"],
  ["翻译", "请把这段内容翻译成中文，专业术语保留英文原文并在括号里注明。"],
  ["公式与符号", "请解释这段中的公式和符号含义，并给出直观理解。"],
  ["举个例子", "请举一个具体例子帮助理解这段内容。"],
];
const ZAC_PAPER_ACTIONS = [
  ["总结核心贡献", "请总结这篇论文的研究问题和核心贡献。"],
  ["方法是怎么做的", "请概括这篇论文的方法：整体流程、关键模块和它们的作用。"],
  ["有哪些局限", "请分析这篇论文的局限性，以及可能的改进方向。"],
];

const ZAC_CSS = `
.zac-view {
  --zac-fs: 1;
  --zac-bg: var(--material-background, #fff);
  --zac-bg2: var(--material-sidepane, #f6f6f7);
  --zac-fg: var(--fill-primary, #1f1f1f);
  --zac-fg2: var(--fill-secondary, #6b6b70);
  --zac-fg3: var(--fill-tertiary, #9a9aa0);
  --zac-line: var(--material-border-quarternary, rgba(0,0,0,.1));
  --zac-soft: var(--fill-quinary, rgba(127,127,127,.12));
  --zac-softer: var(--fill-senary, rgba(127,127,127,.06));
  --zac-accent: var(--accent-blue, var(--color-accent, #3b6fe0));
  --zac-accent-soft: color-mix(in srgb, var(--zac-accent) 12%, transparent);
  --zac-danger: #d93025;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--zac-bg); color: var(--zac-fg);
  font: message-box; font-size: calc(13px * var(--zac-fs, 1)); line-height: 1.55; }
.zac-view * { box-sizing: border-box; }
.zac-view button { appearance: none; -moz-appearance: none; font: inherit; color: inherit; background: none;
  border: none; margin: 0; padding: 0; cursor: pointer; min-width: 0; min-height: 0; }
.zac-view button:disabled { cursor: default; }
.zac-view svg.zac-i { width: calc(16px * var(--zac-fs, 1)); height: calc(16px * var(--zac-fs, 1)); flex: none; fill: none; stroke: currentColor;
  stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.zac-embedded { position: relative; }

/* 额度 */
.zac-view .zac-usage-btn { display: inline-flex; align-items: center; gap: 4px; min-height: calc(24px * var(--zac-fs, 1)); padding: 0 8px 0 6px; margin-right: 4px;
  border-radius: 12px; border: 1px solid var(--zac-line); font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); font-variant-numeric: tabular-nums; flex: none; }
.zac-view .zac-usage-btn:hover, .zac-view .zac-usage-btn.zac-active { background: var(--zac-soft); color: var(--zac-fg); }
.zac-usage-btn svg.zac-i { width: calc(13px * var(--zac-fs, 1)); height: calc(13px * var(--zac-fs, 1)); }
.zac-view .zac-usage-btn.zac-u-lo { color: #2e9d4f; }
.zac-view .zac-usage-btn.zac-u-mid { color: #d97706; }
.zac-view .zac-usage-btn.zac-u-hi, .zac-view .zac-usage-btn.zac-u-error { color: var(--zac-danger); }
.zac-usage-pop { position: absolute; right: 8px; width: min(300px, calc(100% - 16px)); z-index: 10; display: none;
  background: var(--zac-bg); border: 1px solid var(--zac-line); border-radius: 12px; padding: 10px 12px 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18); user-select: text; }
.zac-u-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.zac-u-title { font-weight: 600; flex: 1; }
.zac-u-plan { font-size: calc(10.5px * var(--zac-fs, 1)); font-weight: 600; padding: 1px 8px; border-radius: 10px; background: var(--zac-accent-soft); color: var(--zac-accent); }
.zac-u-row { margin-bottom: 10px; }
.zac-u-line { display: flex; justify-content: space-between; gap: 8px; font-size: calc(12px * var(--zac-fs, 1)); }
.zac-u-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.zac-u-bar { height: 6px; border-radius: 3px; background: var(--zac-soft); overflow: hidden; margin: 4px 0 3px; }
.zac-u-fill { height: 100%; border-radius: 3px; background: #2e9d4f; transition: width .3s; }
.zac-u-mid .zac-u-fill { background: #d97706; }
.zac-u-hi .zac-u-fill { background: var(--zac-danger); }
.zac-u-hi .zac-u-pct { color: var(--zac-danger); }
.zac-u-reset { font-size: calc(10.5px * var(--zac-fs, 1)); color: var(--zac-fg2); }
.zac-u-note { font-size: calc(11.5px * var(--zac-fs, 1)); color: var(--zac-fg2); margin-top: 4px; }
.zac-u-err { font-size: calc(11.5px * var(--zac-fs, 1)); color: var(--zac-danger); margin-top: 4px; white-space: pre-wrap; }
.zac-u-raw { margin-top: 6px; font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); }
.zac-u-raw summary { cursor: pointer; user-select: none; }
.zac-u-raw pre { margin: 4px 0 0; white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: calc(10.5px * var(--zac-fs, 1)); max-height: 180px; overflow: auto; }
.zac-u-foot { font-size: calc(10.5px * var(--zac-fs, 1)); color: var(--zac-fg3); margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--zac-line); }
.zac-spin svg.zac-i { animation: zac-rot 1s linear infinite; }
@keyframes zac-rot { to { transform: rotate(360deg); } }

/* 提示 */
.zac-tip { position: absolute; z-index: 40; display: none; max-width: 260px; padding: 5px 8px; border-radius: 7px;
  background: rgba(30,30,32,.92); color: #fff; font-size: calc(11.5px * var(--zac-fs, 1)); line-height: 1.45; white-space: pre-line;
  pointer-events: none; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
.zac-toast { position: absolute; left: 50%; bottom: 96px; z-index: 40; transform: translate(-50%, 8px); opacity: 0;
  padding: 6px 12px; border-radius: 16px; background: rgba(30,30,32,.9); color: #fff; font-size: calc(12px * var(--zac-fs, 1));
  pointer-events: none; transition: opacity .18s, transform .18s; white-space: nowrap; }
.zac-toast.zac-show { opacity: 1; transform: translate(-50%, 0); }

/* 弹窗 */
.zac-modal { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(0,0,0,.32); backdrop-filter: blur(1px); border-radius: inherit; }
.zac-dialog { width: min(340px, 100%); max-height: 100%; overflow: auto; background: var(--zac-bg); color: var(--zac-fg);
  border: 1px solid var(--zac-line); border-radius: 14px; box-shadow: 0 20px 50px rgba(0,0,0,.3); padding: 16px; }
.zac-dialog-icon { width: calc(34px * var(--zac-fs, 1)); height: calc(34px * var(--zac-fs, 1)); border-radius: 10px; display: flex; align-items: center; justify-content: center;
  background: var(--zac-accent-soft); color: var(--zac-accent); margin-bottom: 10px; }
.zac-dialog-icon svg.zac-i { width: calc(18px * var(--zac-fs, 1)); height: calc(18px * var(--zac-fs, 1)); }
.zac-dialog-title { font-weight: 600; font-size: calc(14px * var(--zac-fs, 1)); margin-bottom: 6px; }
.zac-dialog-text { font-size: calc(12.5px * var(--zac-fs, 1)); color: var(--zac-fg2); white-space: pre-wrap; margin-bottom: 8px; }
.zac-dialog-code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(11px * var(--zac-fs, 1)); padding: 7px 9px; margin-bottom: 12px;
  border-radius: 8px; background: var(--zac-softer); border: 1px solid var(--zac-line); word-break: break-all; user-select: text; }
.zac-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* 容器 */
.zac-floating { position: fixed; z-index: 2147483000; display: none;
  width: 420px; height: 620px; min-width: 320px; min-height: 320px; resize: both;
  border: 1px solid var(--zac-line); border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,.20), 0 2px 8px rgba(0,0,0,.08); }
.zac-embedded { width: 100%; height: 560px; min-height: 320px; resize: vertical;
  border: 1px solid var(--zac-line); border-radius: 12px; }

/* 顶栏 */
.zac-header { display: flex; align-items: center; gap: 2px; padding: 8px 8px 8px 12px; user-select: none;
  border-bottom: 1px solid var(--zac-line); }
.zac-floating .zac-header { cursor: move; touch-action: none; background: var(--zac-bg2); }
.zac-logo { width: calc(26px * var(--zac-fs, 1)); height: calc(26px * var(--zac-fs, 1)); border-radius: 8px; margin-right: 9px; flex: none;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, var(--zac-accent), color-mix(in srgb, var(--zac-accent) 60%, #a855f7)); }
.zac-logo svg.zac-i { width: calc(15px * var(--zac-fs, 1)); height: calc(15px * var(--zac-fs, 1)); }
.zac-title-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
.zac-title { font-weight: 600; font-size: calc(13px * var(--zac-fs, 1)); }
.zac-subtitle { font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zac-embedded .zac-subtitle { font-size: calc(12px * var(--zac-fs, 1)); }
.zac-view .zac-icon-btn { width: calc(28px * var(--zac-fs, 1)); height: calc(28px * var(--zac-fs, 1)); border-radius: 8px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; color: var(--zac-fg2); }
.zac-view .zac-icon-btn:hover { background: var(--zac-soft); color: var(--zac-fg); }
.zac-view .zac-icon-btn.zac-active { background: var(--zac-accent-soft); color: var(--zac-accent); }

/* 消息区 */
.zac-page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.zac-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px 8px; display: flex; flex-direction: column;
  gap: 16px; user-select: text; }
.zac-empty { margin: auto 0; text-align: center; color: var(--zac-fg2); padding: 12px 6px; user-select: none; }
.zac-empty .zac-logo { width: calc(40px * var(--zac-fs, 1)); height: calc(40px * var(--zac-fs, 1)); border-radius: 12px; margin: 0 auto 10px; }
.zac-empty .zac-logo svg.zac-i { width: calc(22px * var(--zac-fs, 1)); height: calc(22px * var(--zac-fs, 1)); }
.zac-empty-title { font-weight: 600; font-size: calc(14px * var(--zac-fs, 1)); color: var(--zac-fg); margin-bottom: 4px; }
.zac-empty-sub { font-size: calc(12px * var(--zac-fs, 1)); margin-bottom: 14px; }
.zac-suggest { display: flex; flex-direction: column; gap: 6px; align-items: stretch; max-width: 300px; margin: 0 auto; }
.zac-view .zac-suggest-btn { text-align: left; padding: 8px 12px; border: 1px solid var(--zac-line); border-radius: 10px;
  font-size: calc(12px * var(--zac-fs, 1)); color: var(--zac-fg); background: var(--zac-bg); }
.zac-view .zac-suggest-btn:hover { background: var(--zac-softer); border-color: color-mix(in srgb, var(--zac-accent) 40%, var(--zac-line)); }

.zac-msg { overflow-wrap: anywhere; user-select: text; }
.zac-user { align-self: flex-end; max-width: 88%; padding: 8px 12px; border-radius: 16px 16px 4px 16px;
  background: var(--zac-accent-soft); white-space: pre-wrap; }
.zac-user .zac-q { display: flex; gap: 6px; font-size: calc(12px * var(--zac-fs, 1)); color: var(--zac-fg2); margin-bottom: 6px;
  padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--zac-accent) 18%, transparent); }
.zac-user .zac-q svg.zac-i { width: calc(12px * var(--zac-fs, 1)); height: calc(12px * var(--zac-fs, 1)); margin-top: 3px; color: var(--zac-accent); }
.zac-user .zac-q span { max-height: 4.6em; overflow: hidden; }
.zac-assistant { align-self: stretch; }
.zac-user .zac-q { display: block; }
.zac-q-text { display: flex; gap: 6px; }
.zac-q-text span { max-height: 4.6em; overflow: hidden; }
.zac-q-tag { display: flex; align-items: center; gap: 5px; font-size: calc(11px * var(--zac-fs, 1)); font-weight: 600; color: var(--zac-accent); margin-bottom: 4px; }
.zac-q-tag svg.zac-i { width: calc(12px * var(--zac-fs, 1)); height: calc(12px * var(--zac-fs, 1)); }
.zac-restored { color: var(--zac-fg); font-size: calc(12.5px * var(--zac-fs, 1)); white-space: normal; }
.zac-restored p { margin: 0 0 4px; }
.zac-snip { display: block; max-width: 100%; max-height: 180px; margin: 6px 0 2px; border-radius: 6px;
  border: 1px solid var(--zac-line); background: #fff; object-fit: contain; }
.zac-view .zac-jump { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; padding: 1px 7px 1px 5px;
  border-radius: 10px; font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-accent); background: color-mix(in srgb, var(--zac-accent) 10%, transparent); }
.zac-view .zac-jump:hover { background: color-mix(in srgb, var(--zac-accent) 18%, transparent); }
.zac-jump svg.zac-i { width: calc(11px * var(--zac-fs, 1)); height: calc(11px * var(--zac-fs, 1)); }
.zac-q-question { white-space: pre-wrap; }
.zac-quote-body { flex: 1; min-width: 0; }
.zac-quote-meta { font-size: calc(10.5px * var(--zac-fs, 1)); color: var(--zac-fg3); margin-top: 3px; }
.zac-quote-btns { display: flex; flex-direction: column; gap: 2px; }
.zac-msg-head { display: flex; align-items: center; gap: 6px; font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2);
  margin-bottom: 4px; user-select: none; }
.zac-avatar { width: calc(18px * var(--zac-fs, 1)); height: calc(18px * var(--zac-fs, 1)); border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, var(--zac-accent), color-mix(in srgb, var(--zac-accent) 60%, #a855f7)); }
.zac-avatar svg.zac-i { width: calc(11px * var(--zac-fs, 1)); height: calc(11px * var(--zac-fs, 1)); }
.zac-md p { margin: 0 0 8px; white-space: pre-wrap; }
.zac-md > :last-child { margin-bottom: 0; }
.zac-md .zac-h { font-weight: 650; margin: 12px 0 6px; font-size: calc(13.5px * var(--zac-fs, 1)); }
.zac-md .zac-h1 { font-size: calc(15px * var(--zac-fs, 1)); }
.zac-md .zac-li { white-space: pre-wrap; margin: 3px 0; padding-left: 16px; position: relative; }
.zac-md .zac-li-mark { position: absolute; left: 2px; color: var(--zac-fg2); }
.zac-md blockquote { margin: 6px 0 8px; padding: 2px 10px; border-left: 3px solid var(--zac-line); color: var(--zac-fg2); white-space: pre-wrap; }
.zac-md hr { border: none; border-top: 1px solid var(--zac-line); margin: 10px 0; }
.zac-math math { font-size: 1.08em; }
.zac-math-display { margin: 6px 0 10px; overflow-x: auto; overflow-y: hidden; padding: 2px 0; text-align: center; }
.zac-math-display math { display: block; margin: 0 auto; width: fit-content; max-width: 100%; font-size: 1.12em; }
.zac-inline-code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(12px * var(--zac-fs, 1)); background: var(--zac-soft);
  padding: 1px 5px; border-radius: 5px; }
.zac-codeblock { margin: 6px 0 10px; border: 1px solid var(--zac-line); border-radius: 10px; overflow: hidden; }
.zac-codebar { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px 3px 10px;
  font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); background: var(--zac-softer); border-bottom: 1px solid var(--zac-line); user-select: none; }
.zac-code { margin: 0; padding: 8px 10px; overflow-x: auto; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: calc(12px * var(--zac-fs, 1)); line-height: 1.5; white-space: pre; background: var(--zac-bg); }
.zac-table-wrap { overflow-x: auto; margin: 6px 0 10px; border: 1px solid var(--zac-line); border-radius: 8px; }
.zac-table { border-collapse: collapse; font-size: calc(12px * var(--zac-fs, 1)); width: 100%; }
.zac-table th, .zac-table td { padding: 5px 8px; border-bottom: 1px solid var(--zac-line); text-align: left; vertical-align: top; }
.zac-table th { background: var(--zac-softer); font-weight: 600; }
.zac-table tr:last-child td { border-bottom: none; }
.zac-stream { white-space: pre-wrap; }
.zac-pending { display: flex; align-items: center; gap: 8px; color: var(--zac-fg2); font-size: calc(12px * var(--zac-fs, 1)); padding: 2px 0; }
.zac-dots { display: inline-flex; gap: 3px; }
.zac-dots span { width: calc(6px * var(--zac-fs, 1)); height: calc(6px * var(--zac-fs, 1)); border-radius: 50%; background: var(--zac-accent); animation: zac-bounce 1.2s infinite ease-in-out; }
.zac-dots span:nth-child(2) { animation-delay: .15s; }
.zac-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes zac-bounce { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.zac-err { border: 1px solid color-mix(in srgb, var(--zac-danger) 35%, transparent); border-radius: 10px;
  background: color-mix(in srgb, var(--zac-danger) 7%, transparent); padding: 8px 10px; font-size: calc(12px * var(--zac-fs, 1)); }
.zac-err-title { display: flex; align-items: center; gap: 6px; font-weight: 600; color: var(--zac-danger); }
.zac-err-hint { margin-top: 4px; }
.zac-err details { margin-top: 6px; color: var(--zac-fg2); }
.zac-err summary { cursor: pointer; font-size: calc(11px * var(--zac-fs, 1)); user-select: none; }
.zac-err pre { margin: 6px 0 0; white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(11px * var(--zac-fs, 1));
  max-height: 180px; overflow: auto; }
.zac-actions { display: flex; gap: 2px; margin: 4px 0 0 -6px; opacity: 0; transition: opacity .12s; }
.zac-assistant:hover .zac-actions, .zac-assistant.zac-last .zac-actions { opacity: 1; }
.zac-view .zac-act { display: inline-flex; align-items: center; gap: 4px; min-height: calc(24px * var(--zac-fs, 1)); padding: 0 7px; border-radius: 6px;
  font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); }
.zac-view .zac-act:hover { background: var(--zac-soft); color: var(--zac-fg); }
.zac-act svg.zac-i { width: calc(13px * var(--zac-fs, 1)); height: calc(13px * var(--zac-fs, 1)); }

/* 输入区 */
.zac-composer-wrap { padding: 4px 10px 10px; }
.zac-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 2px 6px; }
.zac-view .zac-chip { min-height: calc(24px * var(--zac-fs, 1)); padding: 0 10px; border-radius: 12px; font-size: calc(11.5px * var(--zac-fs, 1)); color: var(--zac-fg);
  border: 1px solid var(--zac-line); background: var(--zac-bg); }
.zac-view .zac-chip:hover { border-color: var(--zac-accent); color: var(--zac-accent); }
.zac-composer { border: 1px solid var(--zac-line); border-radius: 14px; background: var(--zac-bg);
  box-shadow: 0 1px 3px rgba(0,0,0,.05); padding: 8px 8px 6px 10px; display: flex; flex-direction: column; gap: 4px;
  transition: border-color .12s, box-shadow .12s; }
.zac-composer:focus-within { border-color: color-mix(in srgb, var(--zac-accent) 70%, transparent);
  box-shadow: 0 0 0 3px var(--zac-accent-soft); }
.zac-quote { display: none; align-items: flex-start; gap: 6px; padding: 6px 4px 6px 8px; margin-right: 2px;
  border-radius: 9px; background: var(--zac-softer); border: 1px solid var(--zac-line); font-size: calc(12px * var(--zac-fs, 1)); }
.zac-quote > svg.zac-i { width: calc(13px * var(--zac-fs, 1)); height: calc(13px * var(--zac-fs, 1)); margin-top: 2px; color: var(--zac-accent); }
.zac-quote-text { flex: 1; min-width: 0; white-space: pre-wrap; max-height: 4.6em; overflow: hidden; color: var(--zac-fg2); }
.zac-view .zac-quote .zac-icon-btn { width: calc(20px * var(--zac-fs, 1)); height: calc(20px * var(--zac-fs, 1)); border-radius: 6px; }
.zac-quote .zac-icon-btn svg.zac-i { width: calc(12px * var(--zac-fs, 1)); height: calc(12px * var(--zac-fs, 1)); }
.zac-input { width: 100%; resize: none; border: none; outline: none; background: transparent; color: inherit;
  font: inherit; font-size: calc(13px * var(--zac-fs, 1)); line-height: 1.5; padding: 2px 0; margin: 0; min-height: 40px; max-height: 180px; height: 40px; }
.zac-input::placeholder { color: var(--zac-fg3); }
.zac-composer-bar { display: flex; align-items: center; gap: 6px; }
.zac-pills { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-left: -4px; }
.zac-pill { position: relative; display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; }
.zac-pill select { appearance: none; -moz-appearance: none; max-width: 100%; min-width: 0; min-height: calc(26px * var(--zac-fs, 1)); margin: 0;
  white-space: nowrap; overflow: hidden;
  padding: 0 22px 0 8px; border: none; border-radius: 8px; background: transparent; color: var(--zac-fg2);
  font: inherit; font-size: calc(12px * var(--zac-fs, 1)); cursor: pointer; text-overflow: ellipsis; }
.zac-pill select:hover, .zac-pill select:focus-visible { background: var(--zac-soft); color: var(--zac-fg); outline: none; }
.zac-pill select:disabled { cursor: default; opacity: .55; background: transparent; }
.zac-pill select option { color: var(--zac-fg); background: var(--zac-bg); }
.zac-pill::after { content: ""; position: absolute; right: 9px; top: 50%; width: 5px; height: 5px; pointer-events: none;
  border-right: 1.5px solid var(--zac-fg2); border-bottom: 1.5px solid var(--zac-fg2); transform: translateY(-70%) rotate(45deg); }
.zac-pill-sep { width: 1px; height: 14px; background: var(--zac-line); margin: 0 2px; }
.zac-view .zac-send { width: calc(30px * var(--zac-fs, 1)); height: calc(30px * var(--zac-fs, 1)); border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--zac-accent); color: #fff; transition: filter .12s, opacity .12s; }
.zac-view .zac-send svg.zac-i { width: calc(16px * var(--zac-fs, 1)); height: calc(16px * var(--zac-fs, 1)); stroke-width: 2.4; }
.zac-view .zac-send:hover { filter: brightness(1.1); }
.zac-view .zac-send.zac-empty-input { opacity: .45; }
.zac-view .zac-send.zac-stopping { background: var(--zac-fg); color: var(--zac-bg); opacity: 1; }
.zac-foot-hint { font-size: calc(10.5px * var(--zac-fs, 1)); color: var(--zac-fg3); text-align: center; margin-top: 5px; user-select: none; }

/* 设置页 */
.zac-settings { flex: 1; min-height: 0; overflow-y: auto; display: none; user-select: text; background: var(--zac-bg2); }
.zac-settings-top { display: flex; align-items: center; gap: 6px; padding: 10px 12px 0; }
.zac-settings-top .zac-title { font-size: calc(14px * var(--zac-fs, 1)); }
.zac-settings-body { padding: 10px 12px 12px; }
.zac-group-title { font-size: calc(11px * var(--zac-fs, 1)); font-weight: 600; color: var(--zac-fg2); text-transform: uppercase; letter-spacing: .04em;
  margin: 10px 4px 6px; }
.zac-card { border: 1px solid var(--zac-line); border-radius: 12px; background: var(--zac-bg); padding: 4px 12px; }
.zac-row-item { padding: 10px 0; border-bottom: 1px solid var(--zac-line); }
.zac-row-item:last-child { border-bottom: none; }
.zac-row-title { font-size: calc(12.5px * var(--zac-fs, 1)); }
.zac-row-desc { font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); margin-top: 1px; }
/* 输入框：Zotero 自带样式会把边框弱化到几乎看不见，这里统一重设 */
.zac-view .zac-field input[type=text], .zac-view .zac-field input[type=number], .zac-view .zac-field textarea {
  appearance: none; -moz-appearance: none; display: block; width: 100%; margin: 6px 0 0; box-sizing: border-box;
  font: inherit; font-size: calc(12.5px * var(--zac-fs, 1)); line-height: 1.5; padding: 6px 10px; color: var(--zac-fg); text-align: left;
  background: color-mix(in srgb, var(--zac-fg) 3%, var(--zac-bg));
  border: 1px solid color-mix(in srgb, var(--zac-fg) 22%, transparent); border-radius: 8px;
  box-shadow: inset 0 1px 1px rgba(0,0,0,.04); transition: border-color .12s, box-shadow .12s, background .12s; }
.zac-view .zac-field input[type=number] { -moz-appearance: textfield; width: 120px; }
.zac-view .zac-field input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zac-view .zac-field input:hover, .zac-view .zac-field textarea:hover { border-color: color-mix(in srgb, var(--zac-fg) 38%, transparent); }
.zac-view .zac-field input:focus, .zac-view .zac-field textarea:focus { outline: none; background: var(--zac-bg);
  border-color: var(--zac-accent); box-shadow: 0 0 0 3px var(--zac-accent-soft); }
.zac-view .zac-field input::placeholder, .zac-view .zac-field textarea::placeholder { color: var(--zac-fg3); }
.zac-view .zac-field textarea { min-height: 76px; resize: vertical; }
.zac-num-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.zac-num-row input[type=number] { margin-top: 0 !important; }
.zac-unit { font-size: calc(12px * var(--zac-fs, 1)); color: var(--zac-fg2); }
.zac-switch { position: relative; display: flex; gap: 10px; align-items: center; cursor: pointer; }
.zac-switch-text { flex: 1; min-width: 0; }
.zac-switch-input { position: absolute; right: 0; top: 50%; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
.zac-track { position: relative; flex: none; width: calc(32px * var(--zac-fs, 1)); height: calc(19px * var(--zac-fs, 1)); border-radius: 10px; background: var(--zac-soft);
  border: 1px solid var(--zac-line); transition: background .15s; }
.zac-track::before { content: ""; position: absolute; top: 1px; left: 1px; width: calc(15px * var(--zac-fs, 1)); height: calc(15px * var(--zac-fs, 1)); border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s; }
.zac-switch-input:checked + .zac-track { background: var(--zac-accent); border-color: var(--zac-accent); }
.zac-switch-input:checked + .zac-track::before { transform: translateX(calc(13px * var(--zac-fs, 1))); }
.zac-switch-input:focus-visible + .zac-track { box-shadow: 0 0 0 3px var(--zac-accent-soft); }
.zac-switch.zac-disabled { opacity: .45; cursor: default; }
.zac-btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.zac-view .zac-btn { display: inline-flex; align-items: center; gap: 5px; min-height: calc(28px * var(--zac-fs, 1)); padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--zac-line); background: var(--zac-bg); font-size: calc(12px * var(--zac-fs, 1)); color: var(--zac-fg); }
.zac-view .zac-btn:hover { background: var(--zac-softer); }
.zac-view .zac-btn:disabled { opacity: .5; }
.zac-btn svg.zac-i { width: calc(13px * var(--zac-fs, 1)); height: calc(13px * var(--zac-fs, 1)); }
.zac-view .zac-btn-primary { background: var(--zac-accent); border-color: var(--zac-accent); color: #fff; }
.zac-view .zac-btn-primary:hover { background: var(--zac-accent); filter: brightness(1.1); }
.zac-src { font-size: calc(11px * var(--zac-fs, 1)); color: var(--zac-fg2); margin-top: 8px; }
.zac-out { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(11px * var(--zac-fs, 1)); line-height: 1.55;
  margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--zac-softer); border: 1px solid var(--zac-line);
  max-height: 260px; overflow: auto; }
.zac-out:empty { display: none; }
.zac-settings-foot { position: sticky; bottom: 0; display: flex; gap: 8px; justify-content: flex-end;
  padding: 10px 12px; background: var(--zac-bg); border-top: 1px solid var(--zac-line); }
/* 字号设置 */
.zac-font-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.zac-font-row input[type=range] { flex: 1; min-width: 0; accent-color: var(--zac-accent); }
.zac-font-val { min-width: 3.2em; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.zac-seg { display: inline-flex; border: 1px solid var(--zac-line); border-radius: 8px; overflow: hidden; margin-top: 8px; }
.zac-view .zac-seg button { padding: 3px 10px; font-size: calc(12px * var(--zac-fs, 1)); color: var(--zac-fg2); border-right: 1px solid var(--zac-line); }
.zac-view .zac-seg button:last-child { border-right: none; }
.zac-view .zac-seg button:hover { background: var(--zac-softer); color: var(--zac-fg); }
.zac-view .zac-seg button.zac-on { background: var(--zac-accent); color: #fff; }
`;

class ZacChatView {
  constructor(session, mode, container) {
    this.s = session;
    this.p = session.p;
    this.mode = mode; // "floating" | "embedded"
    this.win = session.win;
    this.doc = container ? container.ownerDocument : session.win.document;
    this.itemID = null; // embedded：侧边栏当前显示的条目
    this.page = "chat";
    this.msgEls = new Map();
    this.build(container);
    session.addView(this);
    // 后台从本机 CLI 获取模型列表（24 小时内只取一次）
    this.p.refreshModels(this.p.currentAgent()).catch(() => {});
  }

  el(tag, props = {}, ...children) {
    const e = this.doc.createElementNS(ZAC_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "title" && (tag === "button" || tag === "select")) e.setAttribute("data-tip", v);
      else if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) e.append(c);
    return e;
  }

  icon(name) {
    const SVG = "http://www.w3.org/2000/svg";
    const svg = this.doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "zac-i");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ZAC_ICONS[name] || []) {
      const n = this.doc.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    }
    return svg;
  }

  iconBtn(name, title, onclick, cls = "zac-icon-btn") {
    // 用自绘提示（data-tip），不依赖 Zotero 窗口是否显示原生 title 提示
    return this.el("button", { class: cls, "data-tip": title, "aria-label": title, onclick }, this.icon(name));
  }

  /* ---------- 构建 ---------- */

  build(container) {
    const floating = this.mode === "floating";
    this.titleEl = this.el("div", { class: "zac-subtitle" });
    this.gearBtn = this.iconBtn("settings", "设置", () => this.showSettings(this.page !== "settings"));
    const newBtn = this.iconBtn("newChat", "新对话（清空当前记录）", () => this.newChat());
    this.usageText = this.el("span", { text: "额度" });
    this.usageBtn = this.el("button", { class: "zac-usage-btn", onclick: () => this.toggleUsage() }, this.icon("gauge"), this.usageText);
    this.usagePop = this.el("div", { class: "zac-usage-pop" });

    const header = floating
      ? this.el(
          "div",
          { class: "zac-header" },
          this.el("div", { class: "zac-logo" }, this.icon("sparkles")),
          this.el("div", { class: "zac-title-wrap" }, this.el("span", { class: "zac-title", text: "Agent 对话" }), this.titleEl),
          this.usageBtn,
          newBtn,
          this.gearBtn,
          this.iconBtn("close", "关闭（Esc）", () => this.close())
        )
      : this.el("div", { class: "zac-header" }, this.el("div", { class: "zac-title-wrap" }, this.titleEl), this.usageBtn, newBtn, this.gearBtn);
    this.headerEl = header;
    if (floating) this.enableDrag(header);

    // 对话页：消息
    this.msgsEl = this.el("div", { class: "zac-messages" });
    this.emptyEl = this.buildEmpty();

    // 输入区：引用、快捷操作、输入框、模型选择、发送
    this.quoteText = this.el("div", { class: "zac-quote-text" });
    this.quoteMeta = this.el("div", { class: "zac-quote-meta" });
    this.quoteImg = this.el("img", { class: "zac-snip", alt: "选区截图" });
    this.snipBtn = this.iconBtn("image", "附带选区截图（公式会自动截图）", () => this.s.toggleSnip());
    this.quoteEl = this.el(
      "div",
      { class: "zac-quote" },
      this.icon("quote"),
      this.el("div", { class: "zac-quote-body" }, this.quoteText, this.quoteImg, this.quoteMeta),
      this.el("div", { class: "zac-quote-btns" }, this.iconBtn("close", "不附带这段原文", () => this.s.clearQuote()), this.snipBtn)
    );
    this.chipsEl = this.el("div", { class: "zac-chips" });
    for (const [label, q] of ZAC_QUOTE_ACTIONS) {
      this.chipsEl.append(this.el("button", { class: "zac-chip", text: label, title: q, onclick: () => this.quickSend(q) }));
    }
    this.input = this.el("textarea", {
      class: "zac-input",
      placeholder: "向 Agent 提问…",
      rows: "2",
      oninput: () => {
        this.autoGrow();
        this.updateSendState();
      },
      onkeydown: (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          e.stopPropagation();
          this.submit();
        }
      },
    });

    this.agentSel = this.el("select", { title: "Agent", onchange: () => this.s.setPref("agent", this.agentSel.value) });
    for (const [v, label] of Object.entries(ZAC_AGENTS)) this.agentSel.append(this.el("option", { value: v, text: label }));
    this.modelSel = this.el("select", { title: "模型", onchange: () => this.onModelChange() });
    this.effortSel = this.el("select", {
      title: "Effort（推理强度）",
      onchange: () => this.s.setPref(this.p.currentAgent() + "Effort", this.effortSel.value),
    });
    this.modelPill = this.el("span", { class: "zac-pill" }, this.modelSel);
    this.effortPill = this.el("span", { class: "zac-pill" }, this.effortSel);
    this.sendBtn = this.el("button", { class: "zac-send", title: "发送（Enter）", onclick: () => (this.s.state ? this.s.stop() : this.submit()) });

    this.chatPage = this.el(
      "div",
      { class: "zac-page" },
      this.msgsEl,
      this.el(
        "div",
        { class: "zac-composer-wrap" },
        this.chipsEl,
        this.el(
          "div",
          { class: "zac-composer" },
          this.quoteEl,
          this.input,
          this.el(
            "div",
            { class: "zac-composer-bar" },
            this.el("div", { class: "zac-pills" }, this.el("span", { class: "zac-pill" }, this.agentSel), this.modelPill, this.effortPill),
            this.sendBtn
          )
        ),
        this.el("div", { class: "zac-foot-hint", text: "Enter 发送 · Shift+Enter 换行 · 回复由本机 agent 生成，请核对" })
      )
    );

    this.settingsPage = this.el("div", { class: "zac-settings" });

    this.root = this.el(
      "div",
      {
        class: "zac-view " + (floating ? "zac-floating" : "zac-embedded"),
        onkeydown: (e) => {
          // Ctrl/⌘ + = / - / 0：调整插件字号（只在插件界面内生效）
          if ((e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            const cur = this.p.fontScale();
            const v = this.p.setFontScale(e.key === "0" ? 100 : e.key === "-" || e.key === "_" ? cur - 10 : cur + 10);
            this.toast(`字号 ${v}%`);
            return;
          }
          if (e.key !== "Escape") return;
          if (this.dialogEl) {
            e.stopPropagation();
            this.closeDialog();
          } else if (this.usageOpen) {
            e.stopPropagation();
            this.hideUsage();
          } else if (this.page === "settings") {
            e.stopPropagation();
            this.showSettings(false);
          } else if (floating) {
            e.stopPropagation();
            this.close();
          }
        },
      },
      this.el("style", { text: ZAC_CSS }),
      header,
      this.chatPage,
      this.settingsPage,
      this.usagePop
    );
    // 外层容器不应滚动（overflow: hidden 仍可能被焦点滚动带偏），一旦发生立即复位
    this.root.addEventListener("scroll", () => {
      if (this.root.scrollTop || this.root.scrollLeft) {
        this.root.scrollTop = 0;
        this.root.scrollLeft = 0;
      }
    });

    // 自绘提示：悬停在带 data-tip 的元素上 0.4 秒后显示
    this.tipEl = this.el("div", { class: "zac-tip" });
    this.root.append(this.tipEl);
    this.root.addEventListener("mouseover", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t || !this.root.contains(t) || t === this._tipTarget) return;
      this._tipTarget = t;
      this.win.clearTimeout(this._tipTimer);
      this._tipTimer = this.win.setTimeout(() => this.showTip(t), 400);
    });
    this.root.addEventListener("mouseout", (e) => {
      if (this._tipTarget && (!e.relatedTarget || !this._tipTarget.contains(e.relatedTarget))) this.hideTip();
    });
    this.root.addEventListener("mousedown", () => this.hideTip(), true);

    // 点额度面板以外的地方关闭它
    this.root.addEventListener("mousedown", (e) => {
      if (this.usageOpen && !this.usagePop.contains(e.target) && !this.usageBtn.contains(e.target)) this.hideUsage();
    });
    if (container) container.append(this.root);
    else (this.doc.body || this.doc.documentElement).append(this.root);

    this.applyFont();
    this.refreshControls();
    this.renderAll();
    this.renderQuote();
    this.updateStatus();
    this.refreshContext();
    this.renderUsage();
    this.p.refreshUsage(this.p.currentAgent());
  }

  applyFont() {
    if (!this.root) return;
    const pct = this.p.fontScale();
    this.root.style.setProperty("--zac-fs", String(pct / 100));
    if (this.fontVal) this.fontVal.textContent = `${pct}%`;
    if (this.fontRange && +this.fontRange.value !== pct) this.fontRange.value = String(pct);
    if (this.fontSeg) for (const b of this.fontSeg.children) b.classList.toggle("zac-on", +b.dataset.v === pct);
    if (this.input) this.autoGrow();
    // 下拉框宽度按新字号重新计算
    if (this.agentSel) for (const sel of [this.agentSel, this.modelSel, this.effortSel]) this.fitSelect(sel);
  }

  /* ---------- 新对话、提示、轻提示 ---------- */

  newChat() {
    this.closeDialog();
    this.hideUsage();
    if (this.page === "settings") this.showSettings(false);
    const had = this.s.messages.length > 0;
    this.s.reset();
    this.input.focus();
    this.toast(had ? "已开始新对话" : "当前已经是新对话");
  }

  showTip(t) {
    if (!this.root || !t.isConnected) return;
    const text = t.getAttribute("data-tip");
    if (!text) return;
    this.tipEl.textContent = text;
    this.tipEl.style.display = "block";
    const rr = this.root.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    const tw = this.tipEl.offsetWidth;
    let x = r.left - rr.left + r.width / 2 - tw / 2;
    x = Math.max(6, Math.min(x, rr.width - tw - 6));
    let y = r.bottom - rr.top + 6;
    if (y + this.tipEl.offsetHeight > rr.height - 4) y = r.top - rr.top - this.tipEl.offsetHeight - 6;
    this.tipEl.style.left = x + "px";
    this.tipEl.style.top = y + "px";
  }

  hideTip() {
    this.win.clearTimeout(this._tipTimer);
    this._tipTarget = null;
    if (this.tipEl) this.tipEl.style.display = "none";
  }

  toast(text) {
    if (!this.root) return;
    if (!this.toastEl) {
      this.toastEl = this.el("div", { class: "zac-toast" });
      this.root.append(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.classList.add("zac-show");
    this.win.clearTimeout(this._toastTimer);
    this._toastTimer = this.win.setTimeout(() => this.toastEl && this.toastEl.classList.remove("zac-show"), 1600);
  }

  /* ---------- 额度 ---------- */

  renderUsage() {
    if (!this.usageBtn) return;
    const agent = this.p.currentAgent();
    const show = this.p.usageSupported(agent);
    this.usageBtn.style.display = show ? "" : "none";
    if (!show) {
      this.hideUsage();
      return;
    }
    const st = this.p.usageState(agent);
    const d = st.data;
    const ws = (d && d.windows) || [];
    const max = ws.length ? Math.max(...ws.map((w) => w.usedPercent)) : null;
    let text = "额度";
    let level = "";
    if (max != null) {
      text = `${Math.round(max)}%`;
      level = zacUsageLevel(max);
    } else if (st.status === "loading") text = "…";
    else if (st.status === "error") level = "zac-u-error";
    this.usageText.textContent = text;
    this.usageBtn.className = "zac-usage-btn " + level;
    const tip = ws.map((w) => `${w.label}：已用 ${Math.round(w.usedPercent)}%`).join("\n");
    this.usageBtn.setAttribute(
      "data-tip",
      `${ZAC_AGENTS[agent]} 额度（点击查看详情）` + (tip ? "\n" + tip : st.status === "error" ? "\n读取失败：" + st.error : d && d.note ? "\n" + d.note : "")
    );
    if (this.usageOpen) this.renderUsagePop();
  }

  toggleUsage() {
    if (this.usageOpen) return this.hideUsage();
    this.usageOpen = true;
    this.usagePop.style.top = (this.headerEl ? this.headerEl.offsetHeight + 6 : 50) + "px";
    this.usagePop.style.display = "block";
    this.usageBtn.classList.add("zac-active");
    this.renderUsagePop();
    const st = this.p.usageState(this.p.currentAgent());
    if (!st.ts || Date.now() - st.ts > 60 * 1000) this.p.refreshUsage(this.p.currentAgent(), true, true);
  }

  hideUsage() {
    this.usageOpen = false;
    if (this.usagePop) this.usagePop.style.display = "none";
    if (this.usageBtn) this.usageBtn.classList.remove("zac-active");
  }

  renderUsagePop() {
    const agent = this.p.currentAgent();
    const st = this.p.usageState(agent);
    const d = st.data;
    const pop = this.usagePop;
    pop.replaceChildren();
    const refresh = this.iconBtn("refresh", "刷新", () => this.p.refreshUsage(agent, true, true));
    if (st.status === "loading") refresh.classList.add("zac-spin");
    pop.append(
      this.el(
        "div",
        { class: "zac-u-head" },
        this.el("span", { class: "zac-u-title", text: `${ZAC_AGENTS[agent]} 额度` }),
        d && d.plan ? this.el("span", { class: "zac-u-plan", text: d.plan }) : null,
        refresh
      )
    );
    if (!d && st.status === "loading") pop.append(this.el("div", { class: "zac-u-note", text: "正在读取…" }));
    for (const w of (d && d.windows) || []) {
      const pct = Math.max(0, Math.min(100, w.usedPercent));
      pop.append(
        this.el(
          "div",
          { class: "zac-u-row " + zacUsageLevel(pct) },
          this.el("div", { class: "zac-u-line" }, this.el("span", { text: w.label }), this.el("span", { class: "zac-u-pct", text: `${Math.round(pct)}%` })),
          this.el("div", { class: "zac-u-bar" }, this.el("div", { class: "zac-u-fill", style: `width:${pct}%` })),
          w.resetsAt ? this.el("div", { class: "zac-u-reset", text: zacFmtReset(w.resetsAt) }) : w.resetText ? this.el("div", { class: "zac-u-reset", text: w.resetText }) : null
        )
      );
    }
    if (d && d.raw) {
      pop.append(
        this.el(
          "details",
          { class: "zac-u-raw", open: d.windows && d.windows.length ? null : "" },
          this.el("summary", { text: "agy /usage 原始输出" }),
          this.el("pre", { text: zacClip(d.raw, 3000) })
        )
      );
    }
    for (const x of (d && d.extras) || []) pop.append(this.el("div", { class: "zac-u-note", text: x }));
    if (d && d.note) pop.append(this.el("div", { class: "zac-u-note", text: d.note }));
    if (st.status === "error") {
      pop.append(this.el("div", { class: "zac-u-err", text: "读取失败：" + st.error }));
      const h = zacHint(agent, st.error);
      if (h && h !== st.error) pop.append(this.el("div", { class: "zac-u-note", text: h }));
    }
    if (st.ts) {
      const t = new Date(st.ts);
      pop.append(
        this.el("div", {
          class: "zac-u-foot",
          text: `更新于 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")} · ` + (this.p.usageAuto(agent) ? "每次回答后自动刷新" : "点右上角刷新按钮更新"),
        })
      );
    }
  }

  buildEmpty() {
    const sug = this.el("div", { class: "zac-suggest" });
    for (const [label, q] of ZAC_PAPER_ACTIONS) {
      sug.append(this.el("button", { class: "zac-suggest-btn", text: label, title: q, onclick: () => this.quickSend(q, true) }));
    }
    return this.el(
      "div",
      { class: "zac-empty" },
      this.el("div", { class: "zac-logo" }, this.icon("sparkles")),
      this.el("div", { class: "zac-empty-title", text: "和这篇论文对话" }),
      this.el("div", { class: "zac-empty-sub", text: "在 PDF 中选中一段文字再提问，或从下面开始" }),
      sug
    );
  }

  destroy() {
    if (this.mode === "floating") this.saveGeometry();
    if (this.root) this.root.remove();
    this.root = null;
    this.s.removeView(this);
  }

  onSessionEvent(type, data) {
    if (!this.root) return;
    switch (type) {
      case "append": return this.appendMessage(data);
      case "update": return this.updateMessage(data);
      case "reset": return this.renderAll();
      case "quote": return this.renderQuote();
      case "context": return this.refreshContext();
      case "controls":
        this.refreshControls();
        this.updateStatus();
        this.renderUsage();
        if (this._usageAgent !== this.p.currentAgent()) {
          this._usageAgent = this.p.currentAgent();
          this.p.refreshUsage(this._usageAgent);
        }
        return;
      case "usage": return this.renderUsage();
      case "font": return this.applyFont();
      case "status": return this.updateStatus();
    }
  }

  autoGrow() {
    const t = this.input;
    t.style.height = "auto";
    t.style.height = Math.min(Math.max(t.scrollHeight, 40), 180) + "px";
  }

  /* ---------- 模型选择 ---------- */

  refreshControls() {
    const agent = this.p.currentAgent();
    const rawModel = String(this.p.getPref(agent + "Model") || "").trim();
    const { effort } = this.p.agentConfig(agent);
    const info = this.p.modelInfo(agent);
    this.agentSel.value = agent;

    const show = agent !== "custom";
    this.modelPill.style.display = show ? "" : "none";
    this.effortPill.style.display = show ? "" : "none";

    if (show) {
      const defEntry = info.models.find((m) => m.isDefault);
      const defName = defEntry && /\d/.test(defEntry.label) ? defEntry.label : "";
      this.modelSel.replaceChildren(
        this.el("option", { value: "", text: defName ? `默认（${defName}）` : "默认模型", title: defEntry ? defEntry.description : "" })
      );
      for (const m of info.models) {
        if (m.value === "default") continue;
        this.modelSel.append(this.el("option", { value: m.value, text: m.label || m.value, title: m.description || m.value }));
      }
      if (rawModel && !info.models.some((m) => m.value === rawModel)) {
        this.modelSel.append(this.el("option", { value: rawModel, text: rawModel }));
      }
      this.modelSel.append(this.el("option", { value: "__custom__", text: "自定义…" }));
      this.modelSel.value = rawModel;
      this.modelSel.dataset.tip = "模型" + (info.source === "cli" ? "（列表来自本机 CLI）" : "（内置预设）");

      const allowed = this.p.allowedEfforts(agent, rawModel);
      const none = allowed.known && !allowed.list.length;
      this.effortSel.replaceChildren(
        this.el("option", {
          value: "",
          text: none ? "不支持 Effort" : allowed.defaultEffort ? `Effort：默认（${zacEffortLabel(agent, allowed.defaultEffort)}）` : "Effort：默认",
        })
      );
      for (const e of allowed.list) {
        this.effortSel.append(
          this.el("option", { value: e.value, text: zacEffortLabel(agent, e.value), title: [e.value, e.description].filter(Boolean).join(" — ") })
        );
      }
      this.effortSel.value = effort;
      this.effortSel.disabled = none;
      this.effortSel.dataset.tip = none ? "该模型不支持调节 effort" : "Effort（推理强度）";
    }

    for (const sel of [this.agentSel, this.modelSel, this.effortSel]) this.fitSelect(sel);

    // 设置页只在 agent 切换时重建，避免冲掉正在编辑的内容
    if (this.page === "settings" && this._settingsAgent !== agent) this.renderSettings();
  }

  // 下拉框宽度跟随当前选中的文字（原生 select 默认按最长选项撑宽）
  fitSelect(sel) {
    const opt = sel.options[sel.selectedIndex];
    const text = opt ? opt.text : "";
    let w = text.length * 7.5;
    try {
      if (!this._measure) this._measure = this.doc.createElementNS(ZAC_NS, "canvas").getContext("2d");
      const cs = this.win.getComputedStyle(sel);
      this._measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      w = this._measure.measureText(text).width;
    } catch (e) {}
    sel.style.width = Math.ceil(w + 32) + "px";
  }

  onModelChange() {
    const agent = this.p.currentAgent();
    let v = this.modelSel.value;
    if (v === "__custom__") {
      const input = this.win.prompt(`输入 ${ZAC_AGENTS[agent]} 的模型名称（留空 = 默认）：`, this.p.getPref(agent + "Model") || "");
      if (input === null) {
        this.refreshControls();
        return;
      }
      v = input.trim();
    }
    this.s.setPref(agent + "Model", v);
  }

  /* ---------- 设置页 ---------- */

  showSettings(show) {
    this.page = show ? "settings" : "chat";
    if (show) this.renderSettings();
    this.settingsPage.style.display = show ? "block" : "none";
    this.chatPage.style.display = show ? "none" : "flex";
    this.gearBtn.classList.toggle("zac-active", show);
    if (!show) this.input.focus();
  }

  renderSettings() {
    const agent = this.p.currentAgent();
    const name = ZAC_AGENTS[agent];
    this._settingsAgent = agent;
    this.settingInputs = {};

    const field = (key, title, desc, type = "text", placeholder = "") => {
      const input =
        type === "textarea"
          ? this.el("textarea", { placeholder })
          : this.el("input", {
              type: type === "number" ? "number" : "text",
              placeholder,
              min: type === "number" ? "0" : null,
              inputmode: type === "number" ? "numeric" : null,
              spellcheck: "false",
            });
      const v = this.p.getPref(key);
      input.value = v == null ? "" : String(v);
      this.settingInputs[key] = { el: input, type };
      const unit = { historyTurns: "轮", timeoutSec: "秒" }[key];
      return this.el(
        "label",
        { class: "zac-row-item zac-field", style: "display:block" },
        this.el("div", { class: "zac-row-title", text: title }),
        desc ? this.el("div", { class: "zac-row-desc", text: desc }) : null,
        unit ? this.el("div", { class: "zac-num-row" }, input, this.el("span", { class: "zac-unit", text: unit })) : input
      );
    };
    const toggle = (key, title, desc) => {
      const cb = this.el("input", { type: "checkbox", class: "zac-switch-input" });
      cb.checked = this.p.getPref(key) !== false;
      this.settingInputs[key] = { el: cb, type: "bool" };
      const row = this.el(
        "label",
        { class: "zac-row-item zac-switch" },
        this.el(
          "span",
          { class: "zac-switch-text" },
          this.el("div", { class: "zac-row-title", text: title }),
          desc ? this.el("div", { class: "zac-row-desc", text: desc }) : null
        ),
        cb,
        this.el("span", { class: "zac-track" })
      );
      return { row, cb };
    };
    const group = (title, ...rows) => [this.el("div", { class: "zac-group-title", text: title }), this.el("div", { class: "zac-card" }, ...rows)];

    const body = this.el("div", { class: "zac-settings-body" });
    const out = this.el("div", { class: "zac-out" });

    // 1. 当前 agent
    if (agent === "custom") {
      const diagBtn = this.el("button", { class: "zac-btn", onclick: () => this.runDiagnose(out, diagBtn) }, this.icon("pulse"), "诊断连接");
      body.append(
        ...group(
          `${name} agent`,
          field("customCommand", "命令", "名称或完整路径"),
          field("customArgs", "参数", "含 {prompt} 时提示词作为参数传入，否则从 stdin 传入；{pdf_dir} 会替换为 PDF 所在目录", "text", "-p {prompt}"),
          this.el("div", { class: "zac-row-item" }, this.el("div", { class: "zac-btns", style: "margin-top:0" }, diagBtn), out)
        )
      );
    } else {
      const info = this.p.modelInfo(agent);
      const failed = this.p._discoverFailed && this.p._discoverFailed[agent];
      const src =
        info.source === "cli"
          ? `模型列表来自本机 ${name}：${info.models.filter((m) => m.value !== "default").length} 个模型，更新于 ${new Date(info.ts).toLocaleString()}`
          : "模型列表：内置预设" + (failed ? `（从本机获取失败：${zacClip(failed, 100)}）` : "（尚未从本机获取）");
      const diagBtn = this.el("button", { class: "zac-btn", onclick: () => this.runDiagnose(out, diagBtn) }, this.icon("pulse"), "诊断连接");
      const refBtn = this.el("button", { class: "zac-btn", onclick: () => this.refreshModelList(out, refBtn) }, this.icon("refresh"), "刷新模型列表");
      const instBtn = this.el("button", { class: "zac-btn", title: "用官方安装脚本安装或更新命令行工具", onclick: () => this.confirmInstall(agent, out, false) }, this.icon("download"), "安装 / 更新");
      const loginBtn = this.el("button", { class: "zac-btn", title: "打开终端窗口登录账号", onclick: () => this.openLogin(agent, out) }, this.icon("login"), "登录");
      body.append(
        ...group(
          name,
          field(agent + "Path", "命令", "名称或完整路径；Windows 上填 .exe 或 .cmd", "text", agent),
          this.el(
            "div",
            { class: "zac-row-item" },
            this.el("div", { class: "zac-row-title", text: "连接与模型" }),
            this.el("div", { class: "zac-row-desc", text: "模型和 Effort 在输入框下方选择，每个 agent 分别保存。连不上时先点「诊断连接」。" }),
            this.el("div", { class: "zac-btns" }, diagBtn, refBtn, instBtn, loginBtn),
            this.el("div", { class: "zac-src", text: src }),
            out
          )
        )
      );
    }

    // 外观：字号（拖动即时生效并保存）
    this.fontVal = this.el("span", { class: "zac-font-val" });
    this.fontRange = this.el("input", {
      type: "range",
      min: "80",
      max: "160",
      step: "5",
      oninput: () => this.p.setFontScale(+this.fontRange.value),
    });
    this.fontSeg = this.el("div", { class: "zac-seg" });
    for (const [label, v] of [["小", 90], ["标准", 100], ["大", 115], ["特大", 130]]) {
      this.fontSeg.append(this.el("button", { text: label, "data-v": String(v), onclick: () => this.p.setFontScale(v) }));
    }
    body.append(
      ...group(
        "外观",
        this.el(
          "div",
          { class: "zac-row-item" },
          this.el("div", { class: "zac-row-title", text: "字号" }),
          this.el("div", { class: "zac-row-desc", text: "调整插件界面所有文字的大小，悬浮窗和侧边栏同步生效；在插件内也可以按 Ctrl/⌘ 加 = 或 - 调整，Ctrl/⌘+0 恢复。" }),
          this.fontSeg,
          this.el("div", { class: "zac-font-row" }, this.el("span", { class: "zac-row-desc", text: "A" }), this.fontRange, this.el("span", { text: "A", style: "font-size: 1.3em" }), this.fontVal)
        )
      )
    );
    this.applyFont();

    // 2. 悬浮窗口
    const fe = toggle("floatingEnabled", "启用悬浮窗口", "关闭后只使用侧边栏的对话区块；工具栏的 💬 会跳到侧边栏");
    const ao = toggle("autoOpenOnSelect", "选中文字时自动弹出", "侧边栏对话区块可见时不弹出");
    const sync = () => {
      ao.cb.disabled = !fe.cb.checked;
      ao.row.classList.toggle("zac-disabled", !fe.cb.checked);
    };
    fe.cb.addEventListener("change", sync);
    sync();
    body.append(...group("悬浮窗口", fe.row, ao.row));

    // 3. 对话
    body.append(
      ...group(
        "对话",
        toggle("includePdfPath", "允许 agent 读取论文全文", "把 PDF 路径告诉 agent，回答可以结合全文").row,
        (() => {
          const t = toggle(
            "formulaEnhance",
            "公式增强",
            "选中公式时自动截取选区图片交给 agent 识别，并让它先还原出准确的 LaTeX，再回答问题；笔记里也会保存还原后的公式和原始截图。" +
              "开启后，涉及公式的提问会增加模型响应时间（agent 需要额外查看图片并输出还原内容）。"
          );
          t.cb.checked = this.p.formulaEnhance();
          return t.row;
        })(),
        toggle("noteHighlight", "存为笔记时在原文创建高亮", "笔记里的「跳转到原文」会直接定位到这处高亮；关闭则只跳到对应页").row,
        field("historyTurns", "附带的历史轮数", "每次提问附带最近几轮问答，0 表示不附带", "number"),
        field("timeoutSec", "超时", "超过这个时间自动停止", "number"),
        field("systemPrompt", "系统提示词", "留空使用默认", "textarea", ZAC_DEFAULT_SYSTEM)
      )
    );

    // 4. 环境
    body.append(...group("运行环境", field("extraPath", "额外 PATH 目录", "Zotero 找不到命令或 node 时，把所在目录填在这里，每行一个", "textarea")));

    const top = this.el(
      "div",
      { class: "zac-settings-top" },
      this.iconBtn("back", "返回对话", () => this.showSettings(false)),
      this.el("span", { class: "zac-title", text: "设置" })
    );
    const foot = this.el(
      "div",
      { class: "zac-settings-foot" },
      this.el("button", { class: "zac-btn", text: "取消", onclick: () => this.showSettings(false) }),
      this.el("button", {
        class: "zac-btn zac-btn-primary",
        text: "保存",
        onclick: () => {
          this.saveSettings();
          this.showSettings(false);
        },
      })
    );
    this.settingsPage.replaceChildren(top, body, foot);
  }

  saveSettings() {
    for (const [key, { el, type }] of Object.entries(this.settingInputs || {})) {
      if (type === "bool") this.s.setPref(key, !!el.checked);
      else if (type === "number") {
        const n = parseInt(el.value, 10);
        if (!isNaN(n) && n >= 0) this.p.setPref(key, n);
      } else this.p.setPref(key, el.value.trim());
    }
    for (const s of this.p.sessions.values()) s.emit("controls");
  }

  async runDiagnose(out, btn) {
    this.saveSettings();
    const agent = this.p.currentAgent();
    btn.disabled = true;
    out.textContent = "";
    const log = (line) => {
      out.textContent += (out.textContent ? "\n" : "") + line;
      out.scrollTop = out.scrollHeight;
    };
    let res = null;
    try {
      res = await this.p.diagnose(agent, log);
    } catch (e) {
      log("✗ 诊断出错：" + (e.message || e));
    } finally {
      btn.disabled = false;
    }
    if (res && res.missing && this.p.installSpec(agent)) this.confirmInstall(agent, out, true);
  }

  /* ---------- 弹窗、安装、登录 ---------- */

  showDialog({ icon, title, text, code, actions }) {
    this.closeDialog();
    const btns = actions.map((a) =>
      this.el("button", {
        class: "zac-btn" + (a.primary ? " zac-btn-primary" : ""),
        text: a.label,
        onclick: () => {
          this.closeDialog();
          if (a.onClick) a.onClick();
        },
      })
    );
    this.dialogEl = this.el(
      "div",
      {
        class: "zac-modal",
        onmousedown: (e) => {
          if (e.target === this.dialogEl) this.closeDialog();
        },
      },
      this.el(
        "div",
        { class: "zac-dialog", role: "dialog", "aria-modal": "true" },
        icon ? this.el("div", { class: "zac-dialog-icon" }, this.icon(icon)) : null,
        this.el("div", { class: "zac-dialog-title", text: title }),
        text ? this.el("div", { class: "zac-dialog-text", text }) : null,
        code ? this.el("div", { class: "zac-dialog-code", text: code }) : null,
        this.el("div", { class: "zac-dialog-actions" }, ...btns)
      )
    );
    this.root.append(this.dialogEl);
    const primary = btns.find((b) => b.classList.contains("zac-btn-primary"));
    if (primary) primary.focus();
  }

  closeDialog() {
    if (this.dialogEl) this.dialogEl.remove();
    this.dialogEl = null;
  }

  confirmInstall(agent, out, missing) {
    const spec = this.p.installSpec(agent);
    if (!spec) return;
    const name = ZAC_AGENTS[agent];
    this.showDialog({
      icon: "download",
      title: missing ? `没有找到 ${name}` : `安装 / 更新 ${name}`,
      text:
        (missing ? `这台电脑上没有检测到 ${name} 命令行工具，是否现在安装？` : `将用官方安装脚本安装最新版 ${name}。`) +
        "\n需要联网，通常 1–3 分钟；安装后还需要登录一次账号。将执行：",
      code: spec.manual,
      actions: [{ label: "取消" }, { label: "安装", primary: true, onClick: () => this.runInstall(agent, out) }],
    });
  }

  async runInstall(agent, out) {
    if (this._installing) return;
    this._installing = true;
    const name = ZAC_AGENTS[agent];
    const spec = this.p.installSpec(agent);
    for (const b of this.settingsPage.querySelectorAll(".zac-btn")) b.disabled = true;
    out.textContent = "";
    const log = (line) => {
      out.textContent += (out.textContent ? "\n" : "") + line;
      out.scrollTop = out.scrollHeight;
    };
    log(`正在安装 ${name}…（下载过程可能没有输出，请稍候）`);
    let res = null;
    let all = "";
    try {
      res = await this.p.installAgent(agent, (l) => {
        all += l + "\n";
        log(l);
      });
    } catch (e) {
      log("✗ 安装程序无法启动：" + (e.message || e));
    } finally {
      this._installing = false;
      for (const b of this.settingsPage.querySelectorAll(".zac-btn")) b.disabled = false;
    }
    if (res && res.resolved && res.exitCode === 0) {
      let ver = "";
      try {
        const r = await this.p.spawn({ command: res.resolved, args: ["--version"] });
        ver = (r.out || r.err).trim();
      } catch (e) {}
      log(`✓ 安装完成：${res.resolved}${ver ? "（" + ver + "）" : ""}`);
      this.p.refreshModels(agent, true).catch(() => {});
      this.showDialog({
        icon: "login",
        title: `${name} 已安装`,
        text: `下一步：登录账号。将打开一个终端窗口运行「${spec.loginText}」，按提示在浏览器中完成授权。登录后回到这里点「诊断连接」确认。`,
        actions: [{ label: "稍后" }, { label: "打开终端登录", primary: true, onClick: () => this.openLogin(agent, out) }],
      });
    } else if (res) {
      log(`✗ 安装没有成功（退出码 ${res.exitCode}）`);
      const h = zacHint(agent, all);
      if (h) log("→ " + h);
      log(`也可以在终端里手动运行：\n  ${spec.manual}`);
    }
  }

  async openLogin(agent, out) {
    const spec = this.p.installSpec(agent);
    try {
      await this.p.openLoginTerminal(agent);
      if (out) out.textContent = `已打开终端窗口运行「${spec.loginText}」，请按提示完成登录，然后点「诊断连接」。`;
    } catch (e) {
      const msg = String(e.message || e);
      if (out) out.textContent = "无法打开终端：" + msg + `\n请手动在终端运行：${spec.loginText}`;
      if (/找不到命令|在 PATH 中找不到/.test(msg)) this.confirmInstall(agent, out, true);
    }
  }

  async refreshModelList(out, btn) {
    this.saveSettings();
    const agent = this.p.currentAgent();
    btn.disabled = true;
    out.textContent = `正在向本机 ${ZAC_AGENTS[agent]} 获取模型列表…`;
    try {
      const models = await this.p.refreshModels(agent, true);
      const list = models.filter((m) => m.value !== "default");
      out.textContent =
        `已获取 ${list.length} 个模型：\n` +
        list
          .map((m) => `· ${m.label}` + (m.efforts && m.efforts.length ? `   ${m.efforts.map((e) => zacEffortLabel(agent, e.value)).join(" / ")}` : ""))
          .join("\n");
    } catch (e) {
      out.textContent = "获取失败：" + (e.message || e) + "\n仍可使用内置预设，或在模型下拉框选「自定义…」手动输入。";
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- 浮窗：拖动、位置、开关 ---------- */

  enableDrag(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, select, input, option")) return;
      const rect = this.root.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => this.setPos(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this.saveGeometry();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
      e.preventDefault();
    });
  }

  setPos(x, y) {
    const W = this.win.innerWidth;
    const H = this.win.innerHeight;
    const w = this.root.offsetWidth || 420;
    x = Math.min(Math.max(0, x), Math.max(0, W - Math.min(w, W)));
    y = Math.min(Math.max(0, y), Math.max(0, H - 40));
    this.root.style.left = x + "px";
    this.root.style.top = y + "px";
  }

  applyGeometry() {
    let g = {};
    try { g = JSON.parse(this.p.getPref("geometry") || "{}"); } catch (e) {}
    const w = Math.min(g.w || 420, this.win.innerWidth - 16);
    const h = Math.min(g.h || 620, this.win.innerHeight - 16);
    this.root.style.width = w + "px";
    this.root.style.height = h + "px";
    this.setPos(g.x ?? this.win.innerWidth - w - 24, g.y ?? 80);
  }

  saveGeometry() {
    if (this.mode !== "floating" || !this.root || this.root.style.display !== "flex") return;
    const r = this.root.getBoundingClientRect();
    if (!r.width) return;
    this.p.setPref(
      "geometry",
      JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
    );
  }

  isOpen() {
    return !!this.root && this.root.style.display === "flex";
  }

  open({ focus = false, itemID = null } = {}) {
    if (itemID) {
      this.s.itemID = itemID;
      this.refreshContext();
    }
    if (!this.isOpen()) {
      const first = !this._placed;
      this.root.style.display = "flex";
      if (first) {
        this.applyGeometry();
        this._placed = true;
      } else {
        const r = this.root.getBoundingClientRect();
        this.setPos(r.left, r.top);
      }
    }
    if (focus) this.focusInput();
  }

  toggle(opts) {
    if (this.isOpen()) this.close();
    else this.open({ focus: true, ...opts });
  }

  close() {
    this.saveGeometry();
    if (this.root) this.root.style.display = "none";
  }

  /* ---------- 侧边栏 ---------- */

  setItem(itemID) {
    if (this.itemID === itemID) return;
    this.itemID = itemID;
    this.refreshContext();
  }

  isVisible() {
    // 右侧面板收起时 Zotero 用的是 visibility: collapse，元素仍有布局框，不能只看 getClientRects
    return !!this.root && zacIsShown(this.root, 40);
  }

  focusInput() {
    if (this.page === "settings") this.showSettings(false);
    this.input.focus();
  }

  /* ---------- 内容 ---------- */

  async refreshContext() {
    try {
      const ctx = await this.s.getContext(this.mode === "embedded" ? this.itemID : null);
      if (this.titleEl) {
        this.titleEl.textContent = ctx.title || "未关联论文";
        this.titleEl.title = ctx.title || "";
      }
    } catch (e) {
      Zotero.logError(e);
    }
  }

  submit() {
    const ok = this.s.send(this.input.value, this.mode === "embedded" ? this.itemID : null);
    if (ok) {
      this.input.value = "";
      this.autoGrow();
      this.updateSendState();
    }
  }

  quickSend(question, keepInput = false) {
    const typed = keepInput ? "" : this.input.value.trim();
    const ok = this.s.send(typed ? `${question}\n${typed}` : question, this.mode === "embedded" ? this.itemID : null);
    if (ok && !keepInput) {
      this.input.value = "";
      this.autoGrow();
    }
    this.updateSendState();
  }

  renderQuote() {
    const q = this.s.quote;
    this.quoteEl.style.display = q ? "flex" : "none";
    this.chipsEl.style.display = q && !this.s.state ? "flex" : "none";
    if (q) {
      this.quoteText.textContent = zacClip(q, 400);
      this.quoteText.title = zacClip(q, 2000);
    }
    const sel = this.s.selection && this.s.selection.text === q ? this.s.selection : null;
    const enh = this.p.formulaEnhance();
    const showImg = !!(enh && sel && sel.image && sel.useImage);
    this.quoteImg.style.display = showImg ? "block" : "none";
    if (showImg && this.quoteImg.getAttribute("src") !== sel.image.dataURL) this.quoteImg.setAttribute("src", sel.image.dataURL);
    const canSnip = !!(enh && sel && sel.position && sel._reader);
    this.snipBtn.style.display = canSnip ? "" : "none";
    this.snipBtn.classList.toggle("zac-active", showImg);
    const meta = [];
    if (sel && sel.pageLabel) meta.push(`第 ${sel.pageLabel} 页`);
    if (sel && sel.snipping) meta.push("正在截图…");
    else if (showImg) meta.push("已附截图，agent 会对照截图识别公式");
    else if (sel && sel.formula) meta.push(!enh ? "检测到公式（公式增强已关闭）" : sel.snipFailed ? "检测到公式，但截图失败" : "检测到公式");
    this.quoteMeta.textContent = meta.join(" · ");
    this.quoteMeta.style.display = meta.length ? "" : "none";
    this.updateSendState();
  }

  updateSendState() {
    const st = this.s.state;
    const empty = !this.input.value.trim() && !this.s.quote;
    this.sendBtn.replaceChildren(this.icon(st ? "stop" : "arrowUp"));
    this.sendBtn.classList.toggle("zac-stopping", !!st);
    this.sendBtn.classList.toggle("zac-empty-input", !st && empty);
    this.sendBtn.dataset.tip = st ? "停止" : "发送（Enter）";
  }

  updateStatus() {
    const st = this.s.state;
    this.updateSendState();
    this.chipsEl.style.display = this.s.quote && !st ? "flex" : "none";
    // 正在运行的回复里显示耗时
    for (const el of this.msgsEl.querySelectorAll(".zac-elapsed")) {
      el.textContent = st ? ` · ${Math.round((Date.now() - st.start) / 1000)}s` : "";
    }
    // 最后一条回复常显操作按钮；重新生成只在空闲时可用
    const last = this.s.messages[this.s.messages.length - 1];
    for (const [id, el] of this.msgEls) el.classList.toggle("zac-last", !!last && last.id === id && last.role === "assistant");
    for (const b of this.msgsEl.querySelectorAll(".zac-regen")) b.disabled = !!st;
  }

  scrollToBottom(force) {
    const m = this.msgsEl;
    if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 120) m.scrollTop = m.scrollHeight;
  }

  renderAll() {
    this.msgsEl.replaceChildren();
    this.msgEls.clear();
    if (!this.s.messages.length) {
      this.msgsEl.append(this.emptyEl);
      return;
    }
    for (const m of this.s.messages) {
      const el = this.renderMessage(m);
      this.msgEls.set(m.id, el);
      this.msgsEl.append(el);
    }
    this.updateStatus();
    this.scrollToBottom(true);
  }

  appendMessage(m) {
    if (this.emptyEl.parentNode) this.emptyEl.remove();
    const el = this.renderMessage(m);
    this.msgEls.set(m.id, el);
    this.msgsEl.append(el);
    this.updateStatus();
    this.scrollToBottom(true);
  }

  updateMessage(m) {
    const old = this.msgEls.get(m.id);
    if (!old) return this.appendMessage(m);
    const el = this.renderMessage(m);
    old.replaceWith(el);
    this.msgEls.set(m.id, el);
    this.updateStatus();
    this.scrollToBottom();
  }

  renderMessage(m) {
    if (m.role === "user") {
      const b = this.el("div", { class: "zac-msg zac-user" });
      if (m.quote) {
        const q = this.el("div", { class: "zac-q" });
        if (m.restored) {
          const md = this.el("div", { class: "zac-md zac-restored" });
          this.renderMarkdown(md, m.restored);
          q.append(this.el("div", { class: "zac-q-tag" }, this.icon("quote"), "原文（AI 对照截图还原）"), md);
        } else {
          q.append(this.el("div", { class: "zac-q-text", title: zacClip(m.quote, 2000) }, this.icon("quote"), this.el("span", { text: zacClip(m.quote, 300) })));
        }
        if (m.sel && m.sel.image) q.append(this.el("img", { class: "zac-snip", src: m.sel.image.dataURL, alt: "选区截图" }));
        if (m.sel && m.sel.itemID && m.sel.position) {
          q.append(
            this.el(
              "button",
              { class: "zac-jump", title: "在阅读器中打开并定位到这段原文", onclick: () => this.s.jumpTo(m.sel) },
              this.icon("link"),
              `跳到原文 · 第 ${m.sel.pageLabel || m.sel.position.pageIndex + 1} 页`
            )
          );
        }
        b.append(q);
      }
      b.append(this.el("div", { class: "zac-q-question", text: m.question }));
      return b;
    }

    const wrap = this.el(
      "div",
      { class: "zac-msg zac-assistant" },
      this.el("div", { class: "zac-msg-head" }, this.el("span", { class: "zac-avatar" }, this.icon("sparkles")), this.el("span", { text: m.label || "" }))
    );
    const actions = this.el("div", { class: "zac-actions" });
    const regen = this.el(
      "button",
      { class: "zac-act zac-regen", title: "用当前选择的模型重新生成", onclick: () => this.s.regenerate() },
      this.icon("retry"),
      "重新生成"
    );

    if (m.status === "pending") {
      wrap.append(
        this.el(
          "div",
          { class: "zac-pending" },
          this.el("span", { class: "zac-dots" }, this.el("span"), this.el("span"), this.el("span")),
          this.el("span", {}, "思考中", this.el("span", { class: "zac-elapsed" }))
        )
      );
      return wrap;
    }
    if (m.status === "stream") {
      wrap.append(this.el("div", { class: "zac-stream", text: m.text }));
      return wrap;
    }
    if (m.status === "error") {
      const box = this.el(
        "div",
        { class: "zac-err" },
        this.el("div", { class: "zac-err-title" }, this.icon("alert"), m.text || "出错了"),
        m.hint ? this.el("div", { class: "zac-err-hint", text: m.hint }) : null,
        m.detail ? this.el("details", {}, this.el("summary", { text: "详细信息" }), this.el("pre", { text: m.detail })) : null
      );
      const diag = this.el(
        "button",
        { class: "zac-act", title: "打开设置并运行诊断", onclick: () => this.openDiagnose() },
        this.icon("pulse"),
        "诊断连接"
      );
      actions.append(regen, diag);
      if (/找不到命令|在 PATH 中找不到|没有找到 (Claude Code|Codex)/.test((m.detail || "") + (m.hint || "")) && this.p.installSpec(m.agent)) {
        actions.append(
          this.el(
            "button",
            {
              class: "zac-act",
              title: "用官方安装脚本安装",
              onclick: () => {
                this.showSettings(true);
                this.confirmInstall(m.agent, this.settingsPage.querySelector(".zac-out"), true);
              },
            },
            this.icon("download"),
            "一键安装"
          )
        );
      }
      wrap.append(box, actions);
      return wrap;
    }

    const body = this.el("div", { class: "zac-md" });
    this.renderMarkdown(body, m.text);
    const copyBtn = this.el(
      "button",
      {
        class: "zac-act",
        title: "复制回复",
        onclick: () => {
          Zotero.Utilities.Internal.copyTextToClipboard(m.text);
          copyBtn.replaceChildren(this.icon("check"), "已复制");
        },
      },
      this.icon("copy"),
      "复制"
    );
    const noteBtn = this.el(
      "button",
      {
        class: "zac-act",
        title: "保存为这篇论文的子笔记",
        onclick: async () => {
          noteBtn.disabled = true;
          try {
            await this.s.saveNote(m.turn, {
              answerHtml: this.markdownToNoteHtml(m.text),
              restoredHtml: m.turn && m.turn.restored ? this.markdownToNoteHtml(m.turn.restored) : null,
            });
            noteBtn.replaceChildren(this.icon("check"), "已存为笔记");
          } catch (e) {
            Zotero.logError(e);
            noteBtn.replaceChildren(this.icon("alert"), "保存失败");
            noteBtn.disabled = false;
          }
        },
      },
      this.icon("note"),
      "存为笔记"
    );
    actions.append(copyBtn, noteBtn, regen);
    wrap.append(body, actions);
    return wrap;
  }

  openDiagnose() {
    this.showSettings(true);
    const btn = [...this.settingsPage.querySelectorAll(".zac-btn")].find((b) => b.textContent.includes("诊断"));
    const out = this.settingsPage.querySelector(".zac-out");
    if (btn && out) this.runDiagnose(out, btn);
  }

  /* ---------- Markdown（常用子集） ---------- */

  renderMarkdown(box, text) {
    box.replaceChildren();
    // 先把独立公式 $$...$$ / \[...\] 换成占位行（代码块里的不动），逐行解析时再渲染
    const maths = [];
    const src = String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/(```[\s\S]*?(?:```|$))/)
      .map((seg, i) =>
        i % 2
          ? seg
          : seg.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => {
              maths.push((a ?? b).trim());
              return `\n\u0000M${maths.length - 1}\u0000\n`;
            })
      )
      .join("");
    const lines = src.split("\n");
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = this.el("p");
      this.renderInline(p, para.join("\n"));
      box.append(p);
      para = [];
    };
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const mm = /^\s*\u0000M(\d+)\u0000\s*$/.exec(line);
      if (mm) {
        flush();
        box.append(this.el("div", { class: "zac-math-display" }, this.renderMath(maths[+mm[1]], true)));
        continue;
      }
      const fence = /^\s*```\s*([\w+-]*)/.exec(line);
      if (fence) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        const code = buf.join("\n");
        const copy = this.el(
          "button",
          {
            class: "zac-act",
            title: "复制代码",
            onclick: () => {
              Zotero.Utilities.Internal.copyTextToClipboard(code);
              copy.replaceChildren(this.icon("check"), "已复制");
            },
          },
          this.icon("copy"),
          "复制"
        );
        box.append(
          this.el(
            "div",
            { class: "zac-codeblock" },
            this.el("div", { class: "zac-codebar" }, this.el("span", { text: fence[1] || "code" }), copy),
            this.el("pre", { class: "zac-code" }, this.el("code", { text: code }))
          )
        );
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cells(line);
        const table = this.el("table", { class: "zac-table" });
        const tr = this.el("tr");
        for (const c of head) {
          const th = this.el("th");
          this.renderInline(th, c);
          tr.append(th);
        }
        table.append(this.el("thead", {}, tr));
        const tbody = this.el("tbody");
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const row = this.el("tr");
          for (const c of cells(lines[i])) {
            const td = this.el("td");
            this.renderInline(td, c);
            row.append(td);
          }
          tbody.append(row);
          i++;
        }
        i--;
        table.append(tbody);
        box.append(this.el("div", { class: "zac-table-wrap" }, table));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const e = this.el("div", { class: "zac-h" + (h[1].length <= 2 ? " zac-h1" : "") });
        this.renderInline(e, h[2]);
        box.append(e);
        continue;
      }
      if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        flush();
        box.append(this.el("hr"));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        i--;
        const q = this.el("blockquote");
        this.renderInline(q, buf.join("\n"));
        box.append(q);
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flush();
        const indent = Math.min(Math.floor(li[1].replace(/\t/g, "  ").length / 2), 4);
        const e = this.el(
          "div",
          { class: "zac-li", style: indent ? `margin-left:${indent * 14}px` : null },
          this.el("span", { class: "zac-li-mark", text: /\d/.test(li[2]) ? li[2] : "•" })
        );
        if (/\d/.test(li[2])) e.style.paddingLeft = "20px";
        this.renderInline(e, li[3]);
        box.append(e);
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      para.push(line);
    }
    flush();
  }

  renderInline(parent, text) {
    const re = new RegExp("(`[^`\\n]+`)|" + ZAC_INLINE_MATH.source + "|\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\s][^*\\n]*)\\*", "g");
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) parent.append(this.el("code", { class: "zac-inline-code", text: m[1].slice(1, -1) }));
      else if (m[2] != null || m[3] != null) parent.append(this.renderMath((m[2] ?? m[3]).trim(), false));
      else if (m[4] != null) {
        const st = this.el("strong");
        this.renderInline(st, m[4]);
        parent.append(st);
      } else {
        const em = this.el("em");
        this.renderInline(em, m[5]);
        parent.append(em);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  // 存为笔记：复用界面的 Markdown 解析结果，转成 Zotero 笔记编辑器支持的 HTML
  // （标题、段落、粗体/斜体/行内代码、有序/无序列表、引用、代码块、表格、公式）
  markdownToNoteHtml(text) {
    const esc = (x) => Zotero.Utilities.htmlSpecialChars(String(x == null ? "" : x));
    const box = this.el("div");
    this.renderMarkdown(box, text);
    const inline = (node) => {
      let h = "";
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          h += esc(n.nodeValue).replace(/\n/g, "<br/>");
          continue;
        }
        if (n.nodeType !== 1) continue;
        const cl = n.classList;
        if (cl && cl.contains("zac-math")) h += `<span class="math">$${esc(n.getAttribute("data-tex"))}$</span>`;
        else if (cl && cl.contains("zac-li-mark")) continue;
        else if (n.localName === "strong") h += `<strong>${inline(n)}</strong>`;
        else if (n.localName === "em") h += `<em>${inline(n)}</em>`;
        else if (n.localName === "code") h += `<code>${esc(n.textContent)}</code>`;
        else h += inline(n);
      }
      return h;
    };
    const out = [];
    let list = null; // { tag, items }
    const closeList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    for (const n of box.children) {
      const cl = n.classList;
      if (cl.contains("zac-li")) {
        const mark = n.querySelector(".zac-li-mark");
        const tag = mark && /\d/.test(mark.textContent) ? "ol" : "ul";
        if (!list || list.tag !== tag) {
          closeList();
          list = { tag, items: [] };
        }
        list.items.push(inline(n));
        continue;
      }
      closeList();
      if (n.localName === "p") out.push(`<p>${inline(n)}</p>`);
      else if (cl.contains("zac-math-display")) {
        const m = n.querySelector(".zac-math");
        out.push(m && m.hasAttribute("data-tex") ? `<pre class="math">$$${esc(m.getAttribute("data-tex"))}$$</pre>` : `<p>${inline(n)}</p>`);
      } else if (cl.contains("zac-h")) out.push(`<h3>${inline(n)}</h3>`);
      else if (n.localName === "blockquote") out.push(`<blockquote><p>${inline(n)}</p></blockquote>`);
      else if (n.localName === "hr") out.push("<hr/>");
      else if (cl.contains("zac-codeblock")) out.push(`<pre>${esc((n.querySelector("code") || n).textContent)}</pre>`);
      else if (cl.contains("zac-table-wrap")) {
        const rows = [...n.querySelectorAll("tr")].map(
          (tr) => `<tr>${[...tr.children].map((c) => `<${c.localName}>${inline(c)}</${c.localName}>`).join("")}</tr>`
        );
        out.push(`<table>${rows.join("")}</table>`);
      } else out.push(`<p>${inline(n)}</p>`);
    }
    closeList();
    return out.join("");
  }

  // LaTeX → MathML（KaTeX 只做转换，排版交给 Zotero 自带的 MathML 引擎）；失败时原样显示
  renderMath(tex, display) {
    const k = this.p.getKatex();
    if (k) {
      try {
        const html = k.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: false, strict: "ignore", trust: false });
        const parsed = new this.win.DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
        const span = this.el("span", { class: display ? "zac-math zac-math-block" : "zac-math", "data-tex": tex });
        for (const n of [...parsed.body.childNodes]) span.append(this.doc.importNode(n, true));
        return span;
      } catch (e) {
        this.p.log("katex: " + e);
      }
    }
    return this.el("code", { class: "zac-inline-code", text: display ? `$$${tex}$$` : `$${tex}$` });
  }
}
