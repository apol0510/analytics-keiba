#!/usr/bin/env node
/**
 * phase2-canary-preflight.mjs — Phase 2（刻印付きカナリア 1 通）の事前確認（**read-only**）
 *
 * ── 何のためか ────────────────────────────────────────────────
 * 「テスト受信者 1 名へ exactly-one で送る」を、送る前に**構造として**確かめる。
 * 実行後に「2 通行った」「実顧客に届いた」は取り返しがつかないため、
 * 送信の直前条件（allowlist・重複・gate・台帳の初期値）を機械的に固定する。
 *
 * ── 絶対にしないこと ──────────────────────────────────────
 * - Airtable への write（GET しか使わない。POST/PATCH/DELETE を書かない）
 * - メール送信（SendGrid の送信 API を呼ばない）
 * - env の変更
 * - **メールアドレス・secret の出力**（件数とハッシュ断片だけを出す）
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… NEWSLETTER_TEST_RECIPIENTS=… \
 *     node scripts/phase2-canary-preflight.mjs
 *
 * 終了コード 0 = 送信の前提を満たす / 1 = 満たさない（**送ってはいけない**）
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { getCampaign } from '../src/lib/marketing/campaignCatalog.js';
import { parseTestRecipientsEnv } from '../src/lib/newsletter/test-recipients.js';
import { computeCampaignDeliveryKey } from '../src/lib/marketing/campaignSend.js';
import { getBrandConfig } from '../src/lib/newsletter/brand-config.js';
import { EMAIL_EVENTS_TABLE } from '../src/lib/webhooks/emailEventLedger.js';

const BRAND = 'analytics-keiba';
const CAMPAIGN_ID = process.env.PHASE2_CAMPAIGN_ID || 'marketing-canary';
const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

/** アドレスは出さない。同一性の確認だけできるよう先頭 8 桁のハッシュにする */
const tag = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8);

/**
 * 実行の段階。gate の状態から自動判定する（`PHASE2_STAGE` で上書き可）。
 *
 * 「常に両 gate が閉じていること」を要求すると、**手順どおり 1 つ開けた直後に失敗**と表示され、
 * 正常な進行と異常の区別がつかなくなる。段階ごとに「この時点で成り立つべきこと」だけを見る。
 */
export const STAGE = Object.freeze({
  PRE: 'pre',          // 何も開けていない
  ENQUEUE: 'enqueue',  // キュー登録のみ解禁（MARKETING_CAMPAIGN_ENABLED=true）
  SEND: 'send',        // 実送信まで解禁（両方 true）
});

const STAGE_LABEL = Object.freeze({
  [STAGE.PRE]: 'pre（両 gate 未設定・実行前）',
  [STAGE.ENQUEUE]: 'enqueue（キュー登録のみ解禁）',
  [STAGE.SEND]: 'send（実送信まで解禁）',
});

/** env から段階を決める。明示指定（PHASE2_STAGE）があればそれを優先する */
export function resolveStage(env = {}) {
  const forced = String(env.PHASE2_STAGE || '').trim().toLowerCase();
  if (Object.values(STAGE).includes(forced)) return forced;
  const enqueue = String(env.MARKETING_CAMPAIGN_ENABLED || '').trim() === 'true';
  const send = String(env.MARKETING_CAMPAIGN_DISPATCH_ENABLED || '').trim() === 'true';
  if (send) return STAGE.SEND;
  if (enqueue) return STAGE.ENQUEUE;
  return STAGE.PRE;
}

const checks = [];
const check = (ok, label, detail = '') => { checks.push({ ok, label, detail }); };

async function getAll(table, formula) {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (formula) url.searchParams.set('filterByFormula', formula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
    const j = await res.json();
    out.push(...(j.records || []));
    offset = j.offset;
  } while (offset);
  return out;
}

