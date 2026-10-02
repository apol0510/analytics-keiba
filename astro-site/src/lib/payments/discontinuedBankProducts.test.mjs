// 2026-10-02 MK 確定: Light 新規募集停止・Premium 月払いの銀行振込停止（サーバー側 fail closed）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideBankProductAvailability, isPaidLightMember, DISCONTINUED_CODE } from './discontinuedBankProducts.js';

test('Premium 月払いの銀行振込は受け付けない（月額は Stripe）', () => {
  const d = decideBankProductAvailability({ planName: 'Premium', planType: 'Monthly', fields: null });
  assert.equal(d.ok, false);
  assert.equal(d.code, DISCONTINUED_CODE.PREMIUM_MONTHLY);
});

test('Premium 年払い・買い切り・三連複は従来どおり受け付ける', () => {
  for (const [p, t] of [['Premium', 'Annual'], ['Premium', 'Lifetime'], ['Premium Sanrenpuku', 'Lifetime']]) {
    assert.equal(decideBankProductAvailability({ planName: p, planType: t, fields: null }).ok, true, `${p}/${t}`);
  }
});

test('Light: 新規（未登録・無料・期限切れ無料・無償付与）は受け付けない', () => {
  for (const fields of [
    null,
    { 'プラン': 'Free' },
    { 'プラン': 'Light' }, // 支払い実績なし（無償付与 / 永久無料の Light）
    { 'プラン': 'Free', LightGrantUntil: '2099-01-01', PaidAt: '' },
  ]) {
    const d = decideBankProductAvailability({ planName: 'Light', planType: 'Monthly', fields });
    assert.equal(d.ok, false, JSON.stringify(fields));
    assert.equal(d.code, DISCONTINUED_CODE.LIGHT_NEW);
  }
});

test('Light: 既存の有料 Light 会員の更新・再開は受け付ける（期限切れ後の再開も）', () => {
  assert.equal(decideBankProductAvailability({ planName: 'Light', planType: 'Monthly', fields: { 'プラン': 'Light', PaidAt: '2026-09-01T00:00:00Z', '有効期限': '2026-10-01' } }).ok, true);
  assert.equal(isPaidLightMember({ 'プラン': 'Standard', PaidAt: 'x' }), true);
});

test('Light: 会員の確認ができないときは受け付けない（fail closed）', () => {
  const d = decideBankProductAvailability({ planName: 'Light', planType: 'Monthly', fields: null, lookupFailed: true });
  assert.equal(d.code, DISCONTINUED_CODE.LIGHT_UNVERIFIED);
});

test('申込 Function は判定をメール送信・Airtable 書き込みより前に行い、止めたら 409 で返す', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url)), 'utf8');
  const gate = src.indexOf('decideBankProductAvailability({');
  assert.ok(gate > 0);
  for (const effect of ["fetch('https://api.sendgrid.com/v3/mail/send'", "method: 'PATCH'", "method: 'POST',\n", 'createReservation(', 'recordOrderOnApplication(']) {
    const at = src.indexOf(effect);
    assert.ok(at === -1 || gate < at, `${effect.trim()} が判定より前にある`);
  }
  assert.match(src.slice(gate, gate + 600), /statusCode: 409/);
});
