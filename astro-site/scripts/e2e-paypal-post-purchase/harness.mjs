/**
 * e2e-paypal-post-purchase — PayPal 定期課金の決済完了 → Premium 利用画面への自動遷移を実ブラウザで通す（2026-10-22 MK 確定）
 *
 *   npm run e2e:paypal-post-purchase
 *
 * 構成（本物の外部へは 1 度も出ない）:
 *   - 偽の外部（fakeBackend.mjs）: Airtable・PayPal Sandbox・Upstash・SendGrid。顧客は合成値だけ
 *   - astro dev（ページ・SSR の有料ページ gate）と Function 実行器（netlify/functions/* を esbuild で CJS にして実行）を
 *     localhost:8888 の 1 つのオリジンにまとめる。両方とも stub.mjs で fetch を偽の外部へ向ける
 *   - ヘッドレス Chrome（CDP）。メールアプリ内ブラウザは「Cookie も localStorage も無い別のブラウザコンテキスト」で再現する
 *
 * PayPal の承認画面だけは本物を開けないので、「承認して支払った」状態を偽の外部に作り、PayPal と同じ戻り先 URL
 * （購読作成時に渡した return_url）へブラウザを移す。
 *
 * 環境変数: E2E_BROWSER（Chromium 系のバイナリ・未指定なら既知の場所）
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFakeBackend } from './fakeBackend.mjs';
import { PAYPAL_PLAN_IDS, SUBSCRIPTION_PLANS } from '../../src/lib/billing/paypal/paypalSubscriptionCore.js';
import { postPurchaseKey } from '../../src/lib/billing/paypal/postPurchaseLanding.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const require = createRequire(join(ROOT, 'package.json'));
const esbuild = require('esbuild');
const APP_PORT = 8888;
const ASTRO_PORT = 4321;
const APP = `http://localhost:${APP_PORT}`;
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const passes = [];
const fails = [];
const check = (ok, name, detail = '') => { (ok ? passes : fails).push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- 偽の外部 --------------------------------------------------------------------------------
const { st, server: fake } = createFakeBackend();
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const SECRET = randomBytes(32).toString('hex'); // 使い捨ての署名鍵（この実行だけ）
const ENV = {
  E2E_FAKE_BACKEND: FAKE,
  AIRTABLE_API_KEY: 'patE2E.fake', AIRTABLE_BASE_ID: 'appE2EFAKE000000', AIRTABLE_ENDPOINT_URL: `${FAKE}/api.airtable.com`,
  PAYPAL_CLIENT_ID: 'e2e-client', PAYPAL_CLIENT_SECRET: 'e2e-secret', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-E2E',
  UPSTASH_REDIS_REST_URL: 'https://redis.e2e.invalid', UPSTASH_REDIS_REST_TOKEN: 'e2e',
  SESSION_SIGNING_SECRET: SECRET,
  SENDGRID_API_KEY: 'SG.e2e.fake', SENDGRID_FROM_EMAIL: 'noreply@example.invalid',
  MAGIC_LINK_BASE_URL: APP,
};
Object.assign(process.env, ENV);
await import('./stub.mjs');

// ---- astro dev --------------------------------------------------------------------------------
for (const port of [APP_PORT, ASTRO_PORT]) {
  const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
  if (busy) { console.error(`❌ ポート ${port} が使用中です（前回の E2E・dev サーバーを止めてから実行）`); process.exit(1); }
}
step('astro dev を起動');
const astro = spawn(process.execPath, [join(ROOT, 'node_modules/astro/astro.js'), 'dev', '--port', String(ASTRO_PORT), '--host', '127.0.0.1'], {
  cwd: ROOT, env: { ...process.env, ...ENV, NODE_OPTIONS: `--import ${join(ROOT, 'scripts/e2e-paypal-post-purchase/stub.mjs')}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
let astroOut = '';
astro.stdout.on('data', (d) => { astroOut += d; });
astro.stderr.on('data', (d) => { astroOut += d; });
const cleanup = [];
// 次の実行がポートを取れるよう、終了まで待つ
cleanup.push(() => new Promise((r) => { if (astro.exitCode !== null) return r(); astro.once('exit', r); astro.kill('SIGTERM'); setTimeout(() => { astro.kill('SIGKILL'); r(); }, 5000); }));

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* まだ */ }
    await sleep(500);
  }
  return false;
}

