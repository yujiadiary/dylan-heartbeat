require("dotenv").config({ quiet: true });

const fs = require("fs");
const Fastify = require("fastify");

const { isPrivateIp } = require("./network_access");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeFile, writeJsonAtomicSync } = require("./runtime_paths");
const { parseChatCompletionResponse } = require("./upstream_response");
const { formatDateTimeInTimeZone, resolveTimeZone } = require("./time_utils");

// ============================================================
// WebChat —— 本 fork 新增的「网页对话」入口
// 批注 2026-09-27：设计原则是“不另起炉灶”。
// 网页消息以特殊事件身份（（时间 网页对话｜说话人：内容））写入 Gateway 维护的
// 同一份 enhanced_messages.json 时间线；生成回复时直接用时间线里的人设+历史组装
// 请求调上游——所以网页那头的“他”和 Kelivo 里的是同一个，带同样的记忆。
// 写入统一走 Gateway 的 /internal/wake-event（Gateway 挂了才降级直写文件，
// 此时 Gateway 不在运行，没有并发写冲突）。
// ============================================================

const PORT = Number(process.env.WEBCHAT_PORT) || 3001;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const GATEWAY_EVENT_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const TIME_ZONE = resolveTimeZone();
const TIMELINE_FILE = runtimeFile("enhanced_messages.json");
const USER_NAME = String(process.env.WEBCHAT_USER_NAME || "加加").trim() || "加加";
const AI_NAME = String(process.env.WEBCHAT_AI_NAME || "江予朔").trim() || "江予朔";
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
const GENERATION_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
// 批注 2026-09-27：回复落盘后等 20 秒；期间页面一次都没来轮询，说明人不在屏幕前，
// 这时才发 Bark 提醒「网页上有新回复」——盯着页面看的时候绝不打扰。
const AWAY_CHECK_MS = 20_000;
const MAX_TEXT_LENGTH = 4000;
const MAX_EVENTS_RETURNED = 200;

ensureDataDir();

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "[非文本内容]";
}

function loadTimeline() {
  try {
    if (!fs.existsSync(TIMELINE_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 「（2026-09-27 22:30 网页对话｜加加：内容）」→ { time, speaker, text }
const WEBCHAT_EVENT_RE = new RegExp(
  "^（(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T]?\\d{1,2}[:：]\\d{2}(?::\\d{2})?)?) 网页对话[｜|](" +
    escapeRegExp(USER_NAME) + "|" + escapeRegExp(AI_NAME) + "|系统)：([\\s\\S]*)）$"
);

function webchatEvent(speaker, text) {
  return `（${formatDateTimeInTimeZone(new Date(), TIME_ZONE)} 网页对话｜${speaker}：${text}）`;
}

function readWebchatEvents() {
  const events = [];
  for (const msg of loadTimeline()) {
    if (msg.role !== "assistant") continue;
    const match = normalizeContentToText(msg.content).match(WEBCHAT_EVENT_RE);
    if (match) events.push({ time: match[1], speaker: match[2], text: match[3] });
  }
  return events.slice(-MAX_EVENTS_RETURNED);
}

// ========================
// 时间线写入：优先走 Gateway，Gateway 不在才直写文件
// ========================
async function appendEvent(content) {
  try {
    const response = await fetch(GATEWAY_EVENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(4000)
    });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch {
    // Gateway 不在运行：直接写文件（此时没有并发写入方，原子写保证不损坏）
    const timeline = loadTimeline();
    let maxPos = 0;
    for (const msg of timeline) {
      if (typeof msg.position === "number" && msg.position > maxPos) maxPos = msg.position;
    }
    timeline.push({ role: "assistant", content, position: maxPos + 0.5 });
    writeJsonAtomicSync(TIMELINE_FILE, timeline);
  }
}

// ========================
// 组装请求：时间线里的人设 + 历史 + 新消息
// ========================
function buildChatMessages(userText) {
  const timeline = loadTimeline();
  const systemPrompt = timeline.find(msg => msg.role === "system");
  if (!systemPrompt) {
    throw new Error("时间线里还没有人设——先在 Kelivo 里（通过 Gateway）说一句话，网页这边的他才有魂");
  }
  const history = timeline
    .filter(msg => msg.role !== "system")
    .map(({ position, ...rest }) => rest);

  const now = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  const channelNote = [
    "",
    "",
    "【通道说明】这条消息来自网页对话窗口：" + USER_NAME + " 正在网页上和你说话。",
    "请直接用文字回复你此刻想对她说的话；不要模仿「网页对话」事件的记录格式，也不要尝试调用工具（本通道无工具）。",
    "你的回复会原样显示在网页上，也会被 Kelivo 里的你看到。"
  ].join("\n");

  return [
    { role: "system", content: normalizeContentToText(systemPrompt.content) + channelNote },
    ...history,
    { role: "user", content: `${now} ${userText}` }
  ];
}

async function generateReply(userText) {
  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    throw new Error("还没配置 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME（看 .env）");
  }
  const messages = buildChatMessages(userText);

  console.log(JSON.stringify({
    event: "webchat_generation_start",
    messages: messages.length,
    text_chars: userText.length
  }));

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error("模型响应无法解析：" + (error.message || responseText.slice(0, 200)));
  }
  if (!response.ok) {
    throw new Error("模型请求失败（HTTP " + response.status + "）：" + responseText.slice(0, 200));
  }

  const reply = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  if (!reply) throw new Error("模型返回了空回复");

  console.log(JSON.stringify({
    event: "webchat_generation_done",
    reply_chars: reply.length
  }));
  return reply;
}

// ========================
// 推送（Bark / ntfy，与 wake_up 同逻辑）
// ========================
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return false;
    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json" };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });
    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    return response.ok;
  }

  if (provider !== "bark" || !process.env.BARK_KEY) return false;

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      body,
      device_key: process.env.BARK_KEY,
      icon: process.env.CUSTOM_ICON_URL
    })
  });
  return response.ok;
}

