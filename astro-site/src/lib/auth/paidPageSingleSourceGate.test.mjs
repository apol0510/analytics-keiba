/**
 * paidPageSingleSourceGate.test.mjs
 *   node --test src/lib/auth/paidPageSingleSourceGate.test.mjs
 *
 * ## 守る要件（2026-09-02 の事故と同型の再発防止）
 *
 *   **有料ページの認可は 正本（ak_session + resolveEntitlements）だけで決める。
 *     ページが localStorage / plan 文字列で独自に判定しない。**
 *
 * 2026-09-02、三連複を買い切りで購入した会員が `/premium-sanrenpuku/` を開くと
 * 無料体験ページへリダイレクトされていた。原因は「ページ独自のクライアント判定が
 * `plan` 文字列だけを見ていた」こと。三連複は買い切りの追加権で、承認時に書かれるのは
 * `LifetimeSanrenpuku=true` **だけ**（`プラン` は 'Premium' のまま）。
 *
 * 同じ読み違いが `/archive-sanrenpuku*`（三連複の的中実績 6 ページ）にも残っており、
 * そちらは **購入済み会員を実績ページから締め出していた**。本ファイルはその修正を固定する。
 *
 * ## 検査の 2 層
 *   1. 振る舞い … `gatePaidPage` を実経路（session 発行 → gate）で回す
 *   2. 静的     … ページのソースに独自判定が復活していないか
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMembership, MEMBER_TYPE } from './memberResolution.js';
import { issuePaidSessionCookie } from './sessionIssuance.js';
import {
  gatePaidPage,
  resolveEntitlementFlag,
  resolveEntitlementFlags,
  SANRENPUKU_ARCHIVE_PLANS,
} from './paidPageGate.js';

const root = process.cwd(); // astro-site
const read = (rel) => readFileSync(join(root, rel), 'utf8');
/** 経緯コメントは検査対象外（「なぜ消したか」を残すため）。コードだけを見る。 */
const code = (rel) => read(rel)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const NOW = Date.parse('2026-09-02T03:00:00.000Z');
const env = { SESSION_SIGNING_SECRET: SECRET };
const FUTURE = '2027-08-01';
const PAST = '2026-03-31';

/**
 * 三連複アーカイブのうち **本文を返すページ**（判定は 1 つの定数に集約されている）。
 * `archive-sanrenpuku/index.astro` と `archive-sanrenpuku-jra/index.astro` は
 * 無条件 301 のランディングで本文を返さないため、ここには入れない
 * （301 が消えていないことは別テストで固定する）。
 */
const ARCHIVE_PAGES = [
  'src/pages/archive-sanrenpuku/2025/index.astro',
  'src/pages/archive-sanrenpuku/2026/index.astro',
  'src/pages/archive-sanrenpuku-all/index.astro',
  'src/pages/archive-sanrenpuku/[year]/[month].astro',
  'src/pages/archive-sanrenpuku-jra/[year]/[month].astro',
];
/** 三連複 CTA を持つ有料予想ページ（購入済みに追加購入を勧めない） */
const UPSELL_PAGES = [
  'src/pages/premium-prediction/nankan.astro',
  'src/pages/premium-prediction/jra.astro',
  'src/pages/premium-predictions-urawa.astro',
  'src/pages/premium-predictions-funabashi.astro',
];

