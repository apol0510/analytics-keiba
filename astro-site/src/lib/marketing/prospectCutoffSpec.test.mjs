/**
 * prospectCutoffSpec.test.mjs — **2026-08-27 MK 確定仕様**を固定する
 *   node --test src/lib/marketing/prospectCutoffSpec.test.mjs
 *
 * 固定するのは 4 点:
 *   1. 打ち切りは **delivered ≥ 10 かつ open = 0** だけ。送信試行・enqueue では切らない
 *   2. 旧「送信 3 回で打ち切り」は**この経路に存在しない**（定数ごと消えている）
 *   3. 自動除外の対象は **CSV 取り込み由来だけ**（既存 Airtable 顧客へは広げない）
 *   4. prospect の配信台帳は **Airtable の行を増やさない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as policy from './prospectPolicy.js';
import {
  buildProspect, applySend, applyDelivered, applyEngagement, applySuppression,
  evaluateProspectForSend, SKIP_REASON, PROSPECT_STATE,
} from './prospectPolicy.js';
import {
  isProspectCutOff, resolveProspectCutoff, prospectEngagementStats,
  classifyProspectEngagement, PROSPECT_CUTOFF_BASIS, PROSPECT_CUTOFF_REASON,
} from './prospectEngagement.js';
import { DEFAULT_THRESHOLDS, ENGAGEMENT } from './engagementPolicy.js';
import { buildEngagementView } from './engagementGuard.js';
import { COHORT } from './importCohort.js';
import { resolveRecipientLedgerPolicy, projectAirtableLedgerGrowth, partitionRecipientsForLedger, RECIPIENT_SOURCE } from './deliveryKeySource.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 7, 1);
const p0 = () => buildProspect({ email: 'a@example.com', nowMs: T0, batchId: 'b1', source: 'csv' });

/* ── 1. 打ち切りは delivered だけ ─────────────────────────────── */

test('確定仕様: 打ち切り基準は delivered（送信回数ではない）', () => {
  assert.equal(PROSPECT_CUTOFF_BASIS, 'delivered');
  const c = resolveProspectCutoff({});
  assert.equal(c.basis, 'delivered');
  // 数字の正本は engagementPolicy。ここで別の数を持たない
  assert.equal(c.delivered, DEFAULT_THRESHOLDS.inactiveDelivered);
  assert.equal(c.delivered, 10, '確定仕様は delivered 10 通');
});

test('delivered が 10 に達し開封 0 なら打ち切る（9 通では打ち切らない）', () => {
  let p = p0();
  for (let i = 1; i <= 9; i += 1) {
    p = applyDelivered({ prospect: p, nowMs: T0 + i * DAY }).prospect;
    assert.equal(isProspectCutOff(p), false, `${i} 通目では打ち切らない`);
    assert.notEqual(p.state, PROSPECT_STATE.EXHAUSTED);
  }
  p = applyDelivered({ prospect: p, nowMs: T0 + 10 * DAY }).prospect;
  assert.equal(p.delivered, 10);
  assert.equal(isProspectCutOff(p), true);
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED);
  assert.equal(p.suppressedReason, PROSPECT_CUTOFF_REASON);
});

test('⚠️ enqueue / 送信試行を何回積んでも打ち切らない（旧 3 回仕様の再混入防止）', () => {
  let p = p0();
  for (let i = 1; i <= 30; i += 1) {
    p = applySend({ prospect: p, nowMs: T0 + i * DAY, runId: `r${i}` });
  }
  // 前提: 試行だけが増えて delivered は 0 のまま
  assert.equal(p.sends, 30);
  assert.equal(p.delivered, 0);
  assert.equal(p.state, PROSPECT_STATE.SENDING, '試行では EXHAUSTED にしない');
  assert.equal(isProspectCutOff(p), false);
  const v = evaluateProspectForSend({ prospect: p, nowMs: T0 + 60 * DAY, isCustomer: false });
  assert.equal(v.send, true, '1 通も届いていない相手を打ち切ってはいけない');
});

