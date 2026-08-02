/**
 * campaignContentDraft.js — 「今回送る文面」の下書き（純粋・I/O なし・ブラウザ安全）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 件名・本文の正本は `campaignCatalog.js`（コード）。ただし実運用では
 * 「今日の対象者に向けて一文だけ足したい」が毎回起きる。そのたびに PR を出すのは
 * 現実的でないため、**テンプレートを土台に、今回送る分だけを編集**できるようにする。
 *
 * ここが持つのは**下書きの正規化と検証だけ**。描画は `campaignCatalog.renderCampaign`
 * （送信と同じ関数）に任せる。プレビュー専用の描画を作らない。
 *
 * ── 絶対に変えないもの ────────────────────────────────────────
 * - コード上のテンプレート（`CAMPAIGNS`）は書き換えない。`applyDraft` は**新しい
 *   オブジェクトを返す**だけで、元のキャンペーン定義には触れない
 * - campaignId / version / 対象条件（audienceRule）/ CTA URL は編集できない。
 *   誰に送るか・どこへ誘導するかは文面編集の権限外
 *
 * ── fail closed ──────────────────────────────────────────────
 * 未知の差し込み（`{{...}}`）・HTML・生 URL は**エラーにして止める**。
 * 空文字へ黙って置換したり、タグを削って送ったりしない。
 */

/** 件名の上限。RFC 5322 の 998 オクテット制限に対し、UTF-8 3 バイト換算でも収まる長さ */
export const SUBJECT_MAX = 200;
/** 受信箱で切れずに読める目安（超えても送れるが警告を出す） */
export const SUBJECT_RECOMMENDED = 40;
/** 本文の上限（テンプレート最長の約 10 倍。これを超える案内はメール向きではない） */
export const BODY_MAX = 5000;

/** 本文で使える差し込み。**カタログの CAMPAIGN_PLACEHOLDERS と一致させる** */
export const DRAFT_PLACEHOLDERS = Object.freeze([
  { token: '{{salutation}}', label: '宛名', sample: '山田 様',
    note: '氏名があれば「山田 様」、無ければ「お客様」。敬称は自動で付くので「様」を足さない' },
]);

/** 検証エラーコード → 画面にそのまま出す文言 */
export const DRAFT_ERROR = Object.freeze({
  SUBJECT_EMPTY: '件名が空です',
  SUBJECT_NEWLINE: '件名に改行は使えません',
  SUBJECT_TOO_LONG: `件名が長すぎます（${SUBJECT_MAX} 文字まで）`,
  BODY_EMPTY: '本文が空です',
  BODY_TOO_LONG: `本文が長すぎます（${BODY_MAX} 文字まで）`,
  UNKNOWN_PLACEHOLDER: '使えない差し込み項目があります',
  BROKEN_PLACEHOLDER: '差し込みの書き方が壊れています（{{ }} の対応が取れていません）',
  HTML_NOT_ALLOWED: 'HTML タグは使えません（本文はそのまま文字として送られます）',
  URL_NOT_ALLOWED: '本文に URL を直接書けません（リンクは CTA ボタンを使います）',
});

/** 警告コード（送信は止めないが、確認させたいもの） */
export const DRAFT_WARNING = Object.freeze({
  SUBJECT_LONG: `件名が ${SUBJECT_RECOMMENDED} 文字を超えています。スマートフォンでは末尾が省略されます`,
  NO_SALUTATION: '宛名の差し込み（{{salutation}}）がありません。呼びかけ無しで始まります',
});

const str = (v) => String(v ?? '');

