/**
 * importPreview.js — 下見（preview）を**あとから動かせない形**で固定する（純粋・I/O なし）
 *
 * ── 何を防ぐか ────────────────────────────────────────────────
 * 取り込みは戻しにくい。だから「下見で見た件数」と「実際に書き込む対象」が
 * **同じファイル・同じ規則**であることを、実行の瞬間に証明できなければならない。
 *
 *   1. 別ファイルへの差し替え … `fileHash` が変わる → 拒否
 *   2. 列の入れ替え・改名     … `normalizedHeaderHash` が変わる → 拒否
 *      （列の**順番違い**は同じ扱い。順不同のファイルを別物にしない）
 *   3. 件数の書き換え         … `summaryHash` が合わない → 拒否
 *   4. 規則・パーサーの更新   … `ruleVersion` / `parserVersion` 不一致 → 拒否
 *   5. 古い下見の使い回し     … `expiresAt` を過ぎたら拒否
 *
 * ── 個人情報 ──────────────────────────────────────────────────
 * この記録に**アドレス・氏名・行の中身は入らない**。入るのは件数・理由コード・ハッシュだけ。
 * `fileHash` は内容から中身を復元できない（照合専用）。
 *
 * ⚠️ 本番の preview 保存（Airtable / Blobs）は**まだ行わない**。いまは呼び出し側が
 *    メモリに保持するだけで、保存先は実 CSV 受領後に決める。
 */

import { createHash } from 'node:crypto';

/**
 * 判定規則の版。**分類・理由コード・除外条件を変えたら上げる**。
 * 版が違う下見では実行できない（古い件数のまま新しい規則で書き込ませない）。
 */
export const RULE_VERSION = 'import-rule-1';

/** 下見の有効期間。長すぎると AK 側の状態（配信停止・有料化）が動いてしまう */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;   // 30 分

/** 実行を断る理由（固定コード） */
export const PREVIEW_REJECT = Object.freeze({
  NO_PREVIEW: 'no_preview',
  EXPIRED: 'preview_expired',
  FILE_CHANGED: 'file_changed',
  HEADER_CHANGED: 'header_changed',
  TAMPERED: 'preview_tampered',
  RULE_CHANGED: 'rule_version_changed',
  PARSER_CHANGED: 'parser_version_changed',
  ID_MISMATCH: 'preview_id_mismatch',
});

