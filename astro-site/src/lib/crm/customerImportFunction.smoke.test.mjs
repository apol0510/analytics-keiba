/**
 * customerImportFunction.smoke.test.mjs — 下見 API を**ネットワークなし**で通す
 *   node --test src/lib/crm/customerImportFunction.smoke.test.mjs
 *
 * guard テストはソース文字列を見るだけなので、「実際に呼んだら何が返るか」は別に確かめる。
 * ここでは Airtable / SendGrid を差し替え、**外部へ 1 回も出ない**状態で
 *   - 応答が件数だけであること（アドレス・氏名が 1 文字も混ざらないこと）
 *   - 停止リストを確認できないときに fail closed になること
 *   - 取り込みの実行が 501 で断られること
 *   - 認可・メソッドの入口が閉じていること
 * を確認する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FN_URL = new URL('../../../netlify/functions/admin-customer-import.js', import.meta.url);

const SECRET = 'test-secret-for-smoke';
const CSV = 'メールアドレス,氏名\nsomeone@example.com,山田太郎\nbad-address,佐藤\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * 外部呼び出しを差し替える。**想定外の宛先を叩いたら例外**にして気づけるようにする。
 * @param {{ suppressionOk?: boolean, customers?: Array<object> }} opts
 */
function installFetch({ suppressionOk = false, customers = [] } = {}) {
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('api.airtable.com')) {
      return { ok: true, json: async () => ({ records: customers }) };
    }
    if (u.includes('api.sendgrid.com')) {
      if (!suppressionOk) return { ok: false, status: 403, text: async () => 'forbidden' };
      return { ok: true, json: async () => ({ result: [] }) };
    }
    throw new Error(`想定外の外部呼び出し: ${u}`);
  };
  return seen;
}

async function callHandler(body, { headers } = {}) {
  process.env.MARKETING_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'dummy';
  process.env.AIRTABLE_BASE_ID = 'dummy';
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'canary@example.com';
  delete process.env.CUSTOMER_IMPORT_WRITE_ENABLED;
  const { handler } = await import(FN_URL);
  const res = await handler({
    httpMethod: 'POST',
    headers: headers || { 'x-admin-secret': SECRET },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, raw: res.body, json: JSON.parse(res.body || '{}') };
}

test('smoke: 受け入れ仕様を返す（副作用なし）', async () => {
  installFetch();
  const r = await callHandler({ action: 'spec' });
  assert.equal(r.status, 200);
  assert.equal(r.json.sideEffects, 'none');
  assert.deepEqual(r.json.requiredColumns, ['email']);
  assert.ok(r.json.encodings.join(' ').includes('Shift_JIS'));
});

test('smoke: 下見の応答は件数だけ（アドレス・氏名を 1 文字も含まない）', async () => {
  installFetch({ suppressionOk: true });
  const r = await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sideEffects, 'none');
  assert.equal(r.json.counts.総行数, 2);
  assert.equal(r.json.counts.balanced, true);
  // ⚠️ 応答本文そのものを検査する（入れ子のどこかに紛れていても落ちる）
  for (const pii of ['someone@example.com', '山田太郎', '佐藤', '@example.com']) {
    assert.equal(r.raw.includes(pii), false, `応答に ${pii} が含まれている`);
  }
  assert.equal(/\brec[A-Za-z0-9]{14}\b/.test(r.raw), false, '応答に recordId が含まれている');
});

test('smoke: 不正なメールは除外として数える', async () => {
  installFetch({ suppressionOk: true });
  const r = await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  assert.equal(r.json.reasonCounts.invalid_email, 1);
  assert.equal(r.json.counts.除外 >= 1, true);
});

test('smoke: 停止リストを確認できなければ要確認へ倒す（fail closed）', async () => {
  installFetch({ suppressionOk: false });
  const r = await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  assert.equal(r.json.akSnapshot.providerSuppressionAvailable, false);
  assert.equal(r.json.reasonCounts.provider_suppressed, 1);
  assert.equal(r.json.counts.新規追加候補, 0, '確認できないのに取り込もうとしている');
  assert.match(r.json.akSnapshot.providerNote, /要確認/);
});

test('smoke: 必須列が無い CSV は 400 で断る', async () => {
  installFetch({ suppressionOk: true });
  const r = await callHandler({ action: 'previewCsv', contentBase64: b64('氏名,備考\n山田,メモ\n') });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.deepEqual(r.json.missingColumns, ['email']);
  assert.equal(r.raw.includes('山田'), false, 'エラー応答に値が混ざっている');
});

test('smoke: 取り込みの実行は 501（書き込み経路が無い）', async () => {
  installFetch();
  const r = await callHandler({ action: 'run' });
  assert.equal(r.status, 501);
  assert.equal(r.json.writeEnabled, false);
});

test('smoke: 下見では書き込み無効と明示する', async () => {
  installFetch({ suppressionOk: true });
  const r = await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  assert.equal(r.json.writeEnabled, false);
  assert.match(r.json.written, /まだ取り込まれていません/);
  assert.match(r.json.writeNote, /別承認/);
});

test('smoke: secret が違えば 403 / GET は 405', async () => {
  installFetch();
  const wrong = await callHandler({ action: 'spec' }, { headers: { 'x-admin-secret': 'wrong' } });
  assert.equal(wrong.status, 403);

  const { handler } = await import(FN_URL);
  const get = await handler({ httpMethod: 'GET', headers: {}, body: '' });
  assert.equal(get.statusCode, 405);
});

test('smoke: 下見は Airtable の書き込み URL を一度も叩かない', async () => {
  const seen = installFetch({ suppressionOk: true });
  await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  assert.ok(seen.length > 0, '外部を一度も呼んでいない（読み取りが動いていない）');
  // 読むのは Customers / EmailBlacklist / suppression だけ。
  // `Customers/listRecords` は Airtable の**読み取り** API（CSV のアドレスを名指しで引くため
  // 長い formula を POST body に載せる）。書き込み URL ではない。
  for (const u of seen) {
    const ok = /\/v0\/[^/]+\/(Customers|EmailBlacklist)\?/.test(u)
      || /\/v0\/[^/]+\/Customers\/listRecords$/.test(u)
      || u.includes('api.sendgrid.com');
    assert.equal(ok, true, `想定外の宛先を呼んでいる: ${u}`);
  }
});

test('【重要】下見は Customers を全件走査せず、CSV のアドレスを名指しで引く', async () => {
  const seen = installFetch({ suppressionOk: true });
  await callHandler({ action: 'previewCsv', contentBase64: b64(CSV) });
  // 無フィルタの Customers 一覧（?pageSize=... だけ）を叩いていないこと。
  // 叩くと先頭 6,000 件しか見えず、既存会員が「AK に居ない」に化けて二重登録になる
  const bareList = seen.filter((u) => /\/v0\/[^/]+\/Customers\?/.test(u) && !/filterByFormula/.test(u));
  assert.deepEqual(bareList, [], `Customers を無フィルタで走査している: ${bareList[0] || ''}`);
  assert.ok(
    seen.some((u) => /\/Customers\/listRecords$/.test(u)),
    'CSV のアドレスによる名指し取得が行われていない',
  );
});
