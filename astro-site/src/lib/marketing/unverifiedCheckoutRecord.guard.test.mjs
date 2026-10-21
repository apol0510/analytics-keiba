/**
 * 未ログインの定期課金申込で作った「まだ無料のレコード」（メール本人確認前）へ、こちらからメールを送らない。
 *
 * 2026-10-21: 未ログインの申込は入力メールで会員を決め、該当が無ければ無料会員レコードを作る
 * （Source = paypal-subscription-checkout）。誰でも他人のアドレスを入力できるため、支払いで有料に
 * なるまでは全配信から外す。判定の単一源は unverifiedCheckoutRecord.js。
 *
 * このテストは
 *   1. 判定・formula・各単一源（メルマガ / マーケティング送信可否 / 送信直前の再確認）が除外すること
 *   2. **Customers を読む Function / ライブラリが全て分類済み**で、配信経路は除外を通っていること
 * を固定する。新しく Customers を読む Function を足したら、下の表へ分類を足さない限り落ちる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNVERIFIED_CHECKOUT_SOURCE, isUnverifiedCheckoutRecord, UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA, withUnverifiedCheckoutExcluded,
} from './unverifiedCheckoutRecord.js';
import { resolveSendability, resolveCustomerMarketing, MK_SUPPRESSION } from './customerMarketingAudience.js';
import { resolveAudienceRecipients } from '../newsletter/audience-resolver.js';
import { CHECKOUT_RECORD_SOURCE } from '../billing/paypal/paypalSubscriptionServer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const GUEST = { Email: 'someone@example.com', 'プラン': 'Free', Source: UNVERIFIED_CHECKOUT_SOURCE };
const PAID = { ...GUEST, 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2099-01-01' };
const FREE = { Email: 'free@example.com', 'プラン': 'Free', Source: 'nankan-analytics' };

test('判定: 申込で作ったまだ無料のレコードだけ。有料になったら外れる・他の Source は対象外', () => {
  assert.equal(CHECKOUT_RECORD_SOURCE, UNVERIFIED_CHECKOUT_SOURCE, '申込でレコードを作る値と除外する値が同じ単一源');
  assert.equal(isUnverifiedCheckoutRecord(GUEST), true);
  assert.equal(isUnverifiedCheckoutRecord({ ...GUEST, 'プラン': '' }), true);
  assert.equal(isUnverifiedCheckoutRecord({ ...GUEST, 'プラン': ' free ' }), true);
  assert.equal(isUnverifiedCheckoutRecord(PAID), false);
  assert.equal(isUnverifiedCheckoutRecord({ ...GUEST, 'プラン': 'Light' }), false);
  assert.equal(isUnverifiedCheckoutRecord(FREE), false);
  assert.equal(isUnverifiedCheckoutRecord(null), false);
});

test('formula: 除外を AND で足す（!= BLANK() を使わない）', () => {
  assert.match(UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA, /^NOT\(AND\(\{Source\} = 'paypal-subscription-checkout', OR\(\{プラン\} = BLANK\(\), LOWER\(\{プラン\}\) = 'free'\)\)\)$/);
  assert.equal(/!=\s*BLANK\(\)/.test(UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA), false);
  assert.equal(withUnverifiedCheckoutExcluded("{Email} != ''"), `AND({Email} != '', ${UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA})`);
  assert.equal(withUnverifiedCheckoutExcluded(''), UNVERIFIED_CHECKOUT_EXCLUSION_FORMULA);
});

test('マーケティング送信可否（キャンペーン・連続配信・DRM・無料体験・カムバックの単一源）: 送らない', () => {
  const s = resolveSendability({ fields: GUEST });
  assert.equal(s.sendable, false);
  assert.deepEqual(s.suppressionReasons, [MK_SUPPRESSION.UNVERIFIED_CHECKOUT]);
  assert.equal(resolveCustomerMarketing({ fields: GUEST, nowMs: Date.now() }).sendable, false);
  assert.equal(resolveSendability({ fields: PAID }).sendable, true, '支払い後は通常の会員');
  assert.equal(resolveSendability({ fields: FREE }).sendable, true, '通常の無料会員は変わらない');
});

test('メルマガ（send-newsletter / 予約 / キュー / step / プレビュー共通の宛先解決）: 送らない・件数を出す', () => {
  const records = [{ id: 'r1', fields: GUEST }, { id: 'r2', fields: FREE }, { id: 'r3', fields: PAID }];
  const r = resolveAudienceRecipients({ records, brand: 'analytics-keiba', audienceTypeFilter: '*', today: '2026-10-21' });
  assert.equal(r.emails.includes('someone@example.com'), true, '有料になった同じ Source は送る');
  const onlyGuest = resolveAudienceRecipients({ records: [{ id: 'r1', fields: GUEST }, { id: 'r2', fields: FREE }], brand: 'analytics-keiba', audienceTypeFilter: 'free', today: '2026-10-21' });
  assert.deepEqual(onlyGuest.emails, ['free@example.com']);
  assert.equal(onlyGuest.counts.unverifiedCheckoutExcluded, 1);
});

test('送信直前の再確認（marketing-campaign-dispatch）と予約の簡易件数（send-newsletter）も除外を通す', () => {
  const dispatch = strip(read('netlify/functions/marketing-campaign-dispatch.js'));
  assert.match(dispatch, /if \(isUnverifiedCheckoutRecord\(f\)\) suspended\.add\(e\);/);
  const nl = strip(read('netlify/functions/send-newsletter.js'));
  assert.match(nl, /quickFilterFormula = withUnverifiedCheckoutExcluded\(quickFilterFormula\);\s*const quickCheckUrl/);
});

test('申込でレコードを作るときは何も送らない（ポイント・BlastMail・ステップ配信・ウェルカム通知を呼ばない）', () => {
  const s = strip(read('src/lib/billing/paypal/paypalSubscriptionServer.js'));
  const i = s.indexOf('async function resolveCheckoutRecord'); const j = s.indexOf('export async function createPaypalSubscription');
  const body = s.slice(i, j);
  assert.match(body, /at\.create\(\{ Email: email, 'プラン': 'Free', Source: CHECKOUT_RECORD_SOURCE \}\)/);
  assert.equal(/notify\(|BlastMail|enroll|user-notification|sendMail|sendEmail|mail\/send|fetch\(|ポイント/.test(body), false, 'レコード作成に通知・配信を足さない');
});

// ── Customers を読む全経路の分類 ───────────────────────────────────────────
// covered … 除外を通る単一源を使う（RE が本文に必要）
// structural … 条件で構造的に当たらない（有料のみ・取り込みコホートのみ・決済メールの印のみ。RE で条件を確かめる）
// transactional … 操作した本人 / 管理者が名指しした 1 人 / 管理者宛だけ（宛先を Customers から選ばない）
// noMail … メールを送らない（MAIL が本文に無いことを確かめる）
const MAIL = /v3\/mail\/send|singlesends|\bsendEmail\s*\(|\bsendMail\s*\(|ScheduledEmails|sgMail|registerToBlastMail/;
const COVERED = /resolveAudienceRecipients\(|countAudience\(|resolveCustomerMarketing\(|isUnverifiedCheckoutRecord\(|withUnverifiedCheckoutExcluded\(/;
const FUNCTIONS = {
  'admin-marketing.js': ['covered', COVERED],
  'cron-campaign-sequence.js': ['covered', COVERED],
  'cron-drm-autostart.js': ['covered', COVERED],
  'marketing-campaign-dispatch.js': ['covered', /isUnverifiedCheckoutRecord\(f\)/],
  'send-newsletter.js': ['covered', COVERED],
  'create-newsletter-queue.js': ['covered', COVERED],
  'enqueue-step-emails.js': ['covered', COVERED],
  'execute-scheduled-emails-background.js': ['covered', COVERED],
  'newsletter-preview.js': ['covered', COVERED],
  'step-due-preview.js': ['covered', COVERED],
  'step-email-preview.js': ['covered', COVERED],
  'cron-light-trial-grant.js': ['structural', /runLightTrialGrant|loadAndPlanLightTrial/, '取り込みコホート（Source 接頭辞）だけ＋lightTrialPlanLoader で resolveCustomerMarketing'],
  'expiry-notification.js': ['structural', /\{プラン\} != 'Free'/, '有料プランの期限切れだけ'],
  'expiry-warning-notification.js': ['structural', /\{プラン\} != 'Free'/, '有料プランの期限前だけ'],
  'auth-user.js': ['transactional', null, '本人のログイン・無料登録（入力した本人のメール）'],
  'bank-transfer-application.js': ['transactional', null, '振込報告をした本人と管理者'],
  'confirm-bank-payment.js': ['transactional', null, '管理者が入金確認した本人'],
  'offer-application.js': ['transactional', null, 'オファー経由で振込報告をした本人と管理者'],
  'premium-plus-contact.js': ['transactional', null, '問い合わせた本人と管理者'],
  'request-email-change.js': ['transactional', null, '変更を申請した本人'],
  'send-magic-link.js': ['transactional', null, 'ログインリンクを求めた本人'],
  'send-payment-confirmation-auto.js': ['transactional', null, '入金確認済み（Status=active）の本人'],
  'send-payment-confirmation.js': ['transactional', null, '入金確認済みの本人'],
  'admin-canary-payment-email.js': ['transactional', null, '決済メールのカナリア（テストレコード 1 件）'],
  'admin-proxy-payment-notice.js': ['transactional', null, '管理者が名指しした 1 人'],
  'stripe-create-checkout.js': ['noMail'], 'stripe-portal.js': ['noMail'],
  'admin-campaign.js': ['noMail'], 'admin-comeback-grants.js': ['noMail'], 'admin-customer-import-job.js': ['noMail'],
  'admin-customer-import-run.js': ['noMail'], 'admin-customer-import.js': ['noMail'], 'admin-marketing-automation.js': ['noMail'],
  'admin-marketing-prospect.js': ['noMail'], 'claim-reward.js': ['noMail'], 'confirm-email-change.js': ['noMail'],
  'cron-prospect-worker.js': ['noMail'], 'daily-points.js': ['noMail'], 'domain-protection.js': ['noMail'],
  'fix-free-plantype.js': ['noMail'], 'get-customer-stats.js': ['noMail'], 'migrate-customers-plantype.js': ['noMail'],
  'premium-plus-eligibility.js': ['noMail'], 'refresh-session.js': ['noMail'], 'reset-all-plantype.js': ['noMail'],
  'sendgrid-webhook.js': ['noMail'], 'test-all-customers.js': ['noMail'], 'test-expiry-warning.js': ['noMail'],
  'unsubscribe.js': ['noMail'], 'verify-magic-link.js': ['noMail'],
};
const LIBS = {
  'src/lib/comeback/lightTrialPlanLoader.js': ['covered', COVERED],
  'src/lib/marketing/handoffQueueProof.js': ['covered', COVERED],
  'src/lib/marketing/nativeMemberMailAudit.js': ['covered', COVERED],
  'src/lib/marketing/lightRenewal/lightRenewalRunner.js': ['structural', /LOWER\(\{プラン\}\)='light'/, 'Light 有料会員の更新案内だけ（Premium の更新案内も同じ runner に有料の formula を渡す）'],
  'src/lib/payments/paymentEmailDeps.js': ['structural', /\{PaymentEmailStatus\} = 'pending'/, '入金確認で決済メールの印が付いた人だけ'],
  'src/lib/premiumPlus/premiumPlusMail.js': ['transactional', null, 'Premium Plus を購入した本人'],
  'src/lib/billing/stripeServer.js': ['noMail'], 'src/lib/marketing/customerTimeline.js': ['noMail'],
  'src/lib/marketing/lightRenewal/lightRenewalReport.js': ['noMail'], 'src/lib/marketing/step1Preflight.js': ['noMail', /ScheduledEmails/],
  'src/lib/newsletter/airtable-fetch.js': ['noMail'], 'src/lib/ops/airtableCapacityWatch.js': ['noMail', /ScheduledEmails/],
  'src/lib/ops/paymentFunnelCheck.js': ['noMail'], 'src/lib/ops/paypalFirstPurchaseCheck.js': ['noMail'],
  'src/lib/ops/premiumConversionCheck.js': ['noMail'], 'src/lib/premiumPlus/purchaseAnchorLookup.js': ['noMail'],
  'src/lib/unsubscribe/akMarketingGroupBridge.js': ['noMail'],
};

function check(rel, code, entry) {
  assert.ok(entry, `${rel} は Customers を読むが分類が無い。配信するなら unverifiedCheckoutRecord（または resolveSendability / resolveAudienceRecipients）を通し、この表へ足すこと`);
  const [kind, re] = entry;
  if (kind === 'covered' || kind === 'structural') assert.match(code, re, `${rel}: ${kind} の根拠が本文に無い`);
  if (kind === 'noMail') {
    const m = code.match(MAIL);
    // ScheduledEmails 等の語を「読むだけ」で使う純粋モジュールは、分類で許した語だけ通す
    assert.ok(!m || (re && re.test(m[0])), `${rel}: noMail なのに送信の呼び出しがある（${m && m[0]}）`);
  }
}

test('Customers を読む Function は全て分類済みで、配信経路は除外を通っている', () => {
  const dir = path.join(ROOT, 'netlify/functions');
  const seen = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const code = strip(readFileSync(path.join(dir, f), 'utf8'));
    if (!/Customers|CUSTOMERS_TABLE/.test(code)) continue;
    seen.push(f);
    check(`netlify/functions/${f}`, code, FUNCTIONS[f]);
  }
  assert.ok(seen.length >= 40, `検出が少なすぎる（${seen.length}）`);
  for (const f of Object.keys(FUNCTIONS)) assert.ok(seen.includes(f), `分類表の ${f} が見つからない（名前を変えたら表も直す）`);
});

test('Customers を読むライブラリも全て分類済み', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const seen = [];
  for (const p of walk(path.join(ROOT, 'src/lib')).filter((x) => x.endsWith('.js') && !/\.test\.|fake|__fixtures__/.test(x))) {
    const code = strip(readFileSync(p, 'utf8'));
    if (!/CUSTOMERS_TABLE|['"`/]Customers['"`?/]/.test(code)) continue;
    const rel = path.relative(ROOT, p);
    seen.push(rel);
    check(rel, code, LIBS[rel]);
  }
  for (const f of Object.keys(LIBS)) assert.ok(seen.includes(f), `分類表の ${f} が見つからない`);
  // Premium の更新案内は Light と同じ runner に有料プランの formula を渡す
  assert.match(read('src/lib/marketing/premiumRenewal/premiumRenewalRunner.js'), /CANDIDATE_FORMULA = "AND\(OR\(LOWER\(\{プラン\}\)='premium'/);
});