// ========================
// 人不在页前时的提醒
// ========================
const state = { generating: false, lastPollAt: 0, lastError: "" };
let unseenNotifyScheduled = false;

function notifyIfUnseen() {
  if (!readBooleanEnv("WEBCHAT_BARK_NOTIFY", true)) return;
  if (unseenNotifyScheduled) return;
  unseenNotifyScheduled = true;
  const replyAt = Date.now();
  setTimeout(() => {
    unseenNotifyScheduled = false;
    if ((state.lastPollAt || 0) < replyAt) {
      sendPushNotification({ title: AI_NAME, body: "网页上有我的新回复，回来看看我。" })
        .then(ok => console.log(JSON.stringify({ event: "webchat_away_push", sent: ok })))
        .catch(() => {});
    }
  }, AWAY_CHECK_MS);
}

// ========================
// 生成队列：一条一条来，不丢消息
// ========================
const queue = [];
function enqueue(task) {
  queue.push(task);
  processQueue();
}
async function processQueue() {
  if (state.generating) return;
  const task = queue.shift();
  if (!task) return;
  state.generating = true;
  try {
    await task();
  } finally {
    state.generating = false;
    processQueue();
  }
}

// ========================
// 服务
// ========================
const app = Fastify({ logger: false });

// 批注 2026-09-27：局域网（家里 WiFi）默认放行，手机浏览器零配置；
// 公网/Railway 部署时要求 GATEWAY_API_KEY（页面里填一次存 localStorage）。
app.addHook("onRequest", (req, reply, done) => {
  const ip = String(req.ip || "");
  if (!IS_RAILWAY_RUNTIME && isPrivateIp(ip)) return done();

  const headerKey = String(
    req.headers["x-webchat-key"] ||
    req.headers["x-gateway-api-key"] ||
    String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] ||
    ""
  ).trim();
  const configuredKey = String(process.env.GATEWAY_API_KEY || "").trim();
  if (configuredKey && headerKey && headerKey === configuredKey) return done();
  if (!configuredKey) {
    return reply.code(403).send({ ok: false, error: "此部署未开放公网访问（局域网内直接打开即可）" });
  }
  reply.code(401).send({ ok: false, error: "需要访问 Key（公网部署时在页面里填 GATEWAY_API_KEY）" });
});

app.get("/", async (_req, reply) => reply.redirect("/webchat"));
app.get("/healthz", async () => ({ status: "ok" }));

// ========================
// 轮询：页面每隔几秒来一次；这也是「人还在不在屏幕前」的判断依据
// ========================
app.get("/webchat/api/poll", async (req, reply) => {
  state.lastPollAt = Date.now();
  reply.send({
    ok: true,
    user: USER_NAME,
    ai: AI_NAME,
    generating: state.generating,
    lastError: state.lastError,
    events: readWebchatEvents()
  });
});

