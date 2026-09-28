/**
 * gscDateArchiveMeasurement.js — 日付別恒久ページ（南関・中央）の GSC 効果測定（kind: gsc-date-archive）
 *
 * 比較: 登録簿の evalWindow（反映後 28 日）の実測を、baselineSnapshot（反映時の実測）と
 *       baselineWindow（反映前 28 日を API で取り直した値）の両方と並べる。
 * 見るもの（docs/progress.md 🔎 の KPI と同じ）:
 *   - サイト全体のクリック / 表示 / CTR / 平均順位
 *   - 日付ページ（南関 / 中央）のクリック / 表示 と インデックス登録数（URL 検査）
 *   - レース名・特別レース名クエリの表示
 */

export const DATE_PAGE_PATTERNS = Object.freeze({
  nankan: '/free-prediction/nankan/20',
  jra: '/free-prediction/jra/20',
});
export const RACE_NAME_QUERY_RE = /特別|賞|杯|ステークス|記念|カップ|ダービー|オークス|S$/;

const sumRows = (rows) => {
  const c = rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0);
  const i = rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0);
  return { clicks: c, impressions: i };
};

/** searchAnalytics の行（dimension: page）から日付ページの合計 */
export function summarizeDatePages(pageRows, category) {
  const pat = DATE_PAGE_PATTERNS[category];
  const rows = (pageRows || []).filter((r) => String(r.keys?.[0] || '').includes(pat));
  return { pages: rows.length, ...sumRows(rows) };
}

/** searchAnalytics の行（dimension: query）からレース名クエリの合計 */
export function summarizeRaceNameQueries(queryRows) {
  const rows = (queryRows || []).filter((r) => RACE_NAME_QUERY_RE.test(String(r.keys?.[0] || '')));
  return { queries: rows.length, ...sumRows(rows) };
}

/** URL 検査の結果を数える（PASS = インデックス登録済み）*/
export function summarizeInspections(results) {
  const out = { inspected: 0, indexed: 0, notIndexed: 0, errors: 0, byCoverage: {} };
  for (const r of results || []) {
    out.inspected += 1;
    if (r.error) { out.errors += 1; continue; }
    const st = r.result?.inspectionResult?.indexStatusResult || {};
    if (st.verdict === 'PASS') out.indexed += 1; else out.notIndexed += 1;
    const cov = st.coverageState || '(不明)';
    out.byCoverage[cov] = (out.byCoverage[cov] || 0) + 1;
  }
  return out;
}

/** サイトマップ XML から日付ページの URL を取り出す */
export function datePageUrlsFromSitemap(xml, category) {
  const pat = DATE_PAGE_PATTERNS[category];
  return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => u.includes(pat));
}

const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : (a ? '新規' : '±0'));