// ---- Function 実行器（netlify/functions/* を Netlify と同じく esbuild で CJS へ）----------------------
const BUNDLE_DIR = join(ROOT, 'node_modules/.cache/ak-e2e-functions');
mkdirSync(BUNDLE_DIR, { recursive: true });
cleanup.push(() => rmSync(BUNDLE_DIR, { recursive: true, force: true }));
const sendgridStub = {
  name: 'sendgrid-stub',
  setup(b) {
    b.onResolve({ filter: /^@sendgrid\/mail$/ }, () => ({ path: 'sendgrid-stub', namespace: 'e2e' }));
    b.onLoad({ filter: /.*/, namespace: 'e2e' }, () => ({
      contents: `module.exports = { setApiKey() {}, async send(msg) { await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', body: JSON.stringify(msg) }); return [{ statusCode: 202, headers: {} }]; } };`,
      loader: 'js',
    }));
  },
};
const handlers = new Map();
async function handlerFor(name) {
  if (handlers.has(name)) return handlers.get(name);
  const src = join(ROOT, 'netlify/functions', `${name}.js`);
  if (!existsSync(src)) return null;
  const out = join(BUNDLE_DIR, `${name}.cjs`);
  await esbuild.build({ entryPoints: [src], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out, packages: 'external', plugins: [sendgridStub], logLevel: 'silent' });
  const h = require(out).handler;
  handlers.set(name, h);
  return h;
}
const runner = createServer(async (req, res) => {
  const url = new URL(req.url, APP);
  const m = url.pathname.match(/^\/\.netlify\/functions\/([a-z0-9-]+)\/?$/);
  if (!m) {
    // ページは astro dev へ
    const p = httpRequest({ host: '127.0.0.1', port: ASTRO_PORT, path: req.url, method: req.method, headers: { ...req.headers, connection: 'close' }, agent: false }, (r) => { res.writeHead(r.statusCode, { ...r.headers, connection: 'close' }); r.pipe(res); });
    // dev サーバーが一部のモジュール要求に応答しないことがある。放置すると同じホストへの接続枠を使い切り、
    // 後から出す fetch（戻り先の確認など）が始まらなくなるため、上流 15 秒で切る（本番には無い E2E 環境の事情）
    p.setTimeout(15000, () => p.destroy(new Error('upstream_timeout')));
    p.on('error', () => { if (!res.headersSent) { res.writeHead(504); res.end('astro dev timeout'); } else res.destroy(); });
    req.pipe(p);
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  const tStart = Date.now();
  res.on('finish', () => { if (process.env.E2E_TRACE) console.error(`fn ${m[1]} ${res.statusCode} ${Date.now() - tStart}ms`); });
  try {
    const h = await handlerFor(m[1]);
    if (!h) { res.writeHead(404); res.end('{}'); return; }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
    const r = await h({
      httpMethod: req.method, path: url.pathname, rawUrl: url.href, headers, body,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    }, {});
    const out = { ...(r.headers || {}) };
    const cookies = [].concat(r.multiValueHeaders?.['Set-Cookie'] || [], out['Set-Cookie'] ? [out['Set-Cookie']] : []);
    delete out['Set-Cookie'];
    if (cookies.length) out['Set-Cookie'] = cookies.map((c) => c.replace(/; Secure/i, '')); // http の localhost では Secure を外す（本番は HTTPS）
    res.writeHead(r.statusCode || 200, out);
    res.end(r.body || '');
  } catch (e) {
    console.error(`function ${m[1]} failed:`, e);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'harness_error' }));
  }
});
// vite の HMR（WebSocket）は E2E では使わない。受けずに閉じる（放置すると接続が溜まり、後のタブの読み込みが止まる）
runner.on('upgrade', (_req, socket) => socket.destroy());
await new Promise((r) => runner.listen(APP_PORT, '127.0.0.1', r));
cleanup.push(() => runner.close());

// ---- ブラウザ（CDP）---------------------------------------------------------------------------
const CANDIDATES = [process.env.E2E_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean);
const BIN = CANDIDATES.find((p) => existsSync(p));
if (!BIN) throw new Error('Chromium 系のブラウザが見つかりません（E2E_BROWSER を指定）');
let msgId = 0;
const pending = new Map();
const dialogs = [];
let ws = null;
let chrome = null;
let profile = null;
/**
 * Chrome を（起動し直して）用意する。ヘッドレス Chrome はブラウザコンテキストを 8 個ほど開くと
 * 新しいタブの通信が始まらなくなるため（E2E 環境の制約・Function 側は全て即応答していた）、シナリオごとに起動し直す。
 */