/** ログイン → 有料セッション Cookie 付き Request（実経路と同じ手順） */
async function loginAs(fields) {
  const membership = resolveMembership({ fields, recordId: 'recTEST', now: NOW });
  if (membership.memberType !== MEMBER_TYPE.PAID) return { membership, request: null };
  const issued = await issuePaidSessionCookie({
    membership, secret: SECRET, now: NOW, subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok, `session 発行に失敗: ${issued.reason}`);
  return {
    membership,
    request: new Request('https://example.test/archive-sanrenpuku/', {
      headers: { cookie: issued.cookie.split(';')[0] },
    }),
  };
}
const gate = (request, fields, requiredPlan = SANRENPUKU_ARCHIVE_PLANS) => gatePaidPage({
  request, requiredPlan, env, now: NOW, lookup: async () => fields,
});

// ── 1. any-of の意味づけ（新しい認可を作らず、見るフラグを選ぶだけ）──────
test('resolveEntitlementFlags は any-of の対象フラグを返し、未知語は fail closed', () => {
  assert.deepEqual(resolveEntitlementFlags('premium'), ['canViewPremium']);
  assert.deepEqual(resolveEntitlementFlags(SANRENPUKU_ARCHIVE_PLANS),
    ['canViewPremium', 'canViewSanrenpuku']);
  // 1 つでも未知が混ざれば null（設定ミスで全開にしない）
  assert.equal(resolveEntitlementFlags(['premium', 'Nonexistent Plan']), null);
  assert.equal(resolveEntitlementFlags([]), null);
  assert.equal(resolveEntitlementFlags('Nonexistent Plan'), null);
  // 既存の単一版は変わらない
  assert.equal(resolveEntitlementFlag('Premium Sanrenpuku'), 'canViewSanrenpuku');
});

// ── 2. 締め出さない（今回の事故と同型を作らない）────────────────────
const ALLOWED_CUSTOMERS = [
  ['買い切り購入者（プラン=Premium + LifetimeSanrenpuku）※本番 4 名',
    { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': FUTURE, LifetimeSanrenpuku: true }],
  ['買い切り購入者（馬単は期限切れ）',
    { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': PAST, LifetimeSanrenpuku: true }],
  ['旧 Premium Sanrenpuku（期限内）※本番 2 名',
    { 'プラン': 'Premium Sanrenpuku', Status: 'active', '有効期限': FUTURE }],
  ['旧 Premium Combo（期限内）',
    { 'プラン': 'Premium Combo', Status: 'active', '有効期限': FUTURE }],
  ['Light + 買い切り',
    { 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': FUTURE, LifetimeSanrenpuku: true }],
  ['Free + 買い切り',
    { 'プラン': 'Free', Status: 'active', LifetimeSanrenpuku: true }],
  ['入金待ち + 買い切り',
    { 'プラン': 'Premium', Status: 'pending', '有効期限': FUTURE, LifetimeSanrenpuku: true }],
  ['馬単のみの Premium（アップセル面の読者）',
    { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': FUTURE }],
];

for (const [label, fields] of ALLOWED_CUSTOMERS) {
  test(`【締め出さない】${label} は三連複アーカイブを開ける`, async () => {
    const { request } = await loginAs(fields);
    assert.ok(request, '前提: ログインできている');
    const g = await gate(request, fields);
    assert.equal(g.ok, true, `締め出している: ${g.reason}`);
    assert.equal(g.response, null);
  });
}

// ── 3. 権利が無い人は通さない（fail closed）──────────────────────
test('【通さない】Light のみ / 無料会員は三連複アーカイブを開けない', async () => {
  const cases = [
    { 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': FUTURE },
    { 'プラン': 'Free', Status: 'active' },
    { 'プラン': 'Premium', Status: 'active', '有効期限': PAST }, // 期限切れ・買い切り無し
  ];
  for (const fields of cases) {
    const { request } = await loginAs(fields);
    if (!request) continue; // 有料セッションすら出ない = 当然開けない
    const g = await gate(request, fields);
    assert.equal(g.ok, false, `${JSON.stringify(fields)} が開いてしまう`);
    assert.equal(g.reason, 'entitlement_denied');
  }
});

test('【URL 直打ち】Cookie 無しは本文を返さず /login へ送る（302・本文ゼロ）', async () => {
  const g = await gatePaidPage({
    request: new Request('https://example.test/archive-sanrenpuku/2026/'),
    requiredPlan: SANRENPUKU_ARCHIVE_PLANS, env, now: NOW, lookup: async () => ({}),
  });
  assert.equal(g.ok, false);
  assert.equal(g.response.status, 302);
  assert.match(g.response.headers.get('location') || '', /^\/login\//);
});

test('【改竄】署名の無い ak_session を自作しても通らない', async () => {
  const g = await gatePaidPage({
    request: new Request('https://example.test/archive-sanrenpuku/', {
      headers: { cookie: 'ak_session=' + Buffer.from(JSON.stringify({ sub: 'recTEST', plan: 'premium-sanrenpuku' })).toString('base64url') },
    }),
    requiredPlan: SANRENPUKU_ARCHIVE_PLANS, env, now: NOW,
    lookup: async () => ({ 'プラン': 'Premium', Status: 'active', LifetimeSanrenpuku: true }),
  });
  assert.equal(g.ok, false, '自作 Cookie が通っている');
  assert.equal(g.response.status, 302);
});

test('【fail closed】env 未注入 / 未知 requiredPlan は通さない', async () => {
  const req = new Request('https://example.test/archive-sanrenpuku/');
  const noEnv = await gatePaidPage({ request: req, requiredPlan: SANRENPUKU_ARCHIVE_PLANS, now: NOW });
  assert.equal(noEnv.ok, false);
  assert.equal(noEnv.reason, 'env_missing');
  const unknown = await gatePaidPage({ request: req, requiredPlan: ['premium', 'Nope'], env, now: NOW });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown_required_plan');
});

// ── 4. 静的: アーカイブ 6 ページから独自判定が消えている ──────────────
test('三連複アーカイブ 6 ページは SSR + 正本 gate で、独自判定を持たない', () => {
  for (const rel of ARCHIVE_PAGES) {
    const src = read(rel);
    const body = code(rel);
    assert.match(src, /export const prerender = false;/, `${rel}: 静的 HTML のままだと URL 直打ちで読める`);
    assert.match(src, /gatePaidPage\(/, `${rel}: サーバー側 gate が無い`);
    assert.match(src, /SANRENPUKU_ARCHIVE_PLANS/, `${rel}: 閲覧条件の単一源を使っていない`);
    assert.ok(!/localStorage/.test(body), `${rel}: localStorage による判定が残っている`);
    assert.ok(!/sessionStorage/.test(body), `${rel}: sessionStorage による判定が残っている`);
    // 「会員専用です」と alert して追い返す旧ゲート。コピー通知等の無害な alert は対象外。
    assert.ok(!/alert\([^)]*会員/.test(body), `${rel}: alert 方式のクライアントゲートが残っている`);
    assert.ok(!/getStaticPaths/.test(body), `${rel}: SSR 化したのに getStaticPaths が残っている`);
  }
});

test('南関アーカイブのランディングは無条件 301 のまま（死んだ本文を live にしない）', () => {
  const rel = 'src/pages/archive-sanrenpuku/index.astro';
  const src = read(rel);
  // 301 は #491 より前から入っており、このページは本文を返さない。
  // 以降のコードは到達しないが、月次メンテ 3 スクリプトが import 行を読むため残している
  // （経緯はファイル冒頭のコメント）。**リダイレクトを消すと 900 行超の古い本文が live になる。**
  assert.match(src, /Astro\.redirect\('\/archive-sanrenpuku-all\/', 301\)/,
    `${rel}: 301 が消えている（到達しないはずの本文が live になる）`);
  // 条件分岐の中に入れられていない＝無条件であること
  const upto = src.slice(0, src.indexOf("Astro.redirect('/archive-sanrenpuku-all/', 301)"));
  assert.ok(!/\bif\s*\(/.test(upto.split('---')[1] ?? upto),
    `${rel}: 301 が条件付きになっている（無条件であること）`);
  // 到達しない本文・import を持ち込まない（2026-09-02 に 917 行を削除した状態を維持する）
  assert.ok(!/<BaseLayout|<div /.test(src), `${rel}: 到達しない本文が戻っている`);
  // 経緯コメントで名前に触れるのは可。**import 文**が戻っていないことを見る。
  assert.ok(!/import\s+\w+\s+from\s+['"][^'"]*archiveSanrenpukuResults_/.test(src),
    `${rel}: per-month JSON の import が戻っている（月別ページが正本）`);
  // 中央側と同じ集約先であること
  assert.match(read('src/pages/archive-sanrenpuku-jra/index.astro'),
    /Astro\.redirect\('\/archive-sanrenpuku-all\/', 301\)/, '中央側ランディングの 301 が消えている');
});

test('アーカイブの購入 CTA は購入済み（canViewSanrenpuku）に出さない', () => {
  for (const rel of ARCHIVE_PAGES) {
    const src = read(rel);
    if (!/openBankModal|sticky-cta|cta-upsell-box/.test(src)) continue;
    assert.match(src, /const ownsSanrenpuku = gate\.entitlements\?\.canViewSanrenpuku === true;/,
      `${rel}: 購入済み判定をサーバー側 entitlements から取っていない`);
    assert.match(src, /\{!ownsSanrenpuku && \(/, `${rel}: 購入済みに CTA を出さない分岐が無い`);
  }
});

// ── 5. 静的: 認可迂回の残骸が復活していない ──────────────────────
test('welcome.astro は URL クエリから有料プランを自己付与しない', () => {
  const src = read('src/pages/welcome.astro');
  assert.ok(!/setItem\(\s*['"](user-plan|userPlan|userData)['"]/.test(src),
    'URL パラメータ由来の権限を localStorage へ書いている');
  assert.ok(!/URLSearchParams/.test(src), 'クエリからプランを読む処理が残っている');
});

test('AccessControl は client が書ける権限チャネル（temp_auth / auth_data）を読まない', () => {
  const src = read('src/components/AccessControl.astro');
  assert.ok(!/sessionStorage\.getItem\(\s*['"]temp_auth['"]/.test(src), 'temp_auth を読んでいる');
  assert.ok(!/getItem\(\s*['"]auth_data['"]/.test(src), 'auth_data を読んでいる');
});

test('ページが権限キー userPlan を書き換えない（正本は auth/verify のみ）', () => {
  for (const rel of [...ARCHIVE_PAGES, 'src/pages/welcome.astro', 'src/pages/sanrenpuku-demo.astro']) {
    const src = code(rel);
    assert.ok(!/setItem\(\s*['"]userPlan['"]/.test(src), `${rel}: ページが userPlan を書き換えている`);
  }
});

// ── 6. 静的: 追加購入 CTA / 無料体験導線を購入済みに出さない ────────────
test('三連複 CTA を持つ有料予想ページは単一源 sanrenpukuCtaStage を使う', () => {
  for (const rel of UPSELL_PAGES) {
    const raw = read(rel);
    const src = code(rel);
    assert.match(raw, /sanrenpuku\/sanrenpukuCtaStage\.js'/, `${rel}: 単一源を import していない`);
    assert.match(raw, /isFunnelTarget\(planRaw, srpLifetime\)/, `${rel}: 買い切りフラグを渡していない`);
    assert.match(raw, /lifetimeSanrenpuku: srpLifetime/, `${rel}: 段階表示にも買い切りフラグを渡していない`);
    // plan 文字列だけで CTA / 結果を出し分ける旧実装が復活していないこと
    assert.ok(!/userPlan === 'Premium Combo'/.test(src), `${rel}: plan 文字列の独自判定が復活している`);
    assert.ok(!/userPlan === 'Premium Sanrenpuku'/.test(src), `${rel}: plan 文字列の独自判定が復活している`);
  }
});

test('購入済みには追加購入 CTA も無料体験導線も出ない（判定関数レベル）', async () => {
  const { isFunnelTarget, planSanrenpukuDisplay } = await import('../sanrenpuku/sanrenpukuCtaStage.js');
  const now = Date.now();
  const owners = [['Premium', true], ['Premium Predictions', true],
    ['Premium Sanrenpuku', false], ['Premium Combo', false]];
  for (const [plan, lifetime] of owners) {
    assert.equal(isFunnelTarget(plan, lifetime), false, `${plan}/${lifetime}: CTA 対象になっている`);
    const v = planSanrenpukuDisplay({
      planRaw: plan, lifetimeSanrenpuku: lifetime,
      firstSeen: now - 30 * 86400000, now, hasResultSection: true,
    });
    assert.equal(v.showCta, false, `${plan}: 申込 CTA が出ている`);
    assert.equal(v.teaser, 'none');
  }
  // 未購入の馬単 Premium には従来どおり出す（導線を殺さない）
  assert.equal(isFunnelTarget('Premium', false), true);
});

test('無料体験ページは購入済み（買い切り含む）を有料ページへ戻す', () => {
  const src = read('src/pages/sanrenpuku-demo.astro');
  assert.match(src, /lifetimeSanrenpuku === true/, '買い切り購入者を plan 文字列だけで判定している');
});
