#!/usr/bin/env node
// Brand 遡及付与 CSV 出力スクリプト（READ-ONLY）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md
//
// 安全装置:
//   - Airtable API は GET のみ（PATCH/POST/PUT/DELETE は使わない）
//   - SendGrid API は呼ばない
//   - 出力はローカル CSV / JSON のみ
//   - BACKFILL_DRY_RUN=true を環境変数に明示しないと起動拒否
//
// 使い方:
//   BACKFILL_DRY_RUN=true \
//   AIRTABLE_API_KEY=... \
//   AIRTABLE_BASE_ID_ANALYTICS_KEIBA=... \
//   AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE=... \
//   node scripts/newsletter/backfill-customers.mjs --base=analytics-keiba --limit=10

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { normalizeAudienceType } from './lib/plan-normalizer.mjs';
import { resolveStatus } from './lib/status-resolver.mjs';
import {
  resolveEmail,
  resolveName,
  resolvePlanRaw,
  resolveExpiryDate,
  resolveWithdrawalFlag,
  stringifyMultiSelect,
} from './lib/customer-field-resolver.mjs';
import { writeCsv } from './lib/csv-writer.mjs';

// 仕様 §8.1
export const CSV_COLUMNS = [
  'BaseName',
  'AirtableRecordId',
  'Email',
  'NameResolved',
  'CurrentBrand',
  'SuggestedBrand',
  'CurrentServiceType',
  'SuggestedServiceType',
  'CurrentAudienceType',
  'SuggestedAudienceType',
  'CurrentStatus',
  'SuggestedStatus',
  'CurrentPlanRaw',
  'PlanResolved',
  'ExpiryDateResolved',
  'WithdrawalRequested',
  'Reason',
  'Warning',
  'NeedsManualReview',
];

const VALID_BASES = ['analytics-keiba', 'keiba-intelligence'];

/**
 * CLI 引数の最小パーサ
 */
