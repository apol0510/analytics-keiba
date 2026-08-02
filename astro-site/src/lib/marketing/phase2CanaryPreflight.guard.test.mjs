/**
 * phase2CanaryPreflight.guard.test.mjs — Phase 2 事前確認スクリプトの**安全性**を固定する。
 *
 * 事前確認は「送る前に構造で確かめる」ためのもの。ここが write を持ったり、
 * アドレスを出力したりすると、確認そのものが事故になる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = readFileSync(
  fileURLToPath(new URL('../../../scripts/phase2-canary-preflight.mjs', import.meta.url)),
  'utf8'
);
/** コメントを除いた実コード */
const CODE = SCRIPT.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: 事前確認は read-only（write メソッドを持たない）', () => {
  for (const m of ["method: 'POST'", "method: 'PATCH'", "method: 'DELETE'", "method: 'PUT'"]) {
    assert.equal(CODE.includes(m), false, `事前確認が ${m} を含む（書き込み経路がある）`);
  }
  assert.equal(/mail\/send|sendgrid\.com/.test(CODE), false, '事前確認が送信 API を叩ける');
  assert.equal(/performUpsert/.test(CODE), false, 'upsert を含む');
});

test('guard: メールアドレス・secret を出力しない', () => {
  const logs = CODE.split('\n').filter((l) => /console\.(log|error)/.test(l));
  for (const line of logs) {
    assert.equal(/\$\{target\}|\$\{email|recipients\[0\]\}/.test(line), false, `アドレスを出力している: ${line.trim()}`);
    // env の**名前**を出すのは可（未設定の案内）。**値**を出すのが禁止
    assert.equal(/\$\{\s*(KEY|BASE|process\.env)/.test(line), false, `secret の値を出力している: ${line.trim()}`);
  }
  assert.match(CODE, /sha256:\$\{tag\(target\)\}/, 'アドレスをハッシュ断片で示していない');
  assert.match(CODE, /deliveryKey\.slice\(0, 12\)/, 'DeliveryKey を全部出している');
});

test('guard: allowlist ちょうど 1 名を必須にする（exactly-one）', () => {
  assert.match(CODE, /recipients\.length === 1/, 'allowlist の人数を 1 名に固定していない');
  assert.match(CODE, /if \(recipients\.length !== 1\) return finish\(\)/, '1 名以外で続行している');
});

test('guard: 二重送信の芽（同一 DeliveryKey / 同一 version の既存行）を検査する', () => {
  assert.match(CODE, /sameKey\.length === 0/, '同一 DeliveryKey の存在を検査していない');
  assert.match(CODE, /sameCampaign\.length === 0/, '同一 campaign:version の存在を検査していない');
});

test('guard: 段階を gate の状態から判定し、段階ごとに期待値を変える', () => {
  assert.match(CODE, /export function resolveStage/, '段階判定が無い');
  assert.match(CODE, /MARKETING_CAMPAIGN_ENABLED/, 'キュー登録 gate を見ていない');
  assert.match(CODE, /MARKETING_CAMPAIGN_DISPATCH_ENABLED/, '実送信 gate を見ていない');
  for (const s of ['STAGE.PRE', 'STAGE.ENQUEUE']) {
    assert.ok(CODE.includes(`stage === ${s}`), `段階 ${s} の分岐が無い`);
  }
});

test('guard: enqueue 段階では実送信 gate が閉じていることを要求する', () => {
  const from = CODE.indexOf('stage === STAGE.ENQUEUE');
  const to = CODE.indexOf('} else {', from);
  const seg = CODE.slice(from, to > from ? to : from + 900);
  assert.match(seg, /MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true'/,
    'キュー登録だけ解禁した段階で実送信 gate を許してしまう');
});

test('guard: 段階が進んでも exactly-one の上限を必ず検査する', () => {
  assert.match(CODE, /sameCampaign\.length <= 1/, 'enqueue 段階で配信行の上限を見ていない');
  assert.match(CODE, /sameCampaign\.length === 1/, 'send 段階で配信行がちょうど 1 行であることを見ていない');
  assert.match(CODE, /scheduled\.length <= 1/, 'PENDING ジョブの上限を見ていない');
});

test('guard: 顧客の一意性を確認する（重複があると customer_record_id が確定しない）', () => {
  assert.match(CODE, /matched\.length === 1/, 'Customers の重複を検査していない');
  assert.match(CODE, /\^rec\[A-Za-z0-9\]\{14\}\$/, 'recordId の形式を検査していない');
});

test('guard: 判定に失敗したら非ゼロ終了（送ってよいと誤読させない）', () => {
  assert.match(CODE, /process\.exit\(ng\.length === 0 \? 0 : 1\)/, '失敗時に非ゼロ終了しない');
});

// ── 段階判定の単体テスト（import しても main が走らないこと込み）─────────
test('resolveStage: gate の状態から段階を決める', async () => {
  const { resolveStage, STAGE } = await import('../../../scripts/phase2-canary-preflight.mjs');
  assert.equal(resolveStage({}), STAGE.PRE);
  assert.equal(resolveStage({ MARKETING_CAMPAIGN_ENABLED: 'true' }), STAGE.ENQUEUE);
  assert.equal(resolveStage({ MARKETING_CAMPAIGN_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }), STAGE.SEND);
  // 実送信 gate だけ開いている異常な状態も send として扱う（甘く見ない）
  assert.equal(resolveStage({ MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }), STAGE.SEND);
  // 厳密一致（'TRUE' / '1' は解禁扱いにしない）
  assert.equal(resolveStage({ MARKETING_CAMPAIGN_ENABLED: 'TRUE' }), STAGE.PRE);
  assert.equal(resolveStage({ MARKETING_CAMPAIGN_ENABLED: '1' }), STAGE.PRE);
});

test('resolveStage: PHASE2_STAGE で明示指定できる（不正値は無視）', async () => {
  const { resolveStage, STAGE } = await import('../../../scripts/phase2-canary-preflight.mjs');
  assert.equal(resolveStage({ PHASE2_STAGE: 'send' }), STAGE.SEND);
  assert.equal(resolveStage({ PHASE2_STAGE: 'PRE', MARKETING_CAMPAIGN_ENABLED: 'true' }), STAGE.PRE);
  assert.equal(resolveStage({ PHASE2_STAGE: 'bogus', MARKETING_CAMPAIGN_ENABLED: 'true' }), STAGE.ENQUEUE);
});
