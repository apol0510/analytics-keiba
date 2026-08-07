/**
 * sanrenpukuDisplay.test.mjs — 三連複保有の表示
 *   node --test src/lib/entitlements/sanrenpukuDisplay.test.mjs
 *
 * 解決したい誤読:
 *   三連複は会員ランクではなく買い切りの entitlement なので、購入しても `プラン` は
 *   `Premium` のまま。管理画面で「プラン」だけを見ると、
 *     ① プラン=Premium + LifetimeSanrenpuku=true（現行形式）
 *     ② プラン=Premium Sanrenpuku（旧形式）
 *   の ① が三連複購入者だと分からない。両方を同じバッジで見分けられるようにする。
 *
 * 恒久的な回帰条件:
 *   1. 代表 3 ケースを**目視せずに**区別できる（バッジ / 根拠 / 寿命がすべて異なる）
 *   2. 表示は `canViewSanrenpuku` と**絶対に矛盾しない**（判定を再実装していない証明）
 *   3. 永久保有と旧プラン保有を**同じ表示に潰さない**（寿命が違う）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEntitlements, fromAirtableFields } from './resolveEntitlements.js';
import { describeSanrenpukuHolding, sanrenpukuBadgeText, SANRENPUKU_BASIS } from './sanrenpukuDisplay.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import { resolvePlusRoute, PP_ROUTE } from '../premiumPlus/premiumPlusRelease.js';

const NOW = Date.parse('2026-08-07T02:00:00.000Z'); // JST 11:00
const ent = (fields) => resolveEntitlements(fromAirtableFields(fields), NOW);

// ── 代表 3 ケース（実データに対応）────────────────────────────────
/** ① 現行形式: プラン=Premium + LifetimeSanrenpuku=true（本番に 1 名実在） */
const CASE_1 = {
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
  '有効期限': '2027-07-14', LifetimeSanrenpuku: true,
};
/** ② 旧形式: プラン=Premium Sanrenpuku（本番に 20 名） */
const CASE_2 = {
  'プラン': 'Premium Sanrenpuku', PlanType: 'Annual', Status: 'active',
  '有効期限': '2027-01-31',
};
/** ③ 三連複なしの通常 Premium */
const CASE_3 = {
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
  '有効期限': '2027-07-14',
};

test('① Premium + LifetimeSanrenpuku=true → 三連複保有と分かる', () => {
  const d = describeSanrenpukuHolding(ent(CASE_1));
  assert.equal(d.has, true);
  assert.equal(d.basis, SANRENPUKU_BASIS.LIFETIME);
  assert.equal(d.badge, '三連複保有');
  assert.equal(d.label, '永久保有');
  assert.match(d.note, /永久/);
  // プラン名だけでは分からないケースなので、バッジが必ず出ること
  assert.ok(d.badge && d.badge.length > 0, 'プラン=Premium の三連複購入者にバッジが出ていない');
});

test('② 旧 Premium Sanrenpuku → 同じ考え方でバッジが出る', () => {
  const d = describeSanrenpukuHolding(ent(CASE_2));
  assert.equal(d.has, true);
  assert.equal(d.basis, SANRENPUKU_BASIS.LEGACY_TIER);
  assert.match(d.badge, /三連複保有/);
  assert.match(d.label, /保有/);
  assert.match(d.note, /Premium 契約が有効な間/, '旧プランの寿命条件が説明されていない');
});

test('③ Premium + 三連複なし → バッジを出さない', () => {
  const d = describeSanrenpukuHolding(ent(CASE_3));
  assert.equal(d.has, false);
  assert.equal(d.basis, SANRENPUKU_BASIS.NONE);
  assert.equal(d.badge, null);
  assert.equal(d.label, 'なし');
  assert.equal(sanrenpukuBadgeText(ent(CASE_3)), '', '列を汚している');
});

test('代表 3 ケースは目視せずに区別できる（バッジ・根拠・説明がすべて異なる）', () => {
  const ds = [CASE_1, CASE_2, CASE_3].map((f) => describeSanrenpukuHolding(ent(f)));
  const bases = ds.map((d) => d.basis);
  assert.equal(new Set(bases).size, 3, 'basis が重複している');
  const badges = ds.map((d) => String(d.badge));
  assert.equal(new Set(badges).size, 3, 'バッジ文字列が重複している');
  const notes = ds.map((d) => d.note);
  assert.equal(new Set(notes).size, 3, '説明文が重複している');
  // ①②は「保有」で一致、③だけ非保有
  assert.deepEqual(ds.map((d) => d.has), [true, true, false]);
});

test('永久保有と旧プラン保有を同じ表示に潰さない（寿命が違う）', () => {
  const a = describeSanrenpukuHolding(ent(CASE_1));
  const b = describeSanrenpukuHolding(ent(CASE_2));
  assert.notEqual(a.label, b.label);
  assert.notEqual(a.note, b.note);
  assert.match(a.note, /Premium 契約が切れても/);
  assert.match(b.note, /Premium 契約が有効な間/);
});

