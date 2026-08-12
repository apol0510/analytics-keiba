/**
 * lightTrialBarrier.js — 「案内していない付与」を溜めないための**読み取り専用の関所**（純粋）
 *
 * ── 何を防ぐか ──────────────────────────────────────────────
 * 付与と送信を分離した結果、Step1 をまだ案内していないのに翌日の付与が進むと、
 * **使われないまま無料期間 30 日だけが減っていく人**が積み上がる。
 * そこで「前回付与したぶんの Step1 が片付くまで、次の付与へ進まない」。
 *
 * ── 書き込みはしない ────────────────────────────────────────
 * ここがやるのは**数えること**だけ。`CampaignDeliveries` は read-only で参照し、
 * メールのキュー登録も送信も**絶対に行わない**（それは別工程の仕事）。
 *
 * ── 「片付いた（resolved）」の定義 ─────────────────────────────
 * 送信できない人が関所を**永久に塞がない**よう、次のどれかで片付いたとみなす:
 *
 *   1. Step1 が **queue / sent** になっている（案内が届く経路に乗った）
 *   2. **送信対象外として確定**した
 *      - 配信停止・バウンス・停止アカウント等（`marketing.sendable !== true`）
 *      - 配信基盤の suppression に載っている
 *      - 有料契約が有効になった（シーケンスの目的を達成）
 *      - 無料期間が終わった / 取り消された（もう体験中ではない）
 *
 * ⚠️ 2 を入れないと、退会者 1 人で自動付与が永久に止まる。
 */

import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';

/** 自動付与が `ComebackGrantSource` へ書く値（`cron-light-trial-grant` と同じ） */
export const AUTOGRANT_SOURCE = 'light-trial-autogrant';

/** Step1 が「届く経路に乗った」とみなす CampaignDeliveries の状態 */
const REACHED_STATUSES = new Set(['queued', 'sent']);

/** 片付いた理由（画面にそのまま出す） */
export const BARRIER_RESOLVED = Object.freeze({
  STEP1_QUEUED: 'step1_queued',
  NOT_SENDABLE: 'not_sendable',
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  PURCHASED: 'purchased',
  GRANT_ENDED: 'grant_ended',
});

export const BARRIER_RESOLVED_LABEL = Object.freeze({
  step1_queued: 'Step1 がキュー登録・送信済み',
  not_sendable: '配信停止・バウンス等で送信対象外',
  provider_suppressed: '配信基盤の停止リストで送信対象外',
  purchased: '有料契約が成立（案内不要）',
  grant_ended: '無料期間が終了・取消（体験中ではない）',
});

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 自動付与で配った人か（手動付与や他施策は関所の対象にしない） */
export function isAutoGranted(fields) {
  return norm((fields || {}).ComebackGrantSource) === AUTOGRANT_SOURCE;
}

/** `CampaignDeliveries` → Step1 が届く経路に乗った DeliveryKey の集合（read-only） */
export function collectReachedKeys(deliveries) {
  const out = new Set();
  for (const rec of Array.isArray(deliveries) ? deliveries : []) {
    const f = (rec && rec.fields) || {};
    if (String(f.EmailType || '') !== 'campaign') continue;
    if (!REACHED_STATUSES.has(norm(f.Status))) continue;
    const key = String(f.DeliveryKey || '').trim();
    if (key) out.add(key);
  }
  return out;
}

/**
 * 関所を評価する。**1 バイトも書かない。**
 *
 * @param {{records: object[], campaign: object, deliveries: object[],
 *          providerSuppressed: Set<string>|null, brand: string, fromEmail: string,
 *          nowMs: number}} input
 * @returns {{outstanding: number, resolved: number, granted: number,
 *            byReason: object, nextBatchAllowed: boolean}}
 */
export function evaluateStep1Barrier({
  records, campaign, deliveries, providerSuppressed, brand, fromEmail, nowMs,
}) {
  const reached = collectReachedKeys(deliveries);
  const step1 = campaign ? resolveSequenceStep(campaign, 1) : null;
  const byReason = {};
  let granted = 0;
  let outstanding = 0;
  let resolved = 0;

  for (const r of Array.isArray(records) ? records : []) {
    const fields = (r && r.fields) || {};
    if (!isAutoGranted(fields)) continue;

    const grants = resolvePromotionalGrants(fields, nowMs);
    const mk = (r && r.marketing) || {};
    const email = norm(mk.email || fields.Email);

    // 体験中でない人は関所の対象から外す（終わった / 取り消された）
    if (grants.light.active !== true) {
      granted += 1; resolved += 1;
      byReason[BARRIER_RESOLVED.GRANT_ENDED] = (byReason[BARRIER_RESOLVED.GRANT_ENDED] || 0) + 1;
      continue;
    }
    granted += 1;

    // ① Step1 が届く経路に乗ったか
    const key = step1 && email
      ? computeCampaignDeliveryKey({ campaign: step1, recipientEmail: email, brand, fromEmail })
      : null;
    if (key && reached.has(key)) {
      resolved += 1;
      byReason[BARRIER_RESOLVED.STEP1_QUEUED] = (byReason[BARRIER_RESOLVED.STEP1_QUEUED] || 0) + 1;
      continue;
    }

    // ② 送信対象外として確定しているか（**永久に塞がせない**）
    if (mk.premiumActive === true || mk.lightActive === true) {
      resolved += 1;
      byReason[BARRIER_RESOLVED.PURCHASED] = (byReason[BARRIER_RESOLVED.PURCHASED] || 0) + 1;
      continue;
    }
    if (mk.sendable !== true) {
      resolved += 1;
      byReason[BARRIER_RESOLVED.NOT_SENDABLE] = (byReason[BARRIER_RESOLVED.NOT_SENDABLE] || 0) + 1;
      continue;
    }
    if (providerSuppressed instanceof Set && email && providerSuppressed.has(email)) {
      resolved += 1;
      byReason[BARRIER_RESOLVED.PROVIDER_SUPPRESSED] = (byReason[BARRIER_RESOLVED.PROVIDER_SUPPRESSED] || 0) + 1;
      continue;
    }

    // どれにも当たらない = **付与したのにまだ案内していない**
    outstanding += 1;
  }

  return {
    granted,
    outstanding,
    resolved,
    byReason,
    /** 次の付与バッチへ進んでよいか */
    nextBatchAllowed: outstanding === 0,
  };
}

/** 関所の状態を指紋へ混ぜるための短い文字列（同じ状態なら同じ値） */
export function barrierToken(barrier) {
  const b = barrier || {};
  return `barrier:${b.nextBatchAllowed === true ? 'open' : 'wait'}:${Number(b.outstanding) || 0}`;
}
