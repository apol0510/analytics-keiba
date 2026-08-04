/**
 * importMergePlan.js — 複数ファイルを 1 つの取り込み対象へまとめる（純粋・I/O なし）
 *
 * ── 実データにもとづく方針（2026-08-05 / read-only 集計）──────────
 *   file1  6,160 行 / 列: エラーカウント数・状態・氏名・電話番号・E-Mail / 氏名 0.6%
 *   file2  9,621 行 / 列: E-Mail のみ                                   / 氏名 0%
 *   file3 15,688 行 / 列: メールアドレス・名前・電話番号                 / 氏名 0.3%
 *   包含: **file2 ⊂ file3**（9,610 件すべて）/ file1 のうち file3 に無いのは 109 件
 *   統合後の有効一意アドレス 15,779 / 氏名が一意に決まる 85 / 食い違い **1**
 *
 * ── メールが正本、氏名は補完だけ ──────────────────────────────
 * どのファイルが「新しい」かはファイル日時では決められない（file3 が最古だが最大かつ
 * file2 を完全に含む）。そこで**順位付けで勝者を決めない**:
 *
 *   - 対象は「3 ファイル統合後の**正規化一意メール**」
 *   - 氏名は**空欄を埋めるときだけ**使う。既存 AK 顧客の氏名は上書きしない
 *   - 同じアドレスに**違う氏名**が複数ファイルにあるときは、
 *     どちらが正しいか決められないので **REVIEW_REQUIRED**（自動決定しない）
 *   - 電話番号・エラーカウント数は取り込まない
 */

import { normalizeEmail, isValidEmail } from './customerImport.js';
import { classifyStatus, classifyErrorCount, STATUS_VERDICT } from './importStatusRules.js';

/** 統合時に付く判定（分類そのものは `customerImport` 側の verdict と対応させる） */
export const MERGE_FLAG = Object.freeze({
  NAME_CONFLICT: 'name_conflict',
  STATUS_UNKNOWN: 'status_unknown',
  STATUS_EXCLUDED: 'status_excluded',
  DELIVERY_ERROR_HISTORY: 'delivery_error_history',
});

/** 氏名の突合用に正規化（表記ゆれで「別人」にしない） */
export function normalizeName(raw) {
  return String(raw ?? '')
    .replace(/[​-‍﻿]/g, '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

/**
 * 複数ファイルの行を 1 つのアドレス単位へまとめる。
 *
 * @param {{
 *   files: Array<{ name: string, rows: Array<object>, hasStatusColumn?: boolean }>,
 * }} input
 * @returns {{
 *   entries: Array<{ email, name, sources, flags, statusVerdict }>,
 *   stats: object,
 * }}
 */
export function mergeImportFiles({ files } = {}) {
  const list = Array.isArray(files) ? files : [];
  /** email -> エントリ */
  const map = new Map();
  const stats = {
    ファイル数: list.length,
    総行数: 0,
    メール空: 0,
    不正メール: 0,
    ファイル内重複: 0,
    ファイル間重複: 0,
    統合一意アドレス: 0,
    氏名あり: 0,
    氏名の食い違い: 0,
    状態で除外: 0,
    状態が不明: 0,
    配信失敗歴あり: 0,
  };

  for (const file of list) {
    const seenInFile = new Set();
    for (const row of (file.rows || [])) {
      stats.総行数 += 1;
      const email = normalizeEmail(row && row.email);
      if (!email) { stats.メール空 += 1; continue; }
      if (!isValidEmail(email)) { stats.不正メール += 1; continue; }
      if (seenInFile.has(email)) { stats.ファイル内重複 += 1; continue; }
      seenInFile.add(email);

      const name = normalizeName(row && row.name);
      const st = classifyStatus({ label: row && row.status, hasStatusColumn: file.hasStatusColumn !== false });
      const ec = classifyErrorCount(row && row.error_count);

      if (!map.has(email)) {
        map.set(email, {
          email,
          names: new Set(name ? [name] : []),
          sources: new Set([file.name]),
          statusVerdicts: new Set([st.verdict]),
          statusUnknown: st.known === false,
          errorHistory: ec.verdict === STATUS_VERDICT.REVIEW,
        });
      } else {
        stats.ファイル間重複 += 1;
        const e = map.get(email);
        if (name) e.names.add(name);
        e.sources.add(file.name);
        e.statusVerdicts.add(st.verdict);
        if (st.known === false) e.statusUnknown = true;
        if (ec.verdict === STATUS_VERDICT.REVIEW) e.errorHistory = true;
      }
    }
  }

  const entries = [];
  for (const e of map.values()) {
    const flags = [];
    // 状態は**どれか 1 つでも「送ってはいけない」なら除外側へ倒す**
    if (e.statusVerdicts.has(STATUS_VERDICT.EXCLUDE)) flags.push(MERGE_FLAG.STATUS_EXCLUDED);
    if (e.statusUnknown) flags.push(MERGE_FLAG.STATUS_UNKNOWN);
    if (e.errorHistory) flags.push(MERGE_FLAG.DELIVERY_ERROR_HISTORY);
    if (e.names.size > 1) flags.push(MERGE_FLAG.NAME_CONFLICT);

    const name = e.names.size === 1 ? [...e.names][0] : '';
    if (name) stats.氏名あり += 1;
    if (e.names.size > 1) stats.氏名の食い違い += 1;
    if (flags.includes(MERGE_FLAG.STATUS_EXCLUDED)) stats.状態で除外 += 1;
    if (flags.includes(MERGE_FLAG.STATUS_UNKNOWN)) stats.状態が不明 += 1;
    if (flags.includes(MERGE_FLAG.DELIVERY_ERROR_HISTORY)) stats.配信失敗歴あり += 1;

    entries.push({
      email: e.email,
      name,                       // 空 = 氏名を書かない（決められないときも空）
      sources: [...e.sources],
      flags,
      statusVerdict: flags.includes(MERGE_FLAG.STATUS_EXCLUDED) ? STATUS_VERDICT.EXCLUDE
        : (e.statusUnknown ? STATUS_VERDICT.REVIEW : STATUS_VERDICT.SENDABLE),
    });
  }
  stats.統合一意アドレス = entries.length;
  return { entries, stats };
}

/**
 * 統合済みエントリを `buildImportPreview` へ渡せる行の形にする。
 * **1 アドレス 1 行**になるので、以降 `duplicate_in_file` は発生しない。
 */
export function toPreviewRows(entries) {
  return (entries || []).map((e) => {
    const row = { email: e.email };
    if (e.name) row.name = e.name;
    // 状態・氏名の食い違いは要確認へ回すため、判定側へ印を渡す
    if (e.flags.includes(MERGE_FLAG.NAME_CONFLICT)) row.__nameConflict = true;
    if (e.statusVerdict === STATUS_VERDICT.EXCLUDE) row.__statusExcluded = true;
    if (e.statusVerdict === STATUS_VERDICT.REVIEW) row.__statusUnknown = true;
    if (e.flags.includes(MERGE_FLAG.DELIVERY_ERROR_HISTORY)) row.__deliveryErrorHistory = true;
    return row;
  });
}

export default mergeImportFiles;
