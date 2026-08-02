/**
 * campaignEditorState.js — 文面編集の状態遷移（純粋・I/O なし）
 *
 * 「編集したのに、確認したのは前の文面だった」を構造的に起こさないための層。
 * 画面はここが返す判定に従うだけで、独自に「送っていいか」を決めない。
 *
 * ── 3 つの値の関係 ──────────────────────────────────────────
 *   draft        いま編集欄にある文面（まだ確認していない）
 *   confirmed    dry-run が受理し、サーバーが hash を返した文面
 *   queued       キューへ積んだ文面（ScheduledEmails のスナップショット）
 *
 * draft ≠ confirmed なら **送信操作は一切できない**。
 * queued は後から変えられない（編集欄をいじっても登録済みジョブは変わらない）。
 */

import { draftSignature, normalizeDraft } from './campaignContentDraft.js';

/** 文面が変わったことを画面へ伝える文言（仕様で文言まで固定されている） */
export const CONTENT_CHANGED_NOTICE =
  '件名または本文が変更されたため、送信対象と内容をもう一度確認してください';

/** 送信できない理由コード */
export const SEND_BLOCK = Object.freeze({
  NO_CAMPAIGN: 'no_campaign',
  INVALID_DRAFT: 'invalid_draft',
  NOT_CONFIRMED: 'not_confirmed',
  CONTENT_CHANGED: 'content_changed',
  NOT_ACKNOWLEDGED: 'not_acknowledged',
});

export const SEND_BLOCK_LABEL = Object.freeze({
  [SEND_BLOCK.NO_CAMPAIGN]: 'キャンペーンを選んでください',
  [SEND_BLOCK.INVALID_DRAFT]: '件名・本文にエラーがあります',
  [SEND_BLOCK.NOT_CONFIRMED]: '送信対象と内容を確認（dry-run）してください',
  [SEND_BLOCK.CONTENT_CHANGED]: CONTENT_CHANGED_NOTICE,
  [SEND_BLOCK.NOT_ACKNOWLEDGED]: '「この件名・本文をこの対象者へ送信します」にチェックしてください',
});

const str = (v) => String(v ?? '');

/**
 * 確認済みの文面と、いまの下書きが同じか。
 * **hash はサーバーが持つ**ので、画面側は正規化した文字列で比べる（同じ根拠で判定するため）。
 */
export function isContentConfirmed({ draft, confirmed } = {}) {
  if (!confirmed || !confirmed.subject) return false;
  return draftSignature(draft || {}) === draftSignature(confirmed);
}

/** dry-run の結果を「今の下書きの確認結果」として持てる形に整える */
export function acceptConfirmation({ draft, contentHash, planFingerprint } = {}) {
  const d = normalizeDraft(draft || {});
  return {
    subject: d.subject,
    body: d.body,
    contentHash: str(contentHash),
    planFingerprint: str(planFingerprint),
  };
}

/**
 * 送信操作（キュー登録 / 今すぐ送信）を許すか。
 *
 * @param {{campaign: object|null, draftValid: boolean, draft: object,
 *          confirmed: object|null, acknowledged?: boolean, requireAck?: boolean}} state
 */
export function canSendContent(state = {}) {
  const { campaign, draftValid, draft, confirmed, acknowledged = false, requireAck = false } = state;
  if (!campaign) return { allowed: false, reason: SEND_BLOCK.NO_CAMPAIGN };
  if (draftValid === false) return { allowed: false, reason: SEND_BLOCK.INVALID_DRAFT };
  if (!confirmed) return { allowed: false, reason: SEND_BLOCK.NOT_CONFIRMED };
  if (!isContentConfirmed({ draft, confirmed })) {
    return { allowed: false, reason: SEND_BLOCK.CONTENT_CHANGED };
  }
  if (requireAck && acknowledged !== true) {
    return { allowed: false, reason: SEND_BLOCK.NOT_ACKNOWLEDGED };
  }
  return { allowed: true, reason: null };
}

/**
 * 最終確認に出す内容（送信前にこれだけは必ず見せる）。
 * 本文は**確認済みの文面**から作る。編集欄の途中の値は使わない。
 */
export function buildSendSummary({ campaign, confirmed, counts = {}, operationId = '' } = {}) {
  if (!campaign || !confirmed) return null;
  return {
    campaignName: str(campaign.name),
    campaignId: str(campaign.campaignId),
    version: str(campaign.version),
    testOnly: campaign.testOnly === true,
    kindLabel: campaign.testOnly === true ? '🧪 運用テスト専用' : '通常配信',
    subject: confirmed.subject,
    body: confirmed.body,
    contentHash: confirmed.contentHash,
    contentHashShort: confirmed.contentHash.slice(0, 12),
    willSend: Number(counts.willSend) || 0,
    excluded: Number(counts.excluded) || 0,
    selected: Number(counts.selected) || 0,
    operationId: str(operationId) || confirmed.planFingerprint.slice(0, 12),
    irreversible: '送信後は取り消せません。実際の顧客へメールが届きます。',
    ackLabel: '表示されている件名・本文を、この対象者へ送信します',
  };
}

/** 登録済みジョブの内容は変えられない（編集欄をいじっても影響しない）ことを画面へ出す */
export const QUEUED_IMMUTABLE_NOTICE =
  'キューへ登録した文面は固定されています。ここで編集しても、登録済みのジョブの内容は変わりません。';
