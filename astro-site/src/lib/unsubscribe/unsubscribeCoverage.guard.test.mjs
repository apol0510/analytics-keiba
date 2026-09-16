/**
 * unsubscribeCoverage.guard.test.mjs — 「配信停止が無人で完結する」を構造で固定する。
 *   node --test src/lib/unsubscribe/unsubscribeCoverage.guard.test.mjs
 *
 * ## 完成条件（2026-09-16 MK 確定）
 *
 * **Unsubscribe は 1 件ごとの人手対応を要求しない。**
 * 受信箱を人が見る / Claude へ 1 件ずつ依頼する / Airtable を手編集する、は完成形ではない。
 * ここでは「人手が要る状態へ戻っていないこと」をコードの構造で検査する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { SINK_RESULT } from './unsubscribeOutcome.js';
import { suppressProspect, customerResultToSink } from '../../../netlify/functions/unsubscribe.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // astro-site/
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const FN = read('netlify/functions/unsubscribe.js');

// ── 1. 両方の母集団へ記録する ───────────────────────────────────

test('handler が Customers と見込み客プールの両方へ書きにいく', () => {
  assert.match(FN, /planUnsubscribeSinks/, '保存先の決定が単一源を通っていない');
  assert.match(FN, /summarizeUnsubscribeOutcome/, '成否の判定が単一源を通っていない');
  assert.match(FN, /suppressProspect\(/, '見込み客プールへ書いていない（配信の大半がここ）');
  assert.match(FN, /updateUnsubscribeStatus\(/, 'Customers へ書いていない');
});

test('見込み客の抑止理由は unsubscribe（バウンス等と混ぜない）', () => {
  assert.match(FN, /SUPPRESS_REASON\.UNSUBSCRIBE/, '抑止理由を unsubscribe 以外にしている');
});

// ── 2. 権限・契約状態と混同しない ───────────────────────────────

test('配信停止で会員契約・権限フィールドを触らない', () => {
  for (const forbidden of ['プラン', 'PlanType', '有効期限', 'Status', 'PaidAt',
    'LifetimeSanrenpuku', 'WithdrawalRequested']) {
    const written = new RegExp(`['"\`]${forbidden}['"\`]\\s*:`);
    assert.ok(!written.test(FN), `${forbidden} を書いている（配信停止と契約・退会は別物）`);
  }
});

test('触るのは brand 別の配信停止フィールドだけ', () => {
  assert.match(FN, /UnsubscribedAnalyticsKeiba/);
  assert.match(FN, /UnsubscribedKeibaIntelligence/);
});

// ── 3. transactional を誤停止しない ─────────────────────────────

test('決済・利用開始メールの経路は配信停止フラグを見ない（必須通知を止めない）', () => {
  for (const f of ['netlify/functions/payment-email-worker.js',
    'netlify/functions/confirm-bank-payment.js']) {
    const src = read(f);
    assert.ok(!/UnsubscribedAnalyticsKeiba/.test(src),
      `${f} がマーケ配信停止を見ている（入金確認メールまで止まる）`);
  }
});

test('配信停止 Function はメールを 1 通も送らない', () => {
  assert.ok(!/sendgrid|SENDGRID|api\.sendgrid\.com|mail\/send/i.test(FN),
    '配信停止処理からメールを送っている');
});

// ── 4. 他人を止められない ───────────────────────────────────────

test('宛先は URL から取る（body のアドレスを採用しない）', () => {
  const parse = read('src/lib/unsubscribe/parseUnsubscribeRequest.js');
  assert.match(parse, /email: q\.email \?\? null/, 'ワンクリックで body のアドレスを宛先にしている');
});

// ── 5. fail-open でマーケ配信を続けない ─────────────────────────

test('記録できなければ 2xx を返さない', () => {
  assert.match(FN, /statusForResult\(\{ kind: parsed\.kind, ok: false, reason: outcome\.reason \}\)/);
  const parse = read('src/lib/unsubscribe/parseUnsubscribeRequest.js');
  assert.match(parse, /unsubscribe-write-failed'\) return 502/, '書込み失敗を 2xx で握り潰している');
});

// ── 6. 見込み客側の記録（注入した偽ストアで挙動を確認）────────────

test('見込み客として記録できれば recorded', async () => {
  const r = await suppressProspect('a@example.test', {
    makeCmd: () => async () => null,
    createStore: () => ({ recordSuppression: async () => ({ ok: true, changed: true }) }),
  });
  assert.equal(r, SINK_RESULT.RECORDED);
});

test('既に抑止済みなら already（冪等）', async () => {
  const r = await suppressProspect('a@example.test', {
    makeCmd: () => async () => null,
    createStore: () => ({ recordSuppression: async () => ({ ok: true, changed: false }) }),
  });
  assert.equal(r, SINK_RESULT.ALREADY);
});

test('見込み客に居なければ not-found', async () => {
  const r = await suppressProspect('a@example.test', {
    makeCmd: () => async () => null,
    createStore: () => ({ recordSuppression: async () => ({ ok: false, reason: 'not_found' }) }),
  });
  assert.equal(r, SINK_RESULT.NOT_FOUND);
});

test('Redis 未設定は unavailable（成功と混同しない）', async () => {
  const r = await suppressProspect('a@example.test', {
    makeCmd: () => { throw new Error('redis_not_configured'); },
  });
  assert.equal(r, SINK_RESULT.UNAVAILABLE);
});

test('ストアが例外を投げたら error（握り潰さない）', async () => {
  const r = await suppressProspect('a@example.test', {
    makeCmd: () => async () => null,
    createStore: () => ({ recordSuppression: async () => { throw new Error('boom'); } }),
  });
  assert.equal(r, SINK_RESULT.ERROR);
});

test('Customers 側の結果の翻訳', () => {
  assert.equal(customerResultToSink({ ok: true }), SINK_RESULT.RECORDED);
  assert.equal(customerResultToSink({ ok: false, reason: 'email-not-found' }), SINK_RESULT.NOT_FOUND);
  assert.equal(customerResultToSink({ ok: false, reason: 'missing-env' }), SINK_RESULT.UNAVAILABLE);
  assert.equal(customerResultToSink({ ok: false, reason: 'airtable-update-failed' }), SINK_RESULT.ERROR);
});

// ── 7. 送信直前の除外が両母集団で効いている ─────────────────────

test('送信直前の再検証が配信停止と見込み客の抑止を見ている', () => {
  const dispatch = read('netlify/functions/marketing-campaign-dispatch.js');
  assert.match(dispatch, /UnsubscribedAnalyticsKeiba === true/, '会員の配信停止を見ていない');
  assert.match(dispatch, /ctx\.suppressed/, '見込み客の抑止を見ていない');
  const ctx = read('src/lib/marketing/prospectDispatchContext.js');
  assert.match(ctx, /suppressed\.add\(email\)/, '抑止された見込み客を除外集合へ入れていない');
});

test('メルマガ経路も配信停止を除外に使い続ける', () => {
  const nl = read('netlify/functions/execute-scheduled-emails-background.js');
  assert.match(nl, /loadBlacklistEmails|resolveAudienceRecipients|getRecipients/,
    'メルマガ経路の除外が外れている');
});
