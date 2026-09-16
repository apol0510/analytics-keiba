/**
 * unsubscribeOutcome.test.mjs — 「どこへ記録し、成功と言ってよいか」を固定する。
 *   node --test src/lib/unsubscribe/unsubscribeOutcome.test.mjs
 *
 * 完成条件のうち、ここで守るもの:
 *   1 配信停止操作をした利用者は自動で配信停止状態になる（両母集団へ書く）
 *   6 retry / re-enrollment で復活しない（見込み客の抑止は再開で解除しない）
 *   7 二重処理は冪等（already も成功）
 *  11 fail-open でマーケ配信を続けない（記録できなければ 2xx を返さない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planUnsubscribeSinks, summarizeUnsubscribeOutcome, SINK, SINK_RESULT,
} from './unsubscribeOutcome.js';
import { statusForResult, REQUEST_KIND } from './parseUnsubscribeRequest.js';

// ── どこへ書きにいくか ──────────────────────────────────────────

test('配信停止は Customers と見込み客プールの両方へ書きにいく', () => {
  const p = planUnsubscribeSinks({ action: 'unsubscribe' });
  assert.equal(p.customer, true);
  assert.equal(p.prospect, true);
});

test('【重要】配信再開では見込み客の抑止を解除しない（再取り込みで復活させない）', () => {
  const p = planUnsubscribeSinks({ action: 'resubscribe' });
  assert.equal(p.customer, true);
  assert.equal(p.prospect, false, '再開で見込み客の抑止まで外すと、止めた人が配信へ戻る');
});

// ── 成否の判定 ──────────────────────────────────────────────────

test('会員として記録できれば成功', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: SINK_RESULT.RECORDED, [SINK.PROSPECT]: SINK_RESULT.NOT_FOUND });
  assert.equal(r.ok, true);
  assert.deepEqual(r.recorded, [SINK.CUSTOMER]);
});

test('【本件】会員に居なくても見込み客として記録できれば成功', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: SINK_RESULT.NOT_FOUND, [SINK.PROSPECT]: SINK_RESULT.RECORDED });
  assert.equal(r.ok, true, '見込み客宛が配信の大半。ここを落とすと「押しても止まらない」が続く');
  assert.deepEqual(r.recorded, [SINK.PROSPECT]);
});

test('二重処理は冪等（既に停止済みでも成功）', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: SINK_RESULT.ALREADY, [SINK.PROSPECT]: SINK_RESULT.ALREADY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.recorded.sort(), [SINK.CUSTOMER, SINK.PROSPECT].sort());
});

test('どこにも居なければ email-not-found（ワンクリックでは 200 / 存在有無を漏らさない）', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: SINK_RESULT.NOT_FOUND, [SINK.PROSPECT]: SINK_RESULT.NOT_FOUND });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'email-not-found');
  assert.equal(statusForResult({ kind: REQUEST_KIND.ONE_CLICK, ok: false, reason: r.reason }), 200);
  assert.equal(statusForResult({ kind: REQUEST_KIND.JSON_API, ok: false, reason: r.reason }), 404);
});

test('【重要】記録ゼロ＋失敗ありは成功と言わない（fail closed）', () => {
  for (const bad of [SINK_RESULT.ERROR, SINK_RESULT.UNAVAILABLE]) {
    const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: bad, [SINK.PROSPECT]: SINK_RESULT.NOT_FOUND });
    assert.equal(r.ok, false, `${bad} を成功にしている`);
    assert.equal(r.reason, 'unsubscribe-write-failed');
    // ⚠️ ワンクリックでも 2xx を返さない。2xx は「止まった」の意味なので握り潰さない
    assert.equal(statusForResult({ kind: REQUEST_KIND.ONE_CLICK, ok: false, reason: r.reason }), 502);
  }
});

test('片方が失敗しても、もう片方に記録できていれば成功', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: SINK_RESULT.RECORDED, [SINK.PROSPECT]: SINK_RESULT.ERROR });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, [SINK.PROSPECT], '失敗した保存先を握り潰している（気づけなくなる）');
});

test('未知の値は成功として数えない', () => {
  const r = summarizeUnsubscribeOutcome({ [SINK.CUSTOMER]: 'something-else' });
  assert.equal(r.ok, false);
});
