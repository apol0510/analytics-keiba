/**
 * premiumPlusPreview.js — 管理者専用「表示プレビュー」のスナップショット生成（純粋・I/O なし）
 *
 * 管理者が **実顧客のログインリンク・会員セッションを使わずに**、対象会員の Premium Plus
 * 表示状態を確認するための read-only な解決層。
 *
 * ── 絶対にやらないこと ──────────────────────────────────────────
 *   - 会員セッション（ak_session）の発行・なりすまし・Cookie 差し替え
 *   - magic login link の発行 / メール送信
 *   - Customers への書き込み（eligibility / override / EligibleAt / Payment 系すべて）
 *   このモジュールは **受け取った fields を読むだけ**で、書き込み用フィールドを一切組み立てない。
 *
 * ── 判定は単一源を再利用する ────────────────────────────────────
 *   route / phase / intake / 表示フラグは `resolvePlusMemberFromFields` +
 *   `resolvePremiumPlusRelease` + `describeReleaseState` + `intakeCopy` の結果をそのまま返す。
 *   **プレビュー用に phase / intake の判定を複製しない。**
 *
 * ── シミュレーション（管理画面内に閉じる）──────────────────────
 *   `atMin`        … その日の JST 時刻（分）で受付状態を確認する
 *   `phaseDaysAgo` … anchor を「N 日前」にして PHASE 1〜4 の表示を確認する
 *   どちらも **この関数へ渡した値だけ**に作用する。会員向けページ / API は常に
 *   `Date.now()` と実データで解決するため影響を受けない（guard テストで固定）。
 *
 *   phaseDaysAgo が上書きするのは **anchor 系（SanrenpukuPaidAt / EligibleAt）だけ**。
 *   `premiumPaidAtMs`（ROUTE B の 30 日判定に使う）は触らないので、**route は変わらない**。
 */

import {
  PP_PHASE,
  PP_INTAKE,
  PP_PHASE_START_DAY,
  PP_INTAKE_SCHEDULE,
  describeReleaseState,
  intakeCopy,
  resolvePremiumPlusRelease,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 分 → 'HH:MM'（JST 表示用） */
function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * 管理画面のプルダウンに出す時刻シミュレーション候補（JST）。null = 現在時刻。
 *
 * 各境界の「直前」と「ちょうど」を **PP_INTAKE_SCHEDULE から導出**する。
 * 受付時刻を変更したら候補も自動で追従する（時刻をここに再定義しない）。
 */
export const PP_PREVIEW_TIMES = Object.freeze([
  Object.freeze({ label: '現在時刻', atMin: null }),
  ...[
    PP_INTAKE_SCHEDULE.limitedFromMin - 1,
    PP_INTAKE_SCHEDULE.limitedFromMin,
    PP_INTAKE_SCHEDULE.closingFromMin - 1,
    PP_INTAKE_SCHEDULE.closingFromMin,
    PP_INTAKE_SCHEDULE.closedFromMin - 1,
    PP_INTAKE_SCHEDULE.closedFromMin,
    PP_INTAKE_SCHEDULE.closedFromMin + 150, // 締切後の代表例
  ].map((m) => Object.freeze({ label: hhmm(m), atMin: m })),
]);

/** PHASE 表示確認用の候補（anchor を何日前にするか）。null = 実データのまま。 */
export const PP_PREVIEW_PHASES = Object.freeze([
  Object.freeze({ label: '実データ', daysAgo: null }),
  Object.freeze({ label: 'PHASE 1', daysAgo: 0 }),
  Object.freeze({ label: 'PHASE 2', daysAgo: PP_PHASE_START_DAY.TEASER }),
  Object.freeze({ label: 'PHASE 3', daysAgo: PP_PHASE_START_DAY.PREVIEW }),
  Object.freeze({ label: 'PHASE 4', daysAgo: PP_PHASE_START_DAY.SALE }),
]);

/**
 * シミュレーション時刻を解決する。
 * atMin 未指定 → 現在時刻。0〜1439 の整数のみ受理し、それ以外は null（呼び出し側が拒否する）。
 *
 * @param {{ nowMs: number, atMin?: unknown }} input
 * @returns {number|null}
 */
export function resolvePreviewNowMs({ nowMs, atMin }) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  if (atMin === undefined || atMin === null || atMin === '') return nowMs;
  const m = typeof atMin === 'number' ? atMin : Number(atMin);
  if (!Number.isInteger(m) || m < 0 || m > 1439) return null;
  const d = new Date(nowMs + JST_OFFSET_MS);
  const jstMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - JST_OFFSET_MS;
  return jstMidnight + m * 60 * 1000;
}

