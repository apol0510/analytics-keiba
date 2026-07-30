/**
 * premiumPlusAdminAudience.test.mjs — 管理画面の「レビュー候補として表示する条件」の検証
 *   node --test src/lib/premiumPlus/premiumPlusAdminAudience.test.mjs
 *
 * 検証の核心は 2 つ:
 *   1. 有効な Premium 会員が、旧データ（PaidAt）の不足だけを理由に一覧から消えないこと
 *   2. 一覧に出しても**販売資格は一切付かない**こと
 *      （表示条件を広げた結果 resolvePremiumPlusRelease が公開側へ倒れたら本末転倒）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveAdminCandidate,
  PP_CANDIDATE,
  PP_RELEASE_BLOCKER,
} from './premiumPlusAdminAudience.js';
import {
  PP_ROUTE,
  PP_ELIGIBILITY,
  PP_PHASE,
  PREMIUM_30D_DAYS,
  resolvePremiumPlusRelease,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';
import { PP_WRITABLE_FIELDS, PP_FORBIDDEN_FIELDS } from './premiumPlusEligibility.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 3, 1, 0); // 2026-08-03 10:00 JST
const daysAgo = (n) => NOW - n * DAY;
const iso = (ms) => new Date(ms).toISOString();

/** Airtable fields → 実運用と同じ経路で候補判定まで通す（Function の handleList と同一手順） */
function classify(fields) {
  const member = resolvePlusMemberFromFields(fields, { nowMs: NOW });
  const release = resolvePremiumPlusRelease({ ...member, nowMs: NOW });
  const candidate = resolveAdminCandidate({ fields, member, release });
  return { member, release, candidate };
}

/** 通常 Premium（三連複なし）の Airtable レコード */
const premiumFields = (over = {}) => ({
  'プラン': 'Premium',
  'PlanType': 'Annual',
  'Status': 'active',
  '有効期限': '2027-06-01',
  ...over,
});

// ──────────────────────────────────────────────────────────────
// 1. 表示条件（従来の route 判定は維持したまま、抜けていた層を拾う）
// ──────────────────────────────────────────────────────────────

test('ROUTE A（三連複保有）は従来どおり一覧に出る', () => {
  const { candidate, release } = classify(premiumFields({ LifetimeSanrenpuku: true }));
  assert.equal(release.route, PP_ROUTE.SANRENPUKU);
  assert.equal(candidate.listed, true);
  assert.equal(candidate.kind, PP_CANDIDATE.ROUTE_A);
  assert.equal(candidate.releaseBlockedBy, null);
});

