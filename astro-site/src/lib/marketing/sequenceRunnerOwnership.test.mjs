/**
 * sequenceRunnerOwnership.test.mjs — 連続配信の**担当は 1 つだけ**（二重 enqueue を構造で防ぐ）
 *   node --test src/lib/marketing/sequenceRunnerOwnership.test.mjs
 *
 * ── 正本が同時に求めていること ────────────────────────────────
 *   ① `MARKETING_SEQUENCE_CAMPAIGN_ID` **未設定＝対象の連続配信を自動進行**
 *   ② Light 無料体験の 2 本は **`cron-marketing-rollout` が単一担当**
 *      （`cron-campaign-sequence` へ足すと rollout と二重に進む）
 *
 * 以前は未設定のとき「有効な連続配信を全部」返していたので、rollout 所有の 2 本まで
 * 拾って**担当が 2 つ**になった。担当は **campaign の宣言**（`sequence.runner`）を単一源にする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { listCampaigns, getCampaign, validateCampaignSequences } from './campaignCatalog.js';
import {
  resolveSequenceRunner, isOwnedByRunner, isKnownSequenceRunner,
  describeSequence, validateSequence, SEQUENCE_RUNNER,
} from './campaignSequence.js';
import { resolveTickCampaignIds } from '../../../netlify/functions/cron-campaign-sequence.js';
import {
  ROLLOUT_CAMPAIGN_ID, POST_EXPIRY_CAMPAIGN_ID,
} from '../../../netlify/functions/cron-marketing-rollout.js';

const sequences = () => listCampaigns({ includeDisabled: false }).filter((c) => c.sequence);
const ROLLOUT_OWNED = [ROLLOUT_CAMPAIGN_ID, POST_EXPIRY_CAMPAIGN_ID];

// ══════════════════════════════════════════════════════════════════
//  ① 宣言（catalog が単一源）
// ══════════════════════════════════════════════════════════════════

test('【最重要】Light 無料体験 2 本の担当は rollout（既存正本どおり）', () => {
  for (const id of ROLLOUT_OWNED) {
    const c = getCampaign(id, { includeDisabled: true });
    assert.ok(c, `${id} が catalog に無い`);
    assert.equal(resolveSequenceRunner(c), SEQUENCE_RUNNER.ROLLOUT, `${id} の担当が rollout でない`);
  }
});

test('【最重要】それ以外の連続配信は cron-campaign-sequence の担当', () => {
  for (const c of sequences()) {
    if (ROLLOUT_OWNED.includes(c.campaignId)) continue;
    assert.equal(resolveSequenceRunner(c), SEQUENCE_RUNNER.CAMPAIGN_SEQUENCE,
      `${c.campaignId} の担当が既定から変わっている`);
  }
});

test('【最重要】担当が 2 つになる campaign は 1 本も無い（集合が交わらない）', () => {
  const mine = new Set(resolveTickCampaignIds({}));
  for (const id of ROLLOUT_OWNED) {
    assert.equal(mine.has(id), false, `${id} を両方の cron が進めてしまう`);
  }
  // rollout 所有と cron-campaign-sequence 所有で、全連続配信をちょうど分け合う
  const all = sequences().map((c) => c.campaignId);
  const union = new Set([...mine, ...ROLLOUT_OWNED]);
  assert.deepEqual([...union].sort(), [...all].sort(), '担当の決まっていない連続配信がある');
});

test('【重要】未知の runner は catalog 検証で落ちる（黙って既定へ倒さない）', () => {
  assert.equal(isKnownSequenceRunner({ sequence: { runner: 'nope' } }), false);
  const bad = validateSequence({
    campaignId: 'x', sequence: { runner: 'nope', maxSends: 2, steps: [] },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /sequence\.runner/);
  // 実 catalog は通る
  assert.equal(validateCampaignSequences().ok, true);
});

// ══════════════════════════════════════════════════════════════════
//  ② 対象の列挙（env あり / なしの両方）
// ══════════════════════════════════════════════════════════════════

test('【最重要】env 未設定 — 自分の担当だけを自動で拾う', () => {
  const ids = resolveTickCampaignIds({});
  assert.ok(ids.length > 0, '1 本も拾えていない');
  for (const id of ids) {
    assert.ok(isOwnedByRunner(getCampaign(id, { includeDisabled: true }), SEQUENCE_RUNNER.CAMPAIGN_SEQUENCE),
      `${id} は自分の担当ではない`);
  }
  // DRM の 3 本と割引 3 本は入る
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence',
    'campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    assert.ok(ids.includes(id), `${id} が対象に入っていない`);
  }
});

test('【最重要】env に他 runner の campaign を書いても進めない（fail closed）', () => {
  const ids = resolveTickCampaignIds({
    MARKETING_SEQUENCE_CAMPAIGN_ID: `${ROLLOUT_CAMPAIGN_ID},${POST_EXPIRY_CAMPAIGN_ID},campaign-discount-free`,
  });
  assert.deepEqual(ids, ['campaign-discount-free'], 'rollout 所有を env 経由で拾っている');
});

test('【重要】env で名指しした自分の担当はそのまま拾う（既存挙動）', () => {
  const ids = resolveTickCampaignIds({
    MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free,campaign-discount-light,campaign-discount-premium',
  });
  assert.deepEqual(ids, ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']);
});

test('【重要】存在しない campaign 名は黙って進めない', () => {
  assert.deepEqual(resolveTickCampaignIds({ MARKETING_SEQUENCE_CAMPAIGN_ID: 'no-such-campaign' }), []);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 宣言を途中で落とさない（実際に落ちていた）
// ══════════════════════════════════════════════════════════════════

test('【最重要】要約（listCampaigns）が runner / audienceSource を落とさない', () => {
  for (const c of sequences()) {
    const d = describeSequence(getCampaign(c.campaignId, { includeDisabled: true }));
    assert.ok(d, `${c.campaignId} の要約が無い`);
    assert.equal(d.runner, resolveSequenceRunner(getCampaign(c.campaignId, { includeDisabled: true })),
      `${c.campaignId}: 要約の runner が実物と違う`);
    assert.equal(c.sequence.runner, d.runner, `${c.campaignId}: listCampaigns が runner を落としている`);
    assert.equal(typeof c.sequence.audienceSource, 'string',
      `${c.campaignId}: listCampaigns が audienceSource を落としている`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ④ 配線（除外リストを Function 側へ書かない）
// ══════════════════════════════════════════════════════════════════

test('【最重要】担当の判断を Function 側で作り直していない', () => {
  const src = readFileSync(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url), 'utf8');
  const i = src.indexOf('export function resolveTickCampaignIds(');
  const fn = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(fn, /isOwnedByRunner\(/, '宣言を使っていない');
  // campaign 名の除外リストを書いていない
  assert.ok(!fn.includes('light-trial'), 'campaign 名の除外リストを書いている');
  assert.ok(!/EXCLUDE|DENY|SKIP_CAMPAIGNS/.test(fn), '除外リストらしき定数がある');
});

test('【重要】rollout 側は自分の 2 本だけを持つ', () => {
  const src = readFileSync(new URL('../../../netlify/functions/cron-marketing-rollout.js', import.meta.url), 'utf8');
  assert.match(src, /export const ROLLOUT_CAMPAIGN_ID = 'light-trial-to-premium-sequence'/);
  assert.match(src, /export const POST_EXPIRY_CAMPAIGN_ID = 'light-trial-post-expiry-sequence'/);
  // rollout が DRM や割引を進めない
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence',
    'sanrenpuku-upsell-sequence', 'campaign-discount-free']) {
    assert.ok(!src.includes(`'${id}'`), `rollout が ${id} を進めようとしている`);
  }
});