async function startBrowser() {
  await stopBrowser();
  profile = await mkdtemp(join(tmpdir(), 'ak-e2e-paypal-'));
  // ブラウザからも本物の外部へ出さない（GA4・Google タグ等。ローカルホストだけ名前解決する）
  chrome = spawn(BIN, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((r, j) => {
    let buf = '';
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); });
    setTimeout(() => j(new Error('Chrome の起動待ちで時間切れ')), 20000);
  });
  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++msgId, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId: m.sessionId })); return; }
    if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
  };
}
async function stopBrowser() {
  try { ws?.close(); } catch { /* 閉じ済み */ }
  if (chrome) { chrome.kill('SIGTERM'); await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); }); }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  ws = null; chrome = null; profile = null;
}
cleanup.push(() => stopBrowser());
const cdp = (method, params = {}, sessionId) => new Promise((r, j) => {
  const id = ++msgId;
  const timer = setTimeout(() => { pending.delete(id); j(new Error(`CDP ${method} timeout`)); }, 20000);
  pending.set(id, { r: (v) => { clearTimeout(timer); r(v); }, j: (e) => { clearTimeout(timer); j(e); } });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

/** 新しいブラウザコンテキスト（＝Cookie・localStorage が空の別ブラウザ）にタブを 1 つ開く */
async function newTab({ mobile = false } = {}) {
  const { browserContextId } = await cdp('Target.createBrowserContext');
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, sessionId);
  await cdp('Runtime.enable', {}, sessionId);
  if (mobile) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
    await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }, sessionId);
  } else {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  }
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  return {
    ev,
    goto: async (url) => {
      const nav = await cdp('Page.navigate', { url }, sessionId);
      if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
      // dev サーバーでは読み込みが interactive のまま止まる資源があるため、complete を最大 15 秒待ち、無理なら DOM 準備完了で進む
      const done = await waitFor(() => ev('document.readyState === "complete"'), 15000, 'complete').catch(() => false);
      if (done) return;
      await sleep(1500); // モジュールスクリプトのハンドラ登録を待つ
      await waitFor(() => ev('document.readyState !== "loading" && location.href !== "about:blank"'), 45000, `load ${url}`).catch(async (e) => {
        console.error('load state:', await ev('location.href + " " + document.readyState').catch((x) => x.message));
        const probe = await fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => `HTTP ${r.status}`).catch((x) => x.message);
        const astroProbe = await fetch(`http://127.0.0.1:${ASTRO_PORT}/login/`, { signal: AbortSignal.timeout(8000) }).then((r) => `HTTP ${r.status}`).catch((x) => x.message);
        console.error('server probe:', probe, '/ astro direct:', astroProbe);
        throw e;
      });
    },
    url: () => ev('location.pathname + location.search + location.hash'),
    close: () => cdp('Target.disposeBrowserContext', { browserContextId }),
  };
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`時間切れ: ${what}（最後の値: ${String(last).slice(0, 200)}）`);
}

