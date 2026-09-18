/**
 * sendgridContentExport.js — 既存 10 通の**文面を SendGrid Automation へそのまま移す**
 * （純粋・I/O なし）
 *
 * ## 原則：**文面は作り直さない**
 *
 * 件名・本文・CTA・特典欄・フッターはすべて既存 catalog（`campaignDiscountSteps.js` /
 * `prospectPhase2Steps.js`）が単一源で、ここは **`renderCampaign` の出力を
 * SendGrid 用に言い換えるだけ**。文面を書き直すと
 *
 *   - 送信済みの人が受け取った文面と食い違う（何通目まで送ったかの説明がつかない）
 *   - 価格・期限の手書きが混ざる（`emailCopyStandard` の禁止事項）
 *
 * ## SendGrid 側で置き換わるもの（**この 2 つだけ**）
 *
 * | AK の印 | SendGrid | 理由 |
 * |---|---|---|
 * | `{{unsubscribeUrl}}` | `<%asm_group_unsubscribe_raw_url%>` | 配信停止は SendGrid の unsubscribe group が担う |
 * | 宛名 | 固定（`お客様`）| prospect は氏名を持たない（**推測で名前を作らない**）|
 *
 * ⚠️ **未解決の差し込みが 1 つでも残ったら出力しない**（`{{ }}` が本文に残ったまま
 *    配信すると、受信者にそのまま見える）。
 * ⚠️ 出力は**人が SendGrid の画面へ貼るためのもの**。ここから自動投入はしない。
 */

