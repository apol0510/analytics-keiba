/**
 * airtableWritableFields.test.mjs — **控えをそのまま POST しない**（rollback が効くこと）
 *   node --test src/lib/marketing/airtableWritableFields.test.mjs
 *
 * ## なぜ要るか
 *
 * 控え（export）は監査のため**全フィールド**を持つ。そのまま POST すると
 * `登録日`（**`createdTime`**）のような**書けない field** で復元が失敗する。
 * rollback が効かない ＝ 削除が取り返しのつかない操作になる。
 *
 * ここでは **本番 Customers schema のスナップショット**（`__fixtures__/customersSchema.json`・
 * Meta API から取得・型だけ）に対して、復元 payload が成立することを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  classifyFields, buildRestoreFields, validateRestorePayload,
  WRITABLE_FIELD_TYPES, NEVER_WRITE_FIELD_TYPES,
} from './airtableWritableFields.js';

const SCHEMA = JSON.parse(readFileSync(fileURLToPath(
  new URL('./__fixtures__/customersSchema.json', import.meta.url),
), 'utf8'));
const schema = classifyFields(SCHEMA.fields);

/* ── 1. 本番 schema そのものの契約 ───────────────────────── */

test('本番 Customers schema を読めている（型だけのスナップショット）', () => {
  assert.equal(SCHEMA.table, 'Customers');
  assert.ok(SCHEMA.fields.length > 50, `field 数が少なすぎる: ${SCHEMA.fields.length}`);
  assert.equal(SCHEMA.fields.some((f) => f.name.includes('@')), false, 'PII が混ざっている');
});

test('⚠️【要件】登録日 は createdTime なので **書き込み対象にしない**', () => {
  const f = SCHEMA.fields.find((x) => x.name === '登録日');
  assert.ok(f, '登録日 が schema に無い');
  assert.equal(f.type, 'createdTime');
  assert.equal(schema.writable.has('登録日'), false, '⚠️ 登録日 を POST しようとしている');
  assert.equal(schema.computed.has('登録日'), true);
});

test('⚠️【要件】計算・自動 field は 1 つも writable に入らない', () => {
  for (const f of SCHEMA.fields) {
    if (NEVER_WRITE_FIELD_TYPES.has(f.type)) {
      assert.equal(schema.writable.has(f.name), false, `⚠️ ${f.name}(${f.type}) を書こうとしている`);
    }
  }
});

test('⚠️【要件】リンク field は復元で使わない（再配線は別工程）', () => {
  const link = SCHEMA.fields.find((x) => x.type === 'multipleRecordLinks');
  assert.ok(link, 'リンク field が schema に無い');
  assert.equal(schema.writable.has(link.name), false);
  assert.equal(schema.links.has(link.name), true);
});

test('⚠️ 知らない型は writable に入れない（fail closed）', () => {
  const c = classifyFields([{ name: 'X', type: 'someFutureType' }]);
  assert.equal(c.writable.has('X'), false);
  assert.equal(c.unknown.has('X'), true);
});

test('本番 schema の writable が空でない（全部落として復元不能にしない）', () => {
  assert.ok(schema.writable.size > 30, `writable が少なすぎる: ${schema.writable.size}`);
  assert.equal(schema.writable.has('Email'), true);
  assert.equal(schema.writable.has('Source'), true);
});

/* ── 2. 控え → 復元 payload ─────────────────────────────── */

test('⚠️【要件】控えの全フィールドから、書ける field だけを取り出す', () => {
  const exported = {
    Email: 'a@example.com', Source: 'customer-import:imp-1',
    登録日: '2026-08-09T00:00:00.000Z',          // ⚠️ createdTime
    StepEnrollments: ['recStep1'],                 // ⚠️ link
    プラン: 'free', ポイント: 10, AccessEnabled: true,
  };
  const { fields, dropped } = buildRestoreFields(exported, schema.writable);
  assert.equal('登録日' in fields, false, '⚠️ createdTime を POST しようとしている');
  assert.equal('StepEnrollments' in fields, false, '⚠️ link を POST しようとしている');
  assert.deepEqual(dropped.sort(), ['StepEnrollments', '登録日'].sort());
  assert.equal(fields.Email, 'a@example.com');
  assert.equal(fields.ポイント, 10);
  assert.equal(fields.AccessEnabled, true);
});

