/**
 * sendgridMarketingApiLookup.test.mjs — 「1 件も見つからない」を失敗にしない
 *
 * `POST /v3/marketing/contacts/search/emails` は**1 件も一致しないと 404**。
 * これを例外にすると「引けなかった」と「居ない」が混ざり、
 * 居ないだけの人を**外さずに入れて** 2 通届く事故になる（2026-09-19 本番実測）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSendGridMarketingApi } from './sendgridMarketingApi.js';

const res = (status, body) => ({ status, json: async () => body });

test('1 件も見つからない chunk（404）は「居ない」として空で返す', async () => {
  const api = createSendGridMarketingApi({
    apiKey: 'k', fetchImpl: async () => res(404, { errors: [{ message: 'no contacts found' }] }),
  });
  const out = await api.lookupContacts(['a@example.com', 'b@example.com']);
  assert.equal(out.size, 0);
});

test('見つかった分は id / 在籍 list / 通し番号を返す', async () => {
  const api = createSendGridMarketingApi({
    apiKey: 'k',
    fetchImpl: async () => res(200, {
      result: {
        'a@example.com': {
          contact: { id: 'c1', list_ids: ['L2'], custom_fields: { e1_N: 3 } },
        },
      },
    }),
  });
  const out = await api.lookupContacts(['a@example.com'], { fieldId: 'e1_N' });
  assert.deepEqual(out.get('a@example.com'), { id: 'c1', listIds: ['L2'], nextMessage: 3 });
});

test('404 以外の失敗は握りつぶさない（呼び出し側が分割・停止を判断する）', async () => {
  const api = createSendGridMarketingApi({ apiKey: 'k', fetchImpl: async () => res(400, {}) });
  await assert.rejects(() => api.lookupContacts(['a@example.com']), /sendgrid_api:http_error/);
});
