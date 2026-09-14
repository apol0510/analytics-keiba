/**
 * prospectClaimRelease.js — 「送っていないのに予約だけ焼けた」prospect を救う（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-14 の本番事故）
 *
 * prospect は Airtable に配信行を持たないので、冪等性は **Redis の予約**
 * （`claimDelivered` の `SADD`）だけが担う。キュー登録の瞬間に予約が入る設計なので、
 * **キューに積まれたが 1 通も送られなかった**とき、その人は
 * 「送信済み」として扱われたまま**二度と対象に戻らない**。
 *
 * 本番実測（`campaign-discount-free` / 全 11,976 名を走査）:
 *
 *   次に送る step: step1 → 328 ／ step2 → 23 ／ **step3 → 11,625**
 *   開封した人: 0 ／ step2 の実送信: 0 通
 *
 * つまり **11,625 名が step2 を受け取らないまま step3 へ飛ぶ**状態だった。
 * ここはその予約を**名指しで剥がす**ための判断を持つ。
 *
 * ## 絶対にやらないこと
 *
 *   - **step1 の予約は剥がさない**（step1 は実際に 15,509 通送っている。剥がすと再送になる）
 *   - **1 通でも送信実績がある step の予約は剥がさない**（`sentEvidence` で fail closed）
 *   - 予約集合に**無い**鍵を触らない（剥がすのは「いま入っているもの」だけ）
 *   - Customers・課金・prospect レコード本体には一切触れない（触るのは予約集合だけ）
 */

import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveSequenceStep } from './campaignSequence.js';

/** 剥がせない理由（固定コード） */
export const RELEASE_REFUSE = Object.freeze({
  /** step1 は実送信済み。剥がすと再送になる */
  FIRST_STEP: 'first_step_never_released',
  /** その step に送信実績がある = 誰かには届いている */
  HAS_SENT: 'step_has_sent_jobs',
  /** 送信実績を確かめられなかった（分からないまま剥がさない） */
  SENT_UNKNOWN: 'sent_evidence_unavailable',
  /** 予約集合を読めなかった */
  LEDGER_UNAVAILABLE: 'delivered_set_unavailable',
  /** step の本文を決められない */
  STEP_UNRESOLVED: 'step_unresolved',
  /** 下見のときと件数が違う（母集団が動いた） */
  COUNT_MISMATCH: 'expected_count_mismatch',
});

/** 確認文字列（画面から流し込めない値にしておく） */
export const RELEASE_CONFIRM = 'RELEASE PROSPECT CLAIMS';

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 剥がす鍵を決める。**何も書かない**（呼び出し側がゲートの内側で実行する）。
 *
 * @param {{
 *   prospects: Array<{email: string}>,
 *   campaign: object,                      連続配信キャンペーン（base）
 *   step: number,                          剥がす step（**2 以上**）
 *   brand: string,
 *   fromEmail: string,
 *   deliveredKeys: Set<string>|null,       いま予約集合に入っている鍵（null = 読めなかった）
 *   sentEvidence: {ok: boolean, sentJobs: number}|null,  その step の送信実績
 *   expectedCount?: number|null,           下見で確認した件数（TOCTOU ガード）
 * }} input
 * @returns {{ok: boolean, refuse?: string, keys: string[], counts: object}}
 */
export function planProspectClaimRelease({
  prospects, campaign, step, brand, fromEmail, deliveredKeys, sentEvidence, expectedCount = null,
} = {}) {
  const empty = { keys: [], counts: { 母数: 0, 予約あり: 0, 予約なし: 0 } };
  const n = Number(step);
  // ⚠️ step1 は実送信済み。**構造的に**剥がせないようにする
  if (!Number.isInteger(n) || n < 2) return { ok: false, refuse: RELEASE_REFUSE.FIRST_STEP, ...empty };
  if (!sentEvidence || sentEvidence.ok !== true) {
    return { ok: false, refuse: RELEASE_REFUSE.SENT_UNKNOWN, ...empty };
  }
  // ⚠️ 1 通でも出ていれば剥がさない（誰かには届いている＝再送になる）
  if (Number(sentEvidence.sentJobs) > 0) {
    return { ok: false, refuse: RELEASE_REFUSE.HAS_SENT, ...empty };
  }
  if (!(deliveredKeys instanceof Set)) {
    return { ok: false, refuse: RELEASE_REFUSE.LEDGER_UNAVAILABLE, ...empty };
  }
  const sending = resolveSequenceStep(campaign, n);
  if (!sending) return { ok: false, refuse: RELEASE_REFUSE.STEP_UNRESOLVED, ...empty };

  const list = Array.isArray(prospects) ? prospects : [];
  const keys = [];
  let withoutClaim = 0;
  const seen = new Set();
  for (const p of list) {
    const email = lower(p && p.email);
    if (!email) continue;
    const key = computeCampaignDeliveryKey({
      campaign: sending, recipientEmail: email, brand, fromEmail,
    });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // ⚠️ 予約集合に**入っているものだけ**を剥がす
    if (deliveredKeys.has(key)) keys.push(key);
    else withoutClaim += 1;
  }

  const counts = { 母数: list.length, 予約あり: keys.length, 予約なし: withoutClaim };
  if (Number.isInteger(expectedCount) && expectedCount !== keys.length) {
    return { ok: false, refuse: RELEASE_REFUSE.COUNT_MISMATCH, keys: [], counts };
  }
  return { ok: true, keys, counts };
}

/** 応答用の要約（**アドレスも鍵も含めない**） */
export function summarizeClaimRelease({ campaignId, step, counts, released, dryRun }) {
  return {
    キャンペーン: String(campaignId || ''),
    ステップ: Number(step) || null,
    母数: (counts && counts['母数']) || 0,
    '予約あり（剥がす対象）': (counts && counts['予約あり']) || 0,
    '予約なし（触らない）': (counts && counts['予約なし']) || 0,
    剥がした: Number(released) || 0,
    下見: dryRun === true,
  };
}

export default planProspectClaimRelease;