test('⚠️ 1 通も届いていない相手（全部バウンス）は分類上も除外されない', () => {
  let p = p0();
  for (let i = 1; i <= 12; i += 1) p = applySend({ prospect: p, nowMs: T0 + i * DAY, runId: 'r' });
  const stats = prospectEngagementStats(p);
  assert.equal(stats.sent, 12);
  assert.equal(stats.delivered, 0);
  const { state } = classifyProspectEngagement(p);
  // sent 12 ≥ lowEngagementSends(5) なので観察段階にはなるが、**止めない**
  assert.equal(state, ENGAGEMENT.LOW_ENGAGEMENT);
  assert.equal(isProspectCutOff(p), false);
});

test('開封があれば delivered が 20 通でも打ち切らない', () => {
  let p = p0();
  for (let i = 1; i <= 20; i += 1) p = applyDelivered({ prospect: p, nowMs: T0 + i * DAY }).prospect;
  assert.equal(p.state, PROSPECT_STATE.EXHAUSTED);

  // 開封していた場合をやり直す
  let q = p0();
  q = applyEngagement({ prospect: q, nowMs: T0 + DAY, kind: 'open' }).prospect;
  assert.equal(q.opens, 1);
  for (let i = 1; i <= 25; i += 1) q = applyDelivered({ prospect: q, nowMs: T0 + i * DAY }).prospect;
  assert.equal(isProspectCutOff(q), false, '開封がある相手は何通届いても打ち切らない');
});

test('打ち切り後は送信対象から外れる（理由は exhausted）', () => {
  let p = p0();
  for (let i = 1; i <= 10; i += 1) p = applyDelivered({ prospect: p, nowMs: T0 + i * DAY }).prospect;
  const v = evaluateProspectForSend({ prospect: p, nowMs: T0 + 90 * DAY, isCustomer: false });
  assert.equal(v.send, false);
  assert.equal(v.reason, SKIP_REASON.EXHAUSTED);
});

test('除外済み・昇格済み・反応済みの delivered は状態を巻き戻さない', () => {
  const sup = applySuppression({ prospect: p0(), nowMs: T0, reason: 'bounce' }).prospect;
  const r = applyDelivered({ prospect: sup, nowMs: T0 + DAY });
  assert.equal(r.changed, false);
  assert.equal(r.prospect.state, PROSPECT_STATE.SUPPRESSED);

  const eng = applyEngagement({ prospect: p0(), nowMs: T0, kind: 'open' }).prospect;
  assert.equal(applyDelivered({ prospect: eng, nowMs: T0 + DAY }).prospect.state, PROSPECT_STATE.ENGAGED);
});

/* ── 2. 旧「送信 3 回」仕様がこの経路に無いこと ─────────────────── */

test('⚠️ 旧仕様 MAX_SENDS_WITHOUT_ENGAGEMENT は削除されている', () => {
  assert.equal('MAX_SENDS_WITHOUT_ENGAGEMENT' in policy, false,
    '送信回数の打ち切り定数を復活させないこと（delivered 基準と二重になる）');
});

test('⚠️ maxSends を渡しても打ち切りに効かない（旧引数の握り込み防止）', () => {
  let p = p0();
  for (let i = 1; i <= 5; i += 1) p = applySend({ prospect: p, nowMs: T0 + i * DAY, runId: 'r' });
  const v = evaluateProspectForSend({
    prospect: p, nowMs: T0 + 30 * DAY, isCustomer: false, maxSends: 3,
  });
  assert.equal(v.send, true, 'maxSends は無視される（delivered だけが打ち切る）');
});

/* ── 3. 自動除外は CSV 取り込み由来だけ ──────────────────────── */

