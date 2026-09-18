/**
 * sendgridSingleSends.guard.test.mjs — Single Send 生成スクリプトの契約を固定する
 *
 * Single Send は **宛先 list を持ったまま予約できてしまう**ので、
 * 「うっかり送る」経路を**構造的に持たない**ことを source で固定する。
 *
 *   - `send_at` を組み立てない（作ったものは **draft** のまま）
 *   - `/…/schedule` `/…/send` `/…/trigger` を URL の形で拒否する
 *   - 触るのは許可した 4 つの入口の **GET と POST だけ**（更新・削除を持たない）
 *   - 文面は書き出しファイルを**無加工**（`generate_plain_content: false`）
 *   - segment を使わない（宛先は list だけ）
 *   - 同名があれば作らない／`--apply` と合言葉の両方が要る
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { UNSUBSCRIBE_GROUP_NAME } from './sendgridAutomationPlan.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/sendgrid-create-single-sends.mjs', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

test('予約・送信の経路を持たない（draft のまま）', () => {
  // 本体に send_at を組み立てていない
  assert.equal(/send_at:/.test(src), false, 'send_at を body に入れている');
  // URL の形でも拒否する
  assert.match(src, /\/\\\/\(schedule\|send\|trigger\)\\b\//);
  assert.match(src, /forbidden_action/);
  // 作成後の検証で「予約が入っていないこと」を確かめている
  assert.match(src, /!d\.send_at/);
});

test('触るのは許可した入口の GET と POST だけ', () => {
  assert.match(src, /if \(!\['GET', 'POST'\]\.includes\(method\)\) throw new Error\(`method_not_allowed/);
  assert.match(src, /ALLOWED_PATHS\.some/);
  for (const bad of ["method: 'PUT'", "method: 'PATCH'", "method: 'DELETE'", '/v3/marketing/contacts', '/v3/mail/send']) {
    assert.equal(src.includes(bad), false, `${bad} を持っている`);
  }
});

test('文面を加工しない / plain を作り直させない', () => {
  assert.match(src, /generate_plain_content: false/);
  assert.match(src, /subject: message\.subject/);
  assert.match(src, /html_content: message\.html/);
  assert.match(src, /plain_content: message\.text/);
  assert.equal(/message\.html\.(replace|trim|slice)/.test(src), false);
});

test('宛先は list だけ（segment を使わない）', () => {
  assert.match(src, /send_to: \{ list_ids: \[send\.listId\] \}/);
  assert.equal(/segment_ids:/.test(src), false, 'segment を宛先にしている');
});

test('sender と配信停止グループが必ず入る', () => {
  assert.match(src, /sender_id: send\.senderId/);
  assert.match(src, /suppression_group_id: send\.suppressionGroupId/);
  assert.ok(src.includes('UNSUBSCRIBE_GROUP_NAME'));
  assert.equal(UNSUBSCRIBE_GROUP_NAME, 'AK Marketing');
});

test('同名は作らない / `--apply` と合言葉の両方が要る / 検証 NG なら作らない', () => {
  assert.match(src, /if \(existing\.has\(s\.name\)\)/);
  assert.match(src, /CONFIRM = 'CREATE AK SINGLE SENDS'/);
  assert.match(src, /confirm !== CONFIRM/);
  assert.match(src, /if \(ng\.length > 0\)/);
});

test('期限つきの文面が期限後に出る計画では作らない', () => {
  assert.match(src, /checkDeadlineFeasibility/);
  assert.match(src, /findDeadlineMessages/);
  assert.match(src, /apply && !feas\.ok/, '成立しないのに作れてしまう');
  assert.match(src, /describeCampaignDeadline/, '期限を手書きしている');
  // 開始日は**判定にしか使わない**（予約の body へ渡らない）
  assert.match(src, /--start-date/);
  assert.match(src, /startDateIso: startDate \? `\$\{startDate\}T00:00:00\+09:00` : ''/);
  assert.equal(/send_at:\s/.test(src), false, 'body に send_at を入れている');
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
