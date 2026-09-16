/**
 * e2e-admin-proxy-notice.mjs — 代理入金連絡 管理画面の実 DOM E2E
 *
 * ## なぜ要るか
 *
 * この画面の事故は「判定が間違っている」型ではなく、**画面の段取りが崩れる**型で起きる:
 *
 *   - 確認していない内容のまま「登録する」が押せてしまう
 *   - 「内容を確認」を押しただけで書き込みが走ってしまう
 *   - 入力を変えたのに、前の確認結果のまま登録できてしまう
 *   - 運営者が入力したメールアドレスが、送信時に別の値へ差し替わる
 *
 * どれもロジックテストでは通り、実ページを開かないと出ない。ここで守る。
 *
 * ## 本番に触れないこと
 *
 *   - `dist/` を静的配信して開く（Edge 認証も Functions も動かない＝認証を触らない）
 *   - 管理 API はブラウザ側の `fetch` 差し替えで**合成応答**を返す
 *   - Airtable / Redis / SendGrid へは 1 度も接続しない。**実顧客レコードは読まない**
 *
 * ## 使い方
 *
 *   npm run build && npm run e2e:proxy-notice
 *
 * 環境変数 E2E_BROWSER … Chromium 系のバイナリ（未指定なら既知の場所を順に探す）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const PAGE_PATH = '/admin/proxy-payment-notice/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const fails = [];
const passes = [];
const check = (ok, msg) => {
  (ok ? passes : fails).push(msg);
  console[ok ? 'log' : 'error'](`  ${ok ? '✓' : '✗'} ${msg}`);
};

if (!existsSync(join(DIST, PAGE_PATH))) {
  console.error(`⛔ ${PAGE_PATH} がありません。先に npm run build を実行してください。`);
  process.exit(2);
}

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
  // ⚠️ ここで puppeteer 等を勝手に入れない（依存を増やさない方針）
  console.error('⛔ Chromium 系ブラウザが見つかりません。E2E_BROWSER にパスを指定してください。');
  for (const p of BROWSER_CANDIDATES) console.error('     - ' + p);
  process.exit(2);
}

const PROFILE_DIR = await mkdtemp(join(tmpdir(), 'ak-e2e-proxy-'));
const cleanupProfile = async () => { try { await rm(PROFILE_DIR, { recursive: true, force: true }); } catch {} };

// ── dist を静的配信（依存を増やさない素の http サーバー）──────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(DIST, p);
    if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(500).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
step('dist の静的配信を開始');

// ── Chromium を起動して CDP で操作 ──────────────────────────
const proc = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--disable-setuid-sandbox',
  `--user-data-dir=${PROFILE_DIR}`, '--disable-gpu', '--disable-dev-shm-usage',
  'about:blank',
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
const bail = async (code, msg) => {
  console.error(msg);
  server.close(); try { proc.kill(); } catch {}
  await cleanupProfile();
  process.exit(code);
};
if (!wsUrl) {
  await bail(2, '⛔ Chromium の DevTools に接続できませんでした\n' + browserErr.trim().slice(0, 1200));
}
step('DevTools の ws URL を取得');

let msgId = 0;
const pending = new Map();
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
browserWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const rpc = (method, params = {}, sessionId) => withDeadline(new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
}), 60000, `CDP ${method}`);
const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => rpc(method, params, sessionId);
await send('Page.enable');
await send('Runtime.enable');
step('CDP 接続');

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

// ── 管理 API のスタブ（**呼ばれた回数と本文を記録する**）──────────
//    「preview なのに書き込んだ」「apply が 2 回飛んだ」を検出できるようにする。
const STUB_SRC = `
(() => {
  window.__E2E = { calls: [], confirms: [], nextPreview: null };
  window.confirm = (m) => { window.__E2E.confirms.push(String(m)); return true; };
  const realFetch = window.fetch;
  window.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('admin-proxy-payment-notice')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    window.__E2E.calls.push({ action: body.action, body, secret: init.headers['x-admin-secret'] });
    if (body.action === 'preview') {
      const forced = window.__E2E.nextPreview;
      if (forced) {
        window.__E2E.nextPreview = null;
        return new Response(JSON.stringify(forced.body), { status: forced.status, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true, action: 'preview', sideEffects: 'none', auditFieldsReady: false,
        customer: { recordId: 'recE2E', fullName: 'テスト太郎', plan: 'Premium', status: '', expiration: '2026-04-06', requestedPlan: '', paymentConfirmed: false },
        willWrite: { RequestedPlan: 'Premium', RequestedPlanType: 'Annual', RequestedAmount: body.receivedAmount, PaymentConfirmed: false, Status: 'pending' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      ok: true, action: 'apply', sideEffects: 'customers_patched', recordId: 'recE2E',
      wrote: { RequestedPlan: 'Premium', RequestedAmount: body.receivedAmount },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SRC });

console.log(`\n■ 実 DOM E2E（${BROWSER.split('/').pop()} / dist 配信）— 代理入金連絡\n`);

await send('Page.navigate', { url: BASE + PAGE_PATH });
await sleep(1000);
step('画面を開いた');

/** 入力を埋める（運営者が画面でやる操作そのもの） */
const fill = async (amount = '44800') => evaluate(`(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('email', 'soken1122@example.test');
  set('amount', ${JSON.stringify(amount)});
  set('operator', 'MK');
  set('secret', 'e2e-secret');
  const p = document.getElementById('product');
  p.value = 'Premium Annual - Campaign';
  p.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);

const state = () => evaluate(`(() => ({
  applyDisabled: document.getElementById('apply').disabled,
  msg: document.getElementById('msg').textContent.trim(),
  msgVisible: document.getElementById('msg').style.display !== 'none',
  detail: document.getElementById('detail').textContent.trim(),
  calls: window.__E2E.calls.map((c) => c.action),
  lastBody: window.__E2E.calls.length ? window.__E2E.calls[window.__E2E.calls.length - 1].body : null,
  confirms: window.__E2E.confirms.length,
}))()`);

// ── 1. 画面の骨格 ────────────────────────────────────────────
const skeleton = await evaluate(`(() => {
  const ids = ['email', 'product', 'amount', 'paidDate', 'reason', 'operator', 'secret', 'preview', 'apply'];
  const missing = ids.filter((id) => !document.getElementById(id));
  return { missing, h1: document.querySelector('h1').textContent.trim(),
           note: document.querySelector('.note').textContent.replace(/\\s+/g, ' ') };
})()`);
check(skeleton.missing.length === 0, `入力欄とボタンがすべて DOM にある（欠落: ${skeleton.missing.join(',') || 'なし'}）`);
check(/PaymentConfirmed/.test(skeleton.note), '「登録後に PaymentConfirmed を押す」と画面に書いてある');
check(/有料プランはここでは付きません/.test(skeleton.note), '「この画面では権限が付かない」と明示している');

// ── 2. 確認前は登録できない ──────────────────────────────────
let s = await state();
check(s.applyDisabled === true, '確認前は「登録する」を押せない');
check(s.calls.length === 0, '画面を開いただけでは API を 1 度も呼ばない');

await fill();
s = await state();
check(s.applyDisabled === true, '入力しただけでは「登録する」を押せない');
check(s.calls.length === 0, '入力だけでは API を呼ばない（書き込みなし）');

// ── 3. 内容を確認 → 書き込みは起きない ────────────────────────
await evaluate(`document.getElementById('preview').click()`);
await sleep(600);
s = await state();
check(s.calls.length === 1 && s.calls[0] === 'preview', `確認では preview だけを 1 回呼ぶ（実際: ${s.calls.join(',')}）`);
check(!s.calls.includes('apply'), '確認の時点で apply（書き込み）を呼んでいない');
check(s.applyDisabled === false, '確認が通ると「登録する」を押せるようになる');
check(/書き込む内容|RequestedPlan/.test(s.detail), '何が書き込まれるかを画面に出している');
check(s.lastBody.email === 'soken1122@example.test',
  '運営者が入力したメールアドレスがそのまま送られる（別の値へ差し替わらない）');
check(String(s.lastBody.receivedAmount) === '44800', '実入金額 44800 がそのまま送られる（掲載価格へ丸めない）');

// ── 4. 入力を変えたら確認し直させる ──────────────────────────
await fill('44820');
s = await state();
check(s.applyDisabled === true, '入力を変えると「登録する」が再び押せなくなる');

await evaluate(`document.getElementById('preview').click()`);
await sleep(600);
s = await state();
check(s.applyDisabled === false, '確認し直せば再び押せる');
check(String(s.lastBody.receivedAmount) === '44820', '確認し直した内容が送られる');

// ── 5. 登録は 1 回だけ ──────────────────────────────────────
const before = s.calls.length;
await evaluate(`document.getElementById('apply').click()`);
await sleep(600);
s = await state();
const applyCalls = s.calls.filter((c) => c === 'apply').length;
check(applyCalls === 1, `登録は 1 回だけ呼ばれる（実際: ${applyCalls} 回）`);
check(s.calls.length === before + 1, '登録で余分な呼び出しが起きない');
check(s.confirms === 1, '登録前に確認ダイアログを出している');
check(s.applyDisabled === true, '登録後は続けて押せない（二重登録の防止）');
check(/PaymentConfirmed/.test(s.msg), '登録後に「次に何をするか」を画面へ出している');

// ── 6. 確認が拒否されたら登録させない ────────────────────────
await evaluate(`(() => {
  window.__E2E.nextPreview = { status: 422, body: { ok: false, code: 'already_pending', error: '未確認の申込が既にあります。' } };
  return 'ok';
})()`);
await fill('12345');
await evaluate(`document.getElementById('preview').click()`);
await sleep(600);
s = await state();
check(s.applyDisabled === true, '確認が拒否されたら「登録する」は押せないまま');
check(/未確認の申込/.test(s.msg), '拒否理由を画面に出している');

// ── 後片付け ────────────────────────────────────────────────
server.close();
try { proc.kill(); } catch {}
await cleanupProfile();

console.log(`\n結果: ${passes.length} pass / ${fails.length} fail`);
if (fails.length) {
  console.error('\n落ちた観点:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✅ 代理入金連絡 管理画面の実 DOM E2E をすべて通過\n');
process.exit(0);
