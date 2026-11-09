// Public web interface for agent-wechat on Render (no Shell needed).
//
// Render's Web Service requires the app to listen on 0.0.0.0:$PORT.
// The agent-wechat daemon refuses to bind --listen to anything but
// loopback, so this tiny proxy sits in front of it and exposes ONLY
// these safe, scoped endpoints (the daemon's raw /v1 API, which needs
// the owner token, is deliberately NOT exposed):
//
//   GET  /health        -> daemon health (Render health check + UptimeRobot)
//   GET  /connectivity  -> test TCP/TLS to long/short.weixin.qq.com:443
//                          from inside the container (JSON)
//   GET  /login         -> HTML login page: shows the WeChat login QR
//                          (scannable from a phone camera) + live state
//   GET  /qr.png        -> current login attempt's QR code (PNG)
//   GET  /api/state     -> JSON: daemon/account/auth/current-attempt state
//   GET  /              -> operations page (chats, send test message, events)
//   GET  /api/chats     -> JSON list of chats (threads)
//   GET  /api/messages?thread=<id>&limit=<n> -> JSON messages in a chat
//   GET  /api/events?limit=<n>  -> JSON recent daemon events
//   POST /api/send      -> send a text message {threadId, text} (JSON body)
//   POST /api/send-image -> send an image {threadId, imageBase64,
//                          filename?, mimeType?} (JSON body, base64 JPEG/PNG,
//                          max 10 MB; uploads to the daemon then sends it)
//   GET  /api/media?messageId=<id>&quality=<best|original|standard|thumbnail>
//                          -> download an image a group member sent:
//                          JSON {ok, imageBase64, mimeType, quality}.
//                          Uses the daemon's media API: first tries the
//                          saved image (GET /v1/.../messages/{id}/image);
//                          if the copy is not saved yet, starts a media
//                          transfer, polls the job, then retries. Returns
//                          {ok:false, error} when the picture is expired
//                          or cannot be fetched. (v4)
//   anything else      -> 404
//
// Auth: the proxy reads the daemon's owner token from its data dir
// (default ~/.local/share/agent-wechat/api-token, or $AGENT_WECHAT_DATA_DIR)
// and adds it as a Bearer token when calling the daemon on loopback.
// The token is NEVER sent to the browser.
//
// Login flow (all through the daemon HTTP API, verified against v2.2.0):
//   POST /v1/accounts {"alias":"guangpu"}          -> 201 {id,...}
//   POST /v1/accounts/{id}/auth/login {}           -> 202 {id,state:"starting"}
//   GET  /v1/accounts/{id}/login-attempts/{opId}   -> {id,kind:"login",state,result}
//   GET  /v1/accounts/{id}/login-attempts/{opId}/qr -> PNG bytes (or 404
//        {"error":{"code":"login_challenge_unavailable"}} when no QR yet)
//   POST /v1/accounts/{id}/sends  (Idempotency-Key header,
//        body {"threadId","kind":"text","text"})    -> send a text message
//   GET  /v1/accounts/{id}/threads                -> {"items":[...]}
//   GET  /v1/accounts/{id}/threads/{t}/messages   -> {"items":[...]}
//   GET  /v1/accounts/{id}/events                 -> {"items":[...],"nextCursor"}
//
// Notes / limits (same as before):
// - Render free tier has no persistent disk: a container restart loses
//   the agent-wechat login session, so the user must re-scan the QR.
// - Logging in here kicks any other session of the same WeChat account
//   (the old VM's wxbridge login will be disconnected — its message
//   sync was already dead, so nothing is lost).
// - agent-wechat is a reverse-engineered protocol client; use ONLY the
//   spare account (光谱）, never the main account.

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '10000', 10);
const DAEMON_HOST = process.env.DAEMON_HOST || '127.0.0.1';
const DAEMON_PORT = parseInt(process.env.DAEMON_PORT || '6174', 10);
const ACCOUNT_ALIAS = process.env.ACCOUNT_ALIAS || 'guangpu';
// Where the daemon keeps its data (api-token + accounts). The daemon in
// start.sh uses the default; override with AGENT_WECHAT_DATA_DIR if set.
const DATA_DIR = process.env.AGENT_WECHAT_DATA_DIR
  || path.join(os.homedir(), '.local', 'share', 'agent-wechat');
