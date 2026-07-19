/**
 * contact-autofill.test.js
 *
 * お問い合わせ自動入力ヘルパ（src/lib/contact-autofill.js）の堅牢性テスト。
 * JSON 破損 / キー欠落 / null / 配列 / 不正な型でも例外を投げず空を返すことを固定する。
 *
 * 実行: node src/lib/contact-autofill.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { parseLoggedInContact, getLoggedInContact, normalizeContactName } from './contact-autofill.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const fakeStorage = (val) => ({ getItem: (k) => (k === 'user-plan' ? val : null) });

// --- parseLoggedInContact ---
t('正常な user-plan から name/email を取り出す', () => {
  const r = parseLoggedInContact(JSON.stringify({ email: 'a@example.com', name: '山田 太郎', plan: 'premium' }));
  assert.strictEqual(r.name, '山田 太郎');
  assert.strictEqual(r.email, 'a@example.com');
});

t('前後空白は trim される', () => {
  const r = parseLoggedInContact(JSON.stringify({ email: '  a@example.com  ', name: '  太郎  ' }));
  assert.strictEqual(r.name, '太郎');
  assert.strictEqual(r.email, 'a@example.com');
});

t('null / 空文字 / 非文字列 raw は空を返す', () => {
  assert.deepStrictEqual(parseLoggedInContact(null), { name: '', email: '' });
  assert.deepStrictEqual(parseLoggedInContact(''), { name: '', email: '' });
  assert.deepStrictEqual(parseLoggedInContact(undefined), { name: '', email: '' });
  assert.deepStrictEqual(parseLoggedInContact(123), { name: '', email: '' });
});

t('壊れた JSON でも例外にならず空を返す', () => {
  assert.deepStrictEqual(parseLoggedInContact('{not-json'), { name: '', email: '' });
  assert.deepStrictEqual(parseLoggedInContact('{"email": '), { name: '', email: '' });
});

t('配列ルートは空を返す', () => {
  assert.deepStrictEqual(parseLoggedInContact(JSON.stringify(['a@example.com'])), { name: '', email: '' });
});

t('null ルートは空を返す', () => {
  assert.deepStrictEqual(parseLoggedInContact('null'), { name: '', email: '' });
});

t('name/email が不正な型（数値/オブジェクト/配列）なら使用しない', () => {
  const r = parseLoggedInContact(JSON.stringify({ email: 12345, name: { x: 1 } }));
  assert.strictEqual(r.name, '');
  assert.strictEqual(r.email, '');
  const r2 = parseLoggedInContact(JSON.stringify({ email: ['a@example.com'], name: 42 }));
  assert.strictEqual(r2.name, '');
  assert.strictEqual(r2.email, '');
});

t('email のみ / name のみでも壊れず該当分だけ返す', () => {
  assert.deepStrictEqual(parseLoggedInContact(JSON.stringify({ email: 'a@example.com' })), { name: '', email: 'a@example.com' });
  assert.deepStrictEqual(parseLoggedInContact(JSON.stringify({ name: '太郎' })), { name: '太郎', email: '' });
});

// --- getLoggedInContact (storage 経由) ---
t('getLoggedInContact: storage から正常取得', () => {
  const r = getLoggedInContact(fakeStorage(JSON.stringify({ email: 'b@example.com', name: '花子' })));
  assert.deepStrictEqual(r, { name: '花子', email: 'b@example.com' });
});

t('getLoggedInContact: user-plan 無し（null）は空', () => {
  assert.deepStrictEqual(getLoggedInContact(fakeStorage(null)), { name: '', email: '' });
});

t('getLoggedInContact: getItem が例外を投げても空を返す', () => {
  const throwing = { getItem: () => { throw new Error('boom'); } };
  assert.deepStrictEqual(getLoggedInContact(throwing), { name: '', email: '' });
});

t('getLoggedInContact: storage が不正でも空を返す', () => {
  assert.deepStrictEqual(getLoggedInContact({}), { name: '', email: '' });
  assert.deepStrictEqual(getLoggedInContact(null), { name: '', email: '' });
});

// --- プレースホルダ 'お客様' を実名として扱わない（2026-07-18 回帰防止） ---
// dashboard が user-plan に書いていた既定値。自動入力すると管理者宛メールが
// 「お名前: お客様」で届き、返信相手を特定できなくなる。
t("normalizeContactName: 'お客様' は空にする", () => {
  assert.strictEqual(normalizeContactName('お客様'), '');
  assert.strictEqual(normalizeContactName('  お客様  '), '');
});

t('normalizeContactName: 実名・非文字列は従来どおり', () => {
  assert.strictEqual(normalizeContactName('山田 太郎'), '山田 太郎');
  assert.strictEqual(normalizeContactName('  花子  '), '花子');
  // 'お客様' を含むだけの実名は消さない（完全一致のみ除外）
  assert.strictEqual(normalizeContactName('お客様太郎'), 'お客様太郎');
  assert.strictEqual(normalizeContactName(null), '');
  assert.strictEqual(normalizeContactName(42), '');
});

t("parseLoggedInContact: name='お客様' は空・email は残す", () => {
  const r = parseLoggedInContact(JSON.stringify({ email: 'c@example.com', name: 'お客様' }));
  assert.deepStrictEqual(r, { name: '', email: 'c@example.com' });
});

console.log(`\ncontact-autofill.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
