/**
 * e2e-admin-plus.mjs — Premium Plus 管理画面の実 DOM E2E
 *
 * ## なぜ要るか（2026-09-10 MK 指摘）
 *
 * > e2eでテスト確認検証しないの？
 * > 実画面でしか見つからない不具合を拾うE2Eを拡充してください
 *
 * ロジックテストが全部通っているのに本番で壊れていた事例が **2 件**あった。
 *
 * | 起きたこと | ロジックテストで捕まらなかった理由 |
 * |---|---|
 * | 「今すぐ販売可」なのに「9/19 から購入可」と出た | 判定は正しく `purchaseEnabled: true`。**見出しの文言**が誤り |
 * | 全行から「詳細・操作」ボタンが消えた | 生成はしていたが `appendChild` が抜けていた。**ソース検査では通る** |
 *
 * この 2 つはどちらも「**要素を作っているが DOM に無い**」「**表示と実状態が食い違う**」型。
 * 実ページを開いて DOM を見るしか検出手段が無いので、ここで守る。
 *
 * ## 何に対して実行するか
 *
 * **ビルド成果物（`dist/`）を静的配信して開く。**
 *   - 管理画面は `prerender = true` なので `dist/admin/premium-plus-eligibility/index.html` が実体
 *   - Edge の Basic 認証は Netlify 上でしか動かないので、**認証を触らずに**画面を開ける
 *     （ローカル検証のために edge function を退避する必要がない）
 *
 * ## 本番に触れないこと
 *
 *   - 管理 API はブラウザ側の `fetch` 差し替えで**合成データ**を返す
 *   - 書き込み（`setSalePause` / `update`）は**スタブ内のメモリだけ**を書き換える。
 *     これにより「操作 → 状態が実際に切り替わる」までを実 DOM で検証できる
 *   - Airtable / Redis / SendGrid へは 1 度も接続しない
 *
 * ## 使い方
 *
 *   npm run build && npm run e2e:admin-plus
 *
 * 環境変数:
 *   E2E_BROWSER  … Chromium 系のバイナリ（未指定なら既知の場所を順に探す）
 *   E2E_DEV_URL  … 既に起動している dev サーバーを使う（例 http://localhost:4321）。
 *                  未指定なら**このスクリプトが自分で `astro dev` を起動して終了時に落とす**。
 *   E2E_NO_DEV=1 … dev サーバーを使わない（未認証チェックは実行できない＝CI では失敗させる）
 *
 * ⚠️ dev サーバーを CI の step でバックグラウンド起動しないこと。
 *    Actions の step が子プロセスのために終了できず **hang する**（2026-09-10 に実際に起きた）。
 *    起動と停止は必ずこのスクリプトの中で完結させる。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const PAGE_PATH = '/admin/premium-plus-eligibility/index.html';

/**
 * Chromium のプロファイル置き場。
 *
 * ⚠️ **repo の中に作らないこと。**
 *    2026-09-10 に `astro-site/.e2e-profile/` を repo 内に作ってしまい、
 *    Cookies / Login Data / History / Local State などの Chromium 内部ファイル
 *    **316 件が PR に混入**した（changed files 321 件）。
 *    実 secret / session / 顧客 PII は含まれていなかったが、
 *    そもそも repo に入る場所へ作ってはいけない。
 *    OS の一時ディレクトリへ作り、**finally で必ず削除**する。
 */
const PROFILE_DIR = await mkdtemp(join(tmpdir(), 'ak-e2e-profile-'));
let profileRemoved = false;
async function removeProfile() {
  if (profileRemoved) return;
  profileRemoved = true;
  await rm(PROFILE_DIR, { recursive: true, force: true }).catch(() => {});
}
// 異常終了（early exit / 例外）でも消えるよう、exit では同期 API で片付ける
process.on('exit', () => {
  if (profileRemoved) return;
  profileRemoved = true;
  try { rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
});

/**
 * 進捗ログ。**CI で無出力のまま固まると原因が分からない**ため、各フェーズで必ず出す。
 * 2026-09-10 に CI で 10 分無出力のままタイムアウトし、切り分けに手間取った。
 */
const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const fails = [];
const passes = [];
const check = (ok, msg) => { (ok ? passes : fails).push(msg); if (!ok) console.error('  ✗ ' + msg); else console.log('  ✓ ' + msg); };

// ── 前提 ────────────────────────────────────────────────────
if (!existsSync(join(DIST, PAGE_PATH))) {
  console.error('⛔ ビルド成果物がありません。先に `npm run build` を実行してください。');
  console.error('   期待: dist' + PAGE_PATH);
  process.exit(2);
}

const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER,
  process.env.CHROME_BIN,
  process.env.CHROMIUM_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!BROWSER) {
  // ⚠️ ここで puppeteer 等を勝手に入れない（依存を増やさない方針）。理由を出して落とす。
  console.error('⛔ Chromium 系ブラウザが見つかりません。E2E を実行できません。');
  console.error('   探した場所:');
  for (const p of BROWSER_CANDIDATES) console.error('     - ' + p);
  console.error('   E2E_BROWSER にパスを指定してください（依存パッケージは追加しません）。');
  process.exit(2);
}

