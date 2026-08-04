/**
 * audienceSnapshot.js — 送信前に対象を**固定する**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 13,000 件規模の配信は数時間〜数日かかる。その間に顧客データは動き続けるので、
 * 「dry-run で見た対象」と「実際に送る対象」がズレる。ズレを放置すると
 *
 *   - 確認したより**多く**送る（増えるのが一番危険）
 *   - 途中で条件が変わり、同じ人へ二度送る
 *   - 何人に送ったのか後から言えない
 *
 * そこで**送信前に対象を snapshot として固定**し、以後の増加を構造的に禁じる。
 *
 * ── 絶対の約束 ────────────────────────────────────────────────
 *   1. **減ることは許す、増えることは許さない**（送信直前の除外は常に有効）
 *   2. snapshot は改ざん検知つき（整合性ハッシュ）
 *   3. 期限切れ・使用済み・別キャンペーンでの再利用は拒否
 *   4. 個人情報を含めない（アドレス・氏名・recordId を持たない）
 *   5. 対象の実体は**サーバーが segmentId + conditionHash から再導出**する
 *
 * ⚠️ このモジュールは**設計と検証だけ**。本番 snapshot の作成は行わない。
 */

import { createHash } from 'node:crypto';

/** snapshot の状態 */
export const SNAPSHOT_STATUS = Object.freeze({
  DRAFT: 'draft',           // 作っただけ。まだ配信に使っていない
  READY: 'ready',           // 検証済み。配信に使える
  IN_USE: 'in_use',         // 配信中
  CONSUMED: 'consumed',     // 使い切り（同じ snapshot で再登録できない）
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

/** 使えない理由（固定コード） */
export const SNAPSHOT_REJECT = Object.freeze({
  MALFORMED: 'malformed',
  INTEGRITY: 'integrity_mismatch',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
  CAMPAIGN_MISMATCH: 'campaign_mismatch',
  CONDITION_CHANGED: 'condition_changed',
  CONTENT_CHANGED: 'content_changed',
  GREW: 'audience_grew',
  EMPTY: 'empty',
});

export const SNAPSHOT_REJECT_LABEL = Object.freeze({
  malformed: '対象リストが壊れています',
  integrity_mismatch: '対象リストが改ざんされています',
  expired: '対象リストの有効期限が切れています',
  consumed: 'この対象リストは使用済みです（同じ相手へ再送するには取り直します）',
  cancelled: 'この対象リストは取り消されています',
  campaign_mismatch: '別のキャンペーン用の対象リストです',
  condition_changed: '抽出条件が変わっています。取り直してください',
  content_changed: 'メール内容が変わっています。取り直してください',
  audience_grew: '対象が増えています。増加は認めません（取り直してください）',
  empty: '対象が 0 名です',
});

/** 既定の有効期限。長すぎると「いつの対象か」が曖昧になる */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 整合性ハッシュ。**中身を 1 文字でも変えると値が変わる**。
 * 個人情報は材料にしない（件数と条件だけで作る）。
 */
export function computeSnapshotIntegrity(snapshot) {
  const s = snapshot || {};
  const seed = [
    str(s.snapshotId), str(s.campaignId), num(s.campaignVersion), str(s.contentHash),
    str(s.segmentId), num(s.segmentVersion), str(s.conditionHash),
    num(s.targetCount), num(s.excludedCount),
    JSON.stringify(s.excludedByReason || {}),
    num(s.createdAtMs), num(s.expiresAtMs), str(s.createdBy),
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
}

/**
 * snapshot を組み立てる（**保存はしない**。呼び出し側の責務）。
 *
 * @param {{ snapshotId: string, campaignId: string, campaignVersion: number,
 *           contentHash: string, segmentId: string, segmentVersion: number,
 *           conditionHash: string, targetCount: number, excludedCount: number,
 *           excludedByReason?: object, createdBy: string, nowMs: number, ttlMs?: number }} input
 */
export function buildAudienceSnapshot(input = {}) {
  const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const ttl = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : SNAPSHOT_TTL_MS;
  const base = {
    snapshotId: str(input.snapshotId),
    campaignId: str(input.campaignId),
    campaignVersion: num(input.campaignVersion),
    contentHash: str(input.contentHash),
    segmentId: str(input.segmentId),
    segmentVersion: num(input.segmentVersion),
    conditionHash: str(input.conditionHash),
    targetCount: num(input.targetCount),
    excludedCount: num(input.excludedCount),
    excludedByReason: input.excludedByReason && typeof input.excludedByReason === 'object'
      ? input.excludedByReason : {},
    createdAtMs: now,
    expiresAtMs: now + ttl,
    createdBy: str(input.createdBy),
    status: num(input.targetCount) > 0 ? SNAPSHOT_STATUS.READY : SNAPSHOT_STATUS.DRAFT,
  };
  return { ...base, integrity: computeSnapshotIntegrity(base) };
}

/**
 * 配信に使ってよいか。**1 つでも外れたら使わない**（fail closed）。
 *
 * @param {{ snapshot: object, campaignId: string, campaignVersion: number,
 *           contentHash: string, conditionHash: string, nowMs: number }} input
 */
export function canUseSnapshot(input = {}) {
  const s = input.snapshot;
  const no = (reason) => ({ ok: false, reason, label: SNAPSHOT_REJECT_LABEL[reason] || reason });
  if (!s || typeof s !== 'object' || !str(s.snapshotId)) return no(SNAPSHOT_REJECT.MALFORMED);

  // 改ざん検知は**何よりも先**（他の値を信用する前に確かめる）
  const { integrity, ...rest } = s;
  if (str(integrity) !== computeSnapshotIntegrity(rest)) return no(SNAPSHOT_REJECT.INTEGRITY);

  if (s.status === SNAPSHOT_STATUS.CONSUMED) return no(SNAPSHOT_REJECT.CONSUMED);
  if (s.status === SNAPSHOT_STATUS.CANCELLED) return no(SNAPSHOT_REJECT.CANCELLED);
  if (num(s.targetCount) <= 0) return no(SNAPSHOT_REJECT.EMPTY);

  const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  if (num(s.expiresAtMs) > 0 && now >= num(s.expiresAtMs)) return no(SNAPSHOT_REJECT.EXPIRED);

  if (str(input.campaignId) !== str(s.campaignId)
    || num(input.campaignVersion) !== num(s.campaignVersion)) {
    return no(SNAPSHOT_REJECT.CAMPAIGN_MISMATCH);
  }
  if (str(input.contentHash) !== str(s.contentHash)) return no(SNAPSHOT_REJECT.CONTENT_CHANGED);
  if (str(input.conditionHash) !== str(s.conditionHash)) return no(SNAPSHOT_REJECT.CONDITION_CHANGED);

  return { ok: true, reason: null, label: '' };
}

/**
 * 送信直前の再判定。**減るのは正常、増えるのは異常**。
 *
 * snapshot を取ったあとに配信停止・バウンス・有料化した人は必ず落とす。
 * 逆に「条件に合う人が増えたから足す」は**絶対にしない**（確認した数より多く送らない）。
 *
 * @param {{ snapshot: object, currentEligibleCount: number,
 *           excludedSinceSnapshot?: object }} input
 */
export function applyPreSendExclusions(input = {}) {
  const s = input.snapshot || {};
  const target = num(s.targetCount);
  const current = num(input.currentEligibleCount);
  const since = input.excludedSinceSnapshot && typeof input.excludedSinceSnapshot === 'object'
    ? input.excludedSinceSnapshot : {};

  if (current > target) {
    return {
      ok: false,
      reason: SNAPSHOT_REJECT.GREW,
      label: SNAPSHOT_REJECT_LABEL[SNAPSHOT_REJECT.GREW],
      snapshotCount: target,
      currentCount: current,
      willSend: 0,
    };
  }
  return {
    ok: true,
    reason: null,
    snapshotCount: target,
    currentCount: current,
    /** 実際に送る数。**snapshot を超えない** */
    willSend: Math.min(current, target),
    shrunkBy: target - current,
    excludedSinceSnapshot: since,
    note: target === current ? '対象は snapshot 作成時から変わっていません。'
      : `snapshot 作成後に ${target - current} 名が除外条件に該当したため、その分だけ減らして送ります。`,
  };
}

/** 使い切りにする（同じ snapshot からの二重キュー登録を止める） */
export function consumeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const next = { ...snapshot, status: SNAPSHOT_STATUS.CONSUMED };
  const { integrity, ...rest } = next;
  return { ...rest, integrity: computeSnapshotIntegrity(rest) };
}

/** 画面に出す要約（**人数と状態だけ**。ID・条件ハッシュは出さない） */
export function describeSnapshot(snapshot, nowMs) {
  const s = snapshot || {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!str(s.snapshotId)) return '対象は固定されていません';
  const left = num(s.expiresAtMs) - now;
  const mins = left > 0 ? Math.ceil(left / 60000) : 0;
  return `対象 ${num(s.targetCount)} 名を固定済み（除外 ${num(s.excludedCount)} 名 / 有効期限まで約 ${mins} 分）`;
}

export default buildAudienceSnapshot;
