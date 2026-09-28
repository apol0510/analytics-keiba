/**
 * scheduledChecks.test.mjs — 「未来の確認は自動化する」恒久ルールの仕組みを固定する
 *   node --test src/lib/ops/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { validateRegistry, planToday, jstToday, REQUIRED_FIELDS, issueTitle } from './scheduledChecks.js';
import { parseServiceAccount, buildJwt, createGscClient, GSC_SCOPE } from './gscClient.js';
import {
  summarizeDatePages, summarizeRaceNameQueries, summarizeInspections, datePageUrlsFromSitemap,
  runGscDateArchive, renderMarkdown,
} from './gscDateArchiveMeasurement.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const registry = JSON.parse(read('ops/scheduled-checks.json'));
const seo = registry.checks.find((c) => c.id === 'seo-date-archive-2026-10');

test('登録簿: 全件が 5 要素（発火条件・自動実行経路・比較基準・記録先・失敗時）をそろえている', () => {
  assert.deepEqual(validateRegistry(registry), []);
  for (const f of ['runFrom', 'runUntil', 'trigger', 'kind', 'compare', 'record', 'onFailure']) assert.ok(REQUIRED_FIELDS.includes(f));
});

test('登録簿: 南関・中央 SEO の 10/26 前後の効果測定が登録されている', () => {
  assert.ok(seo, '未登録');
  assert.equal(seo.kind, 'gsc-date-archive');
  assert.ok(seo.runFrom >= '2026-10-26' && seo.runFrom <= '2026-10-31');
  assert.equal(seo.compare.evalWindow.start, '2026-09-28');
  assert.equal(seo.compare.baselineSnapshot.siteClicks, 212);
  assert.equal(seo.compare.baselineSnapshot.siteImpressions, 3290);
});

test('検査: 欠けた登録・未実装の kind・日付の逆転は落ちる', () => {
  const bad = { checks: [{ id: 'x', title: 't', kind: 'nope', runFrom: '2026-11-02', runUntil: '2026-11-01', trigger: 'a', compare: {}, record: 'r' }] };
  const errs = validateRegistry(bad).join('\n');
  assert.match(errs, /onFailure が無い/);
  assert.match(errs, /compare が無い/);
  assert.match(errs, /未実装の kind/);
  assert.match(errs, /runUntil が runFrom より前/);
  assert.deepEqual(validateRegistry({}), ['checks が配列ではない']);
});

test('今日の扱い: 期間前は待つ・期間内は実行・成功済みは実行しない・期限後は期限切れ', () => {
  const c = [{ id: 'a', runFrom: '2026-10-28', runUntil: '2026-11-11' }];
  assert.equal(planToday(c, '2026-10-27')[0].action, 'wait');
  assert.equal(planToday(c, '2026-10-28')[0].action, 'run');
  assert.equal(planToday(c, '2026-11-11')[0].action, 'run');
  assert.equal(planToday(c, '2026-11-12')[0].action, 'expired');
  assert.equal(planToday(c, '2026-10-30', new Set(['a']))[0].action, 'done');
  assert.equal(jstToday(Date.UTC(2026, 9, 27, 16, 0)), '2026-10-28', 'JST で日付を切る');
  assert.equal(issueTitle('a'), '[自動測定] a');
});

const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const credFor = (privateKey) => JSON.stringify({ client_email: 'sa@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });

test('GSC 認証: 鍵が無い・壊れている・欠けているは明示のコードで止まる', () => {
  assert.throws(() => parseServiceAccount(''), /credentials_missing/);
  assert.throws(() => parseServiceAccount('{x'), /credentials_invalid_json/);
  assert.throws(() => parseServiceAccount('{"client_email":"a"}'), /credentials_incomplete/);
});

test('GSC 認証: JWT は RS256 で署名され、スコープは読み取り専用', () => {
  const { privateKey, publicKey } = keyPair();
  const jwt = buildJwt(parseServiceAccount(credFor(privateKey)), 1000);
  const [h, c, sig] = jwt.split('.');
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')));
  const claim = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claim.scope, GSC_SCOPE);
  assert.match(GSC_SCOPE, /readonly$/);
});

function fakeFetch({ status = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (String(url).includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ rows: [] }) };
  };
  return { f, calls };
}

test('GSC クライアント: 権限が無ければ no_property_access（人の最小作業を案内できる）', async () => {
  const { privateKey } = keyPair();
  const { f } = fakeFetch({ status: 403 });
  const c = createGscClient({ credentials: credFor(privateKey), fetchImpl: f, siteUrl: 'https://analytics.keiba.link/' });
  await assert.rejects(() => c.searchAnalytics({ startDate: '2026-09-28', endDate: '2026-10-25' }), /no_property_access/);
});

test('GSC クライアント: 呼ぶのは読み取り API（searchAnalytics.query / urlInspection）だけ', () => {
  const src = read('astro-site/src/lib/ops/gscClient.js');
  const urls = [...src.matchAll(/https:\/\/[^'`"\s]+/g)].map((m) => m[0]);
  for (const u of urls) {
    assert.ok(/oauth2\.googleapis\.com\/token|webmasters\.readonly|searchAnalytics\/query|urlInspection\/index:inspect|webmasters\/v3\/sites\/\$\{/.test(u), `想定外の URL: ${u}`);
  }
  assert.equal(/sitemaps|delete|PUT|PATCH/.test(src.replace(/\/\*\*[\s\S]*?\*\//g, '')), false);
});

test('測定: 日付ページ・レース名クエリ・インデックスの集計', () => {
  const pages = [
    { keys: ['https://analytics.keiba.link/free-prediction/nankan/2026-10-01/'], clicks: 2, impressions: 30 },
    { keys: ['https://analytics.keiba.link/free-prediction/jra/2026-10-04/'], clicks: 1, impressions: 10 },
    { keys: ['https://analytics.keiba.link/'], clicks: 100, impressions: 1000 },
  ];
  assert.deepEqual(summarizeDatePages(pages, 'nankan'), { pages: 1, clicks: 2, impressions: 30 });
  assert.deepEqual(summarizeDatePages(pages, 'jra'), { pages: 1, clicks: 1, impressions: 10 });
  assert.equal(summarizeRaceNameQueries([{ keys: ['東京記念 予想'], clicks: 0, impressions: 5 }, { keys: ['南関競馬予想'], impressions: 9 }]).impressions, 5);
  const ins = summarizeInspections([
    { result: { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: '送信して登録されました' } } } },
    { result: { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: '検出 - インデックス未登録' } } } },
    { error: 'api_error' },
  ]);
  assert.equal(ins.indexed, 1); assert.equal(ins.notIndexed, 1); assert.equal(ins.errors, 1);
  const xml = '<loc>https://analytics.keiba.link/free-prediction/nankan/2026-10-01/</loc><loc>https://analytics.keiba.link/free/</loc>';
  assert.deepEqual(datePageUrlsFromSitemap(xml, 'nankan'), ['https://analytics.keiba.link/free-prediction/nankan/2026-10-01/']);
});

test('測定: 実行結果を比較表（スナップショット / 反映前 / 評価期間）で記録する', async () => {
  const client = {
    searchAnalytics: async (b) => (b.dimensions ? { rows: b.dimensions[0] === 'page'
      ? [{ keys: ['https://analytics.keiba.link/free-prediction/nankan/2026-10-01/'], clicks: 3, impressions: 40 }]
      : [{ keys: ['大井記念'], clicks: 0, impressions: 7 }] }
      : { rows: [{ clicks: 300, impressions: 5000, ctr: 0.06, position: 9.5 }] }),
    inspect: async () => ({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: '登録済み' } } }),
  };
  const xml = '<loc>https://analytics.keiba.link/free-prediction/nankan/2026-10-01/</loc><loc>https://analytics.keiba.link/free-prediction/jra/2026-10-04/</loc>';
  const result = await runGscDateArchive({ check: seo, client, fetchSitemap: async () => xml, nowIso: '2026-10-28T01:00:00Z' });
  assert.equal(result.eval.site.clicks, 300);
  assert.equal(result.eval.nankan.impressions, 40);
  assert.equal(result.eval.raceName.impressions, 7);
  assert.equal(result.index.nankan.indexed, 1);
  const md = renderMarkdown({ check: seo, result });
  assert.match(md, /\| サイト全体 クリック \| 212 \| 300 \| \*\*300\*\*/);
  assert.match(md, /南関 日付ページ インデックス登録 \| 0 \| — \| \*\*1\/1\*\*/);
});

