/**
 * importStatusRules.js — 外部リストの「状態」列を判定へ落とす（純粋・I/O なし）
 *
 * ── 実データ（2026-08-05 / read-only 集計）────────────────────────
 * `ak-free-users-1.csv` の `状態` 列は **1 種類しか無かった**:
 *
 *     配信中  6,160 件 / 空欄 0 件
 *
 * 他の 2 ファイルに状態列は無い。したがって現時点で「配信停止」「退会」「エラー」等の
 * ラベルは**実在しない**。だが将来別の名簿が来たときに黙って CREATE してしまわないよう、
 * **知っているラベルだけを許可し、知らないラベルは要確認へ倒す**（fail closed）。
 *
 * ── エラーカウント数 ──────────────────────────────────────────
 * 同ファイルの `エラーカウント数` は 0 / 1 / 2 の 3 値（≥1 は 78 行）。
 * 旧配信基盤での配信失敗回数と読める。**列としては取り込まない**が、
 * 「1 回以上失敗した宛先を、確認なしに新規作成しない」ため要確認へ回す。
 * 緩めたい場合は `ERROR_COUNT_REVIEW_THRESHOLD` を上げる（運用判断）。
 */

/** 状態ラベルの判定 */
export const STATUS_VERDICT = Object.freeze({
  SENDABLE: 'sendable',     // 取り込んでよい
  EXCLUDE: 'exclude',       // 取り込まない
  REVIEW: 'review',         // 人が決める（未知を含む）
});

/**
 * 既知の状態ラベル。**表記ゆれを吸収するため正規化してから引く**。
 * ここに無いラベルは必ず REVIEW（推測で許可しない）。
 */
const KNOWN_STATUS = new Map([
  // 送ってよい
  ['配信中', STATUS_VERDICT.SENDABLE],
  ['有効', STATUS_VERDICT.SENDABLE],
  ['購読中', STATUS_VERDICT.SENDABLE],
  ['active', STATUS_VERDICT.SENDABLE],
  // 送ってはいけない（意思表示・到達不能）
  ['配信停止', STATUS_VERDICT.EXCLUDE],
  ['停止', STATUS_VERDICT.EXCLUDE],
  ['解除', STATUS_VERDICT.EXCLUDE],
  ['解約', STATUS_VERDICT.EXCLUDE],
  ['退会', STATUS_VERDICT.EXCLUDE],
  ['退会済み', STATUS_VERDICT.EXCLUDE],
  ['拒否', STATUS_VERDICT.EXCLUDE],
  ['受信拒否', STATUS_VERDICT.EXCLUDE],
  ['無効', STATUS_VERDICT.EXCLUDE],
  ['エラー', STATUS_VERDICT.EXCLUDE],
  ['配信エラー', STATUS_VERDICT.EXCLUDE],
  ['バウンス', STATUS_VERDICT.EXCLUDE],
  ['unsubscribed', STATUS_VERDICT.EXCLUDE],
  ['bounced', STATUS_VERDICT.EXCLUDE],
  ['error', STATUS_VERDICT.EXCLUDE],
  ['invalid', STATUS_VERDICT.EXCLUDE],
]);

/** 表記ゆれの正規化（全角空白・記号・大文字小文字・送り仮名の揺れを寄せる） */
export function normalizeStatusLabel(raw) {
  return String(raw ?? '')
    .replace(/[​-‍﻿]/g, '')
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .replace(/[（）()【】\[\]]/g, '')
    .replace(/[・･,、.。]/g, '')
    .toLowerCase()
    .trim();
}

/** 1 回以上の配信失敗を要確認にする閾値（0 にすると失敗歴を無視する） */
export const ERROR_COUNT_REVIEW_THRESHOLD = 1;

/**
 * 状態ラベル 1 つの判定。
 *
 * - 空欄は **REVIEW**（「状態列があるのに空」は意味が決められない）
 * - 状態列そのものが無いファイルは呼び出し側が `hasStatusColumn:false` を渡す → SENDABLE 扱い
 *   （列が無いことは「不明な状態」ではなく「その名簿は状態を持たない」）
 *
 * @param {{ label?: string, hasStatusColumn?: boolean }} input
 * @returns {{ verdict: string, label: string, known: boolean }}
 */
export function classifyStatus({ label, hasStatusColumn = true } = {}) {
  if (hasStatusColumn === false) {
    return { verdict: STATUS_VERDICT.SENDABLE, label: '', known: true };
  }
  const norm = normalizeStatusLabel(label);
  if (!norm) return { verdict: STATUS_VERDICT.REVIEW, label: '', known: false };
  const hit = KNOWN_STATUS.get(norm);
  if (hit) return { verdict: hit, label: norm, known: true };
  // 知らないラベルは**絶対に SENDABLE にしない**
  return { verdict: STATUS_VERDICT.REVIEW, label: norm, known: false };
}

/**
 * 配信失敗回数の判定。**取り込む列ではない**（判断材料としてのみ使う）。
 * @param {string|number} raw
 */
export function classifyErrorCount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { verdict: STATUS_VERDICT.SENDABLE, count: null };
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return { verdict: STATUS_VERDICT.REVIEW, count: null };
  if (ERROR_COUNT_REVIEW_THRESHOLD > 0 && n >= ERROR_COUNT_REVIEW_THRESHOLD) {
    return { verdict: STATUS_VERDICT.REVIEW, count: n };
  }
  return { verdict: STATUS_VERDICT.SENDABLE, count: n };
}

/** 既知ラベルの一覧（画面・docs 用。**判定はこの表が単一源**） */
export function listKnownStatusLabels() {
  const out = { sendable: [], exclude: [] };
  for (const [label, verdict] of KNOWN_STATUS) {
    if (verdict === STATUS_VERDICT.SENDABLE) out.sendable.push(label);
    else if (verdict === STATUS_VERDICT.EXCLUDE) out.exclude.push(label);
  }
  return out;
}

export default classifyStatus;