/** 改行コードを LF に揃え、行末の空白を落とす（見えない差分で hash が変わらないように） */
export function normalizeDraft(draft = {}) {
  const subject = str(draft.subject).replace(/\r\n?/g, '\n').trim();
  const body = str(draft.body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')   // 空行の連打は 2 行までに丸める
    .trim();
  return { subject, body };
}

/** テンプレートの既定文面（編集欄の初期値・「既定文面に戻す」の戻り先） */
export function defaultDraft(campaign) {
  const c = campaign || {};
  return normalizeDraft({ subject: c.subject, body: c.body });
}

/** 既定文面から変わっているか（変わっていなければスナップショットは既定と同一） */
export function isDraftEdited(campaign, draft) {
  const base = defaultDraft(campaign);
  const now = normalizeDraft(draft);
  return base.subject !== now.subject || base.body !== now.body;
}

/** 本文・件名に残っている `{{...}}` を全部拾う */
function findPlaceholders(text) {
  const out = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let m = re.exec(text);
  while (m) {
    out.push(`{{${m[1].trim()}}}`);
    m = re.exec(text);
  }
  return out;
}

const HTML_LIKE = /<\s*\/?\s*[a-zA-Z!]/;
const URL_LIKE = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * 下書きを検証する。**エラーが 1 つでもあれば送れない**。
 *
 * @param {{campaign: object, draft: {subject?: string, body?: string}}} input
 * @returns {{ok: boolean, errors: string[], warnings: string[], draft: {subject: string, body: string},
 *            unknownPlaceholders: string[], edited: boolean}}
 */
export function validateDraft({ campaign, draft } = {}) {
  const d = normalizeDraft(draft);
  const errors = [];
  const warnings = [];
  const allowed = new Set(DRAFT_PLACEHOLDERS.map((p) => p.token));

  // ── 件名 ─────────────────────────────────────────────
  if (d.subject === '') errors.push(DRAFT_ERROR.SUBJECT_EMPTY);
  if (str(draft && draft.subject).includes('\n') || str(draft && draft.subject).includes('\r')) {
    errors.push(DRAFT_ERROR.SUBJECT_NEWLINE);
  }
  if (d.subject.length > SUBJECT_MAX) errors.push(DRAFT_ERROR.SUBJECT_TOO_LONG);
  if (d.subject.length > SUBJECT_RECOMMENDED) warnings.push(DRAFT_WARNING.SUBJECT_LONG);

  // ── 本文 ─────────────────────────────────────────────
  if (d.body === '') errors.push(DRAFT_ERROR.BODY_EMPTY);
  if (d.body.length > BODY_MAX) errors.push(DRAFT_ERROR.BODY_TOO_LONG);

  // ── 差し込み（未知は空文字に潰さず、必ずエラーにする）──
  const found = [...findPlaceholders(d.subject), ...findPlaceholders(d.body)];
  const unknown = [...new Set(found.filter((t) => !allowed.has(t)))];
  if (unknown.length > 0) errors.push(`${DRAFT_ERROR.UNKNOWN_PLACEHOLDER}: ${unknown.join(' / ')}`);
  const leftover = `${d.subject}\n${d.body}`.replace(/\{\{[^{}]*\}\}/g, '');
  if (leftover.includes('{{') || leftover.includes('}}')) errors.push(DRAFT_ERROR.BROKEN_PLACEHOLDER);
  if (!d.body.includes('{{salutation}}')) warnings.push(DRAFT_WARNING.NO_SALUTATION);

  // ── HTML / URL（描画側でエスケープされるが、書けてしまう UI にしない）──
  if (HTML_LIKE.test(d.subject) || HTML_LIKE.test(d.body)) errors.push(DRAFT_ERROR.HTML_NOT_ALLOWED);
  if (URL_LIKE.test(d.body) || URL_LIKE.test(d.subject)) errors.push(DRAFT_ERROR.URL_NOT_ALLOWED);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    draft: d,
    unknownPlaceholders: unknown,
    edited: campaign ? isDraftEdited(campaign, d) : false,
  };
}

/**
 * 下書きをキャンペーンへ重ねた**新しいオブジェクト**を返す（カタログは変えない）。
 * 件名・本文だけを差し替え、campaignId / version / CTA / 対象条件はテンプレートのまま。
 */
export function applyDraft(campaign, draft) {
  const c = campaign || {};
  const d = normalizeDraft(draft);
  if (!d.subject && !d.body) return { ...c };
  return { ...c, subject: d.subject || c.subject, body: d.body || c.body };
}

/** 画面に出す文字数の内訳（超過は画面側で赤くする） */
export function describeLength(draft) {
  const d = normalizeDraft(draft);
  return {
    subject: { length: d.subject.length, max: SUBJECT_MAX, recommended: SUBJECT_RECOMMENDED,
      over: d.subject.length > SUBJECT_MAX, long: d.subject.length > SUBJECT_RECOMMENDED },
    body: { length: d.body.length, max: BODY_MAX, over: d.body.length > BODY_MAX,
      lines: d.body === '' ? 0 : d.body.split('\n').length },
  };
}

/**
 * プレビュー用のダミー値。**実顧客の氏名を使わない**（管理画面に他人の名前を出さない）。
 */
export const PREVIEW_NAME = '山田';

/** 文面が変わったかを 1 つの文字列で表す（dry-run 失効判定に使う。hash はサーバーが持つ） */
export function draftSignature(draft) {
  const d = normalizeDraft(draft);
  return `${d.subject} ${d.body}`;
}
