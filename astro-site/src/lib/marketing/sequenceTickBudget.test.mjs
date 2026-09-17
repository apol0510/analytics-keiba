/**
 * sequenceTickBudget.test.mjs — **1 tick で複数 campaign を進める**（時間予算の判定）
 *   node --test src/lib/marketing/sequenceTickBudget.test.mjs
 *
 * ## これが事故そのもの（2026-09-17 本番実測）
 *
 * `MIN_MS_FOR_NEXT_CAMPAIGN`（50 秒）と `TICK_TIME_BUDGET_MS`（55 秒）の差が **5 秒**しかなく、
 * 1 本目が 5 秒を超えて終わると `hasTimeForAnother` が**必ず** false になっていた。
 * つまり **1 本目が 5 秒を超えた tick では 2 本目以降が始まらない**。
 * campaign は 7 本あるので、最悪の場合 `campaign-discount-free` の番は
 * **70 分に 1 回**まで開く（実測の配信速度は約 170 通/時で、軽い campaign が
 * 先頭に来た tick では 2 本目が動くため、常に最悪値になるわけではない）。
 *
 * 実測した所要（下見 / 7 本）: 2 / 3 / 7 / 8 / 11 / 13 / 21 秒。
 * 「1 campaign ≒ 45 秒」という 50 秒の根拠は**古い前提**だった。
 *
 * ## 直し方
 *
 * **同じ tick で実際に掛かった時間の最大 × 安全率**で見積もる。
 * 固定値は「まだ 1 本も走っていない」ときの保険としてだけ残す。
 *
 * ⚠️ ここは**送る人数を変えない**。1 tick の上限（`MAX_RECIPIENTS_PER_TICK`）も
 *    campaign ごとの安全条件も一切触らない。変わるのは「次の 1 本を始めてよいか」だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  rotateCampaigns, hasTimeForAnother, estimateNextCampaignMs,
  TICK_TIME_BUDGET_MS, TICK_HARD_LIMIT_MS, MIN_MS_FOR_NEXT_CAMPAIGN,
  MIN_NEXT_CAMPAIGN_ESTIMATE_MS, NEXT_CAMPAIGN_SAFETY_FACTOR, MAX_CAMPAIGN_MS,
  LATEST_START_MS, HARD_LIMIT_SAFETY_MARGIN_MS,
} from './sequenceTickRotation.js';

const S = 1000;

/**
 * 2026-09-17 に本番で実測した所要（下見）＋ live の送信ぶんを足した想定。
 *
 * ⚠️ **この実測値は安全条件の根拠にしない。** 安全余裕は契約値
 *    （`MAX_CAMPAIGN_MS`）だけで計算する。実測は「契約に収まっているか」の確認と、
 *    本数・公平性のシミュレーションにだけ使う。
 */
const MEASURED_MS = Object.freeze({
  'sanrenpuku-upsell-sequence': 3 * S,
  'light-to-premium-sequence': 4 * S,
  'free-signup-onboarding': 9 * S,
  'campaign-discount-premium': 10 * S,
  'campaign-discount-light': 13 * S,
  'campaign-prospect-phase2': 22 * S,
  'campaign-discount-free': 23 * S,
});
const IDS = Object.keys(MEASURED_MS);
const SLOWEST_MS = Math.max(...Object.values(MEASURED_MS));

// ══════════════════════════════════════════════════════════════════
//  ① 不変条件 — 打ち切り（60 秒）を超えない
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ **これが安全性の根拠**。最も遅く始めた campaign が**契約上の最大**まで掛かっても、
 *    打ち切りまでに**明示的な余裕**を残して終わらなければならない。
 *
 * ```
 * LATEST_START_MS + MAX_CAMPAIGN_MS + HARD_LIMIT_SAFETY_MARGIN_MS <= TICK_HARD_LIMIT_MS
 * ```
 *
 * ⚠️ **実測値（最遅 23 秒）でこの式を計算してはいけない。** 契約が 30 秒なら 30 秒で計算する。
 */
