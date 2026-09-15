/**
 * prospectPhase2Entry.test.mjs — **第 1 期を配り終えた人だけ**が第 2 期へ入る
 *   node --test src/lib/marketing/prospectPhase2Entry.test.mjs
 *
 * ## なぜ要るか（2026-09-15 / 実装ブロッカー）
 *
 * 第 2 期は別 campaignId なので進行はまっさらで、最初の 1 通は step1 になる。
 * 共有 cron は既定で step1 を撃たない（`first_step_is_manual`）ので、
 * catalog へ足しただけでは **第 2 期は 1 通も積まれない**。
 *
 * かといって素通しで許すと、**第 1 期が途中の人にも第 2 期が並走**する。
 * 確定仕様は「**第 1 期 3 通の後段**」。
 *
 * ⚠️ `delivered >= 3` で判定しては**いけない**。累計は過去キャンペーンぶんを含み、
 *    2026-09-15 実測で既に `delivered = 4` の人が 30 名いる。
 *    判定は**第 1 期固有の `DeliveryKey`**で行う。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { planPhase2Entry, PHASE2_ENTRY_SKIP } from './prospectPhase2Entry.js';
import { buildProspectDeliveryKeys } from './prospectSequenceHydration.js';
import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveAutoStart, AUTO_START_KIND } from './campaignSequence.js';
import { PROSPECT_STATE } from './prospectPolicy.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const BRAND = 'AK';
const FROM = 'noreply@keiba.link';
const PRIOR = getCampaign('campaign-discount-free', { includeDisabled: true });
const NEXT = getCampaign('campaign-prospect-phase2', { includeDisabled: true });

const person = (n, over = {}) => ({
  email: `p${n}@example.invalid`, state: PROSPECT_STATE.SENDING, delivered: 0, ...over,
});
/** その人の第 1 期の鍵を `n` 通ぶんだけ「配信済み」にする */
const priorKeysFor = (people, upto) => {
  const map = buildProspectDeliveryKeys({ prospects: people, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const out = new Set();
  const steps = getSequenceSteps(PRIOR);
  for (const [, byStep] of map) {
    for (const s of steps.slice(0, upto)) { const k = byStep.get(s.stepNumber); if (k) out.add(k); }
  }
  return out;
};
const plan = (people, priorDone, over = {}) => planPhase2Entry({
  prospects: people, priorCampaign: PRIOR, nextCampaign: NEXT,
  priorDeliveredKeys: priorDone, brand: BRAND, fromEmail: FROM, ...over,
});

// ══════════════════════════════════════════════════════════════════
//  ① 第 1 期の進み具合で入口が決まる
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 1 期 0 通 → 第 2 期 step1 は積まれない', () => {
  const people = [person(1)];
  const r = plan(people, priorKeysFor(people, 0));
  assert.equal(r.ok, true);
  assert.deepEqual(r.emails, []);
  assert.equal(r.skipped[PHASE2_ENTRY_SKIP.PRIOR_INCOMPLETE], 1);
});

test('【最重要】第 1 期 1 通 → 積まれない', () => {
  const people = [person(1)];
  assert.deepEqual(plan(people, priorKeysFor(people, 1)).emails, []);
});

test('【最重要】第 1 期 2 通 → 積まれない', () => {
  const people = [person(1)];
  assert.deepEqual(plan(people, priorKeysFor(people, 2)).emails, []);
});

test('【最重要】第 1 期 3 step 完了 → 第 2 期 step1 の対象になる', () => {
  const people = [person(1)];
  const r = plan(people, priorKeysFor(people, 3));
  assert.deepEqual(r.emails, ['p1@example.invalid']);
  assert.equal(r.skipped[PHASE2_ENTRY_SKIP.PRIOR_INCOMPLETE], undefined);
});

/**
 * ⚠️ これが「累計で判定してはいけない」理由。
 *    `delivered = 4`（過去キャンペーンぶん）でも、第 1 期が途中なら入れない。
 */