test('CLI: 鍵が無い状態で実行すると exit 2・失敗理由と最小作業を書く（ネットワークへ出ない）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'));
  const fail = join(dir, 'f.md');
  let code = 0;
  try {
    execFileSync(process.execPath, ['scripts/scheduled-checks.mjs', 'run', 'seo-date-archive-2026-10', '--fail-md', fail], {
      cwd: `${ROOT}astro-site`, env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 20000,
    });
  } catch (e) { code = e.status; }
  assert.equal(code, 2);
  const body = rf(fail, 'utf8');
  assert.match(body, /credentials_missing/);
  assert.match(body, /GSC_SERVICE_ACCOUNT_JSON/);
});

test('workflow: 毎日の定期実行・登録簿検査・成功/失敗の記録・失敗で赤', () => {
  const wf = read('.github/workflows/scheduled-checks.yml');
  assert.match(wf, /cron: '0 1 \* \* \*'/);
  assert.match(wf, /scheduled-checks\.mjs validate/);
  assert.match(wf, /secrets\.GSC_SERVICE_ACCOUNT_JSON/);
  assert.match(wf, /TITLE_PREFIX: .*'\[自動測定 検証\]' \|\| '\[自動測定\]'/);
  assert.match(wf, /FAIL_PREFIX: .*'\[自動測定 検証 失敗\]' \|\| '\[自動測定 失敗\]'/);
  assert.match(wf, /gh issue create --title "\$TITLE_PREFIX \$id"/);
  // 本番の完了判定は「[自動測定] 」で始まる題名だけ（検証実行は数えない）
  assert.match(wf, /startswith\("\[自動測定\] "\)/);
  assert.match(wf, /exit 1/);
  assert.match(wf, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
});

test('正本: CLAUDE.md に恒久ルール、progress は「○月○日に確認」だけで終わらせていない', () => {
  const cm = read('CLAUDE.md');
  assert.match(cm, /未来の確認は自動化する/);
  assert.match(cm, /ops\/scheduled-checks\.json/);
  assert.match(read('docs/progress.md'), /seo-date-archive-2026-10/);
});

test('workflow: 失敗経路の検証では鍵を渡さない（`cond && \'\' || x` は常に x になる罠を避ける）', () => {
  const wf = read('.github/workflows/scheduled-checks.yml');
  assert.match(wf, /GSC_SERVICE_ACCOUNT_JSON: \$\{\{ !inputs\.simulate_failure && secrets\.GSC_SERVICE_ACCOUNT_JSON \|\| '' \}\}/);
});

test('測定: 評価期間のデータが未確定（表示 0）なら 0 を記録せず data_not_ready で失敗（翌日再試行）', async () => {
  const client = {
    searchAnalytics: async (b) => (b.dimensions ? { rows: [] } : { rows: [{ clicks: 0, impressions: 0, ctr: 0, position: 0 }] }),
    inspect: async () => ({}),
  };
  await assert.rejects(
    () => runGscDateArchive({ check: seo, client, fetchSitemap: async () => '' }),
    (e) => e.code === 'data_not_ready',
  );
  assert.match(read('astro-site/scripts/scheduled-checks.mjs'), /case 'data_not_ready':/);
});

// ── kind: airtable-premium-conversions（Light→Premium 転換履歴の本番記録を確認）──
const { summarizeConversions, runPremiumConversionCheck, renderConversionMarkdown } = await import('./premiumConversionCheck.js');
const conv = registry.checks.find((c) => c.id === 'premium-conversion-first-record-2026');

test('転換履歴の確認が登録され、5 要素がそろっている', () => {
  assert.ok(conv);
  assert.equal(conv.kind, 'airtable-premium-conversions');
  assert.equal(conv.compare.since, '2026-09-29');
  assert.ok(conv.runFrom <= '2026-10-01' && conv.runUntil >= '2026-12-01');
});

test('転換履歴の集計: 件数・Light 由来・期間内・最初/最新', () => {
  const s = summarizeConversions([
    { fields: { PremiumConvertedFrom: 'Light/Monthly', PremiumConvertedAt: '2026-10-03T01:00:00.000Z' } },
    { fields: { PremiumConvertedFrom: 'Light/Monthly（期限切れ）', PremiumConvertedAt: '2026-10-10T01:00:00.000Z' } },
    { fields: {} },
  ], { since: '2026-09-29' });
  assert.equal(s.total, 2); assert.equal(s.fromLight, 2); assert.equal(s.sinceCount, 2);
  assert.equal(s.first, '2026-10-03T01:00:00.000Z'); assert.equal(s.last, '2026-10-10T01:00:00.000Z');
});

test('転換がまだ 0 件なら no_conversion_yet（成功として記録しない）・トークン無しは明示のコード', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ records: [] }), { status: 200 });
  await assert.rejects(() => runPremiumConversionCheck({ check: conv, token: 't', fetchImpl }), (e) => e.code === 'no_conversion_yet');
  await assert.rejects(() => runPremiumConversionCheck({ check: conv, token: '', fetchImpl }), (e) => e.code === 'airtable_token_missing');
  const denied = async () => new Response('{}', { status: 401 });
  await assert.rejects(() => runPremiumConversionCheck({ check: conv, token: 't', fetchImpl: denied }), (e) => e.code === 'airtable_auth_failed');
});