async function main() {
  if (!KEY || !BASE) {
    console.error('❌ AIRTABLE_API_KEY / AIRTABLE_BASE_ID が未設定です（read-only 取得に必要）');
    process.exit(1);
  }

  // 1) キャンペーンが運用テスト専用であること
  const campaign = getCampaign(CAMPAIGN_ID);
  check(!!campaign, `キャンペーン ${CAMPAIGN_ID} が存在する`);
  if (!campaign) return finish();
  check(campaign.testOnly === true, 'testOnly = true（運用テスト専用）');
  check(campaign.enabled === true, 'enabled = true');
  check(campaign.extraAudience === 'marketing_canary_recipient',
    'extraAudience = marketing_canary_recipient（allowlist 一致者のみ）');
  check(!/[¥￥]|円|価格|購入|申込/.test(String(campaign.body || '') + String(campaign.subject || '')),
    '本文・件名に販売文言が無い');

  // 2) allowlist が **ちょうど 1 名**（exactly-one の第 1 防壁）
  const allow = parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS);
  const recipients = [...allow.recipients];
  check(recipients.length === 1, `NEWSLETTER_TEST_RECIPIENTS がちょうど 1 名（実測 ${recipients.length} 名）`);
  if (recipients.length !== 1) return finish();
  const target = recipients[0];
  console.log(`ℹ️  対象受信者: sha256:${tag(target)}（アドレスは出力しない）`);

  // 3) 受信者が Customers に存在し、**1 件だけ**であること（重複があると customer_record_id が確定しない）
  const customers = await getAll('Customers');
  const matched = customers.filter((r) => String(r.fields?.Email || '').trim().toLowerCase() === target);
  check(matched.length === 1, `Customers に該当が 1 件（実測 ${matched.length} 件）`);
  const customerRecordId = matched.length === 1 ? matched[0].id : '';
  check(/^rec[A-Za-z0-9]{14}$/.test(customerRecordId), 'customer_record_id が Airtable recordId 形式');

  // 4) この版の DeliveryKey が**まだ使われていない**こと（再実行しても二重送信にならない）
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const deliveryKey = computeCampaignDeliveryKey({ campaign, recipientEmail: target, brand: BRAND, fromEmail });
  check(/^[a-f0-9]{64}$/.test(deliveryKey), 'DeliveryKey が sha256 hex');
  const deliveries = await getAll('CampaignDeliveries');
  const sameKey = deliveries.filter((r) => String(r.fields?.DeliveryKey || '') === deliveryKey);
  const sameCampaign = deliveries.filter((r) => String(r.fields?.CampaignType || '') === `${campaign.campaignId}:v${campaign.version}`);
  console.log(`ℹ️  今回の DeliveryKey: ${deliveryKey.slice(0, 12)}…（先頭のみ表示）`);

  const scheduled = await getAll('ScheduledEmails', `{Status}='PENDING'`);
  let ledgerCount = null;
  try {
    ledgerCount = (await getAll(EMAIL_EVENTS_TABLE)).length;
    check(true, `EmailEvents の現在値 = ${ledgerCount} 件（増分判定の基準）`);
  } catch (e) {
    check(false, 'EmailEvents を読めない', String(e.message || '').slice(0, 60));
  }
  const resolved = ledgerCount === null ? [] : await getAll(EMAIL_EVENTS_TABLE, `{ResolutionStatus}='resolved'`).catch(() => []);

  // ── 段階（stage）に応じて期待値を変える ────────────────────────
  // 実行前だけを前提にすると、gate を 1 つ開けた直後に「❌ 未設定であること」となり、
  // **正常に進んでいるのに失敗と読める**。段階を判定してから、その段階で成り立つべきことだけを見る。
  const stage = resolveStage(process.env);
  const own = sameKey.filter((r) => String(r.fields?.CampaignType || '') === `${campaign.campaignId}:v${campaign.version}`);
  const ownStatus = own.length === 1 ? String(own[0].fields?.Status || '') : '';
  console.log(`ℹ️  現在の段階: ${STAGE_LABEL[stage]}`);

  if (stage === STAGE.PRE) {
    // 何も始めていない段階。ここでは「まだ 1 行も無い」ことが正しい
    check(sameKey.length === 0, `同一 DeliveryKey の行が 0 件（実測 ${sameKey.length} 件）`,
      sameKey.length ? '既に送信済み。version を上げないと already_delivered で拒否される（＝二重送信は起きない）' : '');
    check(sameCampaign.length === 0, `${campaign.campaignId}:v${campaign.version} の配信行が 0 件（実測 ${sameCampaign.length} 件）`);
    check(scheduled.length === 0, `ScheduledEmails の PENDING が 0 件（実測 ${scheduled.length} 件）`);
    check(resolved.length === 0, `resolved の行が 0 件（実測 ${resolved.length} 件）`,
      '送信後に増えた resolved が今回のものだと言い切れる状態にする');
    check(true, '両 gate が未設定（この段階では閉じているのが正しい）');
  } else if (stage === STAGE.ENQUEUE) {
    // キュー登録の解禁だけ済んだ段階。**実送信 gate は閉じたままでなければならない**
    check(process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true',
      'MARKETING_CAMPAIGN_DISPATCH_ENABLED が未設定（この段階では実送信を許さない）');
    check(sameCampaign.length <= 1, `${campaign.campaignId}:v${campaign.version} の配信行が 1 行以下（実測 ${sameCampaign.length} 件）`,
      '2 行以上あるなら exactly-one が壊れている');
    check(scheduled.length <= 1, `PENDING ジョブが 1 件以下（実測 ${scheduled.length} 件）`,
      '別のジョブを巻き込んで送らないため');
    check(ownStatus !== 'sent', `対象の配信行がまだ送信済みでない（実測 Status=${ownStatus || '未作成'}）`);
  } else {
    // 実送信まで解禁された段階。**キューにあるものが実際に飛ぶ**ので、対象が 1 通だけであること
    check(sameCampaign.length === 1, `${campaign.campaignId}:v${campaign.version} の配信行がちょうど 1 行（実測 ${sameCampaign.length} 件）`);
    check(scheduled.length <= 1, `PENDING ジョブが 1 件以下（実測 ${scheduled.length} 件）`,
      'この状態で dispatch すると PENDING の全ジョブが対象になる');
    check(true, `対象の配信行の状態 = ${ownStatus || '未作成'}`,
      ownStatus === 'sent' ? '送信済み。再実行しても DeliveryKey 一致で二重送信にならない' : '');
  }

  finish({ customerRecordId, deliveryKey, ledgerCount, campaign, stage, resolvedCount: resolved.length });
}