test('【最重要】global delivered 3 / 4 でも、第 1 期未完なら入らない', () => {
  for (const d of [3, 4, 9]) {
    const people = [person(1, { delivered: d })];
    const r = plan(people, priorKeysFor(people, 2));   // 第 1 期は 2 通で止まっている
    assert.deepEqual(r.emails, [], `delivered=${d} で入ってしまった`);
  }
});

test('【重要】第 1 期を終えた人だけが選ばれる（混在）', () => {
  const done = [person(1), person(2)];
  const half = [person(3)];
  const people = [...done, ...half];
  const keys = new Set([...priorKeysFor(done, 3), ...priorKeysFor(half, 2)]);
  const r = plan(people, keys);
  assert.deepEqual(r.emails.sort(), ['p1@example.invalid', 'p2@example.invalid']);
  assert.equal(r.skipped[PHASE2_ENTRY_SKIP.PRIOR_INCOMPLETE], 1);
});

// ══════════════════════════════════════════════════════════════════
//  ② 状態で弾く
// ══════════════════════════════════════════════════════════════════

test('【最重要】ENGAGED / SUPPRESSED / EXHAUSTED / PROMOTED は第 2 期へ入らない', () => {
  for (const st of [PROSPECT_STATE.ENGAGED, PROSPECT_STATE.SUPPRESSED,
    PROSPECT_STATE.EXHAUSTED, PROSPECT_STATE.PROMOTED]) {
    const people = [person(1, { state: st })];
    const r = plan(people, priorKeysFor(people, 3));
    assert.deepEqual(r.emails, [], `${st} が入っている`);
    assert.equal(r.skipped[PHASE2_ENTRY_SKIP.NOT_SENDABLE], 1);
  }
});

