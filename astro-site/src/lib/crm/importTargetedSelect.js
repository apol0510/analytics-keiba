/**
 * importTargetedSelect.js — 「対象になりうるメールだけ」を引いて CREATE 行を選ぶ
 *
 * ── なぜ要るか ─────────────────────────────────────────────────
 * 従来は毎 step で Customers を**全件ページング取得**していた。
 * 2026-08-09 の本実行（Customers 15,967 件）で **1 回の全件取得に約 170 秒**かかり、
 * Netlify Function のタイムアウト（最大 26 秒）を大きく超えて毎回 504 になった。
 * 列を絞っても変わらない（コストはページ数 = 160 ページ × 約 1 秒）。
 *
 * 実測: **対象 100 件を名指しで引けば 1 コール 1.7 秒**（約 100 倍速い）。
 * そこで「これから書く候補のメールだけ」を窓（window）単位で引く。
 *
 * ── 安全性は落とさない ────────────────────────────────────────
 * `classifyCreateRow` は候補メールに対する `has()` しか見ないので、
 * **候補だけを含む facts でも判定結果は全件取得時と同一**になる。
 * `duplicateInAk` も、名指しクエリが同一メールの全レコードを返すため正しく検出できる。
 *
 * ⚠️ facts を引けなかった窓は**空集合にしない**（空集合 = 除外が全部無効 = fail open）。
 *    読めなければ例外にして呼び出し側で止める。
 */

/** 1 回の名指しクエリに載せるメール数（実測: 100 件で formula 約 4.6KB / 1.7 秒） */
export const LOOKUP_CHUNK = 50;

/** 候補を探すために先読みする件数。既存が多い区間でも数窓で埋まる */
export const SCAN_WINDOW = 300;

/** 1 step で開く窓の上限（暴走防止） */
export const MAX_WINDOWS = 12;

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** entries を窓に切る */
export function planWindows({ entries, cursor, windowSize = SCAN_WINDOW, maxWindows = MAX_WINDOWS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const start = Math.max(0, Number.isFinite(cursor) ? Math.trunc(cursor) : 0);
  const out = [];
  for (let i = start; i < list.length && out.length < maxWindows; i += windowSize) {
    out.push({ from: i, to: Math.min(list.length, i + windowSize) });
  }
  return out;
}

/** 名指しクエリ用にメールを chunk へ割る */
export function chunkEmails(emails, size = LOOKUP_CHUNK) {
  const list = [...new Set((emails || []).map(norm).filter(Boolean))];
  const n = Math.max(1, size);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 窓を順に開いて、必要数の CREATE 行が揃うまで選ぶ。
 *
 * @param {{
 *   entries: Array<object>,
 *   cursor: number,
 *   limit: number,
 *   providerEmails: Set<string>,
 *   loadFacts: (emails: string[]) => Promise<object>,  窓のメールに対する facts
 *   selectFn: Function,                                 importEligibility.selectCreateRows
 *   windowSize?: number, maxWindows?: number,
 * }} input
 * @returns {Promise<{rows, scannedTo, exhausted, skipped, windowsUsed, lookedUp}>}
 */
export async function selectCreateRowsTargeted({
  entries, cursor, limit, providerEmails, loadFacts, selectFn,
  windowSize = SCAN_WINDOW, maxWindows = MAX_WINDOWS,
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const max = Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0);
  const rows = [];
  const skipped = {};
  let scannedTo = Math.max(0, Number.isFinite(cursor) ? Math.trunc(cursor) : 0);
  let windowsUsed = 0;
  let lookedUp = 0;
  /** 書き込み直前の第二防御で使う（窓の既存集合をためる） */
  const existing = new Set();

  for (const w of planWindows({ entries: list, cursor: scannedTo, windowSize, maxWindows })) {
    if (rows.length >= max) break;
    const window = list.slice(w.from, w.to);
    const emails = window.map((e) => norm(e && e.email)).filter(Boolean);
    // ⚠️ 引けなければ例外。空集合で続けると除外が効かず二重作成しうる
    const facts = await loadFacts(emails);
    if (!facts || typeof facts !== 'object') {
      throw new Error('targeted facts unavailable');
    }
    lookedUp += emails.length;
    windowsUsed += 1;
    for (const e of (facts.existing || [])) existing.add(e);

    const picked = selectFn({
      entries: window, facts, providerEmails, cursor: 0, limit: max - rows.length,
    });
    rows.push(...picked.rows);
    for (const [k, v] of Object.entries(picked.skipped || {})) skipped[k] = (skipped[k] || 0) + v;
    scannedTo = w.from + picked.scannedTo;
    if (rows.length >= max) break;
  }

  const exhausted = scannedTo >= list.length && rows.length < max;
  return { rows, scannedTo, exhausted, skipped, windowsUsed, lookedUp, facts: { existing } };
}

export default selectCreateRowsTargeted;
