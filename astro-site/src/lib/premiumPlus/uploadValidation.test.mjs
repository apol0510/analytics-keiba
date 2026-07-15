/**
 * uploadValidation.test.mjs — metadata 検証
 *   node --test src/lib/premiumPlus/uploadValidation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUploadMeta, isValidDate, META_REJECT } from './uploadValidation.js';

const base = { date: '2026-07-15', venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000 };

test('正常 → ok', () => {
  const r = validateUploadMeta(base);
  assert.equal(r.ok, true);
  assert.equal(r.meta.legacy, false);
  assert.equal(r.meta.payout, 277000);
});

// #34 不正 date 拒否
test('#34 不正 date（形式 / 実在しない日 / 範囲外）→ 拒否', () => {
  assert.equal(validateUploadMeta({ ...base, date: '2026-7-5' }).reason, META_REJECT.INVALID_DATE);
  assert.equal(validateUploadMeta({ ...base, date: '2026-02-30' }).reason, META_REJECT.INVALID_DATE);
  assert.equal(validateUploadMeta({ ...base, date: '1999-01-01' }).reason, META_REJECT.INVALID_DATE);
  assert.equal(validateUploadMeta({ ...base, date: 'not-a-date' }).reason, META_REJECT.INVALID_DATE);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2024-02-29'), true);
});

// #35 負数・巨大値拒否
test('#35 負数・巨大値 → 拒否', () => {
  assert.equal(validateUploadMeta({ ...base, payout: -1 }).reason, META_REJECT.INVALID_PAYOUT);
  assert.equal(validateUploadMeta({ ...base, stake: -100 }).reason, META_REJECT.INVALID_STAKE);
  assert.equal(validateUploadMeta({ ...base, payout: 999_999_999_999 }).reason, META_REJECT.INVALID_PAYOUT);
  assert.equal(validateUploadMeta({ ...base, stake: 1e12 }).reason, META_REJECT.INVALID_STAKE);
  assert.equal(validateUploadMeta({ ...base, payout: 1.5 }).reason, META_REJECT.INVALID_PAYOUT);
});

test('raceNumber 範囲（1..12）', () => {
  assert.equal(validateUploadMeta({ ...base, raceNumber: 0 }).reason, META_REJECT.INVALID_RACE);
  assert.equal(validateUploadMeta({ ...base, raceNumber: 13 }).reason, META_REJECT.INVALID_RACE);
  assert.equal(validateUploadMeta({ ...base, raceNumber: null }).ok, true);
});

test('isHit と payout の矛盾を拒否', () => {
  assert.equal(validateUploadMeta({ ...base, isHit: true, payout: 0 }).reason, META_REJECT.HIT_PAYOUT_CONFLICT);
  assert.equal(validateUploadMeta({ ...base, isHit: false, payout: 1000 }).reason, META_REJECT.HIT_PAYOUT_CONFLICT);
  assert.equal(validateUploadMeta({ ...base, isHit: false, payout: 0 }).ok, true);
});

test('venue 文字数・制御文字を拒否', () => {
  assert.equal(validateUploadMeta({ ...base, venue: 'あ'.repeat(21) }).reason, META_REJECT.INVALID_VENUE);
  assert.equal(validateUploadMeta({ ...base, venue: '川崎\n悪意' }).reason, META_REJECT.INVALID_VENUE);
});

// #36 legacy を通常 upload から指定不可
test('#36 legacy は通常 upload で拒否、seed 経路のみ許可', () => {
  assert.equal(validateUploadMeta({ ...base, legacy: true }).reason, META_REJECT.LEGACY_NOT_ALLOWED);
  assert.equal(validateUploadMeta({ ...base, legacy: true }, { allowLegacy: true }).ok, true);
  assert.equal(validateUploadMeta({ ...base, legacy: true }, { allowLegacy: true }).meta.legacy, true);
});
