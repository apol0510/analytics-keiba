/**
 * freeGrantStatus.test.mjs — 「いまの無料付与」と「これまでの記録」を取り違えない
 *
 * ここで固定するのは 2 点。
 *   1. 現在有効かどうかと、過去に付与されたかを**別々に**判定すること
 *   2. 記録が無いことを「付与していない」と断定しないこと
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_GRANT_NOW, FREE_GRANT_HISTORY,
  resolveCurrentFreeGrant, resolveFreeGrantHistory, validateFreeGrantConsistency,
  formatFreeGrantSummary, matchesFreeGrantNow, matchesFreeGrantHistory,
  describeFreeGrantFilters, summarizeFreeGrants,
} from './freeGrantStatus.js';

const NOW = Date.parse('2026-08-03T12:00:00+09:00');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const cur = (fields) => resolveCurrentFreeGrant(fields, NOW);
const hist = (fields) => resolveFreeGrantHistory(fields, NOW);

// ── 現在の無料付与 ────────────────────────────────────────────

test('無料付与なし', () => {
  const c = cur({});
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  assert.equal(c.hasAny, false);
  assert.equal(c.summary, '現在は無料付与なし');
});

test('Light 期間限定 無料中', () => {
  const c = cur({ LightGrantUntil: iso(NOW + 18 * DAY), LightGrantedAt: iso(NOW - 12 * DAY) });
  assert.ok(c.codes.includes(FREE_GRANT_NOW.LIGHT_PERIOD));
  assert.equal(c.light.active, true);
  assert.equal(c.light.daysRemaining, 18);
  assert.match(c.summary, /Light 無料：2026-08-21 まで（残り 18 日）/);
});

test('Light 永久無料', () => {
  const c = cur({ LightGrantLifetime: true, LightGrantedAt: iso(NOW - DAY) });
  assert.ok(c.codes.includes(FREE_GRANT_NOW.LIGHT_LIFETIME));
  assert.equal(c.light.lifetime, true);
  assert.equal(c.summary, 'Light 永久無料');
});

test('Light 無料 終了済みは「現在なし」', () => {
  const c = cur({ LightGrantUntil: iso(NOW - 3 * DAY), LightGrantedAt: iso(NOW - 33 * DAY) });
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  assert.match(c.summary, /Light 無料：2026-07-31 終了/);
});

test('Light 取消済みは「現在なし」で取消日を出す', () => {
  const c = cur({
    LightGrantLifetime: false, LightGrantUntil: null,
    LightGrantedAt: iso(NOW - 20 * DAY), LightGrantRevokedAt: iso(NOW - 19 * DAY),
  });
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  assert.match(c.summary, /Light 無料：取消済み 2026-07-15/);
});

test('Premium 期間限定 無料中 / Premium 永久無料', () => {
  const p = cur({ PremiumGrantUntil: iso(NOW + 5 * DAY), PremiumGrantedAt: iso(NOW - DAY) });
  assert.ok(p.codes.includes(FREE_GRANT_NOW.PREMIUM_PERIOD));
  const l = cur({ PremiumGrantLifetime: true, PremiumGrantedAt: iso(NOW - DAY) });
  assert.ok(l.codes.includes(FREE_GRANT_NOW.PREMIUM_LIFETIME), 'Premium 永久無料は既存フィールドで表現できる');
});

test('Premium 無料 終了済み', () => {
  const c = cur({ PremiumGrantUntil: iso(NOW - DAY), PremiumGrantedAt: iso(NOW - 31 * DAY) });
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  assert.match(c.summary, /Premium 無料：2026-08-02 終了/);
});

test('Light と Premium が同時に有効なら「両方有効」も立つ', () => {
  const c = cur({
    LightGrantLifetime: true,
    PremiumGrantUntil: iso(NOW + 10 * DAY), PremiumGrantedAt: iso(NOW - DAY),
  });
  assert.ok(c.codes.includes(FREE_GRANT_NOW.LIGHT_LIFETIME));
  assert.ok(c.codes.includes(FREE_GRANT_NOW.PREMIUM_PERIOD));
  assert.ok(c.codes.includes(FREE_GRANT_NOW.BOTH));
});

test('期限の境界: 現在時刻ちょうどは「終了」扱い（送りすぎない側へ倒す）', () => {
  const c = cur({ LightGrantUntil: iso(NOW), LightGrantedAt: iso(NOW - DAY) });
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  const c2 = cur({ LightGrantUntil: iso(NOW + 1), LightGrantedAt: iso(NOW - DAY) });
  assert.ok(c2.codes.includes(FREE_GRANT_NOW.LIGHT_PERIOD));
});

test('不整合: 取消の後に値が残っている → 要確認（権利は与えない）', () => {
  const fields = {
    LightGrantLifetime: true,
    LightGrantedAt: iso(NOW - 20 * DAY), LightGrantRevokedAt: iso(NOW - 5 * DAY),
  };
  const c = cur(fields);
  assert.ok(c.codes.includes(FREE_GRANT_NOW.INCONSISTENT));
  assert.equal(c.primary, FREE_GRANT_NOW.INCONSISTENT);
  assert.equal(c.light.active, false, '不整合レコードへ権利を与えている');
  assert.equal(validateFreeGrantConsistency(fields, NOW).ok, false);
});

test('不整合: 永久無料と期限が同時に設定されている', () => {
  const fields = { PremiumGrantLifetime: true, PremiumGrantUntil: iso(NOW + DAY), PremiumGrantedAt: iso(NOW - DAY) };
  const v = validateFreeGrantConsistency(fields, NOW);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes('永久無料と期限が同時')));
  assert.ok(cur(fields).codes.includes(FREE_GRANT_NOW.INCONSISTENT));
});

// ── 無料付与履歴 ──────────────────────────────────────────────

test('履歴: 記録なし（「付与していない」とは言い切らない）', () => {
  const h = hist({});
  assert.deepEqual(h.codes, [FREE_GRANT_HISTORY.NO_RECORD]);
  assert.match(h.note, /証明ではありません/);
});

test('履歴: Light 付与歴あり', () => {
  const h = hist({ LightGrantedAt: iso(NOW - 40 * DAY), LightGrantUntil: iso(NOW - 10 * DAY) });
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.LIGHT));
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.ENDED));
  assert.equal(h.codes.includes(FREE_GRANT_HISTORY.PREMIUM), false);
});

test('履歴: Premium 付与歴あり / 両方の付与歴あり', () => {
  const p = hist({ PremiumGrantedAt: iso(NOW - 3 * DAY), PremiumGrantLifetime: true });
  assert.ok(p.codes.includes(FREE_GRANT_HISTORY.PREMIUM));
  const both = hist({
    LightGrantedAt: iso(NOW - 60 * DAY), LightGrantUntil: iso(NOW - 30 * DAY),
    PremiumGrantedAt: iso(NOW - 3 * DAY), PremiumGrantLifetime: true,
  });
  assert.ok(both.codes.includes(FREE_GRANT_HISTORY.BOTH));
});

test('履歴: 現在なし + 過去あり（この組合せが探せることが目的）', () => {
  const fields = { LightGrantedAt: iso(NOW - 60 * DAY), LightGrantUntil: iso(NOW - 30 * DAY) };
  const c = cur(fields);
  const h = hist(fields);
  assert.deepEqual(c.codes, [FREE_GRANT_NOW.NONE]);
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.LIGHT));
  assert.equal(matchesFreeGrantNow(c.codes, [FREE_GRANT_NOW.NONE]), true);
  assert.equal(matchesFreeGrantHistory(h.codes, [FREE_GRANT_HISTORY.LIGHT, FREE_GRANT_HISTORY.PREMIUM]), true);
});

test('履歴: 取消済みの記録', () => {
  const h = hist({
    LightGrantedAt: iso(NOW - 20 * DAY), LightGrantRevokedAt: iso(NOW - 19 * DAY),
    LightGrantLifetime: false, LightGrantUntil: null,
  });
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.REVOKED));
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.LIGHT));
  assert.match(h.summary, /取消/);
});

test('履歴: 痕跡だけ残っている場合は「履歴不明」（勝手に付与ありにしない）', () => {
  const h = hist({ LightGrantOp: 'op-123', LightGrantedBy: 'admin' });
  assert.ok(h.codes.includes(FREE_GRANT_HISTORY.UNKNOWN));
  assert.equal(h.codes.includes(FREE_GRANT_HISTORY.LIGHT), false);
  assert.match(h.summary, /痕跡/);
});

// ── 検索（OR / AND / 空配列 / 表示との一致）───────────────────

test('同じ項目内は OR', () => {
  const codes = [FREE_GRANT_NOW.LIGHT_PERIOD];
  assert.equal(matchesFreeGrantNow(codes, [FREE_GRANT_NOW.LIGHT_PERIOD, FREE_GRANT_NOW.PREMIUM_PERIOD]), true);
  assert.equal(matchesFreeGrantNow(codes, [FREE_GRANT_NOW.PREMIUM_PERIOD]), false);
});

test('空配列 / 未指定は条件なし', () => {
  assert.equal(matchesFreeGrantNow([FREE_GRANT_NOW.NONE], []), true);
  assert.equal(matchesFreeGrantNow([FREE_GRANT_NOW.NONE], undefined), true);
  assert.equal(matchesFreeGrantHistory([FREE_GRANT_HISTORY.NO_RECORD], 'all'), true);
});

test('旧形式（単一文字列）でも動く', () => {
  assert.equal(matchesFreeGrantNow([FREE_GRANT_NOW.LIGHT_PERIOD], FREE_GRANT_NOW.LIGHT_PERIOD), true);
});

test('条件要約は「特典」という語を使わない', () => {
  const text = describeFreeGrantFilters({
    now: [FREE_GRANT_NOW.NONE], history: [FREE_GRANT_HISTORY.LIGHT, FREE_GRANT_HISTORY.PREMIUM],
  });
  assert.match(text, /現在は無料付与なし/);
  assert.match(text, /Light の付与歴あり/);
  assert.equal(text.includes('特典'), false, '「特典」が残っている');
  assert.equal(describeFreeGrantFilters({}), '無料付与では絞り込んでいません。');
});

test('一覧表示は色に頼らず文言で分かる', () => {
  const s = formatFreeGrantSummary({
    LightGrantUntil: iso(NOW + 28 * DAY), LightGrantedAt: iso(NOW - 2 * DAY),
  }, NOW);
  assert.match(s.current, /Light 無料/);
  assert.ok(s.badges.length > 0);
  assert.ok(s.badges.every((b) => b.text && b.icon), 'アイコンと文言が揃っていない');
});

test('表示と検索が同じ判定を使う（食い違わない）', () => {
  const fields = { PremiumGrantUntil: iso(NOW + 3 * DAY), PremiumGrantedAt: iso(NOW - DAY) };
  const s = formatFreeGrantSummary(fields, NOW);
  assert.deepEqual(s.currentCodes, resolveCurrentFreeGrant(fields, NOW).codes);
  assert.deepEqual(s.historyCodes, resolveFreeGrantHistory(fields, NOW).codes);
  assert.equal(matchesFreeGrantNow(s.currentCodes, [FREE_GRANT_NOW.PREMIUM_PERIOD]), true);
});

test('件数集計は PII を含まず区分ごとに数える', () => {
  const rows = [
    formatFreeGrantSummary({ LightGrantLifetime: true, LightGrantedAt: iso(NOW - DAY) }, NOW),
    formatFreeGrantSummary({}, NOW),
    formatFreeGrantSummary({ LightGrantUntil: iso(NOW - DAY), LightGrantedAt: iso(NOW - 31 * DAY) }, NOW),
  ];
  const sum = summarizeFreeGrants(rows);
  assert.equal(sum.now.total, 3);
  assert.equal(sum.now[FREE_GRANT_NOW.LIGHT_LIFETIME], 1);
  assert.equal(sum.now[FREE_GRANT_NOW.NONE], 2);
  assert.equal(sum.history[FREE_GRANT_HISTORY.NO_RECORD], 1);
  assert.equal(sum.history[FREE_GRANT_HISTORY.ENDED], 1);
  assert.equal(JSON.stringify(sum).includes('@'), false, 'メールアドレスが混ざっている');
});