test('【重要】第 2 期が既に始まっている人は入口へ入れない（二重に積まない）', () => {
  const people = [person(1)];
  const nextKeys = buildProspectDeliveryKeys({
    prospects: people, campaign: NEXT, brand: BRAND, fromEmail: FROM,
  });
  const started = new Set([nextKeys.get('p1@example.invalid').get(1)]);
  const r = plan(people, priorKeysFor(people, 3), { nextDeliveredKeys: started });
  assert.deepEqual(r.emails, []);
  assert.equal(r.skipped[PHASE2_ENTRY_SKIP.ALREADY_STARTED], 1);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 台帳を読めないときは 1 人も入れない
// ══════════════════════════════════════════════════════════════════

test('【最重要】前 campaign の台帳を読めないなら 1 人も入れない（0 件と混同しない）', () => {
  const people = [person(1)];
  const r = planPhase2Entry({
    prospects: people, priorCampaign: PRIOR, nextCampaign: NEXT,
    priorDeliveredKeys: null, brand: BRAND, fromEmail: FROM,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'prior_ledger_unavailable');
  assert.deepEqual(r.emails, []);
});

test('【重要】1 tick の上限を超えない（残りは次の tick へ）', () => {
  const people = Array.from({ length: 120 }, (_, i) => person(i));
  const r = plan(people, priorKeysFor(people, 3), { maxPerTick: 50 });
  assert.equal(r.emails.length, 50);
  assert.equal(r.capped, true);
  assert.equal(r.carriedOver, 70);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 宣言と配線
// ══════════════════════════════════════════════════════════════════

test('【重要】第 2 期は後段接続を宣言している（catalog）', () => {
  const a = resolveAutoStart(NEXT);
  assert.ok(a, '第 2 期が入口を宣言していない');
  assert.equal(a.kind, AUTO_START_KIND.PRIOR_SEQUENCE_DONE);
  assert.equal(a.afterCampaignId, 'campaign-discount-free');
});

test('【重要】他 campaign の「step1 は手動」契約は不変', () => {
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    assert.equal(resolveAutoStart(getCampaign(id, { includeDisabled: true })), null,
      `${id} に入口が付いている（step1 が自動で撃たれる）`);
  }
  // DRM の入口は従来どおり free_signup のまま
  const drm = resolveAutoStart(getCampaign('free-signup-onboarding', { includeDisabled: true }));
  assert.equal(drm && drm.kind, AUTO_START_KIND.FREE_SIGNUP, 'DRM の入口が変わっている');
});

test('【最重要】tick は後段接続で step1 を許し、対象を選ばれた相手に絞る', () => {
  // 後段接続の分岐がある
  assert.match(CRON, /AUTO_START_KIND\.PRIOR_SEQUENCE_DONE/, '後段接続の分岐が無い');
  assert.match(CRON, /planPhase2Entry\(\{/, '入口の判定を呼んでいない');
  /**
   * ⚠️ step1 を許す条件は**入口ゲートそのもの**として表現している。
   *    後段接続のゲートは「前の campaign を配り終えた人が居ること」。
   *    こうすると DRM 側の `allowFirstStep` の字面を 1 文字も変えずに済む。
   */
  assert.match(CRON, /open: priorEntryCount > 0, missing: \[\]/, '後段接続がゲートになっていない');
  assert.match(CRON, /allowFirstStep: autoStartDecl !== null && \(autoStartGate\.open === true \|\| dryFirstStep\)/,
    'DRM と同じ step1 判定になっていない');
  // 未開始の人は選ばれた相手だけに絞る
  assert.match(CRON, /return priorEntryEmails\.has\(e\);/, '母集団を絞っていない');
  // 絞りは計画より手前
  const iGate = CRON.indexOf('const gatedRows =');
  const iPlan = CRON.indexOf('planSequenceTick({');
  assert.ok(iGate > 0 && iPlan > iGate, '絞りが計画より後ろにある');
});

test('【最重要】DRM の入口ゲートに依存しない（別 env を要求しない）', () => {
  const i = CRON.indexOf('const priorDecl =');
  const body = CRON.slice(i, CRON.indexOf('const priorEntryCount', i));
  // 後段接続の候補づくりは env を 1 つも読まない
  assert.equal(body.includes('readAutoStartGate'), false, '後段接続が DRM のゲートを読んでいる');
  assert.equal(body.includes('MARKETING_DRM_AUTOSTART_ENABLED'), false);
  // ゲートは「前の campaign を配り終えた人が居るか」だけで決まる
  assert.match(CRON, /const autoStartGate = priorDecl\s*\n?\s*\? \{ open: priorEntryCount > 0/,
    'ゲートの決め方が変わっている');
  // DRM（後段接続でない）は従来どおり env のゲートを読む
  assert.match(CRON, /: readAutoStartGate\(env\);/, 'DRM のゲートを読まなくなっている');
});

test('【重要】手動 canary / 下見スイッチ無しで成立する', () => {
  const i = CRON.indexOf('const priorDecl =');
  const body = CRON.slice(i, CRON.indexOf('const priorEntryCount', i));
  // live でのみ動く（下見は従来どおり書かない）
  assert.match(body, /priorDecl && !isDry/, '下見でも入口を作ってしまう');
  assert.equal(body.includes('previewAllowFirstStep'), false, '下見スイッチに依存している');
});

test('【重要】prospect を読めないときは入口を開けない', () => {
  const i = CRON.indexOf('const priorDecl =');
  const body = CRON.slice(i, CRON.indexOf('const priorEntryCount', i));
  assert.match(body, /!prospectInputs \|\| !prospectLedger/, 'prospect 不在を見ていない');
  assert.match(body, /prospect_unavailable/, '理由を残していない');
});

test('【重要】後段接続の実績をログへ残す（黙って 0 にしない）', () => {
  assert.match(CRON, /summary\['後段接続'\]/, '後段接続の実績を残していない');
});