test('ROUTE B（有効 Premium・加入 30 日以上）は従来どおり一覧に出る', () => {
  const { candidate, release } = classify(premiumFields({ PaidAt: iso(daysAgo(PREMIUM_30D_DAYS)) }));
  assert.equal(release.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(candidate.kind, PP_CANDIDATE.ROUTE_B);
  assert.equal(candidate.listed, true);
  assert.equal(candidate.releaseBlockedBy, null);
});

test('【本件の中核】有効 Premium だが PaidAt が空な旧会員も一覧に出る（route は none のまま）', () => {
  const { candidate, release, member } = classify(premiumFields()); // PaidAt なし
  assert.equal(member.premiumActive, true);
  assert.equal(member.premiumPaidAtMs, null);
  // 公開判定は従来どおり対象外（顧客側は何も変わらない）
  assert.equal(release.route, PP_ROUTE.NONE);
  assert.equal(release.allowed, false);
  // 管理画面には出す
  assert.equal(candidate.listed, true);
  assert.equal(candidate.kind, PP_CANDIDATE.ANCHOR_MISSING);
  assert.equal(candidate.releaseBlockedBy, PP_RELEASE_BLOCKER.ANCHOR_MISSING);
  assert.ok(candidate.note.includes('PaidAt'), '不足しているフィールド名を管理者に伝える');
});

test('有効 Premium・加入 30 日未満は「待機中（あと N 日）」として一覧に出る', () => {
  const { candidate, release } = classify(premiumFields({ PaidAt: iso(daysAgo(18)) }));
  assert.equal(release.route, PP_ROUTE.NONE);
  assert.equal(candidate.kind, PP_CANDIDATE.WAITING_30D);
  assert.equal(candidate.listed, true);
  assert.equal(candidate.daysUntilRouteB, PREMIUM_30D_DAYS - 18);
  assert.equal(candidate.releaseBlockedBy, PP_RELEASE_BLOCKER.WAIT_30D);
});

test('待機中は 30 日到達で自動的に ROUTE B へ移る（境界 29 / 30 日）', () => {
  assert.equal(classify(premiumFields({ PaidAt: iso(daysAgo(29)) })).candidate.kind, PP_CANDIDATE.WAITING_30D);
  assert.equal(classify(premiumFields({ PaidAt: iso(daysAgo(30)) })).candidate.kind, PP_CANDIDATE.ROUTE_B);
});

test('PremiumPlusEligibility 設定済みなら route が崩れても一覧から消えない', () => {
  const { candidate } = classify({
    'プラン': 'Free', 'Status': 'active', 'PremiumPlusEligibility': 'blocked',
  });
  assert.equal(candidate.kind, PP_CANDIDATE.EXPLICIT);
  assert.equal(candidate.listed, true);
});

// ──────────────────────────────────────────────────────────────
// 2. 広げすぎていないこと（Premium 会員でない人は出さない）
// ──────────────────────────────────────────────────────────────

for (const [name, fields] of [
  ['Free 会員', { 'プラン': 'Free', 'Status': 'active' }],
  ['Light 会員', { 'プラン': 'Light', 'PlanType': 'Monthly', 'Status': 'active', '有効期限': '2027-06-01' }],
  ['期限切れ Premium', premiumFields({ '有効期限': '2026-01-01' })],
  ['Status=expired の Premium', premiumFields({ 'Status': 'expired' })],
  ['Status=pending の Premium', premiumFields({ 'Status': 'pending' })],
  ['退会済み Premium', premiumFields({ 'Status': 'withdrawn' })],
  ['停止中 Premium', premiumFields({ 'Status': 'suspended' })],
  ['WithdrawalRequested の Premium', premiumFields({ 'WithdrawalRequested': true })],
  ['テストアカウント', { 'プラン': 'Test', 'Status': 'test' }],
]) {
  test(`${name} は一覧に出さない`, () => {
    const { candidate } = classify(fields);
    assert.equal(candidate.listed, false, `${name} が候補一覧へ混入している`);
    assert.equal(candidate.kind, PP_CANDIDATE.NONE);
  });
}

test('fields / member / release が欠けても落ちず、非表示へ倒れる（fail closed）', () => {
  for (const input of [undefined, {}, { member: null, release: null }, { fields: 'x' }]) {
    const c = resolveAdminCandidate(input);
    assert.equal(c.listed, false);
    assert.equal(c.kind, PP_CANDIDATE.NONE);
  }
});

// ──────────────────────────────────────────────────────────────
// 3. 表示を広げても販売資格は付かない（この機能の安全条件）
// ──────────────────────────────────────────────────────────────

test('一覧に出しただけでは eligibility は保留のまま（自動 eligible が起きない）', () => {
  for (const fields of [premiumFields(), premiumFields({ PaidAt: iso(daysAgo(18)) })]) {
    const { member, candidate } = classify(fields);
    assert.equal(candidate.listed, true);
    assert.equal(member.eligibility, PP_ELIGIBILITY.REVIEW, '未設定は review（fail closed）のまま');
  }
});

test('新たに表示対象となった会員は顧客側で一切公開されない', () => {
  for (const fields of [premiumFields(), premiumFields({ PaidAt: iso(daysAgo(18)) })]) {
    const { release } = classify(fields);
    assert.equal(release.allowed, false);
    assert.equal(release.phase, PP_PHASE.LOCKED);
    assert.equal(release.showTeaser, false);
    assert.equal(release.showProductPage, false);
    assert.equal(release.showPurchaseCta, false);
    assert.equal(release.purchaseEnabled, false);
  }
});

test('管理者が eligible にしても route 未成立なら公開されない（表示 ≠ 販売許可）', () => {
  const eligibleNow = {
    'PremiumPlusEligibility': 'eligible',
    'PremiumPlusEligibleAt': iso(daysAgo(60)),
    'PremiumPlusReleaseOverride': 'phase4', // 即時販売 override すら効かないこと
  };
  for (const base of [premiumFields(), premiumFields({ PaidAt: iso(daysAgo(18)) })]) {
    const { release, candidate } = classify({ ...base, ...eligibleNow });
    assert.equal(candidate.listed, true);
    assert.equal(release.allowed, false, 'route が none のままなら公開しない');
    assert.equal(release.showPurchaseCta, false);
    assert.equal(release.purchaseEnabled, false);
  }
});

test('候補判定は Airtable へ書く値を一切返さない（表示専用であることの構造的保証）', () => {
  const { candidate } = classify(premiumFields());
  const keys = Object.keys(candidate);
  for (const k of [...PP_WRITABLE_FIELDS, ...PP_FORBIDDEN_FIELDS]) {
    assert.equal(keys.includes(k), false, `候補判定の戻り値に書き込みフィールド ${k} が含まれている`);
  }
  assert.equal(keys.includes('eligibility'), false, '販売資格を返してはいけない');
});

// ──────────────────────────────────────────────────────────────
// 4. ソース側の guard（表示条件を公開条件へ戻していないか）
// ──────────────────────────────────────────────────────────────

const audienceSrc = readFileSync(fileURLToPath(new URL('./premiumPlusAdminAudience.js', import.meta.url)), 'utf8');
const fnSrc = readFileSync(fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url)), 'utf8');

test('list API は表示条件を単一源へ委譲している（インライン再実装へ戻さない）', () => {
  assert.ok(fnSrc.includes('resolveAdminCandidate'), 'handleList が premiumPlusAdminAudience を使っていない');
  assert.ok(
    !/route\s*===\s*PP_ROUTE\.NONE\s*&&\s*!hasExplicitEligibility/.test(fnSrc),
    '旧: 公開判定をそのまま表示条件に使うインライン実装が復活している',
  );
});

test('候補判定モジュールは推測の日付フォールバックを持たない', () => {
  // 登録日 / createdTime は無料登録日、有効期限は加入日からの導出値。anchor に流用しない。
  for (const banned of ['登録日', 'createdTime', '有効期限', 'ValidUntil']) {
    assert.equal(audienceSrc.includes(`f['${banned}']`), false, `${banned} を anchor 代用にしている`);
    assert.equal(audienceSrc.includes(`fields['${banned}']`), false, `${banned} を anchor 代用にしている`);
  }
});

test('候補判定モジュールは I/O を持たない（コメントを除いた実コードで検査）', () => {
  const code = audienceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['fetch(', 'api.airtable.com', 'process.env', 'require(']) {
    assert.equal(code.includes(banned), false, `実コードに ${banned} が含まれている`);
  }
  // import は判定用の定数だけ（Airtable クライアント等を持ち込まない）
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./premiumPlusRelease.js']);
});