// ── dist を静的配信（依存を増やさない素の http サーバー）──────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
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
step('dist の静的配信を開始');
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 未認証チェック用の dev サーバー（自前で起動し、必ず落とす）──────
//    `dist` の静的配信では Edge 認証も Functions も動かないため、
//    この 2 観点だけは dev サーバーが要る。
let devProc = null;
let devBase = process.env.E2E_DEV_URL ? process.env.E2E_DEV_URL.replace(/\/$/, '') : null;
let devError = null;

async function startDevServer() {
  if (devBase || process.env.E2E_NO_DEV === '1') return;
  const port = 4300 + Math.floor(Math.random() * 200);
  devProc = spawn('npx', ['astro', 'dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', detached: false,
    // admin の認証情報は**渡さない**。未設定なら fail closed で 401 になるのが正しい挙動で、
    // それをそのまま検証する。
    env: { ...process.env, ADMIN_BASIC_AUTH_USER: '', ADMIN_BASIC_AUTH_PASSWORD: '' },
  });
  const base = `http://127.0.0.1:${port}`;
  // ⚠️ 疎通確認は **public/ の静的ファイル**へ投げる。`/` は SSR を走らせるので
  //    CI では返るまでに時間がかかり、待ちが終わらない（2026-09-10 に 15 分ハングした）。
  // ⚠️ **1 回ごとに時間制限**を付ける。付けないと fetch が返らないまま
  //    ループが 1 周目から進まず、上限 90 秒に到達しない。
  const deadlineAt = Date.now() + 120000;
  let probes = 0;
  while (Date.now() < deadlineAt) {
    probes += 1;
    if (probes % 10 === 0) step(`dev サーバーの起動を待っています（${probes} 回目）`);
    const ok = await fetch(base + '/robots.txt', { signal: AbortSignal.timeout(4000) })
      .then(() => true).catch(() => false);
    if (ok) { devBase = base; return; }
    if (devProc.exitCode !== null) { devError = `dev サーバーが起動前に終了しました (exit ${devProc.exitCode})`; return; }
    await sleep(1000);
  }
  devError = 'dev サーバーが 120 秒以内に応答しませんでした';
}
const stopDevServer = () => { if (devProc && devProc.exitCode === null) { try { devProc.kill('SIGTERM'); } catch {} } };
process.on('exit', stopDevServer);

step('未認証チェック用の dev サーバーを起動中…');
await startDevServer();
step(devBase ? 'dev サーバー準備完了' : `dev サーバーなし（${devError || 'E2E_NO_DEV'}）`);

// ── Chromium を起動して CDP で操作 ──────────────────────────
step(`Chromium 起動: ${BROWSER.split('/').pop()}`);
const proc = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  // ⚠️ CI（GitHub Actions の runner）ではサンドボックスが使えず起動できないことがある
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
if (!wsUrl) {
  console.error('⛔ Chromium の DevTools に接続できませんでした'
    + (proc.exitCode !== null ? `（exit ${proc.exitCode}）` : '（30 秒待っても ws URL が出ませんでした）'));
  if (browserErr.trim()) console.error('--- ブラウザの出力 ---\n' + browserErr.trim().slice(0, 1500));
  server.close(); proc.kill(); process.exit(2);
}
step('DevTools の ws URL を取得');