test('【最重要】契約上の最大まで掛かっても、打ち切りより余裕を残して終わる', () => {
  const worstEnd = LATEST_START_MS + MAX_CAMPAIGN_MS;
  assert.ok(
    worstEnd + HARD_LIMIT_SAFETY_MARGIN_MS <= TICK_HARD_LIMIT_MS,
    `契約上の最悪 ${worstEnd / S}s ＋ 余裕 ${HARD_LIMIT_SAFETY_MARGIN_MS / S}s が`
    + ` 打ち切り ${TICK_HARD_LIMIT_MS / S}s を超える`,
  );
});

test('【最重要】hard limit に対する余裕が 5 秒以上ある（ぎりぎりを安全としない）', () => {
  const worstEnd = LATEST_START_MS + MAX_CAMPAIGN_MS;
  const actualMargin = TICK_HARD_LIMIT_MS - worstEnd;
  assert.ok(
    actualMargin >= 5 * S,
    `打ち切りまでの余裕が ${actualMargin / S}s しかない（5s 以上が必要）`,
  );
  assert.ok(HARD_LIMIT_SAFETY_MARGIN_MS >= 5 * S, '安全余裕の宣言が 5 秒未満');
});

test('【最重要】最遅開始は契約値だけから導かれている（実測で狭めていない）', () => {
  assert.equal(
    LATEST_START_MS,
    TICK_HARD_LIMIT_MS - MAX_CAMPAIGN_MS - HARD_LIMIT_SAFETY_MARGIN_MS,
    '最遅開始が契約値の式から外れている',
  );
});

test('【最重要】MAX_CAMPAIGN_MS を 30 秒に広げても式が壊れない（契約の自己整合）', () => {
  // 契約を 30 秒とするなら、その 30 秒で計算して余裕が残ること
  assert.equal(MAX_CAMPAIGN_MS, 30 * S, '契約値が変わった（式と docs も直すこと）');
  assert.ok((TICK_HARD_LIMIT_MS - MAX_CAMPAIGN_MS - HARD_LIMIT_SAFETY_MARGIN_MS) > 0,
    '契約値が大きすぎて開始できる時刻が無い');
});

test('【重要】予算は打ち切りより手前にある', () => {
  assert.ok(TICK_TIME_BUDGET_MS < TICK_HARD_LIMIT_MS, '予算が打ち切り以上になっている');
});

// ══════════════════════════════════════════════════════════════════
//  ② 見積り
// ══════════════════════════════════════════════════════════════════

test('【最重要】実測が無ければ従来どおり保守的な固定値', () => {
  assert.equal(estimateNextCampaignMs({ observedMs: [] }), MIN_MS_FOR_NEXT_CAMPAIGN);
  assert.equal(estimateNextCampaignMs({}), MIN_MS_FOR_NEXT_CAMPAIGN);
});

test('【最重要】平均ではなく最大を使う（遅い campaign を過小評価しない）', () => {
  // 平均なら (2+2+20)/3 = 8s だが、最大 20s を採る
  const got = estimateNextCampaignMs({ observedMs: [2 * S, 2 * S, 20 * S] });
  assert.equal(got, 20 * S * NEXT_CAMPAIGN_SAFETY_FACTOR);
});

test('【最重要】速い実測でも下限を下回らない', () => {
  const got = estimateNextCampaignMs({ observedMs: [1 * S, 2 * S] });
  assert.equal(got, MIN_NEXT_CAMPAIGN_ESTIMATE_MS, '下限が効いていない');
});