test('自動除外の既定コホートは imported のみ（既存顧客へ広げない）', () => {
  const openHash = new Map([['h', T0]]);
  const view = buildEngagementView({
    list: [], deliveries: [], nowMs: T0,
    signals: { available: true, openByHash: openHash, clickByHash: new Map(), meta: { startedAtMs: T0 - DAY, lastEventAtMs: T0 } },
    measurement: { open: 'enabled' },
    env: {},
  });
  assert.deepEqual(view.suppressionCohorts, [COHORT.IMPORTED]);
});

/* ── 4. prospect は Airtable の行を増やさない ─────────────────── */

test('prospect 受信者は台帳を Airtable へ書かない（env が dual でも）', () => {
  const pol = resolveRecipientLedgerPolicy({ mode: 'dual', source: RECIPIENT_SOURCE.PROSPECT });
  assert.equal(pol.writeAirtable, false, 'レコード上限を消費しない');
  assert.equal(pol.writeRedis, true, '記録が無いと次回二重送信になる');
  assert.equal(pol.readAirtable, true, '移行途中の既送信を見落とさない');
  assert.equal(pol.forcedBySource, true);
});

test('customer 受信者は従来どおり（モードに従う）', () => {
  assert.equal(resolveRecipientLedgerPolicy({ mode: 'dual', source: 'customer' }).writeAirtable, true);
  assert.equal(resolveRecipientLedgerPolicy({ mode: 'airtable', source: 'customer' }).writeAirtable, true);
  assert.equal(resolveRecipientLedgerPolicy({ mode: 'redis', source: 'customer' }).writeAirtable, false);
});

test('12,872 名 × 2 step を prospect で配ると Airtable の増加は 0 行', () => {
  const recipients = Array.from({ length: 12872 }, () => ({ 出所: RECIPIENT_SOURCE.PROSPECT }));
  const g = projectAirtableLedgerGrowth({ mode: 'dual', recipients, steps: 2 });
  assert.equal(g.airtableRows, 0, 'Customers を消すだけでは足りない。台帳側も増やさない');
  assert.equal(g.redisMembers, 25744);
});

test('同じ人数を Customers 経路で配ると Airtable が 25,744 行増える（比較）', () => {
  const recipients = Array.from({ length: 12872 }, () => ({ 出所: RECIPIENT_SOURCE.CUSTOMER }));
  const g = projectAirtableLedgerGrowth({ mode: 'dual', recipients, steps: 2 });
  assert.equal(g.airtableRows, 25744, '本番実測 50,789/50,000 に対してこれだけ積み増す');
});


test('⚠️ 台帳の書き分け: prospect の鍵は Airtable 側へ 1 つも混ざらない', () => {
  const recipients = [
    { deliveryKey: 'a'.repeat(64), 出所: RECIPIENT_SOURCE.CUSTOMER },
    { deliveryKey: 'b'.repeat(64), 出所: RECIPIENT_SOURCE.PROSPECT },
    { deliveryKey: 'c'.repeat(64), 出所: RECIPIENT_SOURCE.PROSPECT },
    { 出所: RECIPIENT_SOURCE.PROSPECT },   // 鍵が無い = 数えるが積まない
  ];
  const part = partitionRecipientsForLedger({ mode: 'dual', recipients });
  assert.deepEqual(part.airtableKeys, ['a'.repeat(64)]);
  assert.equal(part.redisKeys.length, 3, 'prospect も含め全員 Redis へ記録する');
  assert.equal(part.dropped, 1, '鍵が無いものは黙って落とさず数える');
  for (const k of part.airtableKeys) assert.notEqual(k, 'b'.repeat(64));
});

test('出所を書き忘れた受信者は customer 扱い（prospect 側へ勝手に倒さない）', () => {
  const part = partitionRecipientsForLedger({ mode: 'dual', recipients: [{ deliveryKey: 'd'.repeat(64) }] });
  assert.equal(part.airtableKeys.length, 1, '不明を prospect に倒すと台帳が Airtable から消える');
});