const browserWs = new WebSocket(wsUrl);
// ⚠️ 時間制限を入れる。open も error も来ないと**永久に待ち続ける**（CI で実際に起きた）
await withDeadline(
  new Promise((r, j) => { browserWs.onopen = r; browserWs.onerror = () => j(new Error('WebSocket error')); }),
  20000, 'DevTools への WebSocket 接続',
);
step('CDP 接続');
let msgId = 0; const pending = new Map();
/** 応答が返らない CDP 呼び出しで固まらないよう、必ず時間制限を付ける */
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} が ${ms}ms で応答しませんでした`)), ms); }),
  ]);
}
const rpc = (ws) => (method, params = {}, sessionId) => withDeadline(new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
}), 60000, `CDP ${method}`);
browserWs.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const bsend = rpc(browserWs);
const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await bsend('Target.attachToTarget', { targetId, flatten: true });
const send = (method, params) => bsend(method, params, sessionId);

await send('Page.enable');
await send('Runtime.enable');

/** ブラウザ内で式を評価（例外はそのまま投げる） */
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

// ── 管理 API のスタブ（**書き込みがスタブ内の状態を実際に変える**）──
//    これが無いと「押したのに表示が変わらない」型の不具合を検出できない。
const STUB_SRC = `
(() => {
  const nowIso = new Date().toISOString();
  const mk = (o) => ({
    plan: 'Premium', planType: 'Lifetime', hasSanrenpuku: false,
    salePauseWritable: true, reopenCouponWritable: true,
    reopenCouponClaimed: false, reopenCouponLabel: 'クーポン未取得',
    reopenStart: { startsAtIso: '' }, route: 'premium_30d', upsellTarget: 'auto',
    updatedAt: nowIso, updatedBy: 'MK', ...o,
  });
  // 段階公開の予定を算出するための資格確定日
  const today = nowIso;
  const long = new Date(Date.now() - 20 * 86400000).toISOString();

  const db = {
    // 本番の Audenki99 相当: 今日 eligible + override=phase4（＝今日から買える）
    recAUD: mk({ recordId: 'recAUD', email: 'audenki99@gmail.com', name: 'Hisaji yamaguchi',
      eligibility: 'eligible', phase: 4, overrideApplied: true, purchaseEnabled: true,
      showProductPage: true, showPurchaseCta: true, salePaused: false, eligibleAt: today }),
    // 段階公開で解禁済み（過去日）
    recSALE: mk({ recordId: 'recSALE', email: 'sale@example.com',
      eligibility: 'eligible', phase: 4, overrideApplied: false, purchaseEnabled: true,
      showProductPage: true, showPurchaseCta: true, salePaused: false, eligibleAt: long }),
    // 段階表示中（まだ買えない）
    recSTG: mk({ recordId: 'recSTG', email: 'staged@example.com',
      eligibility: 'eligible', phase: 2, overrideApplied: false, purchaseEnabled: false,
      showProductPage: false, salePaused: false, eligibleAt: today }),
    // 販売停止中
    recPSE: mk({ recordId: 'recPSE', email: 'paused@example.com',
      eligibility: 'eligible', phase: 4, overrideApplied: false, purchaseEnabled: false,
      showProductPage: false, salePaused: true, salePausedBy: 'MK', salePausedAt: nowIso,
      salePauseReason: '申込殺到', eligibleAt: long }),
    // 対象外（販売対象外 / 資格保留）
    recBLK: mk({ recordId: 'recBLK', email: 'blocked@example.com',
      eligibility: 'blocked', phase: 1, overrideApplied: false, purchaseEnabled: false, salePaused: false }),
    recRVW: mk({ recordId: 'recRVW', email: 'review@example.com',
      eligibility: 'review', phase: 1, overrideApplied: false, purchaseEnabled: false, salePaused: false }),
  };

  /** 停止 / 再開 / 資格変更を**実際に反映**する（表示と実状態の食い違いを検出するため） */
  function applyWrite(body) {
    const r = db[body.recordId];
    if (!r) return { ok: false, error: 'not found' };
    if (body.action === 'setSalePause') {
      r.salePaused = body.paused === true;
      r.salePausedAt = new Date().toISOString();
      r.salePausedBy = body.actor || 'e2e';
      r.salePauseReason = body.reason || '';
      // 停止中は買えない / 商品内容も出さない
      r.purchaseEnabled = !r.salePaused && (r.phase === 4 || r.overrideApplied === true)
        && r.eligibility === 'eligible';
      r.showProductPage = !r.salePaused && r.phase >= 3;
      r.reopenLaunch = launchOf(r);
      return { ok: true, label: r.salePaused ? '一時停止中' : '販売中' };
    }
    if (body.action === 'update') {
      if (body.eligibility) r.eligibility = body.eligibility;
      if (body.override === 'phase4') { r.overrideApplied = true; r.phase = 4; }
      if (body.override === '') r.overrideApplied = false;
      r.purchaseEnabled = !r.salePaused && (r.phase === 4 || r.overrideApplied === true)
        && r.eligibility === 'eligible';
      r.showProductPage = !r.salePaused && (r.phase >= 3 || r.overrideApplied === true);
      r.reopenLaunch = launchOf(r);
      return { ok: true, label: r.eligibility, override: r.overrideApplied ? 'phase4' : '' };
    }
    if (body.action === 'reopenStart') {
      // クーポンの 14 日間を開始するだけ。**販売可否は変えない**
      r.reopenStart = { startsAtIso: new Date().toISOString() };
      r.reopenLaunch = launchOf(r);
      return { ok: true, startWritten: true };
    }
    return { ok: false, error: 'unknown action' };
  }

  function launchOf(r) {
    const started = !!(r.reopenStart && r.reopenStart.startsAtIso);
    const state = started ? (r.salePaused ? 'paused_after_start' : 'live') : 'not_started';
    const action = state === 'not_started'
      ? { kind: 'start', label: '▶ クーポンの利用期間（14日）を開始する', enabled: true,
        note: '14日間の開始を確定します。', confirmText: 'クーポンの利用期間を開始します',
        showPauseSwitch: r.salePaused !== true, showResumeSwitch: r.salePaused === true }
      : { kind: 'none', label: '', enabled: false, note: '',
        showPauseSwitch: r.salePaused !== true, showResumeSwitch: r.salePaused === true };
    return { state, action };
  }
  for (const r of Object.values(db)) r.reopenLaunch = launchOf(r);

  window.__E2E = {
    db,
    writes: [],
    // 「販売可なのに未案内」の要対応（対象は購入可能な会員）
    notified: { available: true, notified: 0, never: 2, undelivered: 0, needsAction: 2, note: '案内: 未送信 2 名' },
  };

  const real = window.fetch;
  window.fetch = async (u, init) => {
    const url = String(u && u.url ? u.url : u);
    if (!url.includes('premium-plus-eligibility')) return real(u, init);
    let body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch {}
    const READ_ONLY = ['list', 'preview', 'lookup'];
    if (body.action && !READ_ONLY.includes(body.action)) {
      window.__E2E.writes.push(body);
      const out = applyWrite(body);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rows = Object.values(window.__E2E.db).map((r) => ({ ...r }));
    // 書き込み後の**読み直し**（refreshOne）。本物と同じ形で 1 件返す。
    // ⚠️ これが無いと「操作後に一覧が更新されない」を誤って製品の不具合と誤診する。
    if (body.action === 'lookup') {
      const hit = rows.filter((r) => r.recordId === body.recordId
        || (body.email && String(r.email).toLowerCase() === String(body.email).toLowerCase()));
      return new Response(JSON.stringify({ ok: true, found: hit.length > 0, rows: hit,
        notified: window.__E2E.notified }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      ok: true, writeEnabled: true, overrideEnabled: true,
      salePause: { writable: true }, counts: { total: rows.length },
      notified: window.__E2E.notified, rows,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { sessionStorage.setItem('pp-admin-secret', 'e2e'); } catch {}
  // 確認ダイアログは E2E では自動承諾（危険操作の有無自体は別に検証する）
  window.__E2E.confirms = [];
  window.confirm = (m) => { window.__E2E.confirms.push(String(m)); return true; };
  window.prompt = () => 'e2e';
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB_SRC });

const openPage = async () => {
  await send('Page.navigate', { url: BASE + PAGE_PATH });
  await sleep(1200);
  await evaluate(`(async () => {
    const el = document.getElementById('secret');
    if (el) { el.value = 'e2e'; el.dispatchEvent(new Event('change')); }
    const actor = document.getElementById('actor');
    if (actor) { actor.value = 'e2e'; actor.dispatchEvent(new Event('change')); }
    const b = document.getElementById('reload'); if (b) b.click();
    await new Promise((r) => setTimeout(r, 1200));
    return 'ok';
  })()`);
};

console.log(`\n■ 実 DOM E2E（${BROWSER.split('/').pop()} / dist 配信）\n`);
step('管理画面を開く');
await openPage();
step('一覧の描画を確認');

// ── 1. 上部 4 カードと一覧の一致 ──────────────────────────────
const snap = await evaluate(`(() => {
  const t = (e) => (e ? e.textContent.trim().replace(/\\s+/g, ' ') : null);
  const cards = [...document.querySelectorAll('.sumcard')].map((c) => ({
    key: c.dataset.state, n: Number(t(c.querySelector('.sc-n'))), l: t(c.querySelector('.sc-l')) }));
  const rows = [...document.querySelectorAll('#rows tr')].map((tr) => ({
    email: t(tr.querySelector('.c-cust .em')),
    badge: t(tr.querySelector('.c-state .badge')),
    reason: t(tr.querySelector('.c-state .state-reason')),
    ops: [...tr.querySelectorAll('.c-ops .btn-rowact')].map((b) => ({
      label: t(b.querySelector('.bra-l')), hint: t(b.querySelector('.bra-h')), disabled: b.disabled })),
    detail: !!tr.querySelector('.c-ops .btn-detail'),
    clickable: tr.classList.contains('row-clickable'),
  }));
  return { cards, rows };
})()`);

check(snap.cards.length === 4, '上部に 4 カードが出る');
check(snap.cards.map((c) => c.l).join(',') === '購入可能,販売停止中,段階表示中,対象外',
  `カードの名称と並びが正しい（実際: ${snap.cards.map((c) => c.l).join(',')}）`);
const byLabel = Object.fromEntries(snap.rows.map((r) => [r.email, r.badge]));
check(byLabel['audenki99@gmail.com'] === '購入可能', '今すぐ販売可の会員が「購入可能」で出る');
check(byLabel['sale@example.com'] === '購入可能', '段階公開で解禁済みの会員が「購入可能」で出る');
check(byLabel['staged@example.com'] === '段階表示中', '待機中の会員が「段階表示中」で出る');
check(byLabel['paused@example.com'] === '販売停止中', '停止中の会員が「販売停止中」で出る');
check(byLabel['blocked@example.com'] === '対象外' && byLabel['review@example.com'] === '対象外',
  '資格が無い会員が「対象外」で出る');
const countOf = (k) => (snap.cards.find((c) => c.key === k) || {}).n;
const rowCountOf = (label) => snap.rows.filter((r) => r.badge === label).length;
check(countOf('sale') === rowCountOf('購入可能') && countOf('sale') === 2,
  `カード「購入可能」の件数が一覧と一致する（card=${countOf('sale')} / rows=${rowCountOf('購入可能')}）`);
check(countOf('paused') === rowCountOf('販売停止中'), 'カード「販売停止中」の件数が一覧と一致する');
check(countOf('staged') === rowCountOf('段階表示中'), 'カード「段階表示中」の件数が一覧と一致する');
check(countOf('out') === rowCountOf('対象外'), 'カード「対象外」の件数が一覧と一致する');

// ── 2. 「対象外」の理由が一覧で区別できる ─────────────────────
const blk = snap.rows.find((r) => r.email === 'blocked@example.com');
const rvw = snap.rows.find((r) => r.email === 'review@example.com');
check(blk && blk.reason === '販売対象外' && rvw && rvw.reason === '資格保留',
  '「対象外」の理由（販売対象外 / 資格保留）が一覧で区別できる');

// ── 3. 行の操作（要素が DOM にあり、押せる）────────────────────
check(snap.rows.every((r) => r.detail), '全行に「詳細・操作」ボタンが DOM にある');
check(snap.rows.every((r) => r.clickable), '全行がクリック可能になっている');
const aud = snap.rows.find((r) => r.email === 'audenki99@gmail.com');
check(aud.ops.length === 1 && aud.ops[0].label === '販売を停止' && aud.ops[0].disabled === false,
  '販売中の行に「販売を停止」が出て押せる');
const pse = snap.rows.find((r) => r.email === 'paused@example.com');
check(pse.ops.length === 1 && pse.ops[0].label === '販売を再開' && pse.ops[0].disabled === false,
  '停止中の行に「販売を再開」が出て押せる');
check(snap.rows.every((r) => r.ops.every((o) => o.hint)), '操作ボタンに「押すとどうなるか」が併記されている');
check(blk.ops.length === 0 && rvw.ops.length === 0, '対象外に無意味な販売操作を出さない');

// ── 4. 詳細への到達（4 経路）────────────────────────────────
for (const [name, expr] of [
  ['行クリック', `[...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('audenki99')).click()`],
  ['メールアドレス', `[...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('audenki99')).querySelector('.c-cust .em').click()`],
  ['状態バッジ', `[...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('audenki99')).querySelector('.c-state .badge').click()`],
  ['詳細・操作ボタン', `[...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('audenki99')).querySelector('.c-ops .btn-detail').click()`],
]) {
  const opened = await evaluate(`(async () => {
    const p = document.getElementById('dtBody'); if (p) p.innerHTML = '';
    ${expr};
    await new Promise((r) => setTimeout(r, 500));
    const e = document.querySelector('.dt-email');
    return e ? e.textContent.trim() : null;
  })()`);
  check(String(opened || '').includes('audenki99'), `${name} から詳細パネルへ進める`);
}

// ── 5. 今すぐ販売可: 未来の購入可能日を出さない ─────────────────
const detail = await evaluate(`(async () => {
  const tr = [...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('audenki99'));
  tr.click(); await new Promise((r) => setTimeout(r, 600));
  const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : null; };
  const kv = {};
  const dts = [...document.querySelectorAll('.dt-now-kv dt')];
  const dds = [...document.querySelectorAll('.dt-now-kv dd')];
  dts.forEach((d, i) => { kv[d.textContent.trim()] = (dds[i] || {}).textContent?.trim().replace(/\\s+/g, ' '); });
  return {
    badge: t('.dt-now-badge'), headline: t('.dt-now-head'), stage: t('.dt-now-stage'), kv,
    actions: [...document.querySelectorAll('.dt-act')].map((b) => ({
      label: (b.querySelector('.dt-act-l') || {}).textContent, disabled: b.disabled })),
    foldClosed: !!document.querySelector('.dt-more') && !document.querySelector('.dt-more').open,
    hasDetailSections: ['基本情報', '通常操作'].every((h) =>
      [...document.querySelectorAll('.dt-more h3')].some((x) => x.textContent.includes(h))),
  };
})()`);
const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const futureInHeadline = (String(detail.headline).match(/(\d{4}-\d{2}-\d{2}) から購入できる/) || [])[1];
check(!futureInHeadline || futureInHeadline <= todayJst,
  `今すぐ販売可の会員に未来の購入可能日を出さない（見出し: ${detail.headline}）`);
check(detail.badge === '購入可能', '詳細のバッジが「購入可能」');
check(!detail.actions.some((a) => (a.label || '').includes('今すぐ販売可')),
  'すでに買えるなら「今すぐ販売可」を出さない');
check(detail.foldClosed === true, '詳細の折りたたみが既定で閉じている');
check(detail.hasDetailSections === true, '詳細情報（基本情報 / 通常操作）が折りたたみ内に残っている');

// ── 6. クーポン14日と販売可否を混同しない ────────────────────
check(Object.keys(detail.kv).some((k) => k.includes('クーポンの利用期間')),
  '「クーポンの利用期間（14日）」として別項目で出る');
check(!Object.keys(detail.kv).some((k) => k.includes('再募集')), '「再募集」という誤読される名称を出さない');
const couponRes = await evaluate(`(async () => {
  const before = JSON.stringify(window.__E2E.db.recAUD.purchaseEnabled);
  const b = [...document.querySelectorAll('.dt-act')].find((x) => (x.textContent || '').includes('クーポンの利用期間'));
  if (!b) return { skipped: true };
  b.click(); await new Promise((r) => setTimeout(r, 1200));
  return { before, after: JSON.stringify(window.__E2E.db.recAUD.purchaseEnabled),
    started: !!window.__E2E.db.recAUD.reopenStart.startsAtIso,
    writes: window.__E2E.writes.map((w) => w.action) };
})()`);
check(couponRes.skipped !== true, 'クーポン期間の開始ボタンが DOM にある');
check(couponRes.before === couponRes.after,
  `クーポン14日の開始で販売可否が変わらない（before=${couponRes.before} after=${couponRes.after}）`);
check(couponRes.started === true, 'クーポン期間の開始が実際に記録される');

// ── 7. 販売停止 → 表示と操作が切り替わる（古い状態が残らない）──
await openPage();
const afterPause = await evaluate(`(async () => {
  const tr = () => [...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('sale@example.com'));
  const t = (e) => (e ? e.textContent.trim().replace(/\\s+/g, ' ') : null);
  const before = { badge: t(tr().querySelector('.c-state .badge')), op: t(tr().querySelector('.c-ops .btn-rowact .bra-l')) };
  window.__E2E.trace = [];
  const origFetch = window.fetch;
  window.fetch = async (u, init) => { try { window.__E2E.trace.push(JSON.parse((init && init.body) || '{}').action); } catch {} return origFetch(u, init); };
  tr().querySelector('.c-ops .btn-rowact').click();
  await new Promise((r) => setTimeout(r, 2500));
  const row = tr();
  return { before, after: { badge: t(row.querySelector('.c-state .badge')), op: t(row.querySelector('.c-ops .btn-rowact .bra-l')) },
    dbPaused: window.__E2E.db.recSALE.salePaused,
    writes: window.__E2E.writes.filter((w) => w.action === 'setSalePause').map((w) => ({ id: w.recordId, p: w.paused })),
    trace: window.__E2E.trace, msg: (document.getElementById('message') || {}).textContent,
    confirms: window.__E2E.confirms.length,
    cardPaused: Number((document.querySelector('.sumcard[data-state="paused"] .sc-n') || {}).textContent) };
})()`);
check(afterPause.before.badge === '購入可能' && afterPause.before.op === '販売を停止', '停止前は「購入可能 / 販売を停止」');
check(afterPause.dbPaused === true, '「販売を停止」で実際に停止が書き込まれる');
check(afterPause.after.badge === '販売停止中',
  `停止後に表示が「販売停止中」へ切り替わる（実際: ${afterPause.after.badge}）`);
check(afterPause.after.op === '販売を再開',
  `停止後にボタンが「販売を再開」へ切り替わる（実際: ${afterPause.after.op}）`);
check(afterPause.cardPaused === 2, `上部カードの件数も更新される（販売停止中: ${afterPause.cardPaused}）`);
check(afterPause.confirms >= 1, '停止（危険な操作）では確認ダイアログを出す');

// ── 8. 販売再開 → 正しい状態へ復帰 ──────────────────────────
const afterResume = await evaluate(`(async () => {
  const tr = () => [...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('sale@example.com'));
  const t = (e) => (e ? e.textContent.trim().replace(/\\s+/g, ' ') : null);
  const c0 = window.__E2E.confirms.length;
  tr().querySelector('.c-ops .btn-rowact').click();
  await new Promise((r) => setTimeout(r, 1800));
  const row = tr();
  return { badge: t(row.querySelector('.c-state .badge')), op: t(row.querySelector('.c-ops .btn-rowact .bra-l')),
    dbPaused: window.__E2E.db.recSALE.salePaused,
    purchase: window.__E2E.db.recSALE.purchaseEnabled,
    newConfirms: window.__E2E.confirms.length - c0 };
})()`);
check(afterResume.dbPaused === false, '「販売を再開」で実際に停止が解除される');
check(afterResume.badge === '購入可能', `再開後に「購入可能」へ復帰する（実際: ${afterResume.badge}）`);
check(afterResume.op === '販売を停止', '再開後にボタンが「販売を停止」へ戻る');
check(afterResume.purchase === true, '再開後は購入可能に戻る');
check(afterResume.newConfirms === 0, '再開（通常の操作）では確認を増やさない');

// ── 9. カード押下で絞り込み ────────────────────────────────
const filtered = await evaluate(`(async () => {
  const out = {};
  for (const key of ['sale', 'paused', 'staged', 'out']) {
    document.querySelector('.sumcard[data-state="' + key + '"]').click();
    await new Promise((r) => setTimeout(r, 500));
    out[key] = {
      state: document.getElementById('fState').value,
      badges: [...new Set([...document.querySelectorAll('#rows tr .c-state .badge')].map((b) => b.textContent.trim()))],
    };
  }
  document.getElementById('fState').value = 'all';
  return out;
})()`);
const want = { sale: '購入可能', paused: '販売停止中', staged: '段階表示中', out: '対象外' };
for (const [k, label] of Object.entries(want)) {
  check(filtered[k].state === k && filtered[k].badges.every((b) => b === label),
    `カード「${label}」を押すとその状態だけに絞り込まれる（実際: ${filtered[k].badges.join(',') || '0 件'}）`);
}

// ── 10. 要対応 N 名 → 対象会員だけ表示 ──────────────────────
const needs = await evaluate(`(async () => {
  const b = document.querySelector('#notifyNote .notify-open');
  if (!b) return { skipped: true };
  b.click(); await new Promise((r) => setTimeout(r, 600));
  return { state: document.getElementById('fState').value,
    badges: [...new Set([...document.querySelectorAll('#rows tr .c-state .badge')].map((x) => x.textContent.trim()))],
    label: b.textContent.trim(),
    canOpen: !!document.querySelector('#rows tr .c-ops .btn-detail') };
})()`);
check(needs.skipped !== true, '「要対応 N 名を開く」が DOM にある');
check(needs.state === 'sale' && needs.badges.every((b) => b === '購入可能'),
  `要対応から対象会員（購入可能）だけが表示される（実際: ${needs.badges.join(',')}）`);
check(needs.canOpen === true, '要対応の一覧から 1 クリックで詳細へ進める');

// ── 11. メール完全一致検索 → 詳細が自動で開く ─────────────────
await openPage();
const exact = await evaluate(`(async () => {
  const p = document.getElementById('dtBody'); if (p) p.innerHTML = '';
  const q = document.getElementById('q');
  q.value = 'audenki99@gmail.com';
  q.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 900));
  const e = document.querySelector('.dt-email');
  const rows = [...document.querySelectorAll('#rows tr')].length;
  return { opened: e ? e.textContent.trim() : null, rows };
})()`);
check(String(exact.opened || '').includes('audenki99'),
  `メール完全一致で詳細が自動で開く（実際: ${exact.opened}）`);
check(exact.rows === 1, `完全一致では該当 1 件だけ表示される（実際: ${exact.rows} 件）`);
const partial = await evaluate(`(async () => {
  const q = document.getElementById('q');
  q.value = 'example.com'; q.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 700));
  return [...document.querySelectorAll('#rows tr')].length;
})()`);
check(partial >= 2, `部分一致では該当者だけを一覧表示する（実際: ${partial} 件）`);

// ── 12. 見えるが押せない / 生成したが DOM に無い を検出 ─────────
const ghost = await evaluate(`(() => {
  const bad = [];
  // 画面に見えているのに押せないボタン（理由の提示も無い）を検出
  for (const b of document.querySelectorAll('#rows button, .dt-act, .sumcard')) {
    const r = b.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
    if (visible && b.disabled && !b.title) bad.push('押せないのに理由が無い: ' + (b.textContent || '').trim().slice(0, 24));
  }
  return bad;
})()`);
check(ghost.length === 0, `見えるのに押せない（理由の提示も無い）要素が無い${ghost.length ? ': ' + ghost.join(' / ') : ''}`);

// ── 13. 未認証では admin 画面 / API に到達できない（任意）──────
if (devBase) {
  const base = devBase;
  for (const [path, want, label] of [
    ['/admin/premium-plus-eligibility/', 401, '未認証では admin 画面に到達できない'],
    ['/.netlify/functions/premium-plus-media?limit=3', 404, '未認証では実績画像 API に到達できない'],
  ]) {
    // ⚠️ ここにも時間制限。返らない相手で E2E 全体が止まらないようにする
    const res = await fetch(base + path, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    check(res && res.status === want, `${label}（期待 ${want} / 実際 ${res ? res.status : '接続不可'}）`);
  }
} else {
  // ⚠️ 黙ってスキップしない。確認観点が減ったことに気づけなくなる
  //    （PR 時 56 項目 / CI 54 項目のズレが実際に起きた）。
  check(false, '未認証チェックを実行できませんでした: ' + (devError || 'E2E_NO_DEV=1 が指定されています'));
}
stopDevServer();

// ── 終了 ────────────────────────────────────────────────────
browserWs.close(); server.close(); proc.kill();
await removeProfile();
const skippedUnauth = !devBase;
console.log(`\n合計 ${passes.length + fails.length} 項目 / pass ${passes.length} / fail ${fails.length}`
  + (skippedUnauth ? '（未認証チェック 2 件は未実行）' : '（未認証チェックを含む）'));
if (fails.length) {
  console.error('\n⛔ E2E 失敗:');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log('✅ 実 DOM E2E 全項目 pass');