test('【重要】壊れた値は無視する（推測で小さくしない）', () => {
  assert.equal(estimateNextCampaignMs({ observedMs: ['x', null, NaN] }), MIN_MS_FOR_NEXT_CAMPAIGN);
  assert.equal(estimateNextCampaignMs({ observedMs: [-5, 20 * S] }), 20 * S * NEXT_CAMPAIGN_SAFETY_FACTOR);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 既存の呼び出しは 1 ミリも変わらない
// ══════════════════════════════════════════════════════════════════

test('【最重要】observedMs を渡さなければ従来どおりの判定', () => {
  // 従来: 残り >= 50s のときだけ true
  assert.equal(hasTimeForAnother({ startedAtMs: 0, nowMs: 4 * S }), true);   // 残り 51s
  assert.equal(hasTimeForAnother({ startedAtMs: 0, nowMs: 6 * S }), false);  // 残り 49s
});

test('【重要】時刻が読めなければ従来どおり true（判定しない）', () => {
  assert.equal(hasTimeForAnother({ startedAtMs: NaN, nowMs: 1, observedMs: [] }), true);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 実測ベースなら 2 本目以降が始まる（これが止まっていた）
// ══════════════════════════════════════════════════════════════════

test('【最重要】1 本目が 7 秒でも 2 本目を始められる（従来は始められなかった）', () => {
  const observedMs = [7 * S];
  assert.equal(
    hasTimeForAnother({ startedAtMs: 0, nowMs: 7 * S }), false,
    '前提が変わっている（従来は false のはず）',
  );
  assert.equal(
    hasTimeForAnother({ startedAtMs: 0, nowMs: 7 * S, observedMs }), true,
    '実測ベースでも 2 本目が始められない',
  );
});

test('【最重要】残りが足りなければ始めない', () => {
  const observedMs = [20 * S];            // 見積り 30s
  assert.equal(hasTimeForAnother({ startedAtMs: 0, nowMs: 20 * S, observedMs }), true);  // 20+30=50 <= 55
  assert.equal(hasTimeForAnother({ startedAtMs: 0, nowMs: 26 * S, observedMs }), false); // 26+30=56 > 55
});

/**
 * ⚠️ **送信漏れを防ぐ最後の歯止め。**
 *    予約（`claimDelivered`）を取ったあとキュー登録の前で打ち切られると、
 *    その鍵は配信済み集合に残り**その人へは二度と送られない**。
 *    見積りが外れても、契約上の最遅開始を過ぎたら新しい campaign は始めない。
 */
test('【最重要】最遅開始を過ぎたら、見積りが小さくても始めない', () => {
  // 実測が極端に速く（1 秒）見積りが下限まで落ちても、絶対条件で止まる
  const observedMs = [1 * S];
  assert.equal(
    hasTimeForAnother({ startedAtMs: 0, nowMs: LATEST_START_MS + 1, observedMs }), false,
    '最遅開始を過ぎても始めてしまう（timeout 直前に予約だけ残る）',
  );
  assert.equal(
    hasTimeForAnother({ startedAtMs: 0, nowMs: LATEST_START_MS, observedMs }), true,
    '最遅開始ちょうどで始められない（厳しすぎる）',
  );
});

test('【最重要】最遅開始ちょうどに始めて契約上の最大まで掛かっても余裕が残る', () => {
  const end = LATEST_START_MS + MAX_CAMPAIGN_MS;
  assert.ok(
    TICK_HARD_LIMIT_MS - end >= HARD_LIMIT_SAFETY_MARGIN_MS,
    `最遅開始 ${LATEST_START_MS / S}s + 契約最大 ${MAX_CAMPAIGN_MS / S}s = ${end / S}s で`
    + ` 余裕が ${(TICK_HARD_LIMIT_MS - end) / S}s しかない`,
  );
});

test('【最重要】見積りが余裕を食い潰す位置では始めない（ぎりぎりを許さない）', () => {
  // elapsed + 見積り が hardLimit ちょうどになる位置は **false** でなければならない
  const estimate = 25 * S;                       // 下限ぶん
  const elapsed = TICK_HARD_LIMIT_MS - estimate; // = 35s → ちょうど 60s で終わる位置
  assert.equal(
    hasTimeForAnother({
      startedAtMs: 0, nowMs: elapsed, observedMs: [estimate / NEXT_CAMPAIGN_SAFETY_FACTOR],
      budgetMs: TICK_HARD_LIMIT_MS,              // 予算側の歯止めを外しても
    }),
    false,
    '打ち切りちょうどに終わる計画を許している（余裕 0 秒）',
  );
});

test('【最重要】打ち切りを超える見込みなら始めない（予算を緩めても歯止めが残る）', () => {
  // 予算を打ち切りより後ろに置いても、打ち切り側で止まる
  const got = hasTimeForAnother({
    startedAtMs: 0, nowMs: 40 * S, observedMs: [20 * S],
    budgetMs: 90 * S, hardLimitMs: TICK_HARD_LIMIT_MS,
  });
  assert.equal(got, false, '打ち切りの歯止めが効いていない');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 公平性 — どの campaign にも番が回る
// ══════════════════════════════════════════════════════════════════

/** 実測所要で 1 tick を回し、走った campaign と終了時刻を返す */
function runTick({ order, useObserved }) {
  let elapsed = 0;
  const observedMs = [];
  const ran = [];
  for (const id of order) {
    if (ran.length > 0 && !hasTimeForAnother({
      startedAtMs: 0, nowMs: elapsed, observedMs: useObserved ? observedMs : null,
    })) break;
    elapsed += MEASURED_MS[id];
    observedMs.push(MEASURED_MS[id]);
    ran.push(id);
  }
  return { ran, elapsed };
}

test('【最重要】実測ベースでは 1 tick で 2 本以上進む', () => {
  let multi = 0;
  for (let t = 0; t < IDS.length; t += 1) {
    const order = rotateCampaigns({ ids: IDS, nowMs: t * 600 * S });
    if (runTick({ order, useObserved: true }).ran.length >= 2) multi += 1;
  }
  assert.ok(multi >= IDS.length - 1, `1 本しか進まない tick が多い（${multi}/${IDS.length}）`);
});

test('【最重要】どの tick でも予算内に終わる', () => {
  for (let t = 0; t < IDS.length * 2; t += 1) {
    const order = rotateCampaigns({ ids: IDS, nowMs: t * 600 * S });
    const { elapsed } = runTick({ order, useObserved: true });
    assert.ok(elapsed <= TICK_TIME_BUDGET_MS, `tick ${t} が予算超過（${elapsed / S}s）`);
    assert.ok(elapsed <= TICK_HARD_LIMIT_MS, `tick ${t} が打ち切り超過（${elapsed / S}s）`);
  }
});

test('【最重要】公平性 — 全 campaign が回ってくる（飢えない）', () => {
  const runs = Object.fromEntries(IDS.map((i) => [i, 0]));
  for (let t = 0; t < IDS.length * 2; t += 1) {
    const order = rotateCampaigns({ ids: IDS, nowMs: t * 600 * S });
    for (const id of runTick({ order, useObserved: true }).ran) runs[id] += 1;
  }
  for (const [id, n] of Object.entries(runs)) {
    assert.ok(n > 0, `${id} が 1 度も走らない（飢えている）`);
  }
});

test('【最重要】実測ベースのほうが回数が増える（遅くならない）', () => {
  const count = (useObserved) => {
    const runs = Object.fromEntries(IDS.map((i) => [i, 0]));
    for (let t = 0; t < IDS.length * 2; t += 1) {
      const order = rotateCampaigns({ ids: IDS, nowMs: t * 600 * S });
      for (const id of runTick({ order, useObserved }).ran) runs[id] += 1;
    }
    return runs;
  };
  const before = count(false);
  const after = count(true);
  for (const id of IDS) {
    assert.ok(after[id] >= before[id], `${id} が修正後に減っている（${before[id]} → ${after[id]}）`);
  }
  // 止まっていた campaign は実際に増える
  assert.ok(
    after['campaign-discount-free'] > before['campaign-discount-free'],
    '止まっていた campaign の回数が増えていない',
  );
});