const ATTEMPT_FILE = path.join(os.tmpdir(), 'wx-login-attempt.json');

// ---------------------------------------------------------------- token
let cachedToken = null;
let cachedTokenMtime = 0;
function readToken() {
  try {
    const p = path.join(DATA_DIR, 'api-token');
    const st = fs.statSync(p);
    if (cachedToken && st.mtimeMs === cachedTokenMtime) return cachedToken;
    cachedToken = fs.readFileSync(p, 'utf8').trim();
    cachedTokenMtime = st.mtimeMs;
    return cachedToken;
  } catch {
    cachedToken = null;
    return null;
  }
}

// ------------------------------------------------------- daemon client
function daemonCall(method, reqPath, body, extraHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) { resolve({ status: 0, body: null, error: 'no-daemon-token' }); return; }
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(extraHeaders || {}) };
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, path: reqPath, method, headers, timeout: timeoutMs || 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: null, error: String(e && e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}
async function daemonJson(method, reqPath, body, extraHeaders) {
  const r = await daemonCall(method, reqPath, body, extraHeaders);
  if (r.status === 0) return { ok: false, status: 0, error: r.error };
  let data = null;
  try { data = JSON.parse(r.body.toString('utf8')); } catch { data = null; }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, data, raw: r.body };
}
// Raw-body daemon call (for multipart uploads). bodyBuf is a Buffer,
// contentType is e.g. 'multipart/form-data; boundary=...'.
function daemonRaw(method, reqPath, bodyBuf, contentType, extraHeaders) {
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) { resolve({ status: 0, body: null, error: 'no-daemon-token' }); return; }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': bodyBuf.length, ...(extraHeaders || {}) };
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, path: reqPath, method, headers, timeout: 60000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: null, error: String(e && e.message || e) }));
    req.write(bodyBuf);
    req.end();
  });
}
// Upload an image buffer to the daemon, returns {id, sha256, ...} or null.
async function daemonUploadImage(accountId, imgBuf, filename, mimeType) {
  const boundary = '----wximg' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const bodyBuf = Buffer.concat([head, imgBuf, tail]);
  const r = await daemonRaw('POST', `/v1/accounts/${accountId}/uploads`, bodyBuf, `multipart/form-data; boundary=${boundary}`);
  if (r.status === 0) return { ok: false, error: r.error };
  let data = null;
  try { data = JSON.parse(r.body.toString('utf8')); } catch { data = null; }
  if (r.status >= 200 && r.status < 300 && data && data.id) return { ok: true, data };
  return { ok: false, status: r.status, error: (data && data.error) || 'upload-failed', data };
}
async function daemonHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, path: '/health', method: 'GET', timeout: 5000 },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ------------------------------------------------- incoming media (v4)
// The daemon's media API (verified against the v2.2.0 binary + source):
//   GET  /v1/accounts/{a}/messages/{id}/image?quality=best|original|standard|thumbnail
//        -> raw image bytes (content-type image/*) when a copy is saved;
//           409 image_quality_unavailable when the copy is not saved yet.
//   POST /v1/accounts/{a}/messages/{id}/media-transfers
//        body {message_id (must match the URL id), quality: "best"}
//        -> 202 {id, state, ...} (a MediaJob). Poll GET /v1/.../jobs/{id}
//           until state is "completed" (then retry the image endpoint) or
//           "failed"/"cancelled".
//   GET  /v1/accounts/{a}/messages/{id}/media -> {"items":[MediaAsset,...]}
//        (lists the attachments of a message and whether each is available).
// The daemon auto-downloads images on receipt (up to a per-account limit),
// so the fast path (direct image fetch) usually works and no transfer is
// needed. The transfer path covers pictures that arrived before the bot
// was watching or that were not auto-downloaded.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function daemonGetMessageImage(accountId, messageId, quality) {
  const q = encodeURIComponent(quality || 'best');
  const r = await daemonCall('GET', `/v1/accounts/${accountId}/messages/${encodeURIComponent(messageId)}/image?quality=${q}`, undefined, undefined, 60000);
  if (r.status === 200 && r.body && r.body.length > 100) {
    const mimeType = (r.headers && r.headers['content-type']) || 'image/jpeg';
    const servedQuality = (r.headers && r.headers['x-wechat-image-quality']) || quality || 'best';
    return { ok: true, buf: r.body, mimeType: String(mimeType).split(';')[0].trim(), quality: servedQuality };
  }
  let code = 'image-unavailable';
  try { const j = JSON.parse(r.body.toString('utf8')); if (j.error && j.error.code) code = j.error.code; } catch { /* ignore */ }
  return { ok: false, status: r.status || 0, error: code };
}
async function daemonStartMediaTransfer(accountId, messageId, quality) {
  const r = await daemonJson('POST', `/v1/accounts/${accountId}/messages/${encodeURIComponent(messageId)}/media-transfers`, { message_id: messageId, quality: quality || 'best' });
  if (r.ok && r.data && r.data.id) return { ok: true, jobId: r.data.id };
  return { ok: false, status: r.status, error: (r.data && r.data.error && r.data.error.code) || r.error || 'transfer-failed' };
}
async function daemonPollJob(accountId, jobId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  while (Date.now() < deadline) {
    const r = await daemonJson('GET', `/v1/accounts/${accountId}/jobs/${encodeURIComponent(jobId)}`);
    if (r.ok && r.data) {
      const state = String(r.data.state || '');
      if (state === 'completed') return { ok: true, job: r.data };
      if (state === 'failed' || state === 'cancelled') return { ok: false, error: (r.data.reason || state) };
    }
    await sleep(2000);
  }
  return { ok: false, error: 'job-timeout' };
}
// Download one image message. Returns {ok, buf, mimeType, quality} or
// {ok:false, error}. Tries the saved copy first, then a transfer+poll.
async function fetchMessageImage(accountId, messageId, quality) {
  const q = quality || 'best';
  const first = await daemonGetMessageImage(accountId, messageId, q);
  if (first.ok) return first;
  // Not saved yet (or another transient failure): start a download.
  const t = await daemonStartMediaTransfer(accountId, messageId, q);
  if (!t.ok) return { ok: false, error: t.error || 'transfer-failed', status: t.status };
  const done = await daemonPollJob(accountId, t.jobId, 60000);
  if (!done.ok) return { ok: false, error: done.error || 'download-failed' };
  return daemonGetMessageImage(accountId, messageId, q);
}

