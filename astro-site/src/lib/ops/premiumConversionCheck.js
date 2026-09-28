/**
 * premiumConversionCheck.js — Light→Premium 転換履歴が**実際の入金確認で記録されたか**を確かめる（kind: airtable-premium-conversions）
 *
 * 2026-09-28 に `confirm-bank-payment` へ転換履歴（`PremiumConvertedFrom` / `PremiumConvertedAt`）を足した。
 * 本番で書かれるのは実際の Light→Premium 入金確認のときだけなので、反映直後には確かめられない。
 * 人の記憶に頼らず、scheduled-checks が毎日 Customers を**読むだけ**で確認する。
 *
 * 成功: `PremiumConvertedAt` が入ったレコードが 1 件以上ある → 内訳を Issue に記録して完了
 * 未発生: 0 件 → `no_conversion_yet`（失敗扱いにして翌日再確認。期限まで 0 件なら期限切れを Issue に残す）
 *
 * ⚠️ 読むのは転換履歴の 2 項目だけ（メール・氏名などは取得しない）。トークンは読み取り専用。
 */

const BASE = 'apptmQUPAlgZMmBC9';
const TABLE = 'Customers';

export class ConversionCheckError extends Error {
  constructor(code, detail) { super(`conversion:${code}`); this.code = code; this.detail = detail || null; }
}

/** 取得した行を集計する（純粋）*/
export function summarizeConversions(rows, { since } = {}) {
  const list = (rows || []).map((r) => r.fields || {}).filter((f) => f.PremiumConvertedAt);
  const byFrom = {};
  let sinceCount = 0;
  let first = null; let last = null;
  for (const f of list) {
    const from = String(f.PremiumConvertedFrom || '(未記録)');
    byFrom[from] = (byFrom[from] || 0) + 1;
    const at = String(f.PremiumConvertedAt);
    if (!first || at < first) first = at;
    if (!last || at > last) last = at;
    if (since && at >= since) sinceCount += 1;
  }
  return { total: list.length, fromLight: list.filter((f) => /^Light\//.test(String(f.PremiumConvertedFrom || ''))).length, byFrom, sinceCount, first, last };
}

export async function runPremiumConversionCheck({ check, token, fetchImpl = fetch, nowIso = new Date().toISOString() }) {
  if (!token || !String(token).trim()) throw new ConversionCheckError('airtable_token_missing');
  const rows = [];
  let offset;
  let pages = 0;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`);
    u.searchParams.set('filterByFormula', 'NOT({PremiumConvertedAt} = "")');
    u.searchParams.append('fields[]', 'PremiumConvertedFrom');
    u.searchParams.append('fields[]', 'PremiumConvertedAt');
    u.searchParams.set('pageSize', '100');
    if (offset) u.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- ページ送りは直列
    const res = await fetchImpl(u, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) throw new ConversionCheckError('airtable_auth_failed', `HTTP ${res.status}`);
    if (!res.ok) throw new ConversionCheckError('airtable_api_error', `HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    rows.push(...(j.records || []));
    offset = j.offset;
    pages += 1;
    if (pages > 50) throw new ConversionCheckError('too_many_pages');
  } while (offset);

  const s = summarizeConversions(rows, { since: check.compare.since });
  if (s.total === 0) {
    throw new ConversionCheckError('no_conversion_yet', `${check.compare.since} 以降、転換履歴が記録されたレコードがまだ 0 件`);
  }
  return { ranAt: nowIso, ...s };
}

export function renderConversionMarkdown({ check, result }) {
  return [
    `## ${check.title}`,
    '',
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    `- 確認: Customers の \`PremiumConvertedAt\` が入ったレコード（読み取りのみ・2 項目だけ取得）`,
    '',
    '| 指標 | 値 |',
    '|---|---|',
    `| 転換履歴が記録されたレコード | **${result.total}** |`,
    `| うち Light→Premium | ${result.fromLight} |`,
    `| ${check.compare.since} 以降 | ${result.sinceCount} |`,
    `| 最初 / 最新の転換日時 | ${result.first} / ${result.last} |`,
    '',
    `内訳（元プラン）: ${JSON.stringify(result.byFrom)}`,
    '',
    '→ 実際の入金確認で転換履歴が書かれることを本番で確認できた。以後の集計は Airtable で `PremiumConvertedAt` を期間で数える（spec.md）。',
  ].join('\n');
}
