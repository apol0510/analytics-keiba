#!/usr/bin/env node
/**
 * Airtable の 2 つの上限を毎日見張る（read-only・GitHub Actions `airtable-capacity-watch.yml`）。
 *
 *   1. API 呼び出し（Team: 月 100,000 回）
 *      本番の計測（`airtableCallMeter.js` → Redis）を admin-payment-funnel の `airtableUsage` で読む。
 *      **今月の実績 + 直近 7 日平均 × 残り日数** が 90,000 を超えたら失敗。
 *   2. レコード数（Team: 50,000 件 / 運用目標 45,000 件以下）
 *      `--records` のときだけ全テーブルを数える（約 500 回の呼び出しなので週 1 回）。
 *      45,000 を超えたら失敗、42,000 を超えたら警告。
 *
 * exit: 0=OK / 1=警告 / 2=超過 / 3=測れない（測れないことを OK と言わない）
 *
 * env: SITE_URL（既定 https://analytics.keiba.link）/ PAYMENT_FUNNEL_READ_SECRET /
 *      AIRTABLE_READONLY_TOKEN（--records のとき）
 */
import { evaluateApiUsage, evaluateRecords, API_FAIL_AT, RECORD_FAIL_AT, RECORD_WARN_AT } from '../src/lib/ops/airtableCapacityWatch.js';

const SITE = process.env.SITE_URL || 'https://analytics.keiba.link';
const BASE = 'apptmQUPAlgZMmBC9';
const withRecords = process.argv.includes('--records');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUsage() {
  const secret = process.env.PAYMENT_FUNNEL_READ_SECRET;
  if (!secret) return { error: 'PAYMENT_FUNNEL_READ_SECRET が無い' };
  const res = await fetch(new URL('/.netlify/functions/admin-payment-funnel', SITE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'airtableUsage', days: 40 }),
  });
  if (!res.ok) return { error: `airtableUsage ${res.status}` };
  return res.json();
}

async function countRecords() {
  const key = process.env.AIRTABLE_READONLY_TOKEN;
  if (!key) return { error: 'AIRTABLE_READONLY_TOKEN が無い' };
  const get = async (url) => {
    for (let a = 0; a < 8; a += 1) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (r.status === 429) { await sleep(2000); continue; }
      if (r.ok) return r.json();
      await sleep(1000);
    }
    throw new Error('fetch_failed');
  };
  const meta = await get(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const tables = {};
  for (const t of meta.tables || []) {
    let n = 0; let offset = null;
    do {
      const q = new URLSearchParams({ pageSize: '100' });
      q.append('fields[]', t.fields[0].name);
      if (offset) q.set('offset', offset);
      const j = await get(`https://api.airtable.com/v0/${BASE}/${t.id}?${q}`);
      n += (j.records || []).length; offset = j.offset || null;
      await sleep(220);
    } while (offset);
    tables[t.name] = n;
  }
  return { tables };
}

const lines = [];
let code = 0;
const usage = await readUsage().catch((e) => ({ error: String(e.message || e) }));
if (usage.error) { lines.push(`❓ API 呼び出し: 測れない（${usage.error}）`); code = Math.max(code, 3); }
else {
  const v = evaluateApiUsage(usage.days, { now: new Date() });
  lines.push(`${v.level === 'ok' ? '✅' : '🚨'} API 呼び出し: 今月 ${v.monthToDate.toLocaleString()} 回 / 月末見込み ${v.projected.toLocaleString()} 回（失敗の閾値 ${API_FAIL_AT.toLocaleString()}）`);
  lines.push(`   直近 7 日平均 ${v.avg7.toLocaleString()} 回/日。多い順: ${v.topSources.map((s) => `${s.source} ${s.calls.toLocaleString()}`).join(' / ')}`);
  if (v.level === 'fail') code = Math.max(code, 2);
}
if (withRecords) {
  const rec = await countRecords().catch((e) => ({ error: String(e.message || e) }));
  if (rec.error) { lines.push(`❓ レコード数: 測れない（${rec.error}）`); code = Math.max(code, 3); }
  else {
    const v = evaluateRecords(rec.tables);
    lines.push(`${v.level === 'ok' ? '✅' : v.level === 'warn' ? '⚠️' : '🚨'} レコード数: ${v.total.toLocaleString()} 件（警告 ${RECORD_WARN_AT.toLocaleString()} / 失敗 ${RECORD_FAIL_AT.toLocaleString()}）`);
    lines.push(`   ${v.largest.map(([t, n]) => `${t} ${n.toLocaleString()}`).join(' / ')}`);
    if (v.level === 'fail') code = Math.max(code, 2);
    else if (v.level === 'warn') code = Math.max(code, 1);
  }
}
console.log(lines.join('\n'));
process.exit(code);
