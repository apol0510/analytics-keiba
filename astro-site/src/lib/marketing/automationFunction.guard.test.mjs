/**
 * automationFunction.guard.test.mjs — 自動化 Function の境界を構造で固定する
 *   node --test src/lib/marketing/automationFunction.guard.test.mjs
 *
 * 「動いたときに何をするか」だけでなく、**できないこと**を構造で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const FN = read('../../../netlify/functions/admin-marketing-automation.js');
const CATALOG = read('./automationCatalog.js');
const MODEL = read('./automationModel.js');
const ELIG = read('./automationEligibility.js');
const ADMIN_MARKETING = read('../../../netlify/functions/admin-marketing.js');

const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ── メールを送らない / 送信経路は 1 つ ────────────────────────

test('guard: 自動化 Function は SendGrid の送信 API を持たない', () => {
  const code = codeOnly(FN);
  for (const bad of ['mail/send', '@sendgrid/mail', 'sendgrid.com/v3/mail', 'sgMail']) {
    assert.equal(code.includes(bad), false, `送信経路がある: ${bad}`);
  }
});

test('guard: 新しい配信基盤を作らない（既存 dispatcher に乗る）', () => {
  const code = codeOnly(FN);
  // 自動化はキュー登録の実装を持たない。既存 admin-marketing / dispatcher が担う
  assert.equal(/ScheduledEmails/.test(code), false, '自動化が独自にキューを作っている');
  assert.equal(/CampaignDeliveries/.test(code), false, '自動化が独自に配信台帳へ書いている');
  // 既存経路が唯一の enqueue 実装であることを確認（前提が変わったら気付く）
  assert.match(ADMIN_MARKETING, /ScheduledEmails/, '既存の enqueue 実装が見つからない');
});

test('guard: 送信ゲートは既存の MARKETING_CAMPAIGN_DISPATCH_ENABLED を使う', () => {
  assert.match(MODEL, /MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true'/, '送信ゲートを見ていない');
  // 自動化のためだけの新しい送信ゲートを増やしていない
  const envs = [...MODEL.matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envs)].sort(), ['MARKETING_CAMPAIGN_DISPATCH_ENABLED']);
});

test('guard: 旧送信経路（NEWSLETTER_AUTOMATION_ENABLED）を巻き込まない', () => {
  for (const [name, src] of [['FN', FN], ['MODEL', MODEL], ['ELIG', ELIG], ['CATALOG', CATALOG]]) {
    assert.equal(src.includes('NEWSLETTER_AUTOMATION_ENABLED'), false,
      `${name} が既存メール経路のマスタースイッチを参照している`);
  }
});

// ── Customers を変えない ──────────────────────────────────────

test('guard: Airtable へ GET しか出さない（会員状態を変えない）', () => {
  const code = codeOnly(FN);
  // ⚠️ Redis(Upstash REST) は POST を使うので、**Airtable URL 近傍の書き込み**だけを見る
  assert.equal(/api\.airtable\.com[\s\S]{0,200}?method:\s*'(POST|PATCH|PUT|DELETE)'/.test(code), false,
    'Airtable への書き込み経路がある');
  for (const bad of ["method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'"]) {
    assert.equal(code.includes(bad), false, `書き込み経路がある: ${bad}`);
  }
  assert.match(code, /api\.airtable\.com/, 'Airtable 読み取りが無い');
});

test('guard: 昇格・決済・特典フィールドを書かない', () => {
  // ⚠️ 語の出現ではなく**書き込みの形**で見る。設計メモの文中に
  //    フィールド名が出るのは説明であって書き込みではない。
  const API = read('./automationAdminApi.js');
  const code = codeOnly(FN) + codeOnly(MODEL) + codeOnly(ELIG) + codeOnly(CATALOG) + codeOnly(API);
  for (const f of ['PaymentConfirmed', 'PlanType', 'PaidAt', 'LightGrantUntil', 'PremiumGrantUntil',
    'LifetimeSanrenpuku', 'LightGrantOp', 'PremiumGrantOp', '有効期限']) {
    // オブジェクトのキーとして書いている / fields へ代入している形を検知する
    const asKey = new RegExp(`['"\`]?${f}['"\`]?\\s*:`);
    assert.equal(asKey.test(code), false, `${f} を書き込みの形で扱っている`);
    const asAssign = new RegExp(`fields\\[['"\`]${f}['"\`]\\]\\s*=`);
    assert.equal(asAssign.test(code), false, `${f} へ代入している`);
  }
  // Airtable への書き込み HTTP メソッドを持たない
  // （Redis(Upstash REST) の POST は別物なので Airtable URL 近傍だけを見る）
  assert.equal(
    /api\.airtable\.com[\s\S]{0,200}?method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(codeOnly(FN)),
    false, 'Airtable への書き込み経路がある',
  );
});

test('guard: 純粋モジュールは I/O を持たない', () => {
  for (const [name, src] of [['MODEL', MODEL], ['ELIG', ELIG], ['CATALOG', CATALOG]]) {
    const code = codeOnly(src);
    assert.equal(code.includes('fetch('), false, `${name} が I/O を持っている`);
    assert.equal(code.includes('process.env'), false, `${name} が env を直接読んでいる`);
  }
});

// ── KMA を持ち込まない ────────────────────────────────────────

test('guard: KMA の名称・tenant・env・送信元・台帳が混入していない', () => {
  const all = FN + CATALOG + MODEL + ELIG;
  for (const bad of [
    'keiba-marketing-automation', 'KMA_', 'kma_', 'tenantId', 'tenant_id', 'TENANT',
    '_MarketingAutomation', 'MarketingAutomationTenant',
  ]) {
    assert.equal(all.includes(bad), false, `KMA 由来の識別子が混入: ${bad}`);
  }
  // 送信元は AK 既存の設定を使う（自動化が独自の from を持たない）
  assert.equal(/from(Email)?\s*[:=]\s*['"][^'"]*@/.test(codeOnly(all)), false, '独自の送信元アドレスを持っている');
});

test('guard: 使う env は AK 既存のものだけ', () => {
  const envs = [...FN.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envs)].sort(), [
    'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID',
    'MARKETING_ADMIN_SECRET', 'PREMIUM_PLUS_ADMIN_SECRET',
    'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
  ], '新しい env を要求している');
  // write ゲートは定数名として参照する（値は API モジュール側で判定）
  assert.match(FN, /WRITE_GATE_ENV/);
});

// ── 判定は既存 AK の正本を通す ────────────────────────────────

test('guard: 配信可否は既存の単一源を使う（再実装しない）', () => {
  assert.match(ELIG, /from '\.\/customerMarketingAudience\.js'/, '既存の配信可否判定を使っていない');
  assert.match(ELIG, /resolveCustomerMarketing\(/);
  // 除外条件をローカルに再実装していない
  const code = codeOnly(ELIG);
  for (const bad of ['UnsubscribedAnalyticsKeiba', 'EmailBlacklist', 'AccountStatus']) {
    assert.equal(code.includes(bad), false, `除外判定を再実装している: ${bad}`);
  }
});

test('guard: JST 暦日の差は既存の単一源を使う', () => {
  assert.match(MODEL, /import \{ jstDayDiff \} from '\.\/customerMarketingAudience\.js'/);
  assert.equal(/export function jstDayDiff/.test(MODEL), false, 'jstDayDiff を再実装している');
});

// ── Phase A の範囲 ────────────────────────────────────────────

test('guard: プリセットは全て初期 OFF（コードから緩められない）', () => {
  assert.match(CATALOG, /enabled: false/);
  assert.match(MODEL, /enabled: false,\s*\/\/ ⚠️ 常に OFF から始まる/);
  // 定義生成は必ず DRAFT から始まる
  assert.match(MODEL, /status: AUTOMATION_STATUS\.DRAFT/);
});

test('guard: write action は配線済みだが production ゲートで塞がれる', () => {
  // Phase B で enable/run/cancel は create/activate/pause/cancel として配線した。
  // **未配線ではなく、ゲートで塞ぐ**方式へ変えたので、そちらを固定する。
  assert.match(FN, /WRITE_ACTIONS\.includes\(action\) && !isWriteEnabled\(process\.env\)/);
  assert.match(FN, /code: 'write_blocked'/);
  assert.match(FN, /json\(403,/);
});

test('guard: preview は副作用なしと明示する', () => {
  const API = read('./automationAdminApi.js');
  const i = API.indexOf('async preview(');
  const body = API.slice(i, API.indexOf('async runs(', i));
  assert.match(body, /sideEffects: 'none'/);
  assert.match(body, /dryRun: true/);
});

test('guard: 全 action で管理シークレット必須', () => {
  const secretAt = FN.indexOf('provided !== SECRET');
  const dispatch = FN.indexOf("if (action === 'list')");
  assert.ok(secretAt > -1 && secretAt < dispatch, '認証が dispatch より後ろ');
});

test('guard: 例外の中身を応答へ返さない', () => {
  const c = FN.slice(FN.indexOf('} catch (e) {', FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

test('guard: 応答にアドレスを含めない（件数と理由コードだけ）', () => {
  const API = read('./automationAdminApi.js');
  const i = API.indexOf('async preview(');
  const body = API.slice(i, API.indexOf('async runs(', i));
  // recipients（アドレスを含む配列）をそのまま返していない
  assert.equal(/recipients:\s*audience\.recipients/.test(body), false, 'アドレス配列を返している');
  assert.match(body, /件数: audience\.counts/);
  assert.match(body, /除外理由: audience\.skipped/);
});

// ── 画面 ──────────────────────────────────────────────────────

const PAGE = read('../../pages/admin/premium-plus-eligibility.astro');
const SECTION_AT = PAGE.indexOf('aria-labelledby="autoH"');
const AUTO_SECTION = PAGE.slice(SECTION_AT, PAGE.indexOf('</section>', SECTION_AT));

test('guard(ui): 自動配信の画面がある', () => {
  assert.ok(SECTION_AT > -1, '自動配信セクションが無い');
  assert.ok(AUTO_SECTION.length > 200);
});

test('guard(ui): 管理者が画面だけで設定と影響を確認できる', () => {
  for (const label of ['プリセット', '状態', '次回実行日時', '対象予定人数', '母数', '除外',
    '最大件数', 'quiet hours', 'campaign', 'contentHash', '最終実行結果']) {
    assert.ok(AUTO_SECTION.includes(label), `画面に「${label}」が無い`);
  }
});

test('guard(ui): 保存系ボタンは既定で無効（本番未有効）', () => {
  for (const id of ['autoSave', 'autoActivate', 'autoPause', 'autoCancel']) {
    const i = AUTO_SECTION.indexOf(`id="${id}"`);
    assert.ok(i > -1, `${id} が無い`);
    const btn = AUTO_SECTION.slice(i, i + 160);
    assert.match(btn, /disabled/, `${id} が既定で有効`);
    assert.match(btn, /aria-disabled="true"/);
  }
});

test('guard(ui): 初期 OFF と「送らない」ことを明記する', () => {
  for (const phrase of ['すべて OFF', '自動実行されません', '1 通も送らず', '会員状態・決済・特典は一切変更しません',
    '既存の 1 本だけ', '本番自動配信は未有効']) {
    assert.ok(AUTO_SECTION.includes(phrase), `画面に「${phrase}」が無い`);
  }
});

test('guard(ui): 画面へアドレス・氏名を出さない', () => {
  for (const bad of ['RecipientEmail', 'recordId', 'recipients', '氏名']) {
    assert.equal(AUTO_SECTION.includes(bad), false, `${bad} を出している`);
  }
});

test('guard(ui): 画面は自動化 API だけを叩く（送信 API を叩かない）', () => {
  assert.match(PAGE, /const AUTO_API = '\/\.netlify\/functions\/admin-marketing-automation'/);
  const i = PAGE.indexOf('const AUTO_API');
  const body = PAGE.slice(i, PAGE.indexOf("$('autoPreview')", i) + 4000);
  for (const bad of ['send-newsletter', 'marketing-campaign-dispatch', 'execute-scheduled-emails']) {
    assert.equal(body.includes(bad), false, `画面が送信系 API を叩いている: ${bad}`);
  }
});
