// 会員ランク（docs/MEMBER_RANK.md・2026-10-05 MK 確定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tenureMonths, memberRank, RANKS } from './memberRank.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');
const jst = (s) => Date.parse(`${s}T12:00:00+09:00`);

test('会員歴は JST の暦で満月数（月の途中・月末起点・未来日・読めない値）', () => {
  assert.equal(tenureMonths('2026-01-15', jst('2026-02-14')), 0);
  assert.equal(tenureMonths('2026-01-15', jst('2026-02-15')), 1);
  assert.equal(tenureMonths('2026-01-31', jst('2026-02-27')), 0);
  assert.equal(tenureMonths('2026-01-31', jst('2026-02-28')), 1, '月末起点は月末で満了');
  assert.equal(tenureMonths('2025-10-05', jst('2026-10-05')), 12);
  assert.equal(tenureMonths('2026-11-01', jst('2026-10-05')), null, '未来日はランクを付けない');
  assert.equal(tenureMonths('', jst('2026-10-05')), null);
  assert.equal(tenureMonths('壊れた', jst('2026-10-05')), null);
  // ISO（UTC）でも JST の暦日で読む: 2026-01-14T16:00Z = JST 1/15 01:00
  assert.equal(tenureMonths('2026-01-14T16:00:00.000Z', jst('2026-02-15')), 1);
});

test('ランクは会員歴だけで決まる（0/3/6/12/24 か月）・次のランクまでの月数と進み具合', () => {
  assert.deepEqual(RANKS.map((r) => [r.key, r.minMonths]), [['regular', 0], ['bronze', 3], ['silver', 6], ['gold', 12], ['platinum', 24]]);
  const at = (reg, now) => memberRank({ registeredAt: reg, nowMs: jst(now) });
  let r = at('2026-09-01', '2026-10-05');
  assert.equal(r.rank.key, 'regular'); assert.equal(r.next.key, 'bronze'); assert.equal(r.monthsToNext, 2);
  r = at('2026-04-05', '2026-10-05');
  assert.equal(r.rank.key, 'silver'); assert.equal(r.monthsToNext, 6); assert.equal(r.progress, 0);
  r = at('2025-01-05', '2026-10-05');
  assert.equal(r.rank.key, 'gold'); assert.equal(r.monthsToNext, 3); assert.equal(r.progress, 0.75);
  r = at('2023-01-01', '2026-10-05');
  assert.equal(r.rank.key, 'platinum'); assert.equal(r.next, null); assert.equal(r.monthsToNext, 0); assert.equal(r.progress, 1);
  assert.equal(memberRank({ registeredAt: null }), null, '起点が無ければ出さない');
});

test('マイページ: 有料の権利を持つ会員だけ・起点は登録日（PaidAt を使わない）・取得数や購入額で上げない', () => {
  const d = read('src/pages/dashboard.astro');
  assert.match(d, /const rankInfo = isPaidMember \? memberRank\(\{ registeredAt: viewer\.profile\?\.registeredAt \}\) : null;/);
  assert.match(d, /\{rankInfo && <MemberRankCard rank=\{rankInfo\}/);
  const src = read('src/lib/membership/memberRank.js');
  assert.doesNotMatch(src.replace(/\/\*\*[\s\S]*?\*\//g, ''), /PaidAt|monthCount|payout|amount/i, 'ランク計算は会員歴だけ');
  const card = read('src/components/membership/MemberRankCard.astro');
  assert.match(card, /次のランク <b[^>]*>\{rank\.next\.label\}<\/b> まで あと <strong data-rank-to-next>\{rank\.monthsToNext\}<\/strong> か月/);
  assert.match(card, /\{rank && \(/, 'null のときは描画しない');
  assert.match(card, /background: linear-gradient\(155deg, rgba\(var\(--mr\), 0\.16\)/, '色付きガラス');
  assert.match(read('docs/MEMBER_RANK.md'), /会員歴/);
});