export function parseArgs(argv) {
  const out = { base: 'all', limit: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      out.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Airtable Customers を GET でページネーション取得（READ-ONLY 明示）
 */
async function fetchCustomers(baseId, apiKey, { limit = null } = {}) {
  const records = [];
  let offset = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    const url = new URL(`https://api.airtable.com/v0/${baseId}/Customers`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      method: 'GET', // READ-ONLY 明示
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!res.ok) {
      // API key は絶対にログに出さない
      throw new Error(`Airtable fetch failed: status=${res.status} page=${pageCount}`);
    }

    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || null;

    if (limit && records.length >= limit) break;

    // Airtable 5rps レート対策
    if (offset) await sleep(220);
  } while (offset);

  return limit ? records.slice(0, limit) : records;
}

/**
 * 1レコードを CSV 行に変換（純粋関数として扱える、export する）
 */
export function buildRow({ record, baseName, today }) {
  const f = record.fields || {};
  const isAnalyticsKeiba = baseName === 'analytics-keiba';

  const email = resolveEmail(f);
  const name = resolveName(f);
  const planRaw = resolvePlanRaw(f);
  const expiryDate = resolveExpiryDate(f, baseName);
  const withdrawalFlag = resolveWithdrawalFlag(f, baseName);
  const currentStatus = (f.Status ?? null) || null;

  const { audienceType, planResolvedLabel, reasons: planReasons, warning } =
    normalizeAudienceType(planRaw, {
      status: currentStatus,
      expiryDate,
      today,
    });

  const statusResult = resolveStatus({
    currentStatus,
    withdrawalRequested: withdrawalFlag,
    expiryDate,
    today,
    isAnalyticsKeiba,
  });

  const emailFormatOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const needsManualReview = Boolean(
    !audienceType ||
      warning ||
      statusResult.needsManualReview ||
      !email ||
      !emailFormatOk,
  );

  return {
    BaseName: baseName,
    AirtableRecordId: record.id,
    Email: email,
    NameResolved: name ?? '',
    CurrentBrand: stringifyMultiSelect(f.Brand),
    SuggestedBrand: baseName,
    CurrentServiceType: stringifyMultiSelect(f.ServiceType),
    SuggestedServiceType: baseName,
    CurrentAudienceType: f.AudienceType ?? '',
    SuggestedAudienceType: audienceType ?? '',
    CurrentStatus: currentStatus ?? '',
    SuggestedStatus: statusResult.suggestedStatus ?? '',
    CurrentPlanRaw: planRaw ?? '',
    PlanResolved: planResolvedLabel ?? '',
    ExpiryDateResolved: expiryDate ?? '',
    WithdrawalRequested:
      withdrawalFlag === null ? '' : String(withdrawalFlag),
    Reason: [...planReasons, ...statusResult.reasons].join(';'),
    Warning: warning ?? '',
    NeedsManualReview: needsManualReview ? 'true' : 'false',
  };
}

/**
 * 統計集計（純粋関数、export）
 */
export function summarize(rows) {
  const stats = {
    needsManualReview: 0,
    emailMissing: 0,
    emailDuplicates: 0,
    audienceTypeBreakdown: {},
    withdrawalCandidates: 0,
    expiredCandidates: 0,
    pendingCandidates: 0,
    unknownPlanRaw: [],
  };
  const emailCounts = new Map();
  for (const r of rows) {
    if (r.NeedsManualReview === 'true') stats.needsManualReview += 1;
    if (!r.Email) stats.emailMissing += 1;
    if (r.Email) emailCounts.set(r.Email, (emailCounts.get(r.Email) || 0) + 1);
    const at = r.SuggestedAudienceType || '(null/unknown)';
    stats.audienceTypeBreakdown[at] = (stats.audienceTypeBreakdown[at] || 0) + 1;
    if (r.SuggestedStatus === 'withdrawn') stats.withdrawalCandidates += 1;
    if (r.Reason && r.Reason.includes('plan-expired')) stats.expiredCandidates += 1;
    if (r.CurrentStatus === 'pending') stats.pendingCandidates += 1;
    if (r.Warning && r.Warning.startsWith('unknown plan:')) {
      const planValue = r.Warning.slice('unknown plan: '.length);
      if (!stats.unknownPlanRaw.includes(planValue)) {
        stats.unknownPlanRaw.push(planValue);
      }
    }
  }
  for (const count of emailCounts.values()) {
    if (count > 1) stats.emailDuplicates += 1;
  }
  return stats;
}

function ensureDryRun() {
  if (process.env.BACKFILL_DRY_RUN !== 'true') {
    console.error('❌ BACKFILL_DRY_RUN environment variable must be set to "true".');
    console.error('   This script is READ-ONLY but the dry-run flag is enforced as a safety check.');
    console.error('   Run with: BACKFILL_DRY_RUN=true node scripts/newsletter/backfill-customers.mjs ...');
    process.exit(1);
  }
}

function getEnvOrExit(name, hint = '') {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing env: ${name}`);
    if (hint) console.error(`   ${hint}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  ensureDryRun();

  const args = parseArgs(process.argv);
  if (args.base !== 'all' && !VALID_BASES.includes(args.base)) {
    console.error(`❌ Unknown --base value: ${args.base}`);
    console.error(`   Supported: ${VALID_BASES.join(', ')}, all`);
    process.exit(1);
  }

  const apiKey = getEnvOrExit(
    'AIRTABLE_API_KEY',
    'Use a READ-ONLY (data.records:read) scoped Personal Access Token for safety.',
  );

  const baseIds = {
    'analytics-keiba': process.env.AIRTABLE_BASE_ID_ANALYTICS_KEIBA,
    'keiba-intelligence': process.env.AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE,
  };

  const targets = args.base === 'all' ? VALID_BASES : [args.base];

  for (const t of targets) {
    if (!baseIds[t]) {
      const envName =
        t === 'analytics-keiba'
          ? 'AIRTABLE_BASE_ID_ANALYTICS_KEIBA'
          : 'AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE';
      console.error(`❌ Missing env: ${envName}`);
      process.exit(1);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const outputDir = resolve(process.cwd(), 'tmp/newsletter-backfill');

  const summary = {
    runAt: new Date().toISOString(),
    dryRun: true,
    base: args.base,
    limit: args.limit,
    bases: {},
    totalProcessed: 0,
    totalNeedsManualReview: 0,
    warnings: [],
  };

  for (const baseName of targets) {
    const baseId = baseIds[baseName];
    console.log(`📊 [${baseName}] Fetching Customers via Airtable GET (READ-ONLY)${args.limit ? ` (limit=${args.limit})` : ''}...`);
    const records = await fetchCustomers(baseId, apiKey, { limit: args.limit });
    console.log(`   ${records.length} records fetched`);

    const rows = records.map((record) => buildRow({ record, baseName, today }));
    const stats = summarize(rows);

    const csvPath = join(outputDir, `${baseName}-customers-brand-backfill.csv`);
    const csvResult = await writeCsv(csvPath, rows, CSV_COLUMNS);
    console.log(`   ✅ CSV written: ${csvPath}`);
    console.log(`      rows=${csvResult.rows}, bytes=${csvResult.bytes}`);
    console.log(`   📊 stats: needsManualReview=${stats.needsManualReview}/${rows.length}, emailMissing=${stats.emailMissing}, dupEmails=${stats.emailDuplicates}`);

    summary.bases[baseName] = {
      totalRecords: records.length,
      csvFile: csvPath,
      stats,
    };
    summary.totalProcessed += records.length;
    summary.totalNeedsManualReview += stats.needsManualReview;
  }

  const summaryPath = join(outputDir, 'newsletter-backfill-summary.json');
  await mkdir(outputDir, { recursive: true });
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('');
  console.log(`📋 Summary JSON written: ${summaryPath}`);
  console.log(`   totalProcessed=${summary.totalProcessed}`);
  console.log(`   totalNeedsManualReview=${summary.totalNeedsManualReview}`);
  console.log('');
  console.log('✅ Done. No Airtable WRITE / no SendGrid call was made.');
}

// 直接実行されたときだけ main を呼ぶ（ライブラリとして import されたときは実行しない）
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ Backfill failed:', err.message);
    process.exit(1);
  });
}
