/**
 * marketingSinglePath.guard.test.mjs — マーケ配信の**送信経路が 1 系統だけ**であることを固定する。
 *
 * 送信経路が 2 つあると、片方を止めても他方から出る。過去に
 * 「共有 executor が固定宛先ジョブを再検証なしで送る」構造があり、
 * `NEWSLETTER_AUTOMATION_ENABLED` を ON にした瞬間に飛ぶ状態だった。
 * ここでは **経路の数**と**自動実行されないこと**をリポジトリ全体の実ファイルで検査する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const FN_DIR = fileURLToPath(new URL('../../../netlify/functions/', import.meta.url));
const files = readdirSync(FN_DIR).filter((f) => f.endsWith('.js'));
const read = (f) => readFileSync(join(FN_DIR, f), 'utf8');
/** コメントを除いた実コード */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: キャンペーンを SendGrid へ送る Function は 1 つだけ', () => {
  // 「キャンペーンジョブを取り出して送る」Function だけを数える（他機能の送信は別勘定）
  const senders = files.filter((f) => {
    const code = strip(read(f));
    return code.includes('api.sendgrid.com/v3/mail/send') && code.includes('isMarketingJob');
  });
  assert.deepEqual(senders, ['marketing-campaign-dispatch.js'],
    `キャンペーン送信経路が 1 系統でない: ${senders.join(', ')}`);
});

test('guard: 共有 executor はマーケティングジョブを env に関係なく送らない', () => {
  const gate = readFileSync(fileURLToPath(new URL('./marketingDispatchGate.js', import.meta.url)), 'utf8');
  const code = strip(gate);
  // canSharedExecutorSend は env を引数に取らない＝ env で解禁できない
  assert.match(code, /export function canSharedExecutorSend\(fields\)/,
    '共有 executor の判定が env に依存している（env を開けると旧経路から送れる）');
  assert.match(code, /return \{ allowed: false, reason: 'marketing_job_dedicated_dispatcher_only' \}/,
    'マーケティングジョブを常時 skip していない');
  const shared = files.find((f) => f.startsWith('execute-scheduled-emails'));
  if (shared) {
    assert.match(strip(read(shared)), /canSharedExecutorSend\(/,
      '共有 executor が単一源の判定を通していない');
  }
});

test('guard: dispatcher は定期実行に登録されていない（人が実行しない限り送らない）', () => {
  const dispatcher = strip(read('marketing-campaign-dispatch.js'));
  // Netlify scheduled functions は export const config = { schedule: ... } で登録される
  assert.equal(/schedule\s*:/.test(dispatcher), false, 'dispatcher が定期実行に登録されている');
  assert.match(dispatcher, /x-admin-secret/, '管理者認証なしで実行できる');
});

test('guard: dispatcher の実送信は専用ゲートだけで解禁される', () => {
  const dispatcher = strip(read('marketing-campaign-dispatch.js'));
  assert.match(dispatcher, /isMarketingDispatchEnabled\(process\.env\)/, '専用ゲートを通していない');
  assert.equal(/process\.env\.NEWSLETTER_AUTOMATION_ENABLED/.test(dispatcher), false,
    'dispatcher が全メール自動化フラグを参照している（旧経路と連動してしまう）');
});

test('guard: キュー登録と実送信は別のゲートで分かれている', () => {
  const gate = strip(readFileSync(fileURLToPath(new URL('./marketingDispatchGate.js', import.meta.url)), 'utf8'));
  assert.match(gate, /MARKETING_CAMPAIGN_ENABLED/, 'キュー登録ゲートが無い');
  assert.match(gate, /MARKETING_CAMPAIGN_DISPATCH_ENABLED/, '実送信ゲートが無い');
  // 2 つの判定関数が**別々の env** を見ていること（同じなら分離になっていない）
  const bodyOf = (name) => {
    const i = gate.indexOf('export function ' + name);
    return i < 0 ? '' : gate.slice(i, gate.indexOf('}', i) + 1);
  };
  const enqueueBody = bodyOf('isMarketingEnqueueEnabled');
  const dispatchBody = bodyOf('isMarketingDispatchEnabled');
  assert.ok(
    enqueueBody.includes('MARKETING_CAMPAIGN_ENABLED') && !enqueueBody.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'),
    'キュー登録ゲートが実送信 env を見ている',
  );
  assert.ok(dispatchBody.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), '実送信ゲートが専用 env を見ていない');
});

test('guard: admin はメールを送らない（キュー登録までしかしない）', () => {
  const admin = strip(read('admin-marketing.js'));
  assert.equal(/api\.sendgrid\.com/.test(admin), false, 'admin が送信 API を持っている');
  assert.match(admin, /ScheduledEmails|SCHEDULED_TABLE/, 'admin がキューへ登録していない');
});