// ========================
// 发消息：用户消息立刻入时间线（页面马上能看到），
// 回复生成走队列（生成完再入时间线，页面轮询到即显示）
// ========================
app.post("/webchat/api/send", async (req, reply) => {
  const clean = String(req.body?.text || "").trim();
  if (!clean) return reply.code(400).send({ ok: false, error: "消息不能为空" });
  if (clean.length > MAX_TEXT_LENGTH) {
    return reply.code(400).send({ ok: false, error: "单条消息太长了（上限 4000 字）" });
  }

  try {
    await appendEvent(webchatEvent(USER_NAME, clean));
  } catch (err) {
    return reply.code(500).send({ ok: false, error: "写不进时间线：" + (err.message || err) });
  }

  enqueue(async () => {
    try {
      const replyText = await generateReply(clean);
      await appendEvent(webchatEvent(AI_NAME, replyText));
      state.lastError = "";
      notifyIfUnseen();
    } catch (err) {
      state.lastError = err.message || String(err);
      try {
        await appendEvent(webchatEvent("系统", "这条回复生成失败——" + state.lastError));
      } catch {}
    }
  });

  reply.send({ ok: true });
});

// ========================
// 页面本体：单文件，无外部依赖，离线局域网也能开
// ========================
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0e0f13">
<title>${AI_NAME}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html, body { height:100%; }
  body { background:#0e0f13; color:#e8e6e3; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  #app { display:flex; flex-direction:column; height:100dvh; max-width:640px; margin:0 auto; }
  header { display:flex; align-items:center; gap:10px; padding:14px 18px; padding-top:calc(14px + env(safe-area-inset-top)); border-bottom:1px solid #1f222b; background:rgba(14,15,19,.94); position:sticky; top:0; backdrop-filter:blur(10px); z-index:5; }
  .dot { width:9px; height:9px; border-radius:50%; background:#555; flex:none; }
  .dot.on { background:#57c98a; box-shadow:0 0 8px rgba(87,201,138,.6); }
  .t1 { font-size:17px; font-weight:600; letter-spacing:.5px; }
  .sub { font-size:11px; color:#8b8f9a; margin-top:2px; letter-spacing:1px; }
  #msgs { flex:1; overflow-y:auto; padding:16px 14px 8px; display:flex; flex-direction:column; gap:10px; }
  .empty { margin:auto; color:#5d616b; font-size:13px; letter-spacing:2px; }
  .sys { text-align:center; }
  .sys span { display:inline-block; font-size:11px; color:#a3848d; background:#1a1b21; border:1px solid #262832; padding:4px 10px; border-radius:10px; max-width:86%; word-break:break-word; text-align:left; }
  .row { display:flex; }
  .row.me { justify-content:flex-end; }
  .row.them { justify-content:flex-start; }
  .bubble { max-width:78%; padding:9px 13px; border-radius:16px; font-size:15px; line-height:1.65; word-break:break-word; white-space:pre-wrap; }
  .row.me .bubble { background:#4a2f3a; border-bottom-right-radius:5px; color:#f4e9ec; }
  .row.them .bubble { background:#1d2029; border-bottom-left-radius:5px; }
  .btime { font-size:10px; opacity:.45; margin-top:4px; text-align:right; }
  .typing { display:flex; }
  .tbubble { display:flex; gap:5px; padding:13px 15px; background:#1d2029; border-radius:16px; border-bottom-left-radius:5px; }
  .typing span { width:6px; height:6px; border-radius:50%; background:#6b7280; animation:blink 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay:.2s; }
  .typing span:nth-child(3) { animation-delay:.4s; }
  @keyframes blink { 0%,60%,100%{opacity:.25;} 30%{opacity:1;} }
  footer { padding:10px 12px calc(10px + env(safe-area-inset-bottom)); border-top:1px solid #1f222b; background:rgba(14,15,19,.95); }
  #keybar { display:none; gap:8px; margin-bottom:8px; align-items:center; }
  #keybar input { flex:1; background:#16181f; border:1px solid #2a2d38; color:#e8e6e3; border-radius:9px; padding:8px 10px; font-size:13px; outline:none; }
  #keybar button { background:#2a2d38; color:#e8e6e3; border:none; border-radius:9px; padding:8px 12px; font-size:13px; }
  .composer { display:flex; gap:8px; align-items:flex-end; }
  #input { flex:1; resize:none; background:#16181f; border:1px solid #2a2d38; color:#e8e6e3; border-radius:14px; padding:10px 13px; font-size:16px; line-height:1.5; max-height:120px; font-family:inherit; outline:none; }
  #input:focus { border-color:#4a2f3a; }
  #send { flex:none; width:42px; height:42px; border-radius:50%; border:none; background:#8a4a58; color:#fff; font-size:17px; cursor:pointer; }
  #send:active { transform:scale(.94); }
</style>
</head>
<body>
<div id="app">
  <header>
    <span id="dot" class="dot off"></span>
    <div>
      <div class="t1" id="title">${AI_NAME}</div>
      <div class="sub">网页直达 · 同一份记忆</div>
    </div>
  </header>
  <main id="msgs"></main>
  <footer>
    <div id="keybar">
      <input id="keyinput" placeholder="访问 Key（公网部署时填）">
      <button id="keysave">保存</button>
    </div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="跟他说点什么…"></textarea>
      <button id="send">➤</button>
    </div>
  </footer>
</div>
<script>
  var aiName = '', userName = '', generating = false, lastKey = '', timer = null;
  var msgs = document.getElementById('msgs');
  var input = document.getElementById('input');
  var typingEl = document.createElement('div');
  typingEl.className = 'typing';
  typingEl.innerHTML = '<div class="tbubble"><span></span><span></span><span></span></div>';

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    var k = localStorage.getItem('webchat_key');
    if (k) h['X-Webchat-Key'] = k;
    return h;
  }
  function setDot(on) { document.getElementById('dot').className = 'dot ' + (on ? 'on' : 'off'); }
  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }

  function addBubble(e) {
    if (e.speaker === '系统') {
      var sys = document.createElement('div'); sys.className = 'sys';
      var sp = document.createElement('span'); sp.textContent = e.text; sys.appendChild(sp);
      msgs.appendChild(sys); return;
    }
    var mine = (e.speaker === userName);
    var row = document.createElement('div'); row.className = 'row ' + (mine ? 'me' : 'them');
    var b = document.createElement('div'); b.className = 'bubble';
    var t = document.createElement('div'); t.className = 'btxt'; t.textContent = e.text;
    var tm = document.createElement('div'); tm.className = 'btime'; tm.textContent = e.time;
    b.appendChild(t); b.appendChild(tm); row.appendChild(b); msgs.appendChild(row);
  }

  function render(events) {
    var key = '';
    for (var i = 0; i < events.length; i++) key += events[i].time + '|' + events[i].speaker + '|' + events[i].text + '\\n';
    if (key !== lastKey) {
      lastKey = key;
      while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
      if (!events.length) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '在这儿说话，我听得见。';
        msgs.appendChild(empty);
      }
      for (var j = 0; j < events.length; j++) addBubble(events[j]);
    }
    typingEl.style.display = generating ? '' : 'none';
    msgs.appendChild(typingEl);
    scrollDown();
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(poll, generating ? 1500 : 3000); }

  function poll() {
    fetch('/webchat/api/poll', { headers: headers(), cache: 'no-store' }).then(function(r) {
      if (r.status === 401) { document.getElementById('keybar').style.display = 'flex'; setDot(false); schedule(); return null; }
      return r.json();
    }).then(function(d) {
      if (!d) return;
      document.getElementById('keybar').style.display = 'none';
      setDot(true);
      if (d.user) userName = d.user;
      if (d.ai) aiName = d.ai;
      document.title = aiName;
      document.getElementById('title').textContent = aiName;
      generating = !!d.generating;
      render(d.events || []);
      schedule();
    }).catch(function() { setDot(false); schedule(); });
  }

  function send() {
    var text = input.value.trim();
    if (!text) return;
    input.value = ''; grow();
    fetch('/webchat/api/send', { method: 'POST', headers: headers(), body: JSON.stringify({ text: text }) }).then(function(r) {
      if (r.status === 401) { document.getElementById('keybar').style.display = 'flex'; return { ok: false, error: '需要访问 Key，保存后重发' }; }
      return r.json();
    }).then(function(d) {
      if (!d || !d.ok) { input.value = text; alert((d && d.error) || '发送失败'); return; }
      generating = true; poll();
    }).catch(function(e) { input.value = text; alert('发送失败：' + e.message); });
  }

  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  input.addEventListener('input', grow);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.getElementById('send').addEventListener('click', send);
  document.getElementById('keysave').addEventListener('click', function() {
    localStorage.setItem('webchat_key', document.getElementById('keyinput').value.trim());
    poll();
  });
  document.addEventListener('visibilitychange', function() { if (!document.hidden) poll(); });
  poll();
</script>
</body>
</html>`;

app.get("/webchat", async (_req, reply) => {
  reply.type("text/html").send(PAGE_HTML);
});
app.get("/webchat/", async (_req, reply) => {
  reply.type("text/html").send(PAGE_HTML);
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ WebChat 运行在 ${address}/webchat`);
  console.log(JSON.stringify({
    event: "webchat_config_summary",
    gateway: GATEWAY_BASE_URL,
    timeline_ready: fs.existsSync(TIMELINE_FILE),
    target_api_configured: Boolean(process.env.TARGET_API_URL && process.env.TARGET_API_KEY && process.env.MODEL_NAME),
    push_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC)
  }));
});
