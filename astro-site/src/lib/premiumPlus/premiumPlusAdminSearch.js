/**
 * premiumPlusAdminSearch.js — 管理画面「1 人を名指しで調べる」の検索式（純粋・I/O なし）
 *
 * ## なぜ必要か
 *
 * 一覧は「販売候補になり得る人」へ絞り込んでいるので、候補外の人は出てこない。
 * 管理者が確認したい相手（例: Daniel / 0510apolone / tori）は、
 * **氏名の一部**や**アドレスの一部**しか手元に無いことが多い。
 * 完全一致の Email 検索だけでは辿り着けず、「調べられない」＝「見ていない」と
 * 誤読される。ここで**部分一致・氏名検索**を用意する。
 *
 * ## 全件走査しない
 *
 * 絞り込みは **Airtable 側の formula** で行う（15,962 件を読んでから絞らない）。
 * それでも一致が多すぎることはあるので、呼び出し側は上限に達したら
 * **黙って切らずに** `truncated` を返して「絞り込んでください」と言う。
 *
 * ## 安全性
 *
 * 入力はそのまま formula 文字列へ入るため、`escapeFormulaText` を必ず通す。
 * 通していない値を式へ入れないこと（式が壊れると全件一致・0 件一致どちらにも化ける）。
 */

/** 検索対象のフィールド（表示名は Airtable 実物に合わせる） */
export const SEARCH_FIELDS = Object.freeze(['Email', '氏名']);

/** 短すぎる語で全件に近い一致を起こさない下限 */
export const MIN_QUERY_LENGTH = 2;

/** 1 回の検索で読む最大ページ数（1 ページ 100 件） */
export const MAX_SEARCH_PAGES = 3;

/**
 * Airtable formula の文字列リテラルを壊さないようにする。
 * バックスラッシュ → シングルクォートの順で置換する（順序を逆にすると二重エスケープになる）。
 */
export function escapeFormulaText(raw) {
  return String(raw ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 見た目だけでメールアドレスかを判定する（完全一致を優先するため） */
export function looksLikeEmail(q) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(q || '').trim());
}

/**
 * 検索語を正規化する。
 * @returns {{ok:true, query:string, exactEmail:boolean} | {ok:false, reason:string}}
 */
export function normalizeSearchQuery(raw) {
  const q = String(raw ?? '').trim();
  if (!q) return { ok: false, reason: 'empty' };
  // 全角スペースだけ、記号だけ等で全件に近い一致を出さない
  if (q.replace(/[\s　]/g, '').length < MIN_QUERY_LENGTH) return { ok: false, reason: 'too_short' };
  return { ok: true, query: q, exactEmail: looksLikeEmail(q) };
}

/**
 * 検索式を組み立てる。
 *
 * - メールアドレス形式 → **完全一致**（同姓同名の巻き込みを避ける）
 * - それ以外 → Email / 氏名 の**部分一致（大文字小文字を無視）**
 *
 * `FIND(needle, haystack)` は見つからないと 0 を返すので、`OR()` にそのまま入れられる。
 *
 * @param {string} raw 利用者の入力
 * @returns {{ok:true, formula:string, exactEmail:boolean} | {ok:false, reason:string}}
 */
export function buildLookupFormula(raw) {
  const norm = normalizeSearchQuery(raw);
  if (!norm.ok) return norm;

  if (norm.exactEmail) {
    const safe = escapeFormulaText(norm.query.toLowerCase());
    return { ok: true, exactEmail: true, formula: `LOWER(TRIM({Email})) = '${safe}'` };
  }

  const safe = escapeFormulaText(norm.query.toLowerCase());
  const terms = SEARCH_FIELDS.map((f) => `FIND('${safe}', LOWER({${f}} & ''))`);
  return { ok: true, exactEmail: false, formula: `OR(${terms.join(', ')})` };
}

/** 検索できない理由を管理者向けの日本語にする */
export const SEARCH_ERROR_TEXT = Object.freeze({
  empty: '検索語を入力してください（氏名の一部・アドレスの一部でも引けます）',
  too_short: `検索語が短すぎます（${MIN_QUERY_LENGTH} 文字以上）。全件に近い一致になるため実行しません`,
});
