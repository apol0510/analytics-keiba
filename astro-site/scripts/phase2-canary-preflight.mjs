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
  check(sameKey.length === 0, `同一 DeliveryKey の行が 0 件（実測 ${sameKey.length} 件）`,
    sameKey.length ? '既に送信済み。version を上げないと already_delivered で拒否される（＝二重送信は起きない）' : '');
  check(sameCampaign.length === 0, `${campaign.campaignId}:v${campaign.version} の配信行が 0 件（実測 ${sameCampaign.length} 件）`);
  console.log(`ℹ️  今回の DeliveryKey: ${deliveryKey.slice(0, 12)}…（先頭のみ表示）`);

  // 5) 送信キューが空であること（意図しないジョブを一緒に飛ばさない）
  const scheduled = await getAll('ScheduledEmails', `{Status}='PENDING'`);
  check(scheduled.length === 0, `ScheduledEmails の PENDING が 0 件（実測 ${scheduled.length} 件）`);

  // 6) 台帳の初期値（送信後の増分を判定するための基準）
  let ledgerCount = null;
  try {
    ledgerCount = (await getAll(EMAIL_EVENTS_TABLE)).length;
    check(true, `EmailEvents の現在値 = ${ledgerCount} 件（送信後の増分判定の基準）`);
  } catch (e) {
    check(false, 'EmailEvents を読めない', String(e.message || '').slice(0, 60));
  }
  const resolved = ledgerCount === null ? [] : await getAll(EMAIL_EVENTS_TABLE, `{ResolutionStatus}='resolved'`).catch(() => []);
  check(resolved.length === 0, `resolved の行が 0 件（実測 ${resolved.length} 件）`,
    '送信後に増えた resolved が今回のものだと言い切れる状態にする');

  // 7) gate が閉じていること（**この時点で開いていてはいけない**）
  check(process.env.MARKETING_CAMPAIGN_ENABLED !== 'true', 'MARKETING_CAMPAIGN_ENABLED が未設定（実行前）');
  check(process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true', 'MARKETING_CAMPAIGN_DISPATCH_ENABLED が未設定（実行前）');

  finish({ customerRecordId, deliveryKey, ledgerCount, campaign });
}

function finish(ctx) {
  console.log('\n── Phase 2 事前確認 ─────────────────────────────');
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  const ng = checks.filter((c) => !c.ok);
  if (ctx && ng.length === 0) {
    console.log('\n── 送信後に期待する値 ───────────────────────────');
    console.log(`  ScheduledEmails: +1（Status=PENDING → SENT）`);
    console.log(`  CampaignDeliveries: +1（${ctx.campaign.campaignId}:v${ctx.campaign.version} / queued → sent）`);
    console.log(`  Customers: ±0（マーケ経路は Customers へ書かない）`);
    console.log(`  EmailEvents: ${ctx.ledgerCount} → +2〜6（processed / delivered / open / click…）`);
    console.log(`  すべての新規 EmailEvents: ResolutionStatus=resolved / CustomerRecordId=${ctx.customerRecordId}`);
    console.log(`  admin カルテ ⑥-2: 配信済み 1 / 開封・クリックは実際に開いた回数`);
  }
  console.log(ng.length === 0 ? '\n✅ 前提を満たしています（送信の承認へ進めます）' : `\n❌ ${ng.length} 件が未達。**送ってはいけません**`);
  process.exit(ng.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ 事前確認に失敗:', String(e.message || '').slice(0, 120));
  process.exit(1);
});
