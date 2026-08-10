#!/usr/bin/env node
/**
 * Airtable Base のレコード数を実測し、プラン上限に対する余裕を報告する（read-only）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-08-09 に **50,446 件 / Team 上限 50,000 件** の超過が発覚した。
 * Airtable は上限に達しても静かに書き込みが失敗するだけで、
 * こちらから見ると「取り込みが通らない」「配信台帳が書けない」として現れる。
 * 事前に気づけるよう、件数を機械で見張る。
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   AIRTABLE_API_KEY=... AIRTABLE_BASE_ID=... node scripts/check-airtable-capacity.mjs
 *
 *   --limit=50000   プラン上限（既定 50,000 = Team）
 *   --warn=0.85     この割合を超えたら警告（既定 0.85）
 *   --json          機械可読な出力
 *
 * exit code: 0=余裕あり / 1=警告閾値超え / 2=上限超え / 3=取得失敗
 *
 * ⚠️ 認証情報が無い環境（CI 等）では **skip して 0 を返す**。
 *    ネットワークに出る検査なので check:safety には既定で組み込まない。
 */

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const LIMIT = Number(arg('limit', '50000'));
const WARN_RATIO = Number(arg('warn', '0.85'));
const AS_JSON = args.includes('--json');

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

if (!KEY || !BASE) {
  console.log('⏭️  AIRTABLE_API_KEY / AIRTABLE_BASE_ID が無いため skip します（CI では正常）');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let a = 0; a < 8; a += 1) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (res.status === 429) { await sleep(2000); continue; }
    const j = await res.json().catch(() => null);
    if (j && !j.error) return j;
    if (j && j.error) return { __error: j.error.type || JSON.stringify(j.error) };
    await sleep(1200);
  }
  return { __error: 'fetch_failed' };
}

/** table 一覧（主フィールド名も取る。件数走査の payload を絞るため） */
async function listTables() {
  const j = await getJson(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  if (j.__error) return { error: j.__error };
  return {
    tables: (j.tables || []).map((t) => ({
      name: t.name,
      primary: (t.fields || [])[0]?.name || null,
    })),
  };
}

/** 1 table の件数。Airtable に count API は無いのでページングして数える */
async function countTable(name, primary) {
  let n = 0;
  let off = null;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(name)}`);
    u.searchParams.set('pageSize', '100');
    if (primary) u.searchParams.append('fields[]', primary);
    if (off) u.searchParams.set('offset', off);
    const j = await getJson(u.toString());
    if (j.__error) return { error: j.__error };
    n += (j.records || []).length;
    off = j.offset;
    await sleep(210);
  } while (off);
  return { count: n };
}

const listed = await listTables();
if (listed.error) {
  console.error(`❌ table 一覧を取得できません: ${listed.error}`);
  process.exit(3);
}

const rows = [];
let total = 0;
for (const t of listed.tables) {
  const r = await countTable(t.name, t.primary);
  if (r.error) {
    console.error(`❌ ${t.name}: ${r.error}`);
    process.exit(3);
  }
  rows.push({ table: t.name, count: r.count });
  total += r.count;
}
rows.sort((a, b) => b.count - a.count);

const ratio = total / LIMIT;
const status = total > LIMIT ? 'over' : (ratio >= WARN_RATIO ? 'warn' : 'ok');

if (AS_JSON) {
  console.log(JSON.stringify({ total, limit: LIMIT, ratio, status, tables: rows }, null, 1));
} else {
  console.log('📊 Airtable Base レコード数');
  for (const r of rows) {
    const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : '0.0';
    console.log(`   ${r.table.padEnd(42)}${String(r.count).padStart(8)}  ${pct.padStart(5)}%`);
  }
  console.log(`   ${'合計'.padEnd(42)}${String(total).padStart(8)}  / 上限 ${LIMIT}（${(ratio * 100).toFixed(1)}%）`);
  console.log('');
  if (status === 'over') {
    console.error(`❌ 上限超過: ${total - LIMIT} 件オーバー。書き込みが静かに失敗しうる`);
    console.error('   対処方針は docs/AIRTABLE_CAPACITY.md を参照');
  } else if (status === 'warn') {
    console.warn(`⚠️  残り ${LIMIT - total} 件（${((1 - ratio) * 100).toFixed(1)}%）。配信 1 回で数万件増えるので余裕を過信しない`);
  } else {
    console.log(`✅ 残り ${LIMIT - total} 件`);
  }
}

process.exit(status === 'over' ? 2 : (status === 'warn' ? 1 : 0));
