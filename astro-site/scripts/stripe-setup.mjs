#!/usr/bin/env node
/**
 * stripe-setup.mjs — AK の Stripe（商品・価格・Webhook・カスタマーポータル）を API で用意し、Netlify の env へ入れる
 *
 * 何度実行しても同じ状態に収束する（Price は lookup_key、Webhook は URL で照合）。
 * **秘密鍵・Webhook 署名鍵は標準出力に出さない**（netlify env:set へ直接渡す）。
 *
 * 使い方:
 *   STRIPE_KEY_FILE=~/.analytics-keiba-ops/stripe-test-key \
 *   node scripts/stripe-setup.mjs --context deploy-preview --site https://deploy-preview-123--analytics-keiba.netlify.app [--apply]
 *
 *   --context  Netlify の env を入れる先（production / deploy-preview / branch-deploy）
 *   --site     Webhook の宛先オリジン（本番は https://analytics.keiba.link）
 *   --apply    付けたときだけ Stripe / Netlify へ書く（無ければ下見）
 *
 * 安全条件:
 *   - production には sk_live_ だけ、それ以外には sk_test_ だけを受け付ける（取り違え防止）
 *   - Price の金額が既存と違う場合は**作り直さず止める**（Live の契約価格を黙って変えない）
 *   - 実行は astro-site（netlify link 済み）で行う。worktree からは env を読めないことがある
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import Stripe from 'stripe';
import { STRIPE_PLANS, STRIPE_IDS } from '../src/lib/billing/stripePlans.js';

export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_succeeded',
];

const LOOKUP_KEY = {
  'premium': 'ak_premium_monthly',
  'premium-jra': 'ak_premium_jra_monthly',
  'premium-nankan': 'ak_premium_nankan_monthly',
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const apply = process.argv.includes('--apply');
const context = arg('context');
const site = String(arg('site') || '').replace(/\/$/, '');

function die(msg) { console.error(`✖ ${msg}`); process.exit(1); }

if (!['production', 'deploy-preview', 'branch-deploy'].includes(context)) die('--context は production / deploy-preview / branch-deploy');
if (!/^https:\/\//.test(site)) die('--site は https:// から');
if (context === 'production' && site !== 'https://analytics.keiba.link') die('production の --site は https://analytics.keiba.link だけ');

const keyFile = (process.env.STRIPE_KEY_FILE || '').replace(/^~/, homedir());
if (!keyFile) die('STRIPE_KEY_FILE（秘密鍵を 1 行だけ書いたファイル）を指定してください');
const key = readFileSync(keyFile, 'utf8').trim();
const live = key.startsWith('sk_live_') || key.startsWith('rk_live_');
const test = key.startsWith('sk_test_') || key.startsWith('rk_test_');
if (!live && !test) die('鍵の形式が違います（sk_test_ / sk_live_）');
if (context === 'production' && !live) die('production には本番鍵（sk_live_）だけを入れます');
if (context !== 'production' && !test) die('production 以外にはテスト鍵（sk_test_）だけを入れます');

const stripe = new Stripe(key);

function netlifySet(name, value) {
  if (!apply) { console.log(`  (下見) netlify env:set ${name} <${name === 'STRIPE_SECRET_KEY' || name === 'STRIPE_WEBHOOK_SECRET' ? '秘密' : value}> --context ${context}`); return; }
  // 値は引数で渡すが標準出力には出さない（stdio: ignore）
  execFileSync('netlify', ['env:set', name, value, '--context', context, '--force'], { stdio: 'ignore' });
  console.log(`  ✔ env ${name} を ${context} に設定`);
}

async function ensurePrices() {
  const out = {};
  for (const plan of STRIPE_PLANS) {
    const lookupKey = LOOKUP_KEY[plan.id];
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const existing = found.data[0];
    if (existing) {
      if (existing.unit_amount !== plan.amountYen || existing.currency !== 'jpy' || existing.recurring?.interval !== 'month') {
        die(`${lookupKey} の既存 Price（${existing.unit_amount} ${existing.currency}）が定義（¥${plan.amountYen}/月）と違います。Live の価格は編集せず、新しい lookup_key で作り直してください`);
      }
      console.log(`✔ Price ${plan.id}: 既存 ¥${existing.unit_amount}/月`);
      out[plan.id] = existing.id;
      continue;
    }
    console.log(`＋ Price ${plan.id}: ¥${plan.amountYen}/月 を作成${apply ? '' : '（下見）'}`);
    if (!apply) continue;
    const product = await stripe.products.create({
      name: `KEIBA Analytics ${plan.label}`,
      metadata: { ak_plan: plan.id },
      statement_descriptor: 'KEIBA ANALYTICS',
    });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'jpy',
      unit_amount: plan.amountYen,
      recurring: { interval: 'month', interval_count: 1 },
      lookup_key: lookupKey,
      tax_behavior: 'inclusive',
      metadata: { ak_plan: plan.id },
    });
    out[plan.id] = price.id;
  }
  return out;
}

async function ensurePortal(priceIds) {
  const products = [];
  for (const plan of STRIPE_PLANS) {
    if (!priceIds[plan.id]) continue;
    const price = await stripe.prices.retrieve(priceIds[plan.id]);
    products.push({ product: typeof price.product === 'string' ? price.product : price.product.id, prices: [price.id] });
  }
  const params = {
    business_profile: {
      headline: 'KEIBA Analytics お支払い管理',
      privacy_policy_url: 'https://analytics.keiba.link/privacy/',
      terms_of_service_url: 'https://analytics.keiba.link/terms/',
    },
    default_return_url: `${site}/dashboard/`,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: false },
      // 解約は期間の終わりで（それまでは閲覧できる）
      subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'unused', 'other'] } },
      // 中央版・南関版 ⇄ Premium の切替（差額は日割り）
      subscription_update: products.length === STRIPE_PLANS.length
        ? { enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations', products }
        : { enabled: false },
    },
    metadata: { ak: 'portal' },
  };
  if (!apply) { console.log('＋ カスタマーポータル設定（下見）'); return null; }
  const list = await stripe.billingPortal.configurations.list({ limit: 20 });
  const mine = list.data.find((c) => c.metadata?.ak === 'portal' && c.active);
  const conf = mine
    ? await stripe.billingPortal.configurations.update(mine.id, params)
    : await stripe.billingPortal.configurations.create(params);
  console.log(`✔ カスタマーポータル設定 ${mine ? '更新' : '作成'}`);
  return conf.id;
}

async function ensureWebhook() {
  const url = `${site}/.netlify/functions/stripe-webhook`;
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  const same = list.data.filter((w) => w.url === url);
  if (!apply) { console.log(`＋ Webhook ${url}（既存 ${same.length} 件・下見）`); return null; }
  // 署名鍵は作成時にしか取得できない。同じ URL の既存は消して作り直す（二重登録で片方が 400 になる事故を防ぐ）
  for (const w of same) await stripe.webhookEndpoints.del(w.id);
  const ep = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'analytics-keiba' });
  console.log(`✔ Webhook ${url}（${WEBHOOK_EVENTS.length} イベント・旧 ${same.length} 件を置換）`);
  return ep.secret;
}

const acct = await stripe.accounts.retrieve();
console.log(`Stripe: ${live ? 'LIVE' : 'TEST'} / アカウント ${acct.settings?.dashboard?.display_name || acct.business_profile?.name || '(名称未設定)'} / Netlify context: ${context} / ${apply ? '書き込み' : '下見'}`);

const priceIds = await ensurePrices();
const portalId = await ensurePortal(priceIds);
const webhookSecret = await ensureWebhook();

// ⚠️ Price ID・ポータル設定 ID は env に入れない（関数の環境変数が Lambda の 4KB を超え、
//    2026-10-02 に本番デプロイが全部失敗した）。コード（stripePlans.js の STRIPE_IDS）と一致するかだけ検査する。
const mode = live ? 'live' : 'test';
const mismatch = [];
for (const plan of STRIPE_PLANS) {
  if (priceIds[plan.id] && priceIds[plan.id] !== STRIPE_IDS[mode].prices[plan.id]) mismatch.push(`${plan.id}: Stripe=${priceIds[plan.id]} / コード=${STRIPE_IDS[mode].prices[plan.id]}`);
}
if (portalId && portalId !== STRIPE_IDS[mode].portalConfiguration) mismatch.push(`portal: Stripe=${portalId} / コード=${STRIPE_IDS[mode].portalConfiguration}`);
if (mismatch.length) {
  console.log(`✖ stripePlans.js の STRIPE_IDS.${mode} を次の値に更新して PR を出してください（ID は秘密ではない）:`);
  for (const m of mismatch) console.log(`  ${m}`);
} else {
  console.log(`✔ Price・ポータル設定の ID はコード（STRIPE_IDS.${mode}）と一致`);
}

console.log('Netlify env（秘密の 2 つだけ）:');
netlifySet('STRIPE_SECRET_KEY', key);
if (webhookSecret) netlifySet('STRIPE_WEBHOOK_SECRET', webhookSecret);
console.log(apply ? '完了（env の反映には再デプロイが必要）' : '下見のみ（--apply で書き込み）');
