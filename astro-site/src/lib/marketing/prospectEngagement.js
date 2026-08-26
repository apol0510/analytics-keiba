/**
 * prospectEngagement.js — CSV 取り込み由来の相手を
 * **いつ通常マーケティングから外すか**の単一源（純粋・I/O なし）
 *
 * ## 確定仕様（2026-08-27 MK 確定）
 *
 *   累計 **delivered ≥ 10** かつ **open = 0** かつ
 *   **購入・ログイン等の本人の反応が無い** → 以後は通常マーケティングから自動除外
 *
 * ## 「送信」で数えない（ここを間違えると無関係な人を切る）
 *
 * ⚠️ **分母は「配信成功（delivered）」だけ。** enqueue（キュー登録）も
 *    send attempt（送信試行）も分母にしない。理由:
 *
 *   - enqueue しただけで送られなかった回（ジョブ失敗・ゲート閉・上限持ち越し）
 *   - 送信は試みたが弾かれた回（provider suppression・ハードバウンス）
 *
 *    を数えると、**1 通も届いていない相手が「10 通送っても無反応」に化ける**。
 *    `sends`（試行）と `delivered`（到達）は別々に持ち、**打ち切りは delivered だけ**で決める。
 *
 * ## 旧「送信 3 回で打ち切り」は使わない
 *
 * ⚠️ 旧 prospect 仕様の `MAX_SENDS_WITHOUT_ENGAGEMENT = 3`（送信回数）は
 *    **この経路から外し、定数ごと削除した**。3 と 10 の二重基準が残ると
 *    「どちらで切れたのか」が誰にも説明できなくなる。
 *
 * ## 閾値をここに書かない
 *
 * 数字の正本は `engagementPolicy.js`（`inactiveDelivered` = 10 /
 * `hardInactiveDelivered` = 20）。**複製すると片方だけ直って判定がズレる**ので、
 * このモジュールは解決を委譲するだけにする。
 *
 * ## 適用範囲
 *
 * CSV 取り込み由来（prospect プール / `Source='customer-import:'`）**だけ**。
 * もとからの Airtable 顧客には適用しない（`importCohort.js` / `engagementGuard.js`）。
 * 取引メール（決済確認・認証・サポート・期限通知）には**一切適用しない**。
 */

import {
  classifyEngagement, isBlockedByEngagement, resolveThresholds,
} from './engagementPolicy.js';

/** 打ち切りの数え方。**送信回数ではない**ことを型として残す */
export const PROSPECT_CUTOFF_BASIS = 'delivered';

/** 打ち切りの理由コード（抑止台帳に残る） */
export const PROSPECT_CUTOFF_REASON = 'delivered_without_open';

const n0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/**
 * 打ち切り基準を解決する。**数字は `engagementPolicy` から取る**。
 *
 * @returns {{basis:'delivered', delivered:number, hardDelivered:number}}
 */
export function resolveProspectCutoff(env = process.env) {
  const t = resolveThresholds(env);
  return {
    basis: PROSPECT_CUTOFF_BASIS,
    delivered: t.inactiveDelivered,
    hardDelivered: t.hardInactiveDelivered,
  };
}

/**
 * prospect レコード → `engagementPolicy` が読む形。
 *
 * ⚠️ `sent` は**参考値としてしか渡さない**。`classifyEngagement` が `sent` を見るのは
 *    LOW_ENGAGEMENT（観察段階・止めない）の判定だけで、**除外には効かない**。
 *    除外に効くのは `delivered` だけ。
 * ⚠️ prospect は顧客ではないので `purchases` / `logins` は常に 0。
 *    購入・ログインが起きた相手は Customers へ昇格しており、ここには来ない。
 */
export function prospectEngagementStats(prospect) {
  const p = prospect || {};
  return {
    sent: n0(p.sends),
    delivered: n0(p.delivered),
    open: n0(p.opens),
    click: n0(p.clicks),
    purchases: 0,
    logins: 0,
  };
}

/** 1 件ぶんの分類（`engagementPolicy` の状態をそのまま返す） */
export function classifyProspectEngagement(prospect, { env = process.env, thresholds } = {}) {
  return classifyEngagement(prospectEngagementStats(prospect), {
    thresholds: thresholds || resolveThresholds(env),
  });
}

/**
 * もう通常マーケティングを送らない相手か。
 *
 * **delivered が閾値に達し、open も click も 0** のときだけ true。
 * delivered が 0 のまま `sends` だけ増えても **絶対に true にならない**
 * （届いていないのに切らない）。
 */
export function isProspectCutOff(prospect, opts = {}) {
  const { state } = classifyProspectEngagement(prospect, opts);
  return isBlockedByEngagement(state);
}

/** 画面・ログ用の説明（**数字を直書きしない**） */
export function describeProspectCutoff(env = process.env) {
  const c = resolveProspectCutoff(env);
  return {
    基準: '配信成功（delivered）',
    打ち切り: `delivered ${c.delivered} 通以上で開封 0`,
    完全停止: `delivered ${c.hardDelivered} 通以上で開封 0`,
    対象: 'CSV 取り込み由来のみ（既存 Airtable 顧客には適用しない）',
    数えないもの: ['enqueue（キュー登録）', 'send attempt（送信試行）', 'バウンス・停止リストで落ちた回'],
  };
}

export default isProspectCutOff;
