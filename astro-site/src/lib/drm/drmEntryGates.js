/**
 * drmEntryGates.js — **DRM の入口だけ**を制御する（純粋・I/O なし）
 *
 * ── なぜ分けるか（2026-09-14 本番実測）────────────────────────
 * 入口を `cron-campaign-sequence` に相乗りさせると、動かすために
 * **共有の大量配信スイッチ**を開けることになる。本番の実測値はこうだった:
 *
 *   `MARKETING_SEQUENCE_SCHEDULER_ENABLED` = **false**（4 ゲートの 1 枚が閉）
 *   `MARKETING_SEQUENCE_CAMPAIGN_ID` = `campaign-discount-free,-light,-premium`
 *
 * つまり DRM の入口を開けるには scheduler を true にするしかなく、その瞬間
 * **割引 3 本（step2 が保留中・step1 は 15,509 通配信済み）が tick される**。
 * 15 名へ送るために数千通のリスクを負う構造になっていた。
 *
 * そこで入口を**別系統**にする:
 *   - 読む env は **`MARKETING_DRM_AUTOSTART_ENABLED` だけ**
 *     （`MARKETING_SEQUENCE_*` は 1 つも読まない）
 *   - 対象 campaign は**固定の許可リスト**。割引 3 本は構造的に選べない
 *   - 送信の土台（キュー登録・実送信）は**既存のゲートをそのまま尊重**する
 *     （新しい送信経路を作らない。既存の安全装置を迂回しない）
 *
 * ⚠️ ここは宣言と検査だけ。誰に送るかは `drmAutoStart.planAutoStartEntries`、
 *    キュー登録は既存の `campaignSend` / `marketingEnqueueContract` が単一源。
 */

/** 入口の許可リスト。**ここに無い campaign は構造的に撃てない** */
export const DRM_ENTRY_CAMPAIGN_IDS = Object.freeze(['free-signup-onboarding']);

/** 入口そのものを開けるスイッチ（**これ 1 つだけ**が入口を制御する） */
export const DRM_ENTRY_ENV = 'MARKETING_DRM_AUTOSTART_ENABLED';

/**
 * 送信の土台のゲート。**入口とは別物**で、既存の契約をそのまま使う。
 * ⚠️ ここを迂回すると「既存の安全装置を通らない送信経路」を新設することになる。
 */
export const DRM_ENTRY_BASE_ENV = Object.freeze({
  ENQUEUE: 'MARKETING_CAMPAIGN_ENABLED',
  DISPATCH: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
});

/**
 * **読んではいけない env**（共有の大量配信スケジューラのもの）。
 * これを読むと、また「DRM を動かすために割引 3 本も動く」構造へ戻る。
 */
export const FORBIDDEN_ENV = Object.freeze([
  'MARKETING_SEQUENCE_SCHEDULER_ENABLED',
  'MARKETING_SEQUENCE_ARMED',
  'MARKETING_SEQUENCE_CAMPAIGN_ID',
]);

export const ENTRY_ABORT = Object.freeze({
  GATE_CLOSED: 'drm_entry_gate_closed',
  BASE_GATE_CLOSED: 'base_send_gate_closed',
  CAMPAIGN_NOT_ALLOWED: 'campaign_not_allowed',
  COUNT_MISMATCH: 'expected_count_mismatch',
  COUNT_REQUIRED: 'expected_count_required',
});

const str = (v) => String(v ?? '').trim();

/** その campaign は入口として撃ってよいか（**許可リストのみ**） */
export function isEntryCampaignAllowed(campaignId) {
  return DRM_ENTRY_CAMPAIGN_IDS.includes(str(campaignId));
}

/**
 * 入口のゲート。
 *
 * @returns {{entryOpen:boolean, baseOpen:boolean, allOpen:boolean, missing:string[]}}
 */
export function readDrmEntryGates(env = {}) {
  const entryOpen = str(env[DRM_ENTRY_ENV]) === 'true';
  const enqueue = str(env[DRM_ENTRY_BASE_ENV.ENQUEUE]) === 'true';
  const dispatch = str(env[DRM_ENTRY_BASE_ENV.DISPATCH]) === 'true';
  const missing = [
    !entryOpen ? DRM_ENTRY_ENV : null,
    !enqueue ? DRM_ENTRY_BASE_ENV.ENQUEUE : null,
    !dispatch ? DRM_ENTRY_BASE_ENV.DISPATCH : null,
  ].filter(Boolean);
  return {
    entryOpen,
    baseOpen: enqueue && dispatch,
    allOpen: entryOpen && enqueue && dispatch,
    missing,
  };
}

/**
 * **下見で見た人数を超えて送らない**ための確認。
 *
 * ⚠️ 手動の実行（live）では `expectedCount` を必須にする。下見の数と 1 でも違えば
 *    **1 通も送らずに止める**。「気づいたら 15 名のはずが 30 名だった」を構造的に防ぐ。
 * ⚠️ 自動実行（定期）では `expectedCount` を求めない代わりに、
 *    campaign 宣言の `maxPerTick` と入口の窓（`withinDays`）が上限になる。
 *
 * @returns {{ok:boolean, reason:string|null, planned:number, expected:number|null}}
 */
export function checkExpectedCount({ planned, expectedCount, manual }) {
  const p = Number(planned);
  if (!manual) return { ok: true, reason: null, planned: p, expected: null };
  if (expectedCount === undefined || expectedCount === null || expectedCount === '') {
    return { ok: false, reason: ENTRY_ABORT.COUNT_REQUIRED, planned: p, expected: null };
  }
  const e = Number(expectedCount);
  if (!Number.isInteger(e) || e < 0) {
    return { ok: false, reason: ENTRY_ABORT.COUNT_REQUIRED, planned: p, expected: null };
  }
  if (e !== p) return { ok: false, reason: ENTRY_ABORT.COUNT_MISMATCH, planned: p, expected: e };
  return { ok: true, reason: null, planned: p, expected: e };
}

export default readDrmEntryGates;