test('転換が記録されていれば成功し、取得するのは転換履歴の 2 項目だけ', async () => {
  let url = '';
  const fetchImpl = async (u) => { url = String(u); return new Response(JSON.stringify({ records: [
    { fields: { PremiumConvertedFrom: 'Light/Monthly', PremiumConvertedAt: '2026-10-03T01:00:00.000Z' } },
  ] }), { status: 200 }); };
  const r = await runPremiumConversionCheck({ check: conv, token: 't', fetchImpl, nowIso: '2026-10-04T01:00:00Z' });
  assert.equal(r.total, 1);
  const fields = new URL(url).searchParams.getAll('fields[]');
  assert.deepEqual(fields.sort(), ['PremiumConvertedAt', 'PremiumConvertedFrom']);
  assert.match(renderConversionMarkdown({ check: conv, result: r }), /転換履歴が記録されたレコード \| \*\*1\*\*/);
});

test('workflow: Airtable の読み取りトークンも失敗経路の検証では渡さない', () => {
  const wf = read('.github/workflows/scheduled-checks.yml');
  assert.match(wf, /AIRTABLE_READONLY_TOKEN: \$\{\{ !inputs\.simulate_failure && secrets\.AIRTABLE_READONLY_TOKEN \|\| '' \}\}/);
});

