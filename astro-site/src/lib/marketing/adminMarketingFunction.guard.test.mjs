/**
 * adminMarketingFunction.guard.test.mjs — Function 本体の安全条件をソースで固定する
 *   node --test src/lib/marketing/adminMarketingFunction.guard.test.mjs
 *
 * ここで守るのは「実装を後から書き換えても壊せない」性質:
 *   1. この Function は自分でメールを送らない（SendGrid を呼ばない）
 *   2. Customers を書き換えない（PATCH/POST/DELETE の対象にしない）
 *   3. KMA（keiba-marketing-automation）のテーブル・env を使わない
 *   4. 決済メール v2 / 権限 / Premium Plus 販売資格のフィールドを書かない
 *   5. live 送信は env で二重に閉じている（既定 OFF）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MK_FORBIDDEN_CUSTOMER_FIELDS } from './campaignSend.js';

const fnPath = fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url));
const src = readFileSync(fnPath, 'utf8');
/** コメントを除いた実コード（説明文で guard が誤検知しないようにする） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('1. メール送信 API を呼ばない（送信は既存の送信基盤に委譲する）', () => {
  for (const banned of ['sendgrid', 'api.sendgrid.com', 'mail/send', '@sendgrid', 'nodemailer', 'resend.com']) {
    assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false, `${banned} を呼んでいる`);
  }
  assert.equal(code.includes('SENDGRID_API_KEY'), false, 'SendGrid の鍵を読んでいる');
});

test('2. Customers を書き換えない（GET 以外の対象にしない）', () => {
  // Customers テーブルを指す URL が PATCH / POST / DELETE と同じ fetch 呼び出しに現れないこと
  const writeCalls = [...code.matchAll(/method:\s*'(PATCH|POST|DELETE|PUT)'/g)];
  assert.ok(writeCalls.length > 0, '書き込み経路が消えている（テストの前提が壊れた）');
  // 書き込みヘルパーは CampaignDeliveries / ScheduledEmails のみを対象にする
  const writeTargets = [...code.matchAll(/\$\{encodeURIComponent\(table\)\}|\$\{DELIVERIES_TABLE\}/g)];
  assert.ok(writeTargets.length > 0);
  assert.equal(/CUSTOMERS_TABLE[^\n]*method/.test(code), false);
  // createRecord / upsert に Customers を渡している箇所が無いこと
  assert.equal(/table:\s*CUSTOMERS_TABLE[\s\S]{0,200}?method/.test(code), false, 'Customers を書き込み経路へ渡している');
  for (const m of code.matchAll(/createRecord\(\{[^}]*table:\s*([A-Za-z_]+)/g)) {
    assert.notEqual(m[1], 'CUSTOMERS_TABLE', 'Customers を createRecord へ渡している');
  }
});

test('3. KMA のテーブル / env を使わない（統合しない）', () => {
  for (const banned of [
    'CampaignDeliveries_MarketingAutomation', 'CampaignDeliveries_M5A3LiveTest',
    'MARKETING_AUTOMATION', 'keiba-marketing-automation', 'KMA_',
  ]) {
    assert.equal(code.includes(banned), false, `KMA の資産 ${banned} を参照している`);
  }
  assert.ok(code.includes("DELIVERIES_TABLE = 'CampaignDeliveries'"), 'AK 自身の台帳を使っていない');
});

test('4. 決済 / 権限 / Premium Plus 販売資格のフィールドを書かない（読み取りは可）', () => {
  // 書き込み payload は `fields: { ... }` リテラルだけ。その中身に禁止名が無いことを見る。
  // （表示のために プラン / PremiumPlusEligibility を **読む** のは正当なので全文検索はしない）
  const payloads = [...code.matchAll(/fields:\s*\{([\s\S]*?)\n\s{6}\},/g)].map((m) => m[1]);
  assert.ok(payloads.length > 0, '書き込み payload を検出できない（テストの前提が壊れた）');
  for (const p of payloads) {
    // 「キーとして」現れていないかを見る（TargetPlan のような別カラムに部分一致させない）
    const keys = [...p.matchAll(/(?:^|[\s,{])'?([A-Za-z_぀-ヿ一-龯]+)'?\s*:/gm)].map((m) => m[1]);
    for (const f of MK_FORBIDDEN_CUSTOMER_FIELDS) {
      if (f === 'Status') continue; // ScheduledEmails / CampaignDeliveries 自身の列
      assert.equal(keys.includes(f), false, `書き込み payload に禁止フィールド ${f} がある`);
    }
    // ScheduledEmails の Status は PENDING（送信基盤へ渡すキュー状態）のみ
    if (p.includes('Status:')) {
      assert.ok(/Status:\s*'(PENDING|queued)'/.test(p), '想定外の Status を書いている');
    }
  }
  // Premium Plus の販売資格判定モジュールを import していない（販売と販促の分離）
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const i of imports) assert.equal(i.includes('premiumPlus'), false, `${i} を import している`);
});

test('5. live 送信は既定 OFF（env が無ければ書き込みへ到達しない）', () => {
  assert.ok(code.includes("MARKETING_CAMPAIGN_ENABLED === 'true'"), 'live gate が無い');
  assert.ok(code.includes('isMarketingSendEnabled(process.env)'), 'live gate を使っていない');
  // gate 判定より前に書き込みが起きないこと（gate → 書き込みの順序）
  const gateIdx = code.indexOf('if (live && !isMarketingSendEnabled');
  const writeIdx = Math.min(
    ...['upsertDeliveries(', 'createRecord('].map((s) => {
      const i = code.indexOf(s, code.indexOf('async function handlePlan'));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  assert.ok(gateIdx > 0 && gateIdx < writeIdx, 'live gate が書き込みより後ろにある');
});

test('6. send は dry-run の確認トークン必須（TOCTOU 防止）', () => {
  assert.ok(code.includes('planFingerprint'), '確認トークンを使っていない');
  assert.ok(/token\s*!==\s*plan\.planFingerprint/.test(code), 'トークン照合が無い');
  assert.ok(code.includes('409'), '不一致時に中止していない');
});

test('7. 冪等 upsert のマージキーが DeliveryKey である', () => {
  assert.ok(code.includes("fieldsToMergeOn: ['DeliveryKey']"), 'DeliveryKey で冪等化していない');
});

test('8. 認可がある（secret 未設定なら機能無効）', () => {
  assert.ok(code.includes('x-admin-secret'), '認可ヘッダを見ていない');
  assert.ok(code.includes('return json(403'), '不一致で 403 にしていない');
  assert.ok(/if \(!SECRET\) return json\(503/.test(code), 'secret 未設定で無効化していない');
});

test('9. secret やレコード内容をログへ出さない', () => {
  const logs = [...code.matchAll(/console\.(log|error|warn)\(([^\n]*)/g)].map((m) => m[2]);
  for (const l of logs) {
    for (const banned of ['SECRET', 'KEY', 'provided', 'fields', 'email', 'Email']) {
      assert.equal(l.includes(banned), false, `ログに ${banned} を出している: ${l.slice(0, 80)}`);
    }
  }
});

test('10. モジュールとして読み込める（handler が公開されている）', async () => {
  const mod = await import(fnPath);
  assert.equal(typeof mod.handler, 'function');
  assert.equal(mod.isMarketingSendEnabled({}), false, 'env 未設定で送信が有効になっている');
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: 'false' }), false);
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: '1' }), false, "'true' 以外は無効");
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: 'true' }), true);
  assert.equal(mod.isDispatchEnabled({}), false);
  assert.equal(mod.isDispatchEnabled({ NEWSLETTER_AUTOMATION_ENABLED: 'true' }), true);
});
