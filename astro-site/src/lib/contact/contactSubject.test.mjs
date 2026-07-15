/**
 * contactSubject.test.mjs — 会員種別ラベル / 管理メール件名の組み立て検証
 *   node --test src/lib/contact/contactSubject.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberLabel, buildAdminContactSubject } from './contactSubject.js';

test('会員種別（Airtable プラン）に応じたラベル（別名・日本語・大小も正規化）', () => {
  assert.equal(resolveMemberLabel({ plan: 'Premium' }), 'Premium 会員');
  assert.equal(resolveMemberLabel({ plan: 'プレミアム' }), 'Premium 会員');
  assert.equal(resolveMemberLabel({ plan: 'premium-sanrenpuku' }), 'Premium Sanrenpuku 会員');
  assert.equal(resolveMemberLabel({ plan: 'プレミアムプラス' }), 'Premium Plus 会員');
  assert.equal(resolveMemberLabel({ plan: 'Light' }), 'Light 会員');
  assert.equal(resolveMemberLabel({ plan: 'standard' }), 'Light 会員'); // 旧 standard→light
  assert.equal(resolveMemberLabel({ plan: '無料' }), '無料会員');
});

test('plan 不明（未登録・取得失敗）→ formType でフォールバック（Premium Plus 固定にしない）', () => {
  assert.equal(resolveMemberLabel({ plan: null, formType: 'premium-predictions-contact' }), 'プレミアム会員');
  assert.equal(resolveMemberLabel({ plan: undefined, formType: 'premium-plus-contact' }), 'Premium Plus');
  assert.equal(resolveMemberLabel({ plan: 'garbage-value', formType: 'premium-predictions-contact' }), 'プレミアム会員');
});

test('plan も formType も不明 → 会員種別不明', () => {
  assert.equal(resolveMemberLabel({}), '会員種別不明');
  assert.equal(resolveMemberLabel({ plan: 'xyz', formType: 'unknown-form' }), '会員種別不明');
});

test('管理メール件名・見出しの組み立て', () => {
  const r = buildAdminContactSubject({ plan: 'Premium', formType: 'premium-predictions-contact', subject: '買い目について', email: 'a@example.com' });
  assert.equal(r.memberLabel, 'Premium 会員');
  assert.equal(r.heading, 'Premium 会員 お問い合わせ');
  assert.equal(r.adminSubject, '【Premium 会員 お問い合わせ】買い目について - a@example.com');
});

test('件名/メール欠落時の安全な既定値', () => {
  const r = buildAdminContactSubject({ plan: 'premium-sanrenpuku' });
  assert.equal(r.adminSubject, '【Premium Sanrenpuku 会員 お問い合わせ】（件名なし） - (no-email)');
});

test('回帰: 一般モーダル由来の Premium 会員は Premium Plus 扱いにならない（今回の事故ケース）', () => {
  // Airtable プラン=Premium が取れた場合
  const withPlan = buildAdminContactSubject({ plan: 'Premium', formType: 'premium-predictions-contact', subject: '質問', email: 'member@example.com' });
  assert.equal(withPlan.memberLabel, 'Premium 会員');
  assert.ok(!withPlan.adminSubject.includes('Premium Plus'), 'Premium Plus を含めない');
  // Airtable が取れなくても formType フォールバックで Premium Plus にはならない
  const noPlan = buildAdminContactSubject({ plan: null, formType: 'premium-predictions-contact', subject: '質問', email: 'member@example.com' });
  assert.ok(!noPlan.adminSubject.includes('Premium Plus'), 'フォールバックでも Premium Plus を含めない');
  // 本物の premium-plus ページ由来（Sanrenpuku 会員）は会員種別で正しくラベル
  const realSanrenpuku = buildAdminContactSubject({ plan: 'premium-sanrenpuku', formType: 'premium-plus-contact', subject: 'Premium Plus について', email: 'member@example.com' });
  assert.equal(realSanrenpuku.memberLabel, 'Premium Sanrenpuku 会員');
});