// ---- 合成の顧客と操作 ----------------------------------------------------------------------------
const futureYmd = (days) => new Date(Date.now() + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
function seedMember(email, fields) {
  const id = `rec${randomBytes(7).toString('hex')}`;
  st.tables.Customers[id] = { Email: email, '氏名': 'E2E テスト', ...fields };
  return id;
}
const recordOf = (email) => Object.entries(st.tables.Customers).find(([, f]) => String(f.Email).toLowerCase() === email.toLowerCase());
const amountOf = (planId) => SUBSCRIPTION_PLANS.find((p) => p.id === planId).amountYen;

/** ブラウザから申込（料金ページの「クレジットカードで申し込む」と同じ Function・同じオリジン） */
async function startCheckout(tab, planId, email) {
  await tab.goto(`${APP}/pricing/`);
  const r = await tab.ev(`fetch('/.netlify/functions/monthly-create-checkout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ plan: planId, ...(email ? { email } : {}) })}) }).then(async (r) => ({ s: r.status, b: await r.json() }))`);
  if (r.s !== 200) throw new Error(`申込 ${planId}: ${r.s} ${JSON.stringify(r.b)}`);
  return r.b.subscription;
}
/** PayPal で承認・支払い → PayPal と同じ戻り先へ */
async function approveAndReturn(tab, sid, planId) {
  st.pay(sid, amountOf(planId));
  const ret = new URL(st.subs[sid].returnUrl);
  ret.searchParams.set('subscription_id', sid);
  ret.searchParams.set('ba_token', `BA-${sid}`);
  ret.searchParams.set('token', `EC-${sid}`);
  await tab.goto(ret.href);
}
/** マジックリンクでログイン（login 画面に入力 → 送られたリンクを、指定のタブ＝別ブラウザでも可で開いて「ログインする」）*/
async function loginByMagicLink({ loginTab, linkTab, email }) {
  await waitFor(() => loginTab.ev(`!!document.getElementById('email')`), 30000, 'ログイン画面');
  const before = Object.keys(st.tables.AuthTokens).length;
  await loginTab.ev(`(() => { const i = document.getElementById('email'); i.value = ${JSON.stringify(email)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('submitBtn').click(); return true; })()`);
  await waitFor(() => Object.keys(st.tables.AuthTokens).length > before, 30000, 'ログインリンクの発行').catch(async (e) => {
    console.error('login state:', await loginTab.url(), await loginTab.ev('document.readyState + " | " + (document.getElementById("message")||{}).textContent'), st.log.slice(-5).join(' / '));
    throw e;
  });
  const tok = Object.values(st.tables.AuthTokens).filter((f) => String(f.Email).toLowerCase() === email.toLowerCase()).pop().Token;
  await linkTab.goto(`${APP}/auth/verify/?token=${encodeURIComponent(tok)}`);
  try {
    await waitFor(() => linkTab.ev(`!!document.getElementById('login-btn') && !document.getElementById('login-btn').hidden`), 30000, 'ログインボタン');
  } catch (e) {
    console.error('verify page:', await linkTab.url(), (await linkTab.ev('document.body ? document.body.innerText.slice(0, 400) : ""')).replace(/\s+/g, ' '));
    throw e;
  }
  await linkTab.ev(`document.getElementById('login-btn').click(), true`);
}
/** 画面上で実際に見えて押せるか（要素の中心のヒットテスト） */
const visibleExpr = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') return false; e.scrollIntoView({ block: 'center' }); const r2 = e.getBoundingClientRect(); const hit = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2); return !!hit && (hit === e || e.contains(hit) || hit.contains(e)); })()`;

async function assertPremiumLanding(tab, dest, label) {
  const at = await waitFor(async () => { const u = await tab.url(); return u === dest || (u.startsWith(dest.split('#')[0]) && dest.includes('#') && u.endsWith(dest.slice(dest.indexOf('#')))) ? u : null; }, 60000, `${label}: ${dest} への自動遷移`);
  check(at === dest, `${label}: 追加クリックなしで ${dest} に到達`, at);
  if (dest === '/dashboard/?from=purchase#premium-predictions') {
    try {
      await waitFor(() => tab.ev(visibleExpr('#premium-predictions')), 30000, `${label}: Premium 枠の表示`);
    } catch (e) {
      console.error('dashboard state:', await tab.ev('JSON.stringify(window.__AK_SERVER_AUTH__)'), await tab.ev(`document.getElementById('premium-predictions').style.display`));
      throw e;
    }
    const jra = await tab.ev(visibleExpr('#premium-predictions [data-premium-venue="jra"]'));
    const nankan = await tab.ev(visibleExpr('#premium-predictions [data-premium-venue="nankan"]'));
    const focus = await tab.ev(`document.getElementById('premium-predictions').classList.contains('post-purchase-focus')`);
    check(jra && nankan, `${label}: 中央・南関の両方のボタンが見えて押せる`);
    check(focus, `${label}: Premium 枠を強調`);
    // 中央を押す → 有料ページがサーバーの gate を通る（ログイン画面へ飛ばされない）
    await tab.ev(`document.querySelector('#premium-predictions [data-premium-venue="jra"]').click(), true`);
    const u = await waitFor(async () => { const x = await tab.url(); return x.startsWith('/premium-prediction/jra') ? x : null; }, 60000, `${label}: 中央の Premium 予想`);
    check(!!u, `${label}: 中央の Premium 予想ページを開ける`, u);
  } else {
    const gated = await waitFor(() => tab.ev(`!!document.querySelector('#access-control[data-server-verified="1"]')`), 15000, `${label}: gate`).catch(async () => {
      console.error('premium page state:', await tab.url(), await tab.ev(`(document.getElementById('access-control')||{}).outerHTML?.slice(0,200) || document.body.innerText.slice(0,300)`));
      return false;
    });
    check(gated, `${label}: Premium 予想ページがサーバーの権限確認を通過（data-server-verified=1）`);
  }
}

// ---- シナリオ --------------------------------------------------------------------------------
let exitCode = 1;
try {
  step(`偽の外部 ${FAKE} / アプリ ${APP}`);
  if (!(await waitHttp(`http://127.0.0.1:${ASTRO_PORT}/`, 120000))) throw new Error(`astro dev が起動しない\n${astroOut.slice(-2000)}`);
  step('astro dev 起動済み');

  // H: 既存の会員の通常ログイン（購入なし）は従来どおりマイページ
  {
    const label = '購入なしの通常ログイン';
    step(label);
    await startBrowser();
    const email = `e2e.plain.${Date.now()}@example.invalid`;
    seedMember(email, { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': futureYmd(200), PaymentMethod: 'Bank Transfer' });
    const tab = await newTab();
    await tab.goto(`${APP}/login/`);
    await loginByMagicLink({ loginTab: tab, linkTab: tab, email });
    const u = await waitFor(async () => { const x = await tab.url(); return x.startsWith('/dashboard') ? x : null; }, 60000, `${label}: マイページ`);
    check(u === '/dashboard/', `${label}: 従来どおり /dashboard/`, u);
    await tab.close();
  }


  // A〜D: 未ログインで申込 → 支払い → 完了表示 → ログイン画面へ自動 → メールアプリ内ブラウザ（別コンテキスト）でリンク → Premium
  const guestCases = [
    { plan: 'premium', dest: '/dashboard/?from=purchase#premium-predictions', mobile: true },
    { plan: 'premium-jra', dest: '/premium-prediction/jra/', mobile: false },
    { plan: 'premium-nankan', dest: '/premium-prediction/nankan/', mobile: true },
    { plan: 'premium-annual', dest: '/dashboard/?from=purchase#premium-predictions', mobile: false },
  ];
  for (const c of guestCases) {
    const label = `未ログイン ${c.plan}${c.mobile ? '（スマホ）' : '（PC）'}`;
    step(label);
    await startBrowser();
    const email = `e2e.${c.plan}.${Date.now()}@example.invalid`;
    const buyer = await newTab({ mobile: c.mobile });
    const sid = await startCheckout(buyer, c.plan, email);
    await approveAndReturn(buyer, sid, c.plan);
    await waitFor(() => buyer.ev(`document.getElementById('ccTitle').textContent === 'お申し込みが完了しました'`), 60000, `${label}: 完了表示`);
    check(true, `${label}: 戻り先で購入完了を表示`);
    check(await buyer.ev(`window['ga-disable-G-BTDCZE1B13'] === true`), `${label}: ローカルでは GA4 へ送らない（本番 GA4 を汚さない）`);
    const loginUrl = await waitFor(async () => { const u = await buyer.url(); return u.startsWith('/login/') ? u : null; }, 30000, `${label}: ログイン画面への自動遷移`);
    check(loginUrl === '/login/?from=paypal', `${label}: ログイン画面へ自動遷移`, loginUrl);
    await waitFor(() => buyer.ev(`!document.getElementById('reason-notice').hidden`), 15000, `${label}: 購入直後の案内`);
    const notice = await buyer.ev(`document.querySelector('#reason-notice .rn-title').textContent`);
    check(notice === 'お申し込みありがとうございます', `${label}: ログイン画面に購入直後の案内`, notice);
    const [rid, f] = recordOf(email);
    check(f['プラン'] === 'Premium' && f.Status === 'active', `${label}: 権限付与（Premium・active）`, `${f['プラン']}/${f.PlanType}/${f.VenueAccess || 'all'}`);
    check(st.redis.has(postPurchaseKey(rid)), `${label}: 購入直後の印（サーバー側）`);
    // メールアプリ内ブラウザ: Cookie も localStorage も無い別コンテキストでリンクを開く
    const inApp = await newTab({ mobile: c.mobile });
    await loginByMagicLink({ loginTab: buyer, linkTab: inApp, email });
    await assertPremiumLanding(inApp, c.dest, `${label} → メールアプリ内ブラウザでログイン`);
    check(!st.redis.has(postPurchaseKey(rid)), `${label}: 印は 1 回で消える`);
    await buyer.close(); await inApp.close();
  }

  // E・F: ログイン済み（Light 会員）が申込 → 支払い → 戻り先から追加クリックなしで Premium
  for (const c of [
    { plan: 'premium', dest: '/dashboard/?from=purchase#premium-predictions', mobile: false },
    { plan: 'premium-nankan', dest: '/premium-prediction/nankan/', mobile: true },
  ]) {
    const label = `ログイン済み ${c.plan}${c.mobile ? '（スマホ）' : '（PC）'}`;
    step(label);
    await startBrowser();
    const email = `e2e.member.${c.plan}.${Date.now()}@example.invalid`;
    const rid = seedMember(email, { 'プラン': 'Light', PlanType: 'Annual', Status: 'active', '有効期限': futureYmd(30), PaymentMethod: 'Bank Transfer' });
    const tab = await newTab({ mobile: c.mobile });
    await tab.goto(`${APP}/login/`);
    await loginByMagicLink({ loginTab: tab, linkTab: tab, email });
    await waitFor(async () => (await tab.url()).startsWith('/dashboard'), 60000, `${label}: 事前ログイン`);
    const sid = await startCheckout(tab, c.plan, null);
    await approveAndReturn(tab, sid, c.plan);
    await waitFor(() => tab.ev(`document.getElementById('ccTitle').textContent === 'お申し込みが完了しました'`), 60000, `${label}: 完了表示`);
    await assertPremiumLanding(tab, c.dest, label);
    const f = st.tables.Customers[rid];
    check(f['プラン'] === 'Premium' && f.PaymentMethod === 'PayPal', `${label}: 権限付与`, `${f['プラン']}/${f.VenueAccess || 'all'}`);
    await tab.close();
  }

  // G: 確認中（未払い）は Premium へ移らない・URL だけ（別ブラウザ）は 401 の案内でログイン／問い合わせ、再決済を促さない
  {
    const label = '確認中・確認できない';
    step(label);
    await startBrowser();
    const email = `e2e.pending.${Date.now()}@example.invalid`;
    const tab = await newTab();
    const sid = await startCheckout(tab, 'premium', email);
    const ret = new URL(st.subs[sid].returnUrl); ret.searchParams.set('subscription_id', sid);
    await tab.goto(ret.href);
    await sleep(8000);
    const u = await tab.url();
    const title = await tab.ev(`document.getElementById('ccTitle').textContent`);
    check(u.startsWith('/checkout/paypal-subscription-return/'), `${label}: 未払いは遷移しない`, `${u} / ${title}`);
    check(/確認しています/.test(title), `${label}: 確認中を表示`, title);
    const [rid, f] = recordOf(email);
    check(f['プラン'] !== 'Premium' && !st.redis.has(postPurchaseKey(rid)), `${label}: 権限も印も無し`);
    const other = await newTab();
    st.pay(sid, amountOf('premium'));
    await other.goto(ret.href);
    await waitFor(() => other.ev(`document.getElementById('ccTitle').textContent !== 'お支払いを確認しています…'`), 30000, `${label}: 401 の案内`).catch(async (e) => {
      console.error('other tab:', await other.url(), await other.ev(`document.readyState + ' | ' + performance.getEntriesByType('resource').map((x) => x.name.replace(location.origin, '') + ':' + Math.round(x.duration)).filter((x) => /netlify|astro|@vite|\.js/.test(x)).slice(-8).join(' ')`));
      throw e;
    });
    await sleep(5000);
    const t2 = await other.ev(`document.getElementById('ccTitle').textContent`);
    const links = await other.ev(`[...document.querySelectorAll('#ccActions a')].map((a) => a.getAttribute('href')).join(' ')`);
    const body = await other.ev(`document.querySelector('.co-card').innerText`);
    check((await other.url()).startsWith('/checkout/paypal-subscription-return/'), `${label}: URL だけ（別ブラウザ）は自動で移らない`, t2);
    check(/\/login\//.test(links), `${label}: ログインの導線`, links);
    check(!/もう一度お支払いください|再決済/.test(body), `${label}: 再決済を促さない`);
    await tab.close(); await other.close();
  }

  check(dialogs.length === 0, 'alert/confirm などのダイアログ 0', dialogs.join(' | '));
  check(st.unknownFormulas.length === 0, '偽の Airtable が知らない検索式 0', st.unknownFormulas.slice(0, 3).join(' | '));
  check((globalThis.__akE2eBlocked || []).length === 0, '本物の外部への通信 0（このプロセス）', (globalThis.__akE2eBlocked || []).join(','));
  exitCode = fails.length ? 1 : 0;
} catch (e) {
  console.error('❌ E2E 中断:', e.message);
  fails.push(`中断: ${e.message}`);
} finally {
  console.log(`\nPASS ${passes.length} / FAIL ${fails.length}`);
  for (const f of fails) console.log(`  ❌ ${f}`);
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* 片付けの失敗は無視 */ } }
  fake.close();
  process.exit(exitCode);
}
