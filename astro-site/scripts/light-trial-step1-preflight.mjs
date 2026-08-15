#!/usr/bin/env node
/**
 * light-trial-step1-preflight.mjs — Light 無料体験 Step1 キュー登録の直前確認（**read-only**）
 *
 * ── 何のためか ────────────────────────────────────────────────
 * Step1 のキュー登録は承認が要る操作で、押した後は
 * ScheduledEmails / CampaignDeliveries に行が残る。
 * 「いま押してよいか」を人の記憶ではなく**機械で固定**してから承認を取る。
 *
 * ── どこから答えを取るか ──────────────────────────────────
 * 対象人数・停止理由・関所の残件は `admin-marketing` の **read-only アクション**
 * （`sequence` / `trialGrant` / `jobs`）が単一源として計算している。
 * このスクリプトはそれを**呼んで検算するだけ**で、母集団を自分で作り直さない
 * （作り直すと画面の人数と preflight の人数がズレる）。
 *
 * ── 絶対にしないこと ──────────────────────────────────────
 * - `dryRun` / `send` / `cancelJob` など**書き込みを伴うアクションを呼ばない**
 *   （呼べるアクション名は下の READ_ONLY_ACTIONS に固定し、guard テストが監視する）
 * - Airtable / SendGrid を直接叩かない
 * - env の変更・メール送信
 * - **アドレス・recordId・secret の出力**（件数と理由だけを出す）
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   MARKETING_ADMIN_SECRET=… \
 *     node scripts/light-trial-step1-preflight.mjs [--expect 10] [--stage pre|enqueue]
 *
 *   # secret は PREMIUM_PLUS_ADMIN_SECRET でも可（Function 側の優先順と同じ）
 *   # 基点 URL は AK_BASE_URL で上書きできる（既定 https://analytics.keiba.link）
 *
 * 終了コード 0 = 押してよい / 1 = **押してはいけない**
 */
import {
  evaluateStep1Preflight, resolveStep1Stage, readStep1Gates,
  STEP1_STAGE_LABEL, SEVERITY, stepLabel,
} from '../src/lib/marketing/step1Preflight.js';

/** 呼んでよいアクションはこれだけ（すべて `sideEffects: 'none'`） */
const READ_ONLY_ACTIONS = Object.freeze(['sequence', 'trialGrant', 'jobs', 'duplicateCheck']);

const CAMPAIGN_ID = process.env.STEP1_CAMPAIGN_ID || 'light-trial-to-premium-sequence';
const BASE_URL = process.env.AK_BASE_URL || 'https://analytics.keiba.link';
const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET || '';

/** 引数（`--expect 10` / `--stage pre`）*/
function parseArgs(argv) {
  const out = { expect: null, stage: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--expect') { const n = Number(argv[i + 1]); out.expect = Number.isFinite(n) ? n : null; i += 1; }
    if (argv[i] === '--stage') { out.stage = String(argv[i + 1] || '').trim(); i += 1; }
  }
  return out;
}

/** read-only アクションを 1 つ呼ぶ。**許可リスト外は呼ばずに落とす** */
async function callReadOnly(action, extra = {}) {
  if (!READ_ONLY_ACTIONS.includes(action)) {
    throw new Error(`read-only ではないアクションを呼ぼうとしました: ${action}`);
  }
  const res = await fetch(`${BASE_URL}/.netlify/functions/admin-marketing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify({ action, campaignId: CAMPAIGN_ID, ...extra }),
  });
  // 4xx / 5xx も本文を読む（fail closed の理由を判定へ渡すため）
  const body = await res.json().catch(() => null);
  if (!res.ok && !body) throw new Error(`${action}: HTTP ${res.status}`);
  return body;
}

function printReport(result, gates) {
  const mark = (c) => (c.ok ? '✅' : (c.severity === SEVERITY.CRITICAL ? '❌' : '⚠️ '));
  console.log(`\n── Step1 直前確認 / ${CAMPAIGN_ID} ──`);
  console.log(`段階: ${STEP1_STAGE_LABEL[result.stage] || result.stage}`);
  console.log(`ゲート: キュー登録=${gates.enqueue ? 'ON' : 'OFF'} / 実送信=${gates.dispatch ? 'ON' : 'OFF'}\n`);
  for (const c of result.checks) {
    console.log(`${mark(c)} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  const p = result.plan;
  console.log('\n── 押したときに増える行（件数のみ・宛先は持たない）──');
  console.log(`  ${p.writes.scheduledEmails.table}    : ${p.writes.scheduledEmails.rows} 行 (${p.writes.scheduledEmails.status})`);
  console.log(`  ${p.writes.campaignDeliveries.table} : ${p.writes.campaignDeliveries.rows} 行 (${p.writes.campaignDeliveries.status})`);
  console.log(`  ${p.writes.customers.table}          : ${p.writes.customers.rows} 行 — ${p.writes.customers.note}`);
  // ⚠️ ステップ名の整形は**判定側と同じ関数**を使う（書き写すと片方だけ直り、
  //    実際 #345 では判定側だけ直してここに `Stepnull` が残った）。
  console.log(`\n対象: ${stepLabel(p.step)} / ${p.recipients ?? '(不明)'} 名`
    + ` / 全 ${p.maxSends ?? '(不明)'} 通中`);
  console.log(result.ok
    ? '\n✅ 前提を満たしています。**承認のうえで**キュー登録へ進めます。\n'
    : `\n❌ 押してはいけません（未達 ${result.failures.length} 件）。\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SECRET) {
    console.error('❌ MARKETING_ADMIN_SECRET / PREMIUM_PLUS_ADMIN_SECRET が未設定です（read-only 取得に必要）');
    process.exit(1);
  }
  const gates = readStep1Gates(process.env);
  const stage = args.stage || resolveStep1Stage(process.env);

  let sequence = null; let trialGrant = null; let jobs = null; let duplicateCheck = null;
  try {
    // 先に進行状況を取り、**そこで確定した候補**に対してだけ重複を確認する
    // （campaign 全履歴ではなく、いま送ろうとしている相手だけを見る）
    sequence = await callReadOnly('sequence');
    const next = (sequence && sequence.next) || {};
    [trialGrant, jobs, duplicateCheck] = await Promise.all([
      callReadOnly('trialGrant'),
      callReadOnly('jobs'),
      Array.isArray(next.recordIds) && next.recordIds.length > 0 && next.step
        ? callReadOnly('duplicateCheck', { step: next.step, recordIds: next.recordIds })
        : Promise.resolve(null),
    ]);
  } catch (e) {
    // 取れなかったものは null のまま評価へ渡す（**沈黙を成功にしない**）
    console.error(`⚠️  read-only 取得に失敗: ${e.message}`);
  }

  const result = evaluateStep1Preflight({
    sequence, trialGrant, jobs, duplicateCheck, campaignId: CAMPAIGN_ID,
    expectRecipients: args.expect, stage,
  });
  printReport(result, gates);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ preflight が異常終了しました:', e.message);
  process.exit(1);
});