test('待機中（まだ起きていない・未確定）は失敗と分ける: exit 3・赤にしない・待機中 Issue を 1 つだけ更新', async () => {
  const { exitCodeFor, EXIT, PENDING_CODES } = await import('./scheduledChecks.js');
  assert.deepEqual([...PENDING_CODES].sort(), ['data_not_ready', 'no_conversion_yet']);
  assert.equal(exitCodeFor('no_conversion_yet'), EXIT.PENDING);
  assert.equal(exitCodeFor('data_not_ready'), EXIT.PENDING);
  assert.equal(exitCodeFor('credentials_missing'), EXIT.FAILED);
  assert.equal(exitCodeFor('airtable_auth_failed'), EXIT.FAILED);
  const wf = read('.github/workflows/scheduled-checks.yml');
  assert.match(wf, /elif \[ "\$rc" = 3 \]; then/);
  assert.match(wf, /PEND_PREFIX: .*'\[自動測定 検証 待機中\]' \|\| '\[自動測定 待機中\]'/);
  // 待機中の分岐では failed=1 にしない（赤にしない）
  const pend = wf.slice(wf.indexOf('elif [ "$rc" = 3 ]'), wf.indexOf('            else\n              failed=1'));
  assert.equal(pend.includes('failed=1'), false);
});

test('期限切れは必ず Issue に残す（失敗・待機中 Issue が無くても作る）', () => {
  const wf = read('.github/workflows/scheduled-checks.yml');
  const exp = wf.slice(wf.indexOf('期限切れで未完了のものを知らせる'), wf.indexOf('actions/upload-artifact'));
  assert.match(exp, /"\$FAIL_PREFIX \$id" "\$PEND_PREFIX \$id"/);
  assert.match(exp, /gh issue create --title "\$FAIL_PREFIX \$id"/);
});
