/**
 * contactForm.test.mjs — /contact/ 受付の整形・検査・無害化を固定する
 * 実行: node --test src/lib/contact/contactForm.test.mjs（astro-site 直下）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONTACT_TOPICS, LEGACY_SUBJECT_TO_TOPIC, escapeHtml, resolveTopic, normalizeContactInput,
  MAX_MESSAGE_LENGTH, DEFAULT_CONTACT_NAME,
} from './contactForm.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('escapeHtml: タグ・引用符を無害化する', () => {
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(escapeHtml(null), '');
});

test('resolveTopic: 新 key・旧件名・新ラベルを受け、わからなければ other', () => {
  assert.equal(resolveTopic({ topic: 'payment' }), 'payment');
  assert.equal(resolveTopic({ topic: 'toString' }), 'other');
  assert.equal(resolveTopic({ subject: '料金プランについて' }), 'plan');
  assert.equal(resolveTopic({ subject: 'ログイン・メールが届かない' }), 'login');
  assert.equal(resolveTopic({ subject: '<script>' }), 'other');
  for (const v of Object.values(LEGACY_SUBJECT_TO_TOPIC)) assert.ok(v in CONTACT_TOPICS);
});

test('normalizeContactInput: お名前は任意（空なら お客様）', () => {
  const r = normalizeContactInput({ email: 'a@example.com', message: 'こんにちは', topic: 'usage' });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, DEFAULT_CONTACT_NAME);
  assert.equal(r.value.topicLabel, CONTACT_TOPICS.usage);
});

test('normalizeContactInput: メール不正・本文なし・長すぎは拒否', () => {
  assert.equal(normalizeContactInput({ email: 'x', message: 'a' }).ok, false);
  assert.equal(normalizeContactInput({ email: 'a@example.com', message: '  ' }).ok, false);
  assert.equal(normalizeContactInput({ email: 'a@example.com', message: 'a'.repeat(MAX_MESSAGE_LENGTH + 1) }).ok, false);
  assert.equal(normalizeContactInput(null).ok, false);
});

test('normalizeContactInput: honeypot が埋まっていたら送らない（spam）', () => {
  const r = normalizeContactInput({ email: 'a@example.com', message: 'x', website: 'http://spam' });
  assert.deepEqual(r, { ok: true, spam: true, value: null });
});

test('配線: Function は入力を escapeHtml してからメールへ入れ、honeypot を送らない', () => {
  const fn = read('../../../netlify/functions/contact-form.js');
  assert.match(fn, /normalizeContactInput\(/);
  assert.match(fn, /if \(parsed\.spam\)/);
  // 生の入力値を HTML テンプレートへ直接入れない
  for (const raw of ['${name}', '${email}', '${subject}', '${message}']) {
    assert.equal(fn.includes(raw), false, `生の ${raw} が HTML に入っている`);
  }
  assert.match(fn, /escapeHtml\(v\.message\)/);
  // 成功ログに個人情報を出さない（topic だけ）
  assert.match(fn, /console\.log\('\[contact-form\] accepted', \{ topic: v\.topic \}\)/);
});

test('配線: ページの種類は正本と同じ key だけ', () => {
  const page = read('../../pages/contact.astro');
  // 選択肢は正本 CONTACT_TOPICS から生成する（ページに種類を直書きしない）
  assert.match(page, /import \{ CONTACT_TOPICS \} from '\.\.\/lib\/contact\/contactForm\.js'/);
  assert.match(page, /topics\.map\(\(\[key, label\]\) => <option value=\{key\}>\{label\}<\/option>\)/);
  assert.equal(/<option value="[a-z]+"/.test(page), false, '種類が直書きされている');
  // カードの topic も正本の key だけ
  for (const m of page.matchAll(/topic: '([a-z]+)'/g)) assert.ok(m[1] in CONTACT_TOPICS, m[1]);
  assert.match(page, /name="website"/, 'honeypot 欄が無い');
  assert.match(page, /tabindex="-1"/);
});

test('配線: 成功・エラー表示（#formMessage）は form の外にある（成功時に form ごと隠れるため）', () => {
  const page = read('../../pages/contact.astro');
  const formClose = page.indexOf('</form>');
  const msgAt = page.indexOf('id="formMessage"');
  assert.ok(formClose > 0 && msgAt > formClose, '#formMessage が form の中にある');
});