// ------------------------------------------------------------- account
let cachedAccountId = null;
async function getOrCreateAccount() {
  if (cachedAccountId) return cachedAccountId;
  const list = await daemonJson('GET', '/v1/accounts');
  if (list.ok && Array.isArray(list.data && list.data.items)) {
    const found = list.data.items.find((a) => a.alias === ACCOUNT_ALIAS) || list.data.items[0];
    if (found) { cachedAccountId = found.id; return cachedAccountId; }
  }
  const created = await daemonJson('POST', '/v1/accounts', { alias: ACCOUNT_ALIAS });
  if (created.ok && created.data && created.data.id) {
    cachedAccountId = created.data.id;
    return cachedAccountId;
  }
  return null;
}

// -------------------------------------------------------- login attempt
function loadAttempt() {
  try { return JSON.parse(fs.readFileSync(ATTEMPT_FILE, 'utf8')); } catch { return null; }
}
function saveAttempt(a) {
  try { fs.writeFileSync(ATTEMPT_FILE, JSON.stringify(a)); } catch { /* ignore */ }
}
async function currentAttempt() {
  const saved = loadAttempt();
  if (!saved || !saved.id || !saved.accountId) return null;
  const r = await daemonJson('GET', `/v1/accounts/${saved.accountId}/login-attempts/${saved.id}`);
  if (!r.ok) return null;
  return { ...saved, state: r.data.state, result: r.data.result, updatedAt: r.data.updatedAt };
}
async function startLogin() {
  const accountId = await getOrCreateAccount();
  if (!accountId) return { ok: false, error: 'no-account' };
  // If a login is already in progress, reuse it instead of starting another.
  const existing = await currentAttempt();
  if (existing && (existing.state === 'starting' || existing.state === 'running' || existing.state === 'waiting' || existing.state === 'pending')) {
    return { ok: true, attempt: existing };
  }
  const r = await daemonJson('POST', `/v1/accounts/${accountId}/auth/login`, {});
  if (!r.ok) return { ok: false, error: (r.data && r.data.error && r.data.error.code) || `http-${r.status}` };
  const attempt = { id: r.data.id, accountId, state: r.data.state || 'starting' };
  saveAttempt(attempt);
  return { ok: true, attempt };
}
async function fetchQrPng() {
  const attempt = await currentAttempt();
  if (!attempt) return { ok: false, status: 404, error: 'no-login-attempt' };
  const r = await daemonCall('GET', `/v1/accounts/${attempt.accountId}/login-attempts/${attempt.id}/qr`);
  if (r.status === 200 && r.body && r.body.length > 100) {
    return { ok: true, png: r.body, attempt };
  }
  let code = 'qr-unavailable';
  try { const j = JSON.parse(r.body.toString('utf8')); if (j.error && j.error.code) code = j.error.code; } catch { /* ignore */ }
  return { ok: false, status: r.status || 404, error: code, attempt };
}

