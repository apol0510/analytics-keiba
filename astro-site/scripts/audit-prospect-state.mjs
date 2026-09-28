/**
 * audit-prospect-state.mjs — prospect の**全レコード**で state と 索引 / 抑止台帳 が一致しているかを数える（read-only）
 *
 *   ADMIN_SECRET=... node scripts/audit-prospect-state.mjs [--json out.json]
 *
 * 管理 API `admin-marketing` の `prospectStateAudit` を、4 つの出発点すべてで cursor が 0 に戻るまで回す:
 *   keys    … SCAN ak:prospect:*（全レコード鍵・全抑止台帳鍵）
 *   active / engaged / blocked … SSCAN 各索引（レコードも台帳も無いのに索引にだけ居る hash）
 *
 * ## なぜ要るか
 *
 * これまでの監査（`prospectIndexAudit` / `prospectSequenceCheck`）は「list に居る人」か
 * 「送信候補索引に居る人」から出発するので、**どちらにも居ないレコード**
 * （例: EXHAUSTED なのに抑止台帳が無い）を数えられなかった。
 *
 * ## 終了コード
 *   0 … 全窓を読み切り、critical / integrity の異常 0（info は数えるだけ）
 *   1 … 読み切れなかった（HTTP エラー・途中失敗）。**「異常 0」と混同しない**
 *   2 … 全窓を読み切り、異常あり
 *   3 … 応答にアドレスらしき文字列が混ざった（中止）
 *
 * 読み取りだけ。Redis も Airtable も 1 バイトも書かない。修復もしない。
 */
import { writeFileSync } from 'node:fs';
import {
  AUDIT_SOURCE, createStateAuditAccumulator, FINDING_SEVERITY,
} from '../src/lib/marketing/prospectStateAudit.js';

const ENDPOINT = process.env.AK_ADMIN_MARKETING_ENDPOINT
  || 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
/** 叩いてよい action はこれだけ */
const READ_ONLY_ADMIN_ACTIONS = new Set(['prospectStateAudit']);
/** 1 出発点あたりの窓の上限（cursor が 0 に戻らない異常で無限に回さない）*/
const MAX_WINDOWS_PER_SOURCE = 2000;
const RETRIES = 3;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }
const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > 0 ? process.argv[i + 1] : null; })();

const containsEmailLike = (v) => /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i.test(JSON.stringify(v));

async function call(payload) {
  if (!READ_ONLY_ADMIN_ACTIONS.has(payload && payload.action)) {
    throw new Error(`read_only_violation:${payload && payload.action}`);
  }
  let last = null;
  for (let a = 0; a < RETRIES; a += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- 直列で再試行
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
        body: JSON.stringify(payload),
      });
      // eslint-disable-next-line no-await-in-loop
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j && j.mode === 'prospect-state-audit') return j;
      last = `HTTP ${r.status} ${JSON.stringify(j || {}).slice(0, 200)}`;
      if (r.status < 500) break;   // 4xx は再試行しても同じ
    } catch (e) { last = e && e.message; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => { setTimeout(res, 1500 * (a + 1)); });
  }
  throw new Error(last || 'unknown');
}

const acc = createStateAuditAccumulator();
const windows = {};
try {
  for (const source of Object.values(AUDIT_SOURCE)) {
    let cursor = '0';
    let n = 0;
    do {
      // eslint-disable-next-line no-await-in-loop -- cursor を順に進める
      const j = await call({ action: 'prospectStateAudit', source, cursor });
      if (containsEmailLike(j)) { console.error('✖ 応答にアドレスが混ざっている。中止'); process.exit(3); }
      acc.add(source, j);
      cursor = String(j.cursor);
      n += 1;
      if (n >= MAX_WINDOWS_PER_SOURCE) throw new Error(`${source}: 窓が ${n} を超えた（cursor が戻らない）`);
    } while (cursor !== '0');
    windows[source] = n;
    process.stderr.write(`  ${source}: ${n} 窓\n`);
  }
} catch (e) {
  console.error(`✖ 読み切れなかった（異常 0 ではない）: ${e && e.message}`);
  process.exit(1);
}

const s = acc.summary();
const out = {
  checkedAt: new Date().toISOString(),
  complete: true,
  windows,
  universe: s.universe,
  records: s.records,
  ledgers: s.ledgers,
  ledgerOnly: s.ledgerOnly,
  indexSizes: s.indexSizes,
  stateCounts: s.stateCounts,
  bySeverity: s.bySeverity,
  byCode: s.byCode,
  transientRecovered: s.transient,
  findings: s.findings,
};
if (containsEmailLike(out)) { console.error('✖ 出力にアドレスが混ざっている。中止'); process.exit(3); }

console.log(`走査: 全体 ${out.universe} hash（レコード ${out.records} / 台帳 ${out.ledgers}・うち台帳のみ ${out.ledgerOnly}）`);
console.log(`索引: 送信候補 ${out.indexSizes.active} / 反応済み ${out.indexSizes.engaged} / 抑止 ${out.indexSizes.blocked}`);
console.log(`state: ${JSON.stringify(out.stateCounts)}`);
console.log(`異常: critical ${out.bySeverity.critical} / integrity ${out.bySeverity.integrity}（info ${out.bySeverity.info}・読み直しで消えた ${out.transientRecovered}）`);
for (const [code, n] of Object.entries(out.byCode).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${FINDING_SEVERITY[code] || '?'}\t${code}\t${n}`);
}
for (const f of out.findings.filter((x) => x.severity !== 'info').slice(0, 20)) {
  console.log(`  - ${f.hash.slice(0, 12)}… ${f.state || '(no record)'} ledger=${f.ledgerKind || '-'} ${f.codes.join(',')}`);
}
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 2)); console.log(`→ ${jsonOut}`); }

process.exit(out.bySeverity.critical + out.bySeverity.integrity > 0 ? 2 : 0);
