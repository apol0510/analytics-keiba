/**
 * e2e-bank-transfer-confirm.mjs — 未ログインの入金完了報告を「本人が確定する」流れの実ブラウザ E2E（KAO registry 339e0bd2）
 *
 * 守ること:
 *   - 未ログインで既存のお客様のアドレスから報告しても、そのレコードは変わらない
 *   - 確定リンクを**開いただけ**では反映しない（メールのリンク先読みで確定させない）
 *   - 画面で「この内容で確定する」を押すと 1 回だけ反映され、同じリンクはもう使えない
 *   - 「心当たりがない」で取り消せる・スマホ幅で横スクロールが出ない
 *
 * 本番に触れないこと:
 *   - `dist/` を静的配信し、`/.netlify/functions/bank-transfer-application` だけを**実際の Function** へ渡す
 *   - Function の外向き通信（Airtable / SendGrid / Upstash）はこのプロセス内の合成ストアで受ける。外へは 1 度も出ない
 *
 * 使い方:  npm run build && npm run e2e:bank-transfer-confirm
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
const PAGE_PATH = '/bank-transfer/confirm/index.html';

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

// ── 合成の外部サービス（Function の fetch をここで受ける）──────────
const REDIS_URL = 'https://redis.e2e.invalid';
const db = new Map([['recE2EVICTIM00001', {
  Email: 'e2e-owner@example.test', '氏名': '本人 花子', Status: 'pending', 'プラン': 'Free',
  RequestedPlan: 'Premium', RequestedPlanType: 'Lifetime', RequestedAmount: 98000, PaymentConfirmed: false,
}]]);
const redis = new Map();
const mails = [];
const writes = [];
const j = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const outbound = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.startsWith(REDIS_URL)) {
    const [cmd, key, val, ...rest] = JSON.parse(opts.body);
    const c = String(cmd).toUpperCase();
    if (c === 'SET') { if (rest.includes('NX') && redis.has(key)) return j({ result: null }); redis.set(key, val); return j({ result: 'OK' }); }
    if (c === 'GET') return j({ result: redis.get(key) ?? null });
    if (c === 'GETDEL') { const v = redis.get(key) ?? null; redis.delete(key); return j({ result: v }); }
    if (c === 'DEL') { redis.delete(key); return j({ result: 1 }); }
    return j({ result: null });
  }
  if (u.startsWith('https://api.sendgrid.com/')) {
    const b = JSON.parse(opts.body);
    mails.push({ to: b.personalizations[0].to[0].email, subject: b.personalizations[0].subject, html: b.content[0].value });
    return j({}, 202);
  }
  if (u.startsWith('https://api.airtable.com/')) {
    const path = new URL(u).pathname;
    const m = /\/Customers\/([^/?]+)$/.exec(path);
    if (m && method === 'GET') { const id = decodeURIComponent(m[1]); return db.has(id) ? j({ id, fields: { ...db.get(id) } }) : j({}, 404); }
    if (m && method === 'PATCH') { const id = decodeURIComponent(m[1]); const { fields } = JSON.parse(opts.body); writes.push({ id, fields }); db.set(id, { ...db.get(id), ...fields }); return j({ id }); }
    if (/\/Customers$/.test(path) && method === 'GET') {
      const f = decodeURIComponent(new URL(u).searchParams.get('filterByFormula') || '');
      const e = (/= '([^']*)'/.exec(f) || [])[1] || '';
      return j({ records: [...db.entries()].filter(([, x]) => x.Email === e).map(([id, fields]) => ({ id, fields })) });
    }
    if (/\/Customers$/.test(path) && method === 'POST') { writes.push({ id: 'new', fields: JSON.parse(opts.body).fields }); return j({ id: 'recNEW' }); }
    return j({ records: [] });
  }
  outbound.push(u.slice(0, 60));
  return j({}, 404);
};
for (const [k, v] of [['AIRTABLE_API_KEY', 'e2e'], ['AIRTABLE_BASE_ID', 'appE2E'], ['SENDGRID_API_KEY', 'e2e'],
  ['UPSTASH_REDIS_REST_URL', REDIS_URL], ['UPSTASH_REDIS_REST_TOKEN', 'e2e']]) process.env[k] = v;
delete process.env.SESSION_SIGNING_SECRET;

// Function を読み込む（exports.handler 形式。Plus の smoke と同じ方式）
const realLog = console.log;
globalThis.exports = {};
globalThis.module = { exports: globalThis.exports };
await import(join(ROOT, 'netlify/functions/bank-transfer-application.js'));
const handler = globalThis.exports.handler;
async function callFn(body) {
  console.log = () => {}; const w = console.warn; console.warn = () => {};
  try { return await handler({ httpMethod: 'POST', headers: {}, body }); } finally { console.log = realLog; console.warn = w; }
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

const PROFILE_DIR = await mkdtemp(join(tmpdir(), 'ak-e2e-bank-confirm-'));
const cleanupProfile = async () => { try { await rm(PROFILE_DIR, { recursive: true, force: true }); } catch {} };

// ── dist の静的配信 ＋ Function の経路だけ実 handler へ ──────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
const fnCalls = [];
const server = createServer(async (req, res) => {
  try {
    const p0 = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p0 === '/.netlify/functions/bank-transfer-application' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      try { fnCalls.push(JSON.parse(body).action || 'apply'); } catch { fnCalls.push('?'); }
      const r = await callFn(body);
      res.writeHead(r.statusCode, { 'Content-Type': 'application/json' }); res.end(r.body); return;
    }
    let p = p0;
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


const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const guestReport = (over = {}) => JSON.stringify({
  fullName: '第三者 太郎', email: 'e2e-owner@example.test', transferDate: today, transferTime: '10:00',
  transferAmount: '49800', transferName: 'ﾀﾞｲｻﾝｼｬ', productName: 'Premium Annual (¥49,800/年)',
  paymentCompletedConfirm: true, timestamp: new Date().toISOString(), ...over,
});
const linkFrom = (mail) => {
  const m = /href="[^"]*?(\/bank-transfer\/confirm\/#t=[A-Za-z0-9_-]{43})"/.exec(mail.html);
  return m ? BASE + m[1] : null;
};
const ui = () => evaluate(`(() => document.querySelector('.bt-confirm') ? ({
  state: document.querySelector('.bt-confirm').getAttribute('data-state'),
  status: document.getElementById('bt-status').textContent.trim(),
  detailShown: !document.getElementById('bt-detail').hidden,
  product: (document.querySelector('[data-k="productName"]') || {}).textContent || '',
  amount: (document.querySelector('[data-k="transferAmount"]') || {}).textContent || '',
  actionsShown: !document.getElementById('bt-actions').hidden,
  scrollX: document.documentElement.scrollWidth > window.innerWidth,
}) : ({ state: 'none' }))()`).catch(() => ({ state: 'none' }));
async function waitState(want, ms = 8000) {
  const end = Date.now() + ms; let s;
  while (Date.now() < end) { s = await ui(); if (want.includes(s.state)) return s; await sleep(150); }
  return s;
}

console.log(`\n■ 実ブラウザ E2E（${BROWSER.split('/').pop()} / dist 配信 ＋ 実 Function）— 銀行振込の申込の本人確定\n`);
const before = JSON.stringify(db.get('recE2EVICTIM00001'));

// 1. 未ログインの報告（既存のお客様のアドレス）→ レコードは変わらない
const r1 = await callFn(guestReport());
check(r1.statusCode === 200 && JSON.parse(r1.body).success === true, '未ログインの報告は通常どおり受理（応答は新規と同じ）');
check(JSON.stringify(db.get('recE2EVICTIM00001')) === before && writes.length === 0, '既存のお客様のレコードは 1 文字も変わらない');
const cm = mails.find((m) => m.subject.includes('ご確認のお願い'));
check(Boolean(cm) && cm.to === 'e2e-owner@example.test', '確定リンクはそのアドレス宛てにだけ届く');
const link = cm && linkFrom(cm);
check(Boolean(link), '確定リンクは /bank-transfer/confirm/#t=... の形');

// 2. リンクを開く → 内容が出る・まだ反映しない
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: link });
let s = await waitState(['ready', 'error']);
check(s.state === 'ready', `確定画面に内容が出る（state=${s.state} / ${s.status}）`);
check(/Premium Annual/.test(s.product) && /49,800/.test(s.amount), `商品と金額が見える（${s.product} / ${s.amount}）`);
check(!s.scrollX, 'スマホ幅（375px）で横スクロールが出ない');
check(writes.length === 0 && fnCalls.every((a) => a === 'preview_application'), 'リンクを開いただけでは反映しない');

// 3. 確定ボタン → 1 回だけ反映
await evaluate(`document.getElementById('bt-confirm').click()`);
s = await waitState(['done', 'error']);
check(s.state === 'done', `「この内容で確定する」で確定（${s.status}）`);
check(writes.length === 1 && writes[0].id === 'recE2EVICTIM00001'
  && writes[0].fields.RequestedPlanType === 'Annual' && writes[0].fields['氏名'] === '第三者 太郎',
  '本人が確定した内容が本人のレコードに 1 回だけ入る');
check(!('プラン' in (writes[0] || { fields: {} }).fields), '確定しても昇格はしない（入金確認は管理者）');
check(mails.some((m) => m.subject.includes('本人確認済み')), '管理者へ「本人確認済み」が届く');

// 4. 同じリンクを開き直す → もう使えない
await send('Page.navigate', { url: link });
await send('Page.reload', {});
s = await waitState(['error', 'ready']);
check(s.state === 'error' && !s.actionsShown, `同じリンクは 2 回使えない（${s.status}）`);
check(writes.length === 1, '開き直しても追加の書き込みは無い');

// 5. 心当たりがない → 取り消し
await callFn(guestReport());
const cm2 = mails.filter((m) => m.subject.includes('ご確認のお願い')).pop();
const link2 = linkFrom(cm2);
await send('Page.navigate', { url: 'about:blank' });
await send('Page.navigate', { url: link2 });
s = await waitState(['ready', 'error']);
await evaluate(`document.getElementById('bt-cancel').click()`);
s = await waitState(['cancelled', 'error']);
check(s.state === 'cancelled', `「心当たりがない」で取り消せる（${s.status}）`);
check(writes.length === 1, '取り消しでは何も書かない');

// 6. リンクなし・壊れたリンク
await send('Page.navigate', { url: BASE + '/bank-transfer/confirm/' });
s = await waitState(['error']);
check(s.state === 'error', 'トークンなしで開くと案内だけ出す');
check(outbound.length === 0, `外部への通信が 0 件（${outbound.join(',')}）`);

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
console.log('✅ 銀行振込の申込の本人確定 実ブラウザ E2E をすべて通過\n');
process.exit(0);
