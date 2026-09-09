/**
 * e2e-admin-plus.mjs — Premium Plus 管理画面の実 E2E（実ページを Chromium で動かす）
 *
 * ## なぜ要るか（2026-09-10 MK 指摘）
 *
 * > e2eでテスト確認検証しないの？
 *
 * 2026-09-10 に「今すぐ販売可にしたのに 9/19 から購入可と出る」不具合が本番で出た。
 * **ユニットテストは全部通っていた**（判定は正しく purchaseEnabled=true だった）が、
 * 画面の見出しが段階公開の予定日を出していた。**実画面を動かさないと捕まらない**種類の
 * 不具合なので、実ページを起動して DOM を検証する E2E を用意する。
 *
 * ## 使い方（ローカルのみ・本番へは触れない）
 *
 *   1) astro dev を起動（既定 http://localhost:4376）
 *   2) node scripts/e2e-admin-plus.mjs
 *
 * ⚠️ 管理 API はブラウザ側の fetch 差し替えで**合成データ**を返す。
 *    Airtable にも本番にも一切アクセスしない。書き込みもしない。
 * ⚠️ /admin/* は Edge の Basic 認証の背後にある。ローカルで開けない場合は
 *    認証情報を与えるか、検証中だけ edge function を退避する（**必ず戻すこと**）。
 * ⚠️ Chromium 系ブラウザのパスは E2E_BROWSER で上書きできる。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BROWSER = process.env.E2E_BROWSER
  || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PORT = 9222;
const URL_PAGE = process.env.E2E_URL
  || 'http://localhost:4376/admin/premium-plus-eligibility/';
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const proc = spawn(BROWSER, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--user-data-dir=/tmp/e2e-profile', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

async function cdpTargets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      const page = j.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP に接続できませんでした');
}

const target = await cdpTargets();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};

await send('Page.enable');
await send('Runtime.enable');

// ── 管理 API を差し替える（本番に触れない）──────────────────
const nowIso = new Date().toISOString();
const STUB = {
  ok: true, writeEnabled: true, overrideEnabled: true,
  salePause: { writable: true },
  counts: { total: 3 },
  rows: [
    { recordId: 'recAUD', email: 'Audenki99@gmail.com', name: 'Hisaji yamaguchi',
      plan: 'Premium', planType: 'Lifetime', hasSanrenpuku: false,
      eligibility: 'eligible', eligibilityLabel: '販売可', state: '即時販売',
      phase: 4, overrideApplied: true, purchaseEnabled: true, showProductPage: true, showPurchaseCta: true,
      salePaused: false, salePausedLabel: '販売中', salePauseWritable: true,
      eligibleAt: nowIso, updatedAt: nowIso, updatedBy: 'MK',
      reopenCouponClaimed: false, reopenCouponLabel: 'クーポン未取得', reopenCouponWritable: true,
      reopenStart: { startsAtIso: '' },
      reopenLaunch: { state: 'not_started', action: { kind: 'start', label: '▶ クーポンの利用期間（14日）を開始する', enabled: true, note: '14日間の開始を確定します。', showPauseSwitch: true, showResumeSwitch: false } },
      route: 'premium_30d', upsellTarget: 'auto' },
    { recordId: 'recSTG', email: 'staged@example.com', plan: 'Premium',
      eligibility: 'eligible', phase: 2, overrideApplied: false, purchaseEnabled: false,
      salePaused: false, salePauseWritable: true, eligibleAt: nowIso, updatedAt: nowIso,
      reopenLaunch: { state: 'not_started', action: { kind: 'start', label: '▶ クーポンの利用期間（14日）を開始する', enabled: true, showPauseSwitch: true, showResumeSwitch: false } } },
    { recordId: 'recPSE', email: 'paused@example.com', plan: 'Premium',
      eligibility: 'eligible', phase: 4, overrideApplied: false, purchaseEnabled: false,
      salePaused: true, salePausedLabel: '一時停止中', salePauseWritable: true,
      eligibleAt: '2026-08-20T00:00:00.000Z', updatedAt: nowIso,
      reopenLaunch: { state: 'not_started', action: { kind: 'start', label: '▶ クーポンの利用期間（14日）を開始する', enabled: true, showPauseSwitch: false, showResumeSwitch: true } } },
  ],
};
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__E2E_STUB__ = ${JSON.stringify(STUB)};
  const real = window.fetch;
  window.fetch = async (u, init) => {
    const url = String(u && u.url ? u.url : u);
    if (url.includes('premium-plus-eligibility')) {
      return new Response(JSON.stringify(window.__E2E_STUB__), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(u, init);
  };
  // 管理シークレットのプロンプトを黙らせる
  try { sessionStorage.setItem('pp-admin-secret', 'e2e'); } catch {}
` });

await send('Page.navigate', { url: URL_PAGE });
await sleep(2500);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
};

// シークレットを入れて「再読み込み」を押す（実画面と同じ導線）
await evaluate(`(async () => {
  const el = document.getElementById('secret');
  if (el) { el.value = 'e2e'; el.dispatchEvent(new Event('change')); }
  const btn = document.getElementById('reload');
  if (btn) btn.click();
  await new Promise(r => setTimeout(r, 1500));
  return 'loaded';
})()`);

const out = await evaluate(`(async () => {
  const t = (el) => (el ? el.textContent.trim().replace(/\\s+/g,' ') : null);
  const cards = [...document.querySelectorAll('.sumcard')].map(c => ({
    n: t(c.querySelector('.sc-n')), l: t(c.querySelector('.sc-l')) }));
  const rows = [...document.querySelectorAll('#rows tr')].map(tr => ({
    email: t(tr.querySelector('.c-cust .em')),
    badge: t(tr.querySelector('.c-state .badge')),
    reason: t(tr.querySelector('.c-state .state-reason')),
    ops: [...tr.querySelectorAll('.c-ops .btn-rowact')].map(b => t(b.querySelector('.bra-l'))),
    hasDetailButton: !!tr.querySelector('.c-ops .btn-detail'),
  }));
  return JSON.stringify({ cards, rows, rowCount: rows.length }, null, 1);
})()`);
const list = JSON.parse(out);
console.log('=== 一覧 ===');
console.log(out);
check(list.cards.length === 4, '上部の 4 カードが出ていない');
check(list.cards.map((c) => c.l).join(',') === '購入可能,販売停止中,段階表示中,対象外',
  'カードの並び / 名称が違う: ' + list.cards.map((c) => c.l).join(','));
check(list.cards.every((c) => /^\d+$/.test(String(c.n))), 'カードの件数が数字でない');
const aud = list.rows.find((r) => r.email === 'Audenki99@gmail.com');
check(!!aud, '対象会員が一覧に出ていない');
check(aud && aud.badge === '購入可能', '購入可能の会員が「購入可能」で出ていない: ' + (aud && aud.badge));
check(aud && aud.ops.includes('販売を停止'), '販売中の会員に「販売を停止」が出ていない');
const psd = list.rows.find((r) => r.email === 'paused@example.com');
check(psd && psd.badge === '販売停止中', '停止中の会員のバッジが違う');
check(psd && psd.ops.includes('販売を再開'), '停止中の会員に「販売を再開」が出ていない（戻せない）');
check(list.rows.every((r) => r.hasDetailButton), '「詳細・操作」ボタンが無い行がある');

// 会員行をクリック → 詳細パネル
const detail = await evaluate(`(async () => {
  const tr = [...document.querySelectorAll('#rows tr')].find(x => (x.textContent||'').includes('Audenki99'));
  if (!tr) return JSON.stringify({ error: '対象行が見つからない' });
  tr.click();
  await new Promise(r => setTimeout(r, 800));
  const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim().replace(/\\s+/g,' ') : null; };
  const items = [...document.querySelectorAll('.dt-now-kv dt')].map((dt,i) => ({
    label: dt.textContent.trim(),
    value: (document.querySelectorAll('.dt-now-kv dd')[i]||{}).textContent?.trim().replace(/\\s+/g,' ') }));
  return JSON.stringify({
    badge: t('.dt-now-badge'), headline: t('.dt-now-head'), stage: t('.dt-now-stage'),
    items,
    actions: [...document.querySelectorAll('.dt-act')].map(b => ({
      label: (b.querySelector('.dt-act-l')||{}).textContent, disabled: b.disabled })),
    detailsClosed: !!document.querySelector('.dt-more') && !document.querySelector('.dt-more').open,
  }, null, 1);
})()`);
const d = JSON.parse(detail);
console.log('=== 詳細パネル（Audenki99）===');
console.log(detail);
check(d.badge === '購入可能', '詳細のバッジが違う: ' + d.badge);
// ★本件: 買えるのに未来の予定日を「〜から購入できる」と出さない
check(d.headline === 'いま購入できる状態です',
  '待機日数を飛ばした会員に未来の予定日を出している: ' + d.headline);
check(!/\d{4}-\d{2}-\d{2} から購入できる/.test(String(d.headline)),
  '見出しに購入開始日として未来日が入っている: ' + d.headline);
check(/待機日数を飛ばして販売中/.test(String(d.stage)), '段階の表示が違う: ' + d.stage);
check(d.actions.some((a) => (a.label || '').includes('販売を停止')), '詳細に「販売を停止」が無い');
check(!d.actions.some((a) => (a.label || '').includes('今すぐ販売可')),
  'すでに購入できるのに「今すぐ販売可」が出ている');
check(d.detailsClosed === true, '詳細の折りたたみが既定で開いている');

ws.close(); proc.kill();

if (fails.length) {
  console.error('\n⛔ E2E 失敗 ' + fails.length + ' 件');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log('\n✅ E2E 全項目 pass');