test('空の値は送らない（既定値を上書きしない）', () => {
  const { fields } = buildRestoreFields(
    { Email: 'a@example.com', 氏名: '', Memo: null, ノート: undefined }, schema.writable,
  );
  assert.deepEqual(Object.keys(fields), ['Email']);
});

test('⚠️【要件】計算 field が混ざった payload は検算で弾く', () => {
  const bad = validateRestorePayload({
    records: [{ fields: { Email: 'a@example.com', 登録日: 'x' } }], ...schema,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => r.startsWith('computed_field_in_payload:登録日')));
});

test('⚠️ Email が無い payload は弾く（復元先を特定できない）', () => {
  const bad = validateRestorePayload({ records: [{ fields: { 氏名: 'x' } }], ...schema });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.includes('missing_email'));
});

test('⚠️ 空の payload は弾く', () => {
  assert.equal(validateRestorePayload({ records: [], ...schema }).ok, false);
});

/* ── 3. 【要件】削除対象 1 件相当で、実 Customers へ書かずに成立を確かめる ── */

test('⚠️【要件】削除対象 1 件相当の控えが、本番 schema に対して有効な payload になる', () => {
  // 実データは使わない。**本番 schema の全 field 名**を埋めた最悪ケースを作る
  const worstCase = {};
  for (const f of SCHEMA.fields) {
    if (f.type === 'checkbox') worstCase[f.name] = true;
    else if (f.type === 'number') worstCase[f.name] = 1;
    else if (f.type === 'multipleSelects') worstCase[f.name] = ['analytics-keiba'];
    else if (f.type === 'multipleRecordLinks') worstCase[f.name] = ['recXXXXXXXXXXXXXX'];
    else if (f.type === 'email') worstCase[f.name] = 'target@example.com';
    else worstCase[f.name] = '2026-08-09T00:00:00.000Z';
  }
  const { fields, dropped } = buildRestoreFields(worstCase, schema.writable);

  // 落ちたのは「計算 field ＋ リンク field」だけ
  assert.deepEqual(
    dropped.sort(),
    [...schema.computed, ...schema.links, ...schema.unknown].sort(),
    '⚠️ 落とす field / 残す field がずれている',
  );
  // 送る payload には計算 field が 1 つも無い
  for (const k of Object.keys(fields)) {
    assert.equal(schema.computed.has(k), false, `⚠️ ${k} が payload に残っている`);
    assert.equal(schema.links.has(k), false, `⚠️ ${k}（link）が payload に残っている`);
  }
  const v = validateRestorePayload({ records: [{ fields }], ...schema });
  assert.equal(v.ok, true, `⚠️ payload が schema に対して無効: ${v.reasons.join(', ')}`);
  assert.equal(v.checked, 1);
  assert.ok(Object.keys(fields).length > 30, '送る field が少なすぎる（復元が痩せる）');
});

test('⚠️ 実 Customers へ書きに行っていない（この test は純粋関数だけを使う）', () => {
  const src = readFileSync(fileURLToPath(new URL('./airtableWritableFields.js', import.meta.url)), 'utf8');
  assert.equal(/fetch\(/.test(src), false, '⚠️ 判定モジュールが通信している');
  assert.equal(/api\.airtable\.com/.test(src), false);
});

/* ── 4. guard: 復元ハンドラが schema を見ている ─────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const restoreSrc = adminSrc.slice(
  adminSrc.indexOf('async function handleCustomerDeletionRestore'),
  adminSrc.indexOf('async function fetchCustomersFieldSchema'),
);

test('⚠️ guard: 復元は本番 schema を取り直してから payload を作る', () => {
  assert.ok(restoreSrc.length > 200, 'handler が見つからない');
  assert.match(restoreSrc, /fetchCustomersFieldSchema\(/, '⚠️ schema を見ずに POST している');
  assert.match(restoreSrc, /buildRestoreFields\(/);
  assert.match(restoreSrc, /validateRestorePayload\(/, '⚠️ 送る前の検算が無い');
  assert.match(restoreSrc, /schema\.writable\.size === 0/, '⚠️ schema が空でも作りに行く');
  assert.equal(/records: rawRows/.test(restoreSrc), false, '⚠️ 控えを素通しで POST している');
});

test('⚠️ guard: writable / never-write の集合が重なっていない', () => {
  for (const t of WRITABLE_FIELD_TYPES) {
    assert.equal(NEVER_WRITE_FIELD_TYPES.has(t), false, `型 ${t} が両方に入っている`);
  }
});
