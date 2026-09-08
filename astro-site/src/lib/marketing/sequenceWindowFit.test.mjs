/**
 * sequenceWindowFit.test.mjs — 連続配信が**期間内に配り終わる**ことを定義側で固定する
 *   node --test src/lib/marketing/sequenceWindowFit.test.mjs
 *
 * ## 何を固定するか（2026-09-08 に確認した穴）
 *
 * 期間限定キャンペーンは期間外になると `enabled` が false になり、
 * 途中まで送った人は `campaign_disabled` で**恒久停止**する（設計どおり）。
 * だが「最終 step が期間内に収まるか」は誰も検査していなかったので、
 * **配り切れない定義を置けてしまう**。置くと続きが無言で届かなくなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeSequenceWindowFit, totalSequenceDays, findSequenceWindowOverflows,
} from './sequenceWindowFit.js';
import { CAMPAIGNS, CAMPAIGN_DISABLED_REASON } from './campaignCatalog.js';
import { CAMPAIGN_WINDOW } from '../promotions/campaignOffers.js';

const DAY = 86400000;
const WINDOW = { startsAtIso: '2026-08-24T00:00:00+09:00', endsAtIso: '2026-09-07T00:00:00+09:00' };
const step = (n, delayDays) => ({ stepNumber: n, delayDays });
const seq = (steps, maxSends) => ({
  campaignId: 'fit-test', sequence: { maxSends: maxSends ?? steps.length, steps },
});

test('最終 step までの日数は delayDays の総和', () => {
  assert.equal(totalSequenceDays(seq([step(1, 0), step(2, 5), step(3, 6)])), 11);
  assert.equal(totalSequenceDays(seq([step(1, 0)])), 0);
  assert.equal(totalSequenceDays({ sequence: { steps: [] } }), null);
});

test('maxSends を超える step は数えない（送らない step で判定しない）', () => {
  assert.equal(totalSequenceDays(seq([step(1, 0), step(2, 5), step(3, 90)], 2)), 5);
});

test('期間内に収まれば ok', () => {
  const fit = describeSequenceWindowFit({ campaign: seq([step(1, 0), step(2, 5), step(3, 6)]), window: WINDOW });
  assert.equal(fit.ok, true);
  assert.equal(fit.totalDays, 11);
  assert.equal(fit.windowDays, 14);
});

test('【検知】最終 step が期間を超える定義を弾く', () => {
  const fit = describeSequenceWindowFit({ campaign: seq([step(1, 0), step(2, 7), step(3, 8)]), window: WINDOW });
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'last_step_after_window');
  assert.equal(fit.totalDays, 15);
});

test('【検知】1 通目が遅れて始まると超える場合も分かる（実運用の形）', () => {
  const campaign = seq([step(1, 0), step(2, 5), step(3, 6)]);
  const startedAtMs = Date.parse('2026-08-25T00:00:00+09:00');
  assert.equal(describeSequenceWindowFit({ campaign, window: WINDOW, startedAtMs }).ok, true);
  // 4 日遅れて始めると最終 step が期間外へ出る
  const late = Date.parse('2026-08-28T00:00:00+09:00');
  const fit = describeSequenceWindowFit({ campaign, window: WINDOW, startedAtMs: late });
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'last_step_after_window');
});

test('1 通しかない campaign は対象外（期間を跨がない）', () => {
  assert.equal(describeSequenceWindowFit({ campaign: seq([step(1, 0)]), window: WINDOW }).ok, true);
});

test('期間が読めない・逆順なら fail closed', () => {
  const campaign = seq([step(1, 0), step(2, 5)]);
  assert.equal(describeSequenceWindowFit({ campaign, window: null }).ok, false);
  assert.equal(describeSequenceWindowFit({ campaign, window: { startsAtIso: 'x', endsAtIso: 'y' } }).reason, 'window_unreadable');
  assert.equal(describeSequenceWindowFit({
    campaign, window: { startsAtIso: WINDOW.endsAtIso, endsAtIso: WINDOW.startsAtIso },
  }).reason, 'window_inverted');
});

// ── カタログの不変条件 ──────────────────────────────────────
/** 期間で自動停止する campaign（`enabled` が期間依存であることの宣言） */
const isWindowBound = (c) => c && c.disabledReason === CAMPAIGN_DISABLED_REASON.WINDOW_CLOSED;

test('【不変条件】期間で止まる連続配信は、期間内に最終 step まで配り切れる', () => {
  const bound = CAMPAIGNS.filter(isWindowBound);
  assert.ok(bound.length > 0, '期間依存の campaign が 1 本も無い（検査が素通りしている）');
  const overflows = findSequenceWindowOverflows({
    campaigns: CAMPAIGNS, window: CAMPAIGN_WINDOW, isWindowBound,
  });
  assert.deepEqual(
    overflows, [],
    `期間内に配り終われない連続配信がある: ${JSON.stringify(overflows)}`,
  );
});

test('【不変条件】検査は本物の期間を見ている（期間を縮めれば落ちる）', () => {
  const narrow = {
    startsAtIso: CAMPAIGN_WINDOW.startsAtIso,
    endsAtIso: new Date(Date.parse(CAMPAIGN_WINDOW.startsAtIso) + 2 * DAY).toISOString(),
  };
  const overflows = findSequenceWindowOverflows({ campaigns: CAMPAIGNS, window: narrow, isWindowBound });
  assert.ok(overflows.length > 0, '期間を 2 日にしても検知しない = 検査が効いていない');
});