/** 結果表（Markdown）。数字は実測だけを書き、推定を混ぜない */
export function renderMarkdown({ check, result }) {
  const s = check.compare.baselineSnapshot;
  const e = result.eval;
  const b = result.baseline;
  const row = (label, snap, base, now) => `| ${label} | ${snap ?? '—'} | ${base ?? '—'} | **${now}** | ${pct(now, snap ?? base ?? 0)} |`;
  return [
    `## ${check.title}`,
    '',
    `- 評価期間: ${check.compare.evalWindow.start} 〜 ${check.compare.evalWindow.end}`,
    `- 比較: 反映時スナップショット（${s.$source}）/ 反映前 28 日（${check.compare.baselineWindow.start} 〜 ${check.compare.baselineWindow.end}・API 再取得）`,
    `- 実行: ${result.ranAt}（GitHub Actions scheduled-checks）`,
    '',
    '| 指標 | 反映時スナップショット | 反映前 28 日（API）| 評価期間 | 変化（対スナップショット）|',
    '|---|---|---|---|---|',
    row('サイト全体 クリック', s.siteClicks, b.site.clicks, e.site.clicks),
    row('サイト全体 表示', s.siteImpressions, b.site.impressions, e.site.impressions),
    `| サイト全体 CTR / 平均順位 | ${(s.siteCtr * 100).toFixed(1)}% / ${s.sitePosition} | ${(b.site.ctr * 100).toFixed(1)}% / ${b.site.position.toFixed(1)} | **${(e.site.ctr * 100).toFixed(1)}% / ${e.site.position.toFixed(1)}** | — |`,
    row('南関 日付ページ 表示', s.nankanDatePagesImpressions, b.nankan.impressions, e.nankan.impressions),
    row('南関 日付ページ クリック', s.nankanDatePagesClicks, b.nankan.clicks, e.nankan.clicks),
    row('中央 日付ページ 表示', null, b.jra.impressions, e.jra.impressions),
    row('中央 日付ページ クリック', null, b.jra.clicks, e.jra.clicks),
    row('レース名クエリ 表示', s.raceNameQueryImpressions, b.raceName.impressions, e.raceName.impressions),
    `| 南関 日付ページ インデックス登録 | ${s.nankanDatePagesIndexed} | — | **${result.index.nankan.indexed}/${result.index.nankan.inspected}** | — |`,
    `| 中央 日付ページ インデックス登録 | 検出-未登録 ${s.jraDatePagesDiscoveredNotIndexed} | — | **${result.index.jra.indexed}/${result.index.jra.inspected}** | — |`,
    '',
    `インデックス状態の内訳: 南関 ${JSON.stringify(result.index.nankan.byCoverage)} / 中央 ${JSON.stringify(result.index.jra.byCoverage)}`,
    '',
    '判定の目安: 日付ページの表示・インデックス登録が 0 から増えていれば「表示不足（A）」の是正が効き始めている。増えていなければ内部リンク・内容の見直しを次の仮説にする（docs/progress.md 🔎）。',
  ].join('\n');
}

/**
 * 実行（I/O は client / fetchSitemap を注入）。
 * @param {{check, client, fetchSitemap: () => Promise<string>, nowIso?: string, maxInspect?: number}} deps
 */
export async function runGscDateArchive({ check, client, fetchSitemap, nowIso = new Date().toISOString(), maxInspect = 400 }) {
  const { evalWindow, baselineWindow } = check.compare;
  const window = async (w) => {
    const [total, pages, queries] = await Promise.all([
      client.searchAnalytics({ startDate: w.start, endDate: w.end }),
      client.searchAnalytics({ startDate: w.start, endDate: w.end, dimensions: ['page'] }),
      client.searchAnalytics({ startDate: w.start, endDate: w.end, dimensions: ['query'] }),
    ]);
    const t = (total.rows || [])[0] || {};
    return {
      site: { clicks: Number(t.clicks) || 0, impressions: Number(t.impressions) || 0, ctr: Number(t.ctr) || 0, position: Number(t.position) || 0 },
      nankan: summarizeDatePages(pages.rows, 'nankan'),
      jra: summarizeDatePages(pages.rows, 'jra'),
      raceName: summarizeRaceNameQueries(queries.rows),
    };
  };
  const evalR = await window(evalWindow);
  // ⚠️ 評価期間のデータがまだ確定していない（表示 0）ときに 0 を「結果」として記録しない。
  //    失敗扱いにして翌日の定期実行で取り直す（runUntil まで）。
  if (!(evalR.site.impressions > 0)) {
    const err = new Error('gsc:data_not_ready');
    err.code = 'data_not_ready';
    err.detail = `評価期間 ${evalWindow.start}〜${evalWindow.end} の表示が 0（GSC のデータがまだ確定していない）`;
    throw err;
  }
  const baseR = await window(baselineWindow);

  const xml = await fetchSitemap();
  const index = {};
  for (const cat of ['nankan', 'jra']) {
    const urls = datePageUrlsFromSitemap(xml, cat).slice(0, maxInspect);
    const results = [];
    for (const u of urls) {
      // eslint-disable-next-line no-await-in-loop -- URL 検査は 600 件/分の上限があるので直列
      try { results.push({ url: u, result: await client.inspect(u) }); } catch (err) { results.push({ url: u, error: err?.code || 'error' }); }
    }
    index[cat] = summarizeInspections(results);
  }
  return { ranAt: nowIso, eval: evalR, baseline: baseR, index };
}
