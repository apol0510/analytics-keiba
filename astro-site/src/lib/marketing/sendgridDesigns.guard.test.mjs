/**
 * sendgridDesigns.guard.test.mjs — Design 登録スクリプトの契約を固定する
 *
 * Design は **Automation が実際に送る文面**になる。したがって
 *   - **ファイルの中身を加工しない**（subject / html / text をそのまま送る）
 *   - **SendGrid に text を作り直させない**（`generate_plain_content: false`）
 *   - 触るのは `/v3/designs` の **GET と POST だけ**（更新・削除・送信・contact は無い）
 *   - 同名があれば作らない（二重作成しない）
 *   - 作ったあと **GET で 1 バイト単位に突き合わせる**
 * を source と実行で固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { TOTAL_MESSAGES } from './sendgridMessagePlan.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/sendgrid-create-designs.mjs', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

test('触るのは /v3/designs の GET と POST だけ', () => {
  assert.match(src, /if \(!\['GET', 'POST'\]\.includes\(method\)\) throw new Error\(`method_not_allowed/);
  assert.match(src, /if \(!path\.startsWith\('\/v3\/designs'\)\) throw new Error\(`path_not_allowed/);
  for (const bad of ['/v3/marketing/contacts', '/v3/mail/send', '/v3/marketing/lists', 'singlesends']) {
    assert.equal(src.includes(bad), false, `${bad} を触っている`);
  }
});

test('文面を加工しない（text を作り直させない）', () => {
  assert.match(src, /generate_plain_content: false/);
  // 読み込んだ値をそのまま body へ載せている（置換・trim をしていない）
  assert.match(src, /subject: m\.subject/);
  assert.match(src, /html_content: m\.html/);
  assert.match(src, /plain_content: m\.text/);
  assert.equal(/m\.html\.(replace|trim|slice)/.test(src), false, 'HTML を加工している');
  assert.equal(/m\.text\.(replace|trim|slice)/.test(src), false, 'text を加工している');
});

test('名前は 01〜10 のゼロ埋め、10 通ぶん', () => {
  /**
   * ⚠️ このスクリプトは CLI（先頭で env を確かめて `process.exit` する）なので
   *    **テストから import しない**（import した瞬間にテストのプロセスごと落ちる）。
   *    名前の形は source で確かめる。
   */
  assert.match(src, /AK Prospect Selection \$\{String\(n\)\.padStart\(2, '0'\)\}/);
  assert.equal(TOTAL_MESSAGES, 10);
  assert.match(src, /index\.length !== TOTAL_MESSAGES/, '10 通そろっていないと進めない');
});

test('同名があれば作らない / 作成後に 1 バイト単位で突き合わせる', () => {
  assert.match(src, /if \(existing\.has\(m\.name\)\)/);
  assert.match(src, /String\(d\.subject\) === m\.subject/);
  assert.match(src, /String\(d\.html_content\) === m\.html/);
  assert.match(src, /String\(d\.plain_content\) === m\.text/);
  assert.match(src, /全件一致/);
});

test('`--apply` と合言葉の両方が要る', () => {
  assert.match(src, /const apply = args\.includes\('--apply'\)/);
  assert.match(src, /confirm !== CONFIRM/);
  assert.match(src, /CONFIRM = 'CREATE AK DESIGNS'/);
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