// ── 旧プラン + Premium 期限切れ ────────────────────────────────
test('旧プランで Premium 期限切れ → 「三連複なし」と同じ表示にしない', () => {
  const expired = { ...CASE_2, '有効期限': '2025-01-01' };
  const e = ent(expired);
  assert.equal(e.canViewSanrenpuku, false, '前提: 期限切れで閲覧不可');
  const d = describeSanrenpukuHolding(e);
  assert.equal(d.has, false);
  assert.equal(d.basis, SANRENPUKU_BASIS.LEGACY_EXPIRED);
  assert.notEqual(d.basis, SANRENPUKU_BASIS.NONE, '未購入と同じ扱いになっている');
  assert.match(d.note, /切れている/);
  assert.ok(d.badge, '購入者であることが一覧から消えている');
});

test('永久保有は Premium 期限切れでも保有のまま', () => {
  const expired = { ...CASE_1, '有効期限': '2025-01-01' };
  const e = ent(expired);
  assert.equal(e.canViewSanrenpuku, true, '買い切りは契約期限に依存しない');
  const d = describeSanrenpukuHolding(e);
  assert.equal(d.has, true);
  assert.equal(d.basis, SANRENPUKU_BASIS.LIFETIME);
});

// ── 判定を再実装していないことの証明 ──────────────────────────
test('表示は canViewSanrenpuku と絶対に矛盾しない', () => {
  const cases = [
    CASE_1, CASE_2, CASE_3,
    { ...CASE_1, '有効期限': '2025-01-01' },
    { ...CASE_2, '有効期限': '2025-01-01' },
    { ...CASE_1, Status: 'inactive' },
    { ...CASE_2, Status: 'withdrawn' },
    { 'プラン': 'Premium Combo', Status: 'active', '有効期限': '2027-01-31' },
    { 'プラン': 'Light', Status: 'active', '有効期限': '2027-01-31' },
    { 'プラン': 'Free' },
    {},
  ];
  for (const f of cases) {
    const e = ent(f);
    const d = describeSanrenpukuHolding(e);
    assert.equal(d.has, e.canViewSanrenpuku === true,
      `表示が権限正本と食い違う: ${JSON.stringify(f)}`);
  }
});

test('ent が空 / 不正でも安全側（保有と言わない）', () => {
  for (const v of [null, undefined, {}, { canViewSanrenpuku: 'true' }, { canViewSanrenpuku: 1 }]) {
    const d = describeSanrenpukuHolding(v);
    assert.equal(d.has, false, `v=${JSON.stringify(v)}`);
  }
});

// ── ROUTE A との整合 ─────────────────────────────────────────
test('バッジが出る＝ROUTE A になる（Premium Plus 判定と一致）', () => {
  for (const f of [CASE_1, CASE_2]) {
    const d = describeSanrenpukuHolding(ent(f));
    const member = resolvePlusMemberFromFields(f, { nowMs: NOW });
    const route = resolvePlusRoute({
      hasSanrenpuku: member.hasSanrenpuku,
      premiumActive: member.premiumActive,
      premiumPaidAtMs: member.premiumPaidAtMs,
      nowMs: NOW,
      adminPlusTarget: false,
    });
    assert.equal(d.has, true);
    assert.equal(member.hasSanrenpuku, true, '表示は保有なのに member は非保有');
    assert.equal(route.route, PP_ROUTE.SANRENPUKU, 'バッジが出るのに ROUTE A でない');
  }
});

test('バッジが出ない＝ROUTE A にならない', () => {
  for (const f of [CASE_3, { ...CASE_2, '有効期限': '2025-01-01' }]) {
    const d = describeSanrenpukuHolding(ent(f));
    const member = resolvePlusMemberFromFields(f, { nowMs: NOW });
    const route = resolvePlusRoute({
      hasSanrenpuku: member.hasSanrenpuku,
      premiumActive: member.premiumActive,
      premiumPaidAtMs: member.premiumPaidAtMs,
      nowMs: NOW,
      adminPlusTarget: false,
    });
    assert.equal(d.has, false);
    assert.notEqual(route.route, PP_ROUTE.SANRENPUKU, '非保有なのに ROUTE A');
  }
});

// ── 表示レイヤーであることの guard ────────────────────────────
test('判定モジュールを再実装していない（純粋・I/O なし・書き込みなし）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./sanrenpukuDisplay.js', import.meta.url)), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 会員判定の再実装を禁止（期限比較・Status 解釈・プラン正規化を持たない）
  assert.doesNotMatch(code, /有効期限|expiresAt|isExpiredAt|Date\.now|nowMs/, '期限判定を持っている');
  assert.doesNotMatch(code, /Status|accountStatus|withdrawn/, 'アカウント状態を解釈している');
  assert.doesNotMatch(code, /paidPremiumActive|premiumActive/, 'Premium 有効性を自前で見ている');
  // I/O・書き込みを持たない
  assert.doesNotMatch(code, /fetch\(|api\.airtable\.com|method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(code, /^\s*import\s/m, '依存を持たない純粋モジュールである');
});