import { renderCampaign, getCampaign as catalogGetCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './marketingEmailShell.js';
import { PROSPECT_SELECTION_OVERRIDES } from './prospectSelectionSteps.js';

/** SendGrid の配信停止リンク（unsubscribe group）の置換タグ */
export const SENDGRID_UNSUBSCRIBE_TAG = '<%asm_group_unsubscribe_raw_url%>';

/** prospect は氏名を持たないので宛名は固定（`buildSalutation(null)` と同じ語） */
export const FALLBACK_SALUTATION_NAME = null;

export const CONTENT_FAIL = Object.freeze({
  CAMPAIGN_MISSING: 'campaign_missing',
  STEP_MISSING: 'step_missing',
  RENDER_FAILED: 'render_failed',
  PLACEHOLDER_LEFT: 'unresolved_placeholder',
  UNSUBSCRIBE_MISSING: 'unsubscribe_tag_missing',
});

/**
 * 差し込みが残っていないか。
 *
 * ⚠️ **`{{ }}` の片側だけで判定しない。** HTML には `@media` の `}}` が出るので、
 *    素朴な `/\{\{|\}\}/` は false positive になる（実際に踏んだ）。
 *    差し込み印の形（`{{name}}`）だけを見る。
 */
const MUSTACHE = /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/;
const hasPlaceholder = (s) => MUSTACHE.test(String(s || ''));

/**
 * 通し番号ぶんの文面を組む。
 *
 * ## 差し替え（2026-09-18 / 案 B）
 *
 * 通し番号 **01 / 02 / 03 / 10** は固定の期限（「◯月◯日まで」）を含んでいたため、
 * **選別配信用の期限なし文面**（`prospectSelectionSteps.js`）へ差し替える。
 *
 * ⚠️ 差し替えるのは**本文だけ**。通し番号 ↔ (campaignId, step) の対応と
 *    `DeliveryKey` は**変えない**ので、「誰が何通目まで受け取ったか」も
 *    **next_message も動かない**（＝既送信の号を送り直さない）。
 * ⚠️ **04〜09 は catalog のまま**（日付を含まないので差し替えない）。
 * ⚠️ `overrides: {}` を渡せば差し替え無しにもできる（比較・検証用）。
 *
 * @param {{plan: Array, lookup?: Function, overrides?: object}} input
 * @returns {{ok: boolean, reason?: string, detail?: string, messages: Array<{
 *   messageNumber: number, campaignId: string, stepNumber: number,
 *   subject: string, html: string, text: string}>}}
 */
export function buildMessageContents({ plan, lookup, overrides } = {}) {
  const get = typeof lookup === 'function'
    ? lookup
    : (id) => catalogGetCampaign(id, { includeDisabled: true });
  const swapByNumber = overrides === undefined ? PROSPECT_SELECTION_OVERRIDES : (overrides || {});

  const messages = [];
  for (const entry of Array.isArray(plan) ? plan : []) {
    const campaign = get(entry.campaignId);
    if (!campaign) {
      return { ok: false, reason: CONTENT_FAIL.CAMPAIGN_MISSING, detail: entry.campaignId, messages: [] };
    }
    const effective = resolveSequenceStep(campaign, entry.stepNumber);
    if (!effective) {
      return {
        ok: false,
        reason: CONTENT_FAIL.STEP_MISSING,
        detail: `${entry.campaignId}:s${entry.stepNumber}`,
        messages: [],
      };
    }
    /**
     * ⚠️ 差し替えは**描画の入力を置き換えるだけ**。
     *    `campaignId` / `stepNumber` / `DeliveryKey` は触らない。
     */
    const override = swapByNumber[entry.messageNumber] || null;
    const source = override
      ? { ...effective, ...override, sequenceStep: effective.sequenceStep }
      : effective;
    /**
     * ⚠️ **`unsubscribeUrl` に SendGrid のタグを直接渡さない。**
     *    シェルは href を HTML escape するので `<%...%>` が `&lt;%...%&gt;` になり、
     *    SendGrid が置換してくれない（＝配信停止リンクが壊れる）。
     *    既定の印のまま描画し、**描画後に印だけ差し替える**。
     */
    const rendered = renderCampaign({
      campaign: source,
      name: FALLBACK_SALUTATION_NAME,
    });
    if (!rendered) {
      return {
        ok: false,
        reason: CONTENT_FAIL.RENDER_FAILED,
        detail: `${entry.campaignId}:s${entry.stepNumber}`,
        messages: [],
      };
    }
    const swap = (v) => String(v).split(UNSUBSCRIBE_PLACEHOLDER).join(SENDGRID_UNSUBSCRIBE_TAG);
    const html = swap(rendered.html);
    const text = swap(rendered.text);
    // ⚠️ 配信停止のタグが消えていたら出さない（**停止できないメールを配らない**）
    if (!html.includes(SENDGRID_UNSUBSCRIBE_TAG) || !text.includes(SENDGRID_UNSUBSCRIBE_TAG)) {
      return {
        ok: false,
        reason: CONTENT_FAIL.UNSUBSCRIBE_MISSING,
        detail: `${entry.campaignId}:s${entry.stepNumber}`,
        messages: [],
      };
    }
    const leftovers = [rendered.subject, html, text].some(hasPlaceholder);
    if (leftovers) {
      return {
        ok: false,
        reason: CONTENT_FAIL.PLACEHOLDER_LEFT,
        detail: `${entry.campaignId}:s${entry.stepNumber}`,
        messages: [],
      };
    }
    messages.push({
      messageNumber: entry.messageNumber,
      campaignId: entry.campaignId,
      stepNumber: entry.stepNumber,
      /** 選別用に差し替えたか（監査で見る） */
      差し替え: Boolean(override),
      subject: rendered.subject,
      html,
      text,
    });
  }
  return { ok: true, messages };
}

/**
 * 移植の突き合わせ表（**本文を含めない**。件名と長さだけ）。
 * 「SendGrid 側に貼った文面が AK の何通目と同じか」を人が確認するための一覧。
 */
export function summarizeMessageContents(result) {
  return {
    ok: result ? result.ok === true : false,
    理由: (result && result.reason) || null,
    通数: ((result && result.messages) || []).length,
    一覧: ((result && result.messages) || []).map((m) => ({
      通し番号: m.messageNumber,
      campaignId: m.campaignId,
      step: m.stepNumber,
      件名: m.subject,
      本文の長さ: m.text.length,
    })),
  };
}

export default buildMessageContents;
