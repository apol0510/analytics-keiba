/**
 * sendgridCreateSetup.guard.test.mjs — **作るものを増やさない / 既存を壊さない**契約を固定する
 *
 * このスクリプトは本番の SendGrid へ**作る**唯一の経路。したがって
 *   - 作ってよい名前は 6 つだけ（unsubscribe group 1 / custom field 1 / list 3 / sender 1）
 *   - **更新・削除の HTTP メソッドを持たない**（PUT / PATCH / DELETE を書かない）
 *   - **contact を投入しない**（`/v3/marketing/contacts` を触らない）
 *   - `--apply` と合言葉の**両方**が無ければ 1 つも作らない
 *   - `marketing.write` が無ければ**何も作らない**（片方だけ作られた状態にしない）
 * を source と実行の両方で固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  listNameFor, UNSUBSCRIBE_GROUP_NAME, buildMinimalSetupNames,
} from './sendgridAutomationPlan.js';
import { CONTACT_FIELD_NAMES_REQUIRED } from './sendgridContactExport.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/sendgrid-create-minimal-setup.mjs', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

test('作ってよいのは 6 つだけ（名前は既存モジュールと一致する）', () => {
  const CREATE_ALLOWLIST = buildMinimalSetupNames();
  assert.equal(CREATE_ALLOWLIST.group, UNSUBSCRIBE_GROUP_NAME);
  assert.equal(CREATE_ALLOWLIST.field, CONTACT_FIELD_NAMES_REQUIRED[0]);
  assert.deepEqual(CREATE_ALLOWLIST.lists, [listNameFor(1), listNameFor(2), listNameFor(3)]);
  assert.equal(CREATE_ALLOWLIST.senderNickname, 'KEIBA Analytics');
  // 4〜10 始まりの list は作らない
  for (const n of [4, 5, 6, 7, 8, 9, 10]) {
    assert.equal(CREATE_ALLOWLIST.lists.includes(listNameFor(n)), false, `${n} を作ろうとしている`);
  }
});

test('更新・削除のメソッドを持たない（POST と GET だけ）', () => {
  const methods = [...src.matchAll(/sg\('([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)].sort(), ['GET', 'POST']);
  for (const verb of ["'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.equal(src.includes(`sg(${verb}`), false, `${verb} を使っている`);
  }
});

test('contact を投入しない（別工程・別承認）', () => {
  assert.equal(/\/v3\/marketing\/contacts/.test(src), false);
  assert.equal(/singlesends/.test(src), false, 'Single Send を作らない');
});

test('KI の資産に触らない印を持っている', () => {
  assert.match(src, /const FOREIGN = \[/);
  for (const x of ['intelligence', 'keiba-review', 'nankan']) {
    assert.ok(src.includes(`'${x}'`), `${x} を素通り対象にしていない`);
  }
});

test('作成スクリプトは allowlist を単一源から取る（名前を二重に持たない）', () => {
  assert.match(src, /buildMinimalSetupNames\(\)/);
  assert.equal(/senderNickname: '(?!KEIBA Analytics)/.test(src), false);
});

test('`--apply` と合言葉の両方が要る / write が無ければ中止する', () => {
  assert.match(src, /const apply = args\.includes\('--apply'\)/);
  assert.match(src, /confirm !== CONFIRM/);
  assert.match(src, /apply && !hasWrite/);
  // 既存があれば飛ばす（重複を作らない）
  assert.match(src, /p\.exists.*skipped_existing|if \(p\.exists\)/s);
});

test('資格情報が無ければネットワークへ出ずに終了する', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH }, stdio: 'pipe', timeout: 20000,
    });
  } catch (e) { code = e.status; }
  assert.equal(code, 2);
});
