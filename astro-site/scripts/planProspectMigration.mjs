/**
 * planProspectMigration.mjs — CSV 取り込み分を prospect へ戻す計画を**下見する**（read-only）
 *
 * 判定の正本は `src/lib/marketing/prospectMigrationPlan.js`（純粋関数）。
 * このスクリプトは Airtable を読むだけで、**1 バイトも書かない**。
 *
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… node scripts/planProspectMigration.mjs [--out <dir>]
 *
 * 出力: 判定ごとの件数 / 取り込みバッチ別の内訳 / 巻き戻し可否 / 送信継続性の確認。
 * **アドレスも氏名も出力しない**（recordId と件数だけ）。
 */
import { writeFileSync } from 'node:fs';
import {
  buildMigrationPlan, assertRollbackComplete, DECISION_LABEL, MIGRATION_DECISION,
  buildSuppressionHandoff,
} from '../src/lib/marketing/prospectMigrationPlan.js';
import { emailHash } from '../src/lib/marketing/prospectStore.js';

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;
if (!KEY || !BASE) { console.error('✖ AIRTABLE_API_KEY / AIRTABLE_BASE_ID が要る'); process.exit(1); }
const argv = process.argv.slice(2);
const OUT = (argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null)
  || `${process.env.HOME}/.analytics-keiba-ops/prospect-migration`;

const FIELDS = ['Email', 'Source', 'プラン', 'PlanType', 'Status', 'PaidAt', 'PaymentConfirmed',
  'RequestedPlan', 'RequestedAmount', 'LifetimeSanrenpuku', 'LightGrantLifetime', 'LightGrantUntil',
  'PremiumGrantLifetime', 'PremiumGrantUntil', 'PremiumPlusEligibility', 'ポイント', '最終ログイン',
  'UnsubscribedAnalyticsKeiba', 'WithdrawalRequested', 'ForceLogout'];

async function fetchAll() {
  const out = [];
  let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/Customers`);
    u.searchParams.set('pageSize', '100');
    FIELDS.forEach((f, i) => u.searchParams.set(`fields[${i}]`, f));
    if (offset) u.searchParams.set('offset', offset);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) { console.error(`✖ 取得に失敗: ${res.status}`); process.exit(1); }
    const j = await res.json();
    out.push(...j.records.map((r) => ({ id: r.id, fields: r.fields })));
    offset = j.offset;
  } while (offset);
  return out;
}

// ── 反応（開封）の一覧 ────────────────────────────────────────
//
// ⚠️ **開封の記録は Redis（engagement signal store）にあり、ここからは読めない**
//    （本番 env の値はマスクされて手元に降りてこない）。
//    反応した人は本来 Customers へ残す（昇格対象）ので、**一覧が無いまま実行してはいけない**。
//    `--engaged <file>`（1 行 1 アドレス）で渡すか、管理 API 側で当ててから実行する。
const engagedPath = argv.includes('--engaged') ? argv[argv.indexOf('--engaged') + 1] : null;
let engagedEmails = null;
if (engagedPath) {
  const { readFileSync } = await import('node:fs');
  engagedEmails = new Set(readFileSync(engagedPath, 'utf8').split('\n')
    .map((x) => x.trim().toLowerCase()).filter(Boolean));
}

const records = await fetchAll();
const plan = buildMigrationPlan({ records, engagedEmails });
const rollback = assertRollbackComplete({ records, migrateIds: plan.migrateIds });

console.log(`Customers 総数: ${plan.total}`);
console.log(`母数と判定の合計が一致: ${plan.balanced ? 'はい' : '⚠️ いいえ（計画を使わないこと）'}`);
console.log('\n判定ごとの件数');
for (const [k, v] of Object.entries(plan.counts)) console.log(`  ${String(DECISION_LABEL[k]).padEnd(36)} ${v}`);
console.log('  ⚠️ review_* は「消さないが顧客化とも数えない」保留（運営側の付与・由来不明）');
console.log('\n取り込みバッチ別');
for (const [b, c] of Object.entries(plan.byBatch)) {
  const keep = Object.entries(c)
    .filter(([k]) => k !== MIGRATION_DECISION.MIGRATE)
    .reduce((a, [, v]) => a + v, 0);
  console.log(`  ${b}: 移す ${c.migrate} / 残す ${keep}`
    + ` （うち保留 ${c.review_operator_grant + c.review_ambiguous}）`);
}

// ── 配信停止・バウンス・退会の引き継ぎ計画（**書き込みはしない**）─────────
// `keep_suppressed` を Airtable に永久保持しないための下見。
// hash は sha256（`prospectStore.emailHash`）。**アドレスは出力しない**。
const handoff = buildSuppressionHandoff({
  records, hashFn: emailHash, nowIso: new Date().toISOString(), engagedEmails,
});
console.log('\n配信停止・バウンス・退会の抑止台帳への引き継ぎ（計画のみ）');
console.log(`  対象 ${handoff.counts['対象']} / 引き継げる ${handoff.counts['引き継ぎ']}`
  + ` / 理由が決まらず保留 ${handoff.counts['保留']}`);
console.log('  ⚠️ 台帳へ hash を書くのが先、生アドレスを消すのは後（逆順だと再取り込みで復活する）');
console.log(`\n巻き戻しに必要な項目: ${rollback.ok ? `そろっている（${rollback.checked} 件）` : `⚠️ 欠けている ${rollback.missing.length} 件`}`);

if (!engagedEmails) {
  console.log('\n⚠️ 反応（開封）の一覧を渡していないため、この計画は**暫定**です。');
  console.log('   開封した人まで「移す」に入っている可能性があります。');
  console.log('   実行前に --engaged <file> で渡すか、管理 API 側で当ててください。');
} else {
  console.log(`\n反応の一覧: ${engagedEmails.size} 件を適用しました。`);
}

writeFileSync(`${OUT}/plan-${new Date().toISOString().slice(0, 10)}.json`,
  JSON.stringify({ counts: plan.counts, byBatch: plan.byBatch, migrateIds: plan.migrateIds,
    balanced: plan.balanced, rollbackOk: rollback.ok,
    /** 反応の一覧を当てたか。false のまま実行してはいけない */
    engagementApplied: Boolean(engagedEmails),
    engagedCount: engagedEmails ? engagedEmails.size : 0 }, null, 1));
console.log(`\n計画を保存: ${OUT}/plan-…json（**書き込みは 1 件もしていない**）`);