// ---------------------------------------------------------- connectivity
function tlsProbe(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      const detail = cert && cert.subject ? `TLS OK, cert CN=${cert.subject.CN || ''}` : 'TLS OK';
      socket.destroy();
      resolve({ host, reachable: true, detail });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ host, reachable: false, detail: 'timeout (8s)' }); });
    socket.on('error', (e) => resolve({ host, reachable: false, detail: String(e && e.message || e) }));
  });
}
async function connectivity() {
  const [long, short] = await Promise.all([tlsProbe('long.weixin.qq.com'), tlsProbe('short.weixin.qq.com')]);
  return { overall: long.reachable && short.reachable, long, short, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- helpers
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// ---------------------------------------------------------------- pages
const LOGIN_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>微信登录 - agent-wechat</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#222}
h1{font-size:22px} .card{border:1px solid #ddd;border-radius:12px;padding:20px;text-align:center}
#qr{width:280px;height:280px;object-fit:contain;border:1px solid #eee;border-radius:8px;background:#fff}
#state{font-size:18px;margin:12px 0} .hint{color:#666;font-size:14px;line-height:1.7;text-align:left}
button{padding:10px 18px;font-size:16px;border-radius:8px;border:1px solid #07c160;background:#07c160;color:#fff;cursor:pointer}
.warn{color:#b00;font-size:14px;line-height:1.6}
</style></head><body>
<h1>微信登录（小号 光谱）</h1>
<div class="card">
  <div id="state">正在准备登录…</div>
  <img id="qr" alt="登录二维码" style="display:none">
  <div id="qrmsg" style="color:#888">二维码加载中…</div>
  <p><button onclick="startLogin()">重新获取二维码</button>
  <button onclick="location.reload()" style="background:#fff;color:#07c160">刷新状态</button></p>
</div>
<div class="hint">
  <p>1. 用手机打开微信，确认登的是小号 <b>光谱</b>（不是大号）。<br>
  2. 微信点右上角 + → 扫一扫，对着上面这个二维码扫（不要用手机相机直接扫）。<br>
  3. 手机上出现确认登录就点确认，等这里显示“已登录”。<br>
  4. 二维码几分钟会过期，过期了点“重新获取二维码”。</p>
  <p class="warn">注意：登录会顶掉原来那台服务器上的小号登录（那边收发本来就是死的，没损失）。只用小号光谱，别用大号登录。</p>
</div>
<p><a href="/">← 回操作页</a> · <a href="/connectivity" target="_blank">连通性测试</a></p>
<script>
let timer=null;
async function refresh(){
  try{
    const r=await fetch('/api/state'); const s=await r.json();
    const el=document.getElementById('state'), qr=document.getElementById('qr'), qm=document.getElementById('qrmsg');
    if(!s.daemonUp){ el.textContent='服务未启动（daemon 没起来），请稍后再试'; qr.style.display='none'; qm.textContent=''; return; }
    if(s.authenticated){ el.textContent='✅ 已登录：'+(s.account&&s.account.alias||'光谱'); qr.style.display='none'; qm.textContent='登录成功！可以去操作页看群聊了。'; clearInterval(timer); return; }
    if(s.attempt){
      const st=s.attempt.state||'';
      if(st==='failed'){ el.textContent='❌ 这次登录失败了（'+(s.attempt.result&&s.attempt.result.code||'')+'），点下面按钮重新获取二维码'; qr.style.display='none'; qm.textContent=''; }
      else if(st==='succeeded'){ el.textContent='✅ 已登录'; qr.style.display='none'; qm.textContent=''; clearInterval(timer); }
      else { el.textContent='等待扫码…（状态：'+st+'）'; qr.src='/qr.png?t='+Date.now(); qr.style.display=''; qm.textContent='二维码 15 秒自动刷新一次'; }
    } else { el.textContent='还没有登录任务，点下面按钮开始'; qr.style.display='none'; qm.textContent=''; }
  }catch(e){ document.getElementById('state').textContent='请求失败：'+e; }
}
async function startLogin(){
  document.getElementById('state').textContent='正在获取二维码…';
  await fetch('/api/login', {method:'POST'});
  refresh();
}
refresh(); timer=setInterval(refresh, 15000);
</script></body></html>`;

function opsPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>agent-wechat 操作页</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;color:#222}
h1{font-size:22px} .box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:8px 14px;font-size:15px;border-radius:8px;border:1px solid #07c160;background:#07c160;color:#fff;cursor:pointer}
input,select,textarea{padding:8px;font-size:15px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box}
pre{background:#f6f6f6;padding:12px;border-radius:8px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-word}
a{color:#07c160}
</style></head><body>
<h1>agent-wechat 操作页</h1>
<div class="box"><b>状态</b> <span id="status">加载中…</span>
<p><a href="/login">去登录 / 扫码 →</a> · <a href="/connectivity" target="_blank">连通性测试</a> · <a href="/health" target="_blank">/health</a></p></div>
<div class="box"><b>群聊列表</b> <button onclick="loadChats()">刷新群聊</button>
<pre id="chats">点“刷新群聊”查看（登录后才能看到）。</pre></div>
<div class="box"><b>发一条测试消息</b>
<p>群聊 ID（@chatroom，一般以 @chatroom 结尾，从上面列表里复制）：<input id="thread" placeholder="例如 xxxxx@chatroom"></p>
<p>内容：<input id="text" value="测试：我是光谱，能收到我发的这条吗？" placeholder="要发的内容"></p>
<p><button onclick="sendMsg()">发送</button> <span id="sendResult"></span></p></div>
<div class="box"><b>最近事件</b> <button onclick="loadEvents()">刷新事件</button>
<pre id="events">点“刷新事件”查看（有新消息时这里会显示）。</pre></div>
<script>
async function j(u,o){ const r=await fetch(u,o); return r.json(); }
async function refreshStatus(){ try{ const s=await j('/api/state'); document.getElementById('status').textContent = s.daemonUp ? (s.authenticated ? '✅ 已登录（'+(s.account&&s.account.alias||'')+'）' : '未登录（去 /login 扫码）') : 'daemon 未启动'; }catch(e){ document.getElementById('status').textContent='请求失败：'+e; } }
async function loadChats(){ try{ const d=await j('/api/chats'); document.getElementById('chats').textContent=JSON.stringify(d,null,2); }catch(e){ document.getElementById('chats').textContent='失败：'+e; } }
async function loadEvents(){ try{ const d=await j('/api/events?limit=20'); document.getElementById('events').textContent=JSON.stringify(d,null,2); }catch(e){ document.getElementById('events').textContent='失败：'+e; } }
async function sendMsg(){
  const thread=document.getElementById('thread').value.trim(), text=document.getElementById('text').value.trim();
  if(!thread||!text){ document.getElementById('sendResult').textContent='请先填群聊 ID 和内容'; return; }
  document.getElementById('sendResult').textContent='发送中…';
  try{ const d=await j('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threadId:thread,text})});
    document.getElementById('sendResult').textContent = d.ok ? '✅ 已提交（id：'+(d.data&&d.data.id||'')+'）' : '❌ 失败：'+JSON.stringify(d.error||d);
  }catch(e){ document.getElementById('sendResult').textContent='失败：'+e; }
}
refreshStatus();
</script></body></html>`;
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  // --- public, unauthenticated, safe endpoints ---
  if (p === '/health' && req.method === 'GET') {
    const up = await daemonHealth();
    if (up && up.status === 200) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(up.body || '{"status":"ok"}'); }
    else sendJson(res, 503, { status: 'daemon-unavailable' });
    return;
  }

  if (p === '/connectivity' && req.method === 'GET') {
    const c = await connectivity();
    sendJson(res, 200, c);
    return;
  }

  if (p === '/login' && req.method === 'GET') { sendHtml(res, 200, LOGIN_PAGE); return; }
  if ((p === '/' || p === '/index.html' || p === '/app') && req.method === 'GET') { sendHtml(res, 200, opsPage()); return; }

  if (p === '/qr.png' && req.method === 'GET') {
    const q = await fetchQrPng();
    if (q.ok) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(q.png);
    } else {
      sendJson(res, 404, { error: q.error || 'qr-unavailable', attempt: q.attempt ? { id: q.attempt.id, state: q.attempt.state } : null });
    }
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    const up = await daemonHealth();
    const out = { daemonUp: !!(up && up.status === 200), account: null, authenticated: false, attempt: null };
    if (out.daemonUp) {
      const accountId = await getOrCreateAccount();
      if (accountId) {
        const a = await daemonJson('GET', `/v1/accounts/${accountId}`);
        if (a.ok) { out.account = { id: a.data.id, alias: a.data.alias, authenticated: !!a.data.authenticated, connection: a.data.connection }; out.authenticated = !!a.data.authenticated; }
      }
      const att = await currentAttempt();
      if (att) out.attempt = { id: att.id, state: att.state, result: att.result };
    }
    sendJson(res, 200, out);
    return;
  }

  if (p === '/api/login' && req.method === 'POST') {
    const r = await startLogin();
    if (r.ok) sendJson(res, 200, { ok: true, attempt: r.attempt });
    else sendJson(res, 500, { ok: false, error: r.error });
    return;
  }

  if (p === '/api/chats' && req.method === 'GET') {
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { error: 'no-account' }); return; }
    const r = await daemonJson('GET', `/v1/accounts/${accountId}/threads?limit=100`);
    if (r.ok) sendJson(res, 200, r.data);
    else sendJson(res, r.status || 500, { error: (r.data && r.data.error) || 'daemon-error', status: r.status });
    return;
  }

  if (p === '/api/messages' && req.method === 'GET') {
    const thread = url.searchParams.get('thread');
    const limit = url.searchParams.get('limit') || '20';
    if (!thread) { sendJson(res, 400, { error: 'thread-required' }); return; }
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { error: 'no-account' }); return; }
    const r = await daemonJson('GET', `/v1/accounts/${accountId}/threads/${encodeURIComponent(thread)}/messages?limit=${encodeURIComponent(limit)}`);
    if (r.ok) sendJson(res, 200, r.data);
    else sendJson(res, r.status || 500, { error: (r.data && r.data.error) || 'daemon-error', status: r.status });
    return;
  }

  if (p === '/api/events' && req.method === 'GET') {
    const limit = url.searchParams.get('limit') || '20';
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { error: 'no-account' }); return; }
    const r = await daemonJson('GET', `/v1/accounts/${accountId}/events?limit=${encodeURIComponent(limit)}`);
    if (r.ok) sendJson(res, 200, r.data);
    else sendJson(res, r.status || 500, { error: (r.data && r.data.error) || 'daemon-error', status: r.status });
    return;
  }

  if (p === '/api/send' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const threadId = body.threadId || body.thread;
    const text = body.text;
    if (!threadId || !text) { sendJson(res, 400, { ok: false, error: 'threadId-and-text-required' }); return; }
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { ok: false, error: 'no-account' }); return; }
    const key = `web-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const r = await daemonJson('POST', `/v1/accounts/${accountId}/sends`, { threadId, kind: 'text', text }, { 'Idempotency-Key': key });
    if (r.ok) sendJson(res, 200, { ok: true, data: r.data });
    else sendJson(res, r.status || 500, { ok: false, error: (r.data && r.data.error) || 'daemon-error', status: r.status });
    return;
  }

  // Send an image: POST {threadId, imageBase64, filename?, mimeType?}
  // Flow: upload the bytes to the daemon (/uploads, multipart) to get a
  // sourceId, then send {threadId, kind:'image', sourceId} to /sends.
  // (Verified against the v2.2.0 daemon: sends with kind image + sourceId
  // returns 409 auth_required when the shape is right and the account is
  // not logged in; adding sourceSha256 makes it 400 invalid_request.)
  if (p === '/api/send-image' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { body = {}; }
    const threadId = body.threadId || body.thread;
    const b64 = body.imageBase64 || body.image || body.data;
    if (!threadId || !b64) { sendJson(res, 400, { ok: false, error: 'threadId-and-imageBase64-required' }); return; }
    let imgBuf;
    try { imgBuf = Buffer.from(String(b64), 'base64'); } catch { sendJson(res, 400, { ok: false, error: 'bad-base64' }); return; }
    if (imgBuf.length < 10 || imgBuf.length > 10 * 1024 * 1024) { sendJson(res, 400, { ok: false, error: 'image-size-out-of-range' }); return; }
    const filename = String(body.filename || 'image.jpg').replace(/[^A-Za-z0-9._-]/g, '_');
    const mimeType = String(body.mimeType || (filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'));
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { ok: false, error: 'no-account' }); return; }
    const up = await daemonUploadImage(accountId, imgBuf, filename, mimeType);
    if (!up.ok) { sendJson(res, up.status || 500, { ok: false, error: up.error, step: 'upload' }); return; }
    const key = `img-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const r = await daemonJson('POST', `/v1/accounts/${accountId}/sends`, { threadId, kind: 'image', sourceId: up.data.id }, { 'Idempotency-Key': key });
    if (r.ok) sendJson(res, 200, { ok: true, data: r.data, uploadId: up.data.id });
    else sendJson(res, r.status || 500, { ok: false, error: (r.data && r.data.error) || 'daemon-error', status: r.status, step: 'send' });
    return;
  }

  // Download an image a group member sent: GET /api/media?messageId=<id>
  // [&quality=best|original|standard|thumbnail]. Returns JSON
  // {ok:true, imageBase64, mimeType, quality} (base64 so any client can
  // use it without handling binary bodies), or {ok:false, error}.
  // The daemon's /messages/{id}/image needs the opaque message id from
  // /api/messages (NOT the numeric localId). Max ~10 MB of image bytes.
  if (p === '/api/media' && req.method === 'GET') {
    const messageId = url.searchParams.get('messageId') || url.searchParams.get('id');
    let quality = (url.searchParams.get('quality') || 'best').toLowerCase();
    if (!['best', 'original', 'standard', 'thumbnail'].includes(quality)) quality = 'best';
    if (!messageId) { sendJson(res, 400, { ok: false, error: 'messageId-required' }); return; }
    const accountId = await getOrCreateAccount();
    if (!accountId) { sendJson(res, 500, { ok: false, error: 'no-account' }); return; }
    const img = await fetchMessageImage(accountId, messageId, quality);
    if (!img.ok) { sendJson(res, 502, { ok: false, error: img.error || 'media-unavailable', status: img.status }); return; }
    if (img.buf.length > 10 * 1024 * 1024) { sendJson(res, 502, { ok: false, error: 'image-too-large' }); return; }
    sendJson(res, 200, { ok: true, imageBase64: img.buf.toString('base64'), mimeType: img.mimeType, quality: img.quality, byteLength: img.buf.length });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`proxy listening on 0.0.0.0:${PORT}, daemon at ${DAEMON_HOST}:${DAEMON_PORT}, data dir ${DATA_DIR}`);
});
