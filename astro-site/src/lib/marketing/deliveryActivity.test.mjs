/**
 * deliveryActivity.test.mjs — 配信結果の読み取り（GET のみ・取得できない範囲を偽らない）
 *   node --test src/lib/marketing/deliveryActivity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchDeliveryActivity, classifyEvent, DETAIL_LIMIT } from './deliveryActivity.js';

const NOW = Date.parse('2026-08-01T06:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** provider を模したフェイク。呼ばれた URL とメソッドを記録する */
function fakeProvider({ messages = [], details = {}, listOk = true, detailOk = true } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    if (String(url).includes('?limit=')) {
      return listOk
        ? { ok: true, status: 200, json: async () => ({ messages }) }
        : { ok: false, status: 500, json: async () => ({}) };
    }
    const id = String(url).split('/').pop();
    return detailOk && details[id]
      ? { ok: true, status: 200, json: async () => details[id] }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

test('鍵・宛先が無ければ取得しない（available=false）', async () => {
  for (const args of [{ email: '', apiKey: 'k' }, { email: 'a@b.co', apiKey: '' }]) {
    const r = await fetchDeliveryActivity({ ...args, fetchImpl: fakeProvider() });
    assert.equal(r.available, false);
    assert.equal(r.events.length, 0);
    assert.equal(r.reason, 'no_credentials');
  }
});

test('GET だけを使う（送信 API を呼ばない）', async () => {
  const impl = fakeProvider({ messages: [{ msg_id: 'm1', last_event_time: iso(NOW - HOUR), status: 'delivered', subject: 'テスト' }] });
  await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: impl });
  assert.ok(impl.calls.length > 0);
  for (const c of impl.calls) {
    assert.equal(c.method, 'GET', `GET 以外を呼んでいる: ${c.method}`);
    assert.equal(/mail\/send/.test(c.url), false, '送信 API を呼んでいる');
  }
});

test('開封・クリックは詳細を取れた通だけ available=true にする', async () => {
  const messages = [{ msg_id: 'm1', last_event_time: iso(NOW - HOUR), status: 'delivered', subject: '案内' }];
  const details = {
    m1: {
      events: [
        { event_name: 'processed', processed: iso(NOW - 3 * HOUR) },
        { event_name: 'delivered', processed: iso(NOW - 2 * HOUR) },
        { event_name: 'open', processed: iso(NOW - HOUR) },
      ],
    },
  };
  const r = await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: fakeProvider({ messages, details }) });
  assert.equal(r.available, true);
  assert.equal(r.coveredMessages, 1);
  const kinds = r.events.map((e) => e.kind);
  assert.ok(kinds.includes('open'));
  assert.ok(kinds.includes('delivered'));
  assert.equal(kinds.includes('processed'), false, '未知のイベント名を種別にしている');
});

test('詳細が取れなければ available=false（0 件と言わない）', async () => {
  const messages = [{ msg_id: 'm1', last_event_time: iso(NOW - HOUR), status: 'delivered', subject: '案内' }];
  const r = await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: fakeProvider({ messages, detailOk: false }) });
  assert.equal(r.available, false, '詳細が無いのに開封 0 と判断できる状態にしている');
  // 一覧から分かる到達情報は残す
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'delivered');
  assert.match(r.note, /取得できません/);
});

test('一覧が取れなければ unavailable（例外を投げない）', async () => {
  const r = await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: fakeProvider({ listOk: false }) });
  assert.equal(r.available, false);
  assert.match(r.reason, /^http_/);
  assert.equal(r.events.length, 0);
});

test('詳細を引く通数に上限がある（管理画面を待たせない）', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    msg_id: `m${i}`, last_event_time: iso(NOW - i * HOUR), status: 'delivered', subject: 's',
  }));
  const details = Object.fromEntries(messages.map((m) => [m.msg_id, { events: [{ event_name: 'open', processed: iso(NOW) }] }]));
  const impl = fakeProvider({ messages, details });
  const r = await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: impl });
  assert.equal(r.coveredMessages, DETAIL_LIMIT);
  assert.equal(r.totalMessages, 12);
  // 一覧 1 回 + 詳細 DETAIL_LIMIT 回まで
  assert.equal(impl.calls.length, 1 + DETAIL_LIMIT);
  assert.match(r.note, new RegExp(`直近 ${DETAIL_LIMIT} 通`));
});

test('不達は bounce として扱う', async () => {
  const messages = [{ msg_id: 'm1', last_event_time: iso(NOW), status: 'not_delivered', subject: 's' }];
  const r = await fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: fakeProvider({ messages, detailOk: false }) });
  assert.equal(r.events[0].kind, 'bounce');
});

test('classifyEvent は既知の名前だけを通す', () => {
  assert.equal(classifyEvent('click'), 'click');
  assert.equal(classifyEvent('open'), 'open');
  assert.equal(classifyEvent('bounce'), 'bounce');
  assert.equal(classifyEvent('dropped'), 'bounce');
  assert.equal(classifyEvent('delivered'), 'delivered');
  assert.equal(classifyEvent('processed'), null);
  assert.equal(classifyEvent('spamreport'), null);
  assert.equal(classifyEvent(''), null);
});