/** phaseDaysAgo の検証。null（実データ）か 0〜3650 の整数のみ。 */
export function normalizePreviewPhaseDays(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 3650) return undefined; // undefined = 不正
  return n;
}

/**
 * 管理者プレビュー用スナップショット。**PII（Email / 氏名）は含めない。**
 *
 * @param {{
 *   fields: object|null,      Airtable Customers の fields（読むだけ）
 *   nowMs: number,
 *   atMin?: unknown,          時刻シミュレーション（JST の分）
 *   phaseDaysAgo?: unknown,   PHASE シミュレーション（anchor を N 日前に）
 * }} input
 * @returns {{ ok: true, preview: object } | { ok: false, reason: string }}
 */
export function buildPreviewSnapshot({ fields, nowMs, atMin, phaseDaysAgo }) {
  const previewNow = resolvePreviewNowMs({ nowMs, atMin });
  if (previewNow === null) return { ok: false, reason: 'invalid_at_min' };

  const days = normalizePreviewPhaseDays(phaseDaysAgo);
  if (days === undefined) return { ok: false, reason: 'invalid_phase_days' };

  const member = resolvePlusMemberFromFields(fields, { nowMs: previewNow });

  // PHASE シミュレーションは anchor 系だけを差し替える。
  // premiumPaidAtMs（ROUTE B の 30 日判定）は触らないので route は変わらない。
  const simulated = days === null ? member : {
    ...member,
    sanrenpukuPaidAtMs: previewNow - days * DAY_MS,
    eligibleAtMs: previewNow - days * DAY_MS,
  };

  const release = resolvePremiumPlusRelease({ ...simulated, nowMs: previewNow });
  const intake = release.intake ? intakeCopy(release.intake) : null;

  const jst = new Date(previewNow + JST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');

  return {
    ok: true,
    preview: {
      // 何を基準に解決したか（管理者が誤読しないよう明示する）
      simulated: { atMin: atMin ?? null, phaseDaysAgo: days, isSimulatedTime: atMin !== undefined && atMin !== null && atMin !== '' },
      evaluatedAtJst: `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`,

      // 会員状態（既存の権限正本 resolveEntitlements 由来）
      hasSanrenpuku: member.hasSanrenpuku,
      premiumActive: member.premiumActive,
      daysSincePremium: release.daysSincePremium,

      // 販売対象・資格
      route: release.route,
      eligibility: release.eligibility,
      releaseOverride: release.releaseOverride,
      overrideApplied: release.overrideApplied,

      // 段階公開
      phase: release.phase,
      state: describeReleaseState(release),
      anchorJst: release.anchorMs === null ? null
        : new Date(release.anchorMs + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' '),
      daysSincePurchase: release.daysSincePurchase,

      // 受付
      intake: release.intake,
      intakeTitle: intake ? intake.title : null,
      intakeStatus: intake ? intake.status : null,
      intakeNote: intake ? intake.note : null,

      // 会員向けページに何が出るか
      showTeaser: release.showTeaser,
      showProductPage: release.showProductPage,
      showPurchaseCta: release.showPurchaseCta,
      purchaseEnabled: release.purchaseEnabled,

      // 商品ページの見え方（価格の実額はページ側の定数が正本。ここでは有無だけを返す）
      priceVisible: release.showPurchaseCta,
      ctaEnabled: release.purchaseEnabled,
      canBrowseWhenClosed: release.intake === PP_INTAKE.CLOSED ? release.showProductPage : null,
      productPageStatus: release.showProductPage ? 200 : 404,
    },
  };
}

/** 会員向けページの見え方を日本語 1 行で説明する（管理画面表示用）。 */
export function describePreviewVisibility(preview) {
  if (!preview) return '';
  if (!preview.showProductPage) {
    return preview.showTeaser
      ? '商品ページは 404。会員ページに予告のみ表示されます。'
      : '商品ページは 404。予告も表示されません（会員からは存在が見えません）。';
  }
  if (!preview.showPurchaseCta) return '商品ページを閲覧できます。価格・購入 CTA は非表示（受付準備中）。';
  return preview.purchaseEnabled
    ? '商品ページ・価格・購入 CTA が表示され、申し込み操作ができます。'
    : '商品ページ・価格は表示されますが、購入 CTA は操作不可です（本日分の受付終了）。';
}

export { PP_PHASE, PP_INTAKE };