export const PREVIEW_REJECT_LABEL = Object.freeze({
  no_preview: '先に下見を実行してください。',
  preview_expired: '下見の有効期限が切れています。もう一度下見を取り直してください。',
  file_changed: '下見のときと違うファイルです。取り込みできません。',
  header_changed: '列の構成が変わっています。もう一度下見を取り直してください。',
  preview_tampered: '下見の記録が書き換えられています。取り込みできません。',
  rule_version_changed: '判定規則が更新されました。もう一度下見を取り直してください。',
  parser_version_changed: '読み取り方法が更新されました。もう一度下見を取り直してください。',
  preview_id_mismatch: '別の下見の記録です。取り込みできません。',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/** 件数オブジェクトを**順序に依存しない**文字列にする（キー順で結果を変えない） */
function stableJson(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/**
 * 下見 1 回分の記録を作る。**この戻り値がそのまま実行時の照合材料**になる。
 *
 * @param {{
 *   importPreviewId: string,
 *   fileHash: string,
 *   normalizedHeaderHash: string,
 *   rowCount: number,
 *   classificationCounts: Record<string, number>,
 *   reasonCounts: Record<string, number>,
 *   parserVersion: string,
 *   encoding?: string,
 *   detectedColumns?: string[],
 *   ignoredColumns?: string[],
 *   createdAtMs: number,
 *   ttlMs?: number,
 * }} input
 */
export function buildPreviewRecord(input = {}) {
  const createdAtMs = Number.isFinite(input.createdAtMs) ? input.createdAtMs : 0;
  const ttl = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : PREVIEW_TTL_MS;
  const record = {
    importPreviewId: str(input.importPreviewId),
    fileHash: str(input.fileHash),
    normalizedHeaderHash: str(input.normalizedHeaderHash),
    rowCount: int(input.rowCount),
    classificationCounts: { ...(input.classificationCounts || {}) },
    reasonCounts: { ...(input.reasonCounts || {}) },
    parserVersion: str(input.parserVersion),
    ruleVersion: RULE_VERSION,
    encoding: str(input.encoding),
    detectedColumns: [...(input.detectedColumns || [])],
    ignoredColumns: [...(input.ignoredColumns || [])],
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + ttl).toISOString(),
    createdAtMs,
    expiresAtMs: createdAtMs + ttl,
  };
  record.summaryHash = computeSummaryHash(record);
  return record;
}

/**
 * 記録の指紋。**中身が 1 つでも変わったら変わる**。
 * ここに入れる項目を増やすときは `RULE_VERSION` も上げること
 *（古い記録の指紋が合わなくなるため）。
 */
export function computeSummaryHash(record = {}) {
  const seed = [
    str(record.importPreviewId),
    str(record.fileHash),
    str(record.normalizedHeaderHash),
    int(record.rowCount),
    stableJson(record.classificationCounts),
    stableJson(record.reasonCounts),
    str(record.parserVersion),
    str(record.ruleVersion),
    str(record.encoding),
    int(record.createdAtMs),
    int(record.expiresAtMs),
  ].join('|');
  return sha(seed).slice(0, 32);
}

/**
 * この下見で実行してよいか。**1 つでも合わなければ実行しない**（fail closed）。
 *
 * @param {{
 *   record: object|null,
 *   importPreviewId?: string,
 *   fileHash?: string,
 *   normalizedHeaderHash?: string,
 *   parserVersion?: string,
 *   nowMs: number,
 * }} input
 * @returns {{ ok: boolean, reason: string|null, label: string|null }}
 */
export function verifyPreviewRecord(input = {}) {
  const r = input.record;
  const no = (reason) => ({ ok: false, reason, label: PREVIEW_REJECT_LABEL[reason] || null });
  if (!r || typeof r !== 'object') return no(PREVIEW_REJECT.NO_PREVIEW);
  if (!str(r.summaryHash)) return no(PREVIEW_REJECT.NO_PREVIEW);

  // 1) 記録そのものが書き換えられていないか（件数の水増し・除外の消去を防ぐ）
  if (computeSummaryHash(r) !== str(r.summaryHash)) return no(PREVIEW_REJECT.TAMPERED);

  // 2) 期限
  const now = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  if (!Number.isFinite(r.expiresAtMs) || now > r.expiresAtMs) return no(PREVIEW_REJECT.EXPIRED);

  // 3) 同じ下見か
  if (str(input.importPreviewId) && str(input.importPreviewId) !== str(r.importPreviewId)) {
    return no(PREVIEW_REJECT.ID_MISMATCH);
  }
  // 4) 同じファイルか（差し替え検知）
  if (str(input.fileHash) && str(input.fileHash) !== str(r.fileHash)) return no(PREVIEW_REJECT.FILE_CHANGED);
  // 5) 同じ列構成か（順番違いは同じ扱い）
  if (str(input.normalizedHeaderHash) && str(input.normalizedHeaderHash) !== str(r.normalizedHeaderHash)) {
    return no(PREVIEW_REJECT.HEADER_CHANGED);
  }
  // 6) 規則・パーサーが更新されていないか
  if (str(r.ruleVersion) !== RULE_VERSION) return no(PREVIEW_REJECT.RULE_CHANGED);
  if (str(input.parserVersion) && str(input.parserVersion) !== str(r.parserVersion)) {
    return no(PREVIEW_REJECT.PARSER_CHANGED);
  }
  return { ok: true, reason: null, label: null };
}

/**
 * 下見の ID。**日時とファイル指紋から決まる**（乱数を使わないので再現できる）。
 * アドレスも件数も復元できない。
 */
export function buildPreviewId({ fileHash, createdAtMs }) {
  const h = str(fileHash);
  const t = int(createdAtMs);
  if (!h || !t) return '';
  return `prev-${sha(`${h}:${t}`).slice(0, 16)}`;
}

/** 画面に出す用のまとめ（**件数とハッシュだけ**。行の中身は含めない） */
export function describePreview(record = {}) {
  return {
    importPreviewId: str(record.importPreviewId),
    rowCount: int(record.rowCount),
    classificationCounts: { ...(record.classificationCounts || {}) },
    reasonCounts: { ...(record.reasonCounts || {}) },
    encoding: str(record.encoding),
    detectedColumns: [...(record.detectedColumns || [])],
    ignoredColumns: [...(record.ignoredColumns || [])],
    parserVersion: str(record.parserVersion),
    ruleVersion: str(record.ruleVersion),
    createdAt: str(record.createdAt),
    expiresAt: str(record.expiresAt),
    summaryHash: str(record.summaryHash),
    /** 下見は**書き込みをしていない**ことを毎回言う */
    written: 'なし（下見のみ・まだ取り込まれていません）',
  };
}

export default buildPreviewRecord;
