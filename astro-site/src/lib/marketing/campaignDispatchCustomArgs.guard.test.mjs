/**
 * campaignDispatchCustomArgs.guard.test.mjs — dispatcher の**配線**を実ファイル検査で固定する。
 *
 * 純粋モジュール（campaignCustomArgs.js）が正しくても、Function 側で
 * 「解決できなくても送る」「DeliveryKey を送信側で作り直す」「アドレスを刻む」
 * のいずれかに戻ったら、台帳の紐付けが壊れる / PII が provider 側へ出る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/marketing-campaign-dispatch.js', import.meta.url)),
  'utf8'
);
/** コメントを除いた実コード */
const CODE = FN.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: custom_args の組み立ては単一源を import する（Function に再実装しない）', () => {
  assert.match(CODE, /from '[^']*marketing\/campaignCustomArgs\.js'/, '単一源を import していない');
  assert.match(CODE, /buildCampaignCustomArgs\(/, '単一源の組み立て関数を呼んでいない');
  assert.match(CODE, /indexDeliveriesByRecipient\(/, '配信行の索引を単一源で作っていない');
  // キー名を Function 側で直書きしない
  for (const k of ['delivery_key:', 'customer_record_id:', 'campaign_delivery_id:']) {
    assert.equal(CODE.includes(k), false, `custom_args のキー ${k} を Function 側で組み立てている`);
  }
});

test('guard: DeliveryKey を送信側で再生成しない（enqueue 時の値だけを使う）', () => {
  assert.equal(/computeDeliveryKey|computeCampaignDeliveryKey/.test(CODE), false,
    'dispatcher が DeliveryKey を再計算している（enqueue 時と食い違う恐れ）');
  assert.equal(/createHash/.test(CODE), false, 'dispatcher でハッシュを作っている');
});

test('guard: custom_args を解決できない相手へは送らない（fail closed）', () => {
  // 解決失敗は skip として記録され、送信ループへ進まない
  assert.match(CODE, /if \(!ca\.ok\)[\s\S]{0,400}continue;/, '解決失敗時に continue していない');
  // 送信直前にも custom_args の有無を確認する
  const sendIdx = CODE.indexOf('await sendOne(');
  const guardIdx = CODE.indexOf('if (!customArgs)');
  assert.ok(guardIdx > -1 && guardIdx < sendIdx, 'custom_args 未解決のまま sendOne へ到達しうる');
  assert.match(CODE, /custom_args_unresolved/, '未解決を理由コードとして記録していない');
});

test('guard: 送信ペイロードに custom_args を載せる', () => {
  assert.match(CODE, /custom_args: customArgs/, 'SendGrid ペイロードへ custom_args を載せていない');
  const bodyIdx = CODE.indexOf('personalizations:');
  const caIdx = CODE.indexOf('custom_args: customArgs');
  assert.ok(caIdx > bodyIdx, 'custom_args が送信ペイロード内にない');
});

test('guard: custom_args へアドレス・氏名・URL・token を混ぜない', () => {
  const from = CODE.indexOf('async function sendOne');
  const to = CODE.indexOf('async function patchDeliveriesByEmail');
  const fn = CODE.slice(from, to > from ? to : undefined);
  // sendOne が受け取るのは組み上がった customArgs だけ（中で組み立て直さない）
  assert.equal(/custom_args:\s*\{/.test(fn), false, 'sendOne 内で custom_args を組み立てている');
  for (const banned of ['custom_args: { email', 'offerKey', 'token']) {
    assert.equal(fn.includes(banned), false, `custom_args 経路で ${banned} を扱っている`);
  }
});

test('guard: 既存の送信可否判定を custom_args 導入で変えていない', () => {
  for (const marker of [
    'verifyBeforeSend(',            // suppression / blacklist / 配信停止 / 退会 / 頻度
    'fetchProviderSuppression(',    // provider suppression（取得失敗なら中止）
    'evaluateExtraAudience(',       // キャンペーン固有条件
    'linkOfferForRecipient(',       // オファー有効性
    'isMarketingDispatchEnabled(',  // 送信ゲート（既定 OFF）
  ]) {
    assert.ok(CODE.includes(marker), `既存判定 ${marker} が失われている`);
  }
  // custom_args の解決は既存判定を通過した後にだけ走る
  const verifyIdx = CODE.indexOf('verifyBeforeSend(');
  const caIdx = CODE.indexOf('buildCampaignCustomArgs(');
  assert.ok(caIdx > verifyIdx, 'custom_args 解決が既存判定より前にある');
});

test('guard: 送信ゲートが false のとき実送信へ進まない（既定 OFF を維持）', () => {
  assert.match(CODE, /if \(!dryRun && !isMarketingDispatchEnabled\(process\.env\)\)[\s\S]{0,200}return json\(503/,
    '実送信ゲートが失われている');
});

test('guard: Customers / 決済メール v2 のフィールドへ書かない', () => {
  // Customers は **読むだけ**。patchRecord / createRecord の対象に含めない
  assert.equal(/patchRecord\(\{[^}]*table: CUSTOMERS_TABLE/.test(CODE), false, 'Customers を更新している');
  assert.equal(/createRecord\(\{[^}]*CUSTOMERS_TABLE/.test(CODE), false, 'Customers を作成している');
  assert.ok(/fetchAll\(\{ KEY, BASE, table: CUSTOMERS_TABLE \}\)/.test(CODE), 'Customers の読み取りが失われている');
  for (const f of ['PaymentEmailStatus', 'PaymentEmailSent', 'PaymentConfirmed', 'idempotency_key', 'payment_confirmation_v2']) {
    assert.equal(CODE.includes(f), false, `決済メール v2 のフィールド ${f} に触れている`);
  }
});

test('guard: 送信失敗時は CampaignDeliveries を failed で記録する（状態を落とさない）', () => {
  assert.match(CODE, /status: ok \? 'sent' : 'failed'/, '送信結果を配信台帳へ記録していない');
  assert.match(CODE, /fields\.FailedAt = iso;[\s\S]{0,80}ErrorMessage/, '失敗理由を記録していない');
});

test('guard: ログへメールアドレス・custom_args を出さない', () => {
  const logLines = CODE.split('\n').filter((l) => /console\.(log|warn|error)/.test(l));
  for (const line of logLines) {
    assert.equal(/customArgs|custom_args/.test(line), false, `ログに custom_args を出している: ${line.trim()}`);
    assert.equal(/\$\{email/.test(line), false, `ログにアドレスを出している: ${line.trim()}`);
  }
});
