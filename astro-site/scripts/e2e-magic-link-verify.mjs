/**
 * e2e-magic-link-verify.mjs — 「ログインリンクは押したときだけ使われる」実 DOM E2E
 *
 * ## なぜ要るか（2026-09-10 MK 指摘）
 *
 * > このリンクやボタン長押しでコピーするとログインリンクが使用されたことになり、
 * > 認証エラーになるんでこれは混乱します。
 *
 * `/auth/verify` は**開いた瞬間に**検証していた。iOS はリンクを長押ししただけで
 * プレビューを描画し、その中で **JS を実行する**ため、コピーしようとしただけで
 * トークンが使用済みになっていた。リンク検査ボット・先読みでも同じ。
 *
 * 確定仕様: **GET で開いただけでは絶対に消費しない。「ログインする」を押したときだけ。**
 *
 * ソース検査（`verifyRequiresUserAction.guard.test.mjs`）は「書き方」を固定するが、
 * 「実際にページを開いて 1 回も通信しないか」は実ブラウザでしか確かめられない。
 * ここでは**本物のページの markup と script をそのまま**取り出して読み込み、
 * `fetch` を差し替えて**呼ばれた回数**を数える。
 *
 * ## 本番に触れないこと
 *
 *   - `fetch` はブラウザ側で差し替える。Netlify Functions / Airtable へは 1 度も接続しない
 *   - トークンは架空の文字列。実在のトークンは使わない
 *
 * ## 使い方
 *
 *   npm run e2e:magic-link
 *
 * 環境変数: `E2E_BROWSER` … Chromium 系のバイナリ（未指定なら既知の場所を順に探す）
 *
 * ⚠️ ブラウザプロファイルは **repo の中に作らない**（一時ディレクトリ + finally で削除）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PAGE_SRC = join(ROOT, 'src', 'pages', 'auth', 'verify.astro');

const PROFILE_DIR = await mkdtemp(join(tmpdir(), 'ak-e2e-magic-'));
let profileRemoved = false;
async function removeProfile() {
  if (profileRemoved) return;
  profileRemoved = true;
  await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
}
process.on('exit', () => {
  if (profileRemoved) return;
  profileRemoved = true;
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const fails = [];
const passes = [];
const check = (ok, msg) => { (ok ? passes : fails).push(msg); console[ok ? 'log' : 'error'](`  ${ok ? '✓' : '✗'} ${msg}`); };

const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER, process.env.CHROME_BIN, process.env.CHROMIUM_BIN,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  // ⚠️ puppeteer 等を勝手に入れない（依存を増やさない方針）。理由を出して落とす。
  console.error('⛔ Chromium 系ブラウザが見つかりません。E2E を実行できません。');
  for (const p of BROWSER_CANDIDATES) console.error('     - ' + p);
  process.exit(2);
}

// ── 本物のページから markup と script を取り出す ─────────────
//    ここを合成すると「テスト用に書いた別物」を検証してしまうので、必ず実ファイルから取る。
const src = await readFile(PAGE_SRC, 'utf8');
const markup = (() => {
  const a = src.indexOf('<section class="verify-section">');
  const b = src.indexOf('</section>', a);
  if (a < 0 || b < 0) throw new Error('verify.astro の markup を取り出せませんでした');
  return src.slice(a, b + '</section>'.length).replace(/<!--[\s\S]*?-->/g, '');
})();
const script = (() => {
  const a = src.indexOf('<script define:vars=');
  const open = src.indexOf('>', a);
  const b = src.indexOf('</script>', open);
  if (a < 0 || b < 0) throw new Error('verify.astro の script を取り出せませんでした');
  return src.slice(open + 1, b);
})();
const ttl = (src.match(/MAGIC_LINK_TTL_MINUTES/) ? 60 : 60);
step('verify.astro から markup と script を取得');

const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>verify</title></head>
<body>${markup}
<script>
  // ⚠️ 実際の通信はしない。**呼ばれた回数だけ**を数える。
  window.__calls = [];
  window.__nextResponse = { ok: true, status: 200, body: { userPlan: { plan: 'Premium' }, redirectTo: '/dashboard/' } };
  window.fetch = (url, opts) => {
    window.__calls.push({ url: String(url), credentials: opts && opts.credentials });
    const r = window.__nextResponse;
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
  };
<\/script>
<script>const TTL_MIN = ${ttl};
${script}
<\/script></body></html>`;

const server = createServer((req, res) => {
  if ((req.url || '').startsWith('/dashboard')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('dashboard'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
step('ページ配信を開始');

// ── ブラウザ起動 ────────────────────────────────────────────
step(`Chromium 起動: ${BROWSER.split('/').pop()}`);
const proc = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--disable-setuid-sandbox',
  `--user-data-dir=${PROFILE_DIR}`, '--disable-gpu', '--disable-dev-shm-usage', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let wsUrl = null;
let browserErr = '';
proc.stderr.on('data', (b) => {
  browserErr += String(b);
  const m = String(b).match(/ws:\/\/[^\s]+/);
  if (m && !wsUrl) wsUrl = m[0];
});
for (let i = 0; i < 120 && !wsUrl; i += 1) {
  if (proc.exitCode !== null) break;
  await sleep(250);
}
if (!wsUrl) {
  console.error('⛔ Chromium の DevTools に接続できませんでした');
  if (browserErr.trim()) console.error('--- ブラウザの出力 ---\n' + browserErr.trim().slice(0, 1500));
  server.close(); proc.kill(); await removeProfile(); process.exit(2);
}

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} が ${ms}ms で応答しませんでした`)), ms); }),
  ]);
}
const browserWs = new WebSocket(wsUrl);
await withDeadline(
  new Promise((r, j) => { browserWs.onopen = r; browserWs.onerror = () => j(new Error('WebSocket error')); }),
  20000, 'DevTools への WebSocket 接続',
);
let msgId = 0; const pending = new Map();
browserWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const rpc = (method, params = {}, sid) => withDeadline(new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  browserWs.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
}), 60000, `CDP ${method}`);
const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => rpc(method, params, sessionId);
await send('Page.enable');
await send('Runtime.enable');
step('CDP 接続');

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function open(query) {
  await send('Page.navigate', { url: BASE + '/auth/verify' + query });
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`document.readyState === 'complete' && !!document.getElementById('status')`).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error('ページが開きませんでした: ' + query);
}

const TOKEN = 'e2e-fake-token-0000-1111-2222';

try {
  // ── 1. 開いただけでは消費しない ────────────────────────────
  step('開いただけで消費しないか');
  await open(`?token=${TOKEN}`);
  await sleep(1200); // 自動実行があるなら、この間に必ず走る
  check(await evaluate('window.__calls.length') === 0,
    '開いただけではトークンを消費しない（通信 0 回）');
  check(await evaluate(`document.getElementById('status').textContent`) === 'ログインの確認',
    '「ログインの確認」で待っている（勝手に認証中にならない）');

  // ── 2. プレビュー / 先読みで起きるイベントでも消費しない ──────
  step('プレビュー相当のイベントでも消費しないか');
  await evaluate(`(() => {
    for (const ev of ['DOMContentLoaded', 'load', 'pageshow', 'visibilitychange', 'focus', 'mouseover', 'touchstart']) {
      window.dispatchEvent(new Event(ev));
      document.dispatchEvent(new Event(ev));
    }
    const b = document.getElementById('login-btn');
    // 長押し相当（押しっぱなし → 離さない）でも起動してはいけない
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  check(await evaluate('window.__calls.length') === 0,
    '読み込み・可視化・フォーカス・長押し相当でも消費しない（通信 0 回）');

  // ── 3. ボタンが「見えていて押せる」 ──────────────────────────
  step('ボタンが見えていて押せるか');
  const btn = await evaluate(`(() => {
    const b = document.getElementById('login-btn');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      text: (b.textContent || '').trim(), disabled: b.disabled, hidden: b.hidden,
      w: Math.round(r.width), h: Math.round(r.height),
      onTop: !!top && (top === b || b.contains(top)),
    };
  })()`);
  check(!!btn && btn.text === 'ログインする', '「ログインする」ボタンが DOM にある');
  check(!!btn && !btn.disabled && !btn.hidden && btn.w > 0 && btn.h > 0, 'ボタンが表示されていて押せる状態');
  check(!!btn && btn.onTop, 'ボタンが他の要素に覆われていない（見えるのに押せない、が無い）');
  check(/押すまでリンクは使われません/.test(await evaluate(`document.getElementById('hint').textContent`)),
    '「押すまで使われない」ことを画面に書いている');

  // ── 4. 押したときだけ消費する ──────────────────────────────
  step('押したら消費するか');
  await evaluate(`document.getElementById('login-btn').click()`);
  await sleep(600);
  const calls = await evaluate('window.__calls');
  check(calls.length === 1, `押したときだけ 1 回だけ消費する（実際: ${calls.length} 回）`);
  check(calls.length === 1 && calls[0].url.includes(encodeURIComponent(TOKEN)),
    'その 1 回でトークンを送っている');
  check(calls.length === 1 && calls[0].credentials === 'include',
    'セッション Cookie を受け取る呼び方（credentials: include）を保っている');
  const okText = await evaluate(`document.getElementById('message').textContent`);
  check(await evaluate(`document.getElementById('status').textContent`) === 'ログイン成功', '成功表示に切り替わる');
  check(/このブラウザへのログインが完了しました/.test(okText), '「このブラウザにログインした」と伝える');

  // ── 5. 連打しても二重に消費しない ──────────────────────────
  step('連打で二重に消費しないか');
  await open(`?token=${TOKEN}`);
  await evaluate(`(() => { const b = document.getElementById('login-btn'); b.click(); b.click(); b.click(); })()`);
  await sleep(600);
  check(await evaluate('window.__calls.length') === 1,
    `連打しても消費は 1 回だけ（実際: ${await evaluate('window.__calls.length')} 回）`);

  // ── 6. 使用済みトークンの案内 ──────────────────────────────
  step('使用済みの案内が出るか');
  await open(`?token=${TOKEN}`);
  await evaluate(`window.__nextResponse = { ok: false, status: 403, body: { error: 'Token already used' } }`);
  await evaluate(`document.getElementById('login-btn').click()`);
  await sleep(600);
  const usedMsg = await evaluate(`document.getElementById('message').textContent`);
  check(/既に使用済み/.test(usedMsg), '使用済みなら「既に使用済み」と伝える');
  check(/ログインリンクを再送する/.test(usedMsg), '再送への導線を出す');
  check(await evaluate(`document.getElementById('login-btn').hidden`) === true,
    '失敗後は押せないボタンを残さない');

  // ── 7. token 無しでは通信しない ────────────────────────────
  step('token 無しの扱い');
  await open('');
  await sleep(800);
  check(await evaluate('window.__calls.length') === 0, 'token が無ければ 1 回も通信しない');
  check(/トークンが指定されていません/.test(await evaluate(`document.getElementById('message').textContent`)),
    'token 無しはその場で案内する');
} catch (e) {
  check(false, 'E2E の実行中に例外: ' + (e && e.message ? e.message : String(e)));
} finally {
  browserWs.close(); server.close(); proc.kill();
  await removeProfile();
}

console.log(`\n合計 ${passes.length + fails.length} 項目 / pass ${passes.length} / fail ${fails.length}`);
if (fails.length) {
  console.error('\n⛔ E2E 失敗:');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log('✅ ログインリンクは「押したときだけ」使われる（実 DOM で確認）');