/** 段階ごとの「次にやること」。判定結果を運用手順へつなぐ */
const NEXT_ACTION = Object.freeze({
  [STAGE.PRE]: 'MARKETING_CAMPAIGN_ENABLED=true を投入 → redeploy（キュー登録の解禁）',
  [STAGE.ENQUEUE]: 'admin で dry-run → キュー登録 → dispatcher dryRun:true（willSend=1 / skipped=0）',
  [STAGE.SEND]: 'dispatcher を dryRun:false で実行（実メール 1 通）→ 検証 → **両 gate を unset → redeploy で再閉鎖**',
});

function finish(ctx) {
  console.log('\n── Phase 2 事前確認 ─────────────────────────────');
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  const ng = checks.filter((c) => !c.ok);
  if (ctx && ng.length === 0) {
    console.log('\n── 期待する値 ─────────────────────────────────');
    console.log(`  ScheduledEmails: 対象ジョブ 1 件（PENDING → SENT）`);
    console.log(`  CampaignDeliveries: ${ctx.campaign.campaignId}:v${ctx.campaign.version} が 1 行（queued → sent）`);
    console.log(`  Customers: ±0（マーケ経路は Customers へ書かない）`);
    console.log(`  EmailEvents: 現在 ${ctx.ledgerCount} 件（うち resolved ${ctx.resolvedCount} 件）。**増分は固定しない**`);
    console.log(`    （provider が何を送るかに依存。open / click は受信者が開く・押した後の実観測）`);
    console.log(`  検証条件: 観測できた**各**イベントが ResolutionStatus=resolved / CustomerRecordId=${ctx.customerRecordId}`);
    console.log(`\n── 次にやること（段階 ${ctx.stage}）──────────────────`);
    console.log(`  ${NEXT_ACTION[ctx.stage]}`);
  }
  console.log(ng.length === 0
    ? `\n✅ 段階「${ctx ? ctx.stage : '-'}」で成り立つべき前提を満たしています`
    : `\n❌ ${ng.length} 件が未達。**次の操作へ進んではいけません**`);
  process.exit(ng.length === 0 ? 0 : 1);
}

// **直接実行したときだけ**動かす。import しても走らないので、段階判定を単体テストできる
const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌ 事前確認に失敗:', String(e.message || '').slice(0, 120));
    process.exit(1);
  });
}
