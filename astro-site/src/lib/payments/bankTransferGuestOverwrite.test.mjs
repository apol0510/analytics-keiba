/**
 * bankTransferGuestOverwrite.test.mjs — 未ログインの入金完了報告が他のお客様のレコードを書き換えない（KAO registry 339e0bd2）
 *   node --test src/lib/payments/bankTransferGuestOverwrite.test.mjs
 *
 * `bank-transfer-application` Function を実際に呼び、Airtable / SendGrid / Upstash を fetch 差し替えで模擬する
 * （本番・外部サービスへは一切接続しない。アドレスは example.test のダミー）。
 *
 * 確かめること:
 *   1. 未ログインで既存のお客様のアドレスを入れても、そのレコードは 1 文字も変わらない
 *   2. 応答は「レコードがある / ない」で同じ（登録の有無を明かさない）
 *   3. 確定リンクはそのアドレス宛てにだけ届き、確定すると初めて反映される（1 回限り）
 *   4. ログイン中の本人は従来どおり自分のレコードを更新できる・他人のアドレスは 403
 *   5. 新規のお客様は従来どおり新規作成
 *   6. Light / Premium Plus の未ログイン申込はアドレスに関係なく同じ応答
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSession } from '../auth/session.js';
import { pendingApplicationKey } from './guestApplicationConfirm.js';

// 署名鍵はテストごとに乱数で作る（固定値をソースに置かない）
const SIGNING_KEY = randomBytes(32).toString('hex');
const REDIS_URL = 'https://redis.example.test';

let db; // recordId -> fields
let mails; // { to, subject, html }
let writes; // { method, recordId, fields }
let redis; // Map
let nextId;

function resetWorld() {
  db = new Map([
    ['recVictim', { Email: 'victim@example.test', '氏名': '本物 花子', Status: 'pending',
      RequestedPlan: 'Premium', RequestedPlanType: 'Lifetime', RequestedAmount: 98000, PaymentConfirmed: false,
      'プラン': 'Free' }],
    ['recPaid', { Email: 'paid@example.test', '氏名': '会員 太郎', Status: 'active', 'プラン': 'Premium',
      PlanType: 'Annual', '有効期限': '2099-01-01', PaidAt: '2026-01-01', LifetimeSanrenpuku: true }],
  ]);
  mails = [];
  writes = [];
  redis = new Map();
  nextId = 1;
}

function json(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function findByFormula(url) {
  const f = decodeURIComponent(new URL(url).searchParams.get('filterByFormula') || '');
  const m = /= '([^']*)'/.exec(f);
  const email = m ? m[1].replace(/\\'/g, "'") : '';
  return [...db.entries()]
    .filter(([, f2]) => String(f2.Email || '').trim().toLowerCase() === email)
    .map(([id, fields]) => ({ id, fields: { ...fields } }));
}

async function fakeFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.startsWith(REDIS_URL)) {
    const args = JSON.parse(opts.body);
    const [cmd, key, val, ...rest] = args;
    switch (String(cmd).toUpperCase()) {
      case 'SET':
        if (rest.includes('NX') && redis.has(key)) return json({ result: null });
        redis.set(key, val); return json({ result: 'OK' });
      case 'GET': return json({ result: redis.has(key) ? redis.get(key) : null });
      case 'GETDEL': { const v = redis.has(key) ? redis.get(key) : null; redis.delete(key); return json({ result: v }); }
      case 'DEL': redis.delete(key); return json({ result: 1 });
      default: return json({ result: null });
    }
  }
  if (u.startsWith('https://api.sendgrid.com/')) {
    const b = JSON.parse(opts.body);
    mails.push({ to: b.personalizations[0].to[0].email, subject: b.personalizations[0].subject, html: b.content[0].value });
    return json({}, 202);
  }
  if (u.startsWith('https://api.airtable.com/')) {
    const path = new URL(u).pathname;
    const m = /\/Customers\/([^/?]+)$/.exec(path);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      return db.has(id) ? json({ id, fields: { ...db.get(id) } }) : json({ error: 'NOT_FOUND' }, 404);
    }
    if (m && method === 'PATCH') {
      const id = decodeURIComponent(m[1]);
      const { fields } = JSON.parse(opts.body);
      writes.push({ method, recordId: id, fields });
      db.set(id, { ...db.get(id), ...fields });
      return json({ id, fields: db.get(id) });
    }
    if (/\/Customers$/.test(path) && method === 'POST') {
      const { fields } = JSON.parse(opts.body);
      const id = `recNew${nextId++}`;
      writes.push({ method, recordId: id, fields });
      db.set(id, { ...fields });
      return json({ id, fields });
    }
    if (/\/Customers$/.test(path) && method === 'GET') return json({ records: findByFormula(u) });
    return json({ records: [] });
  }
  return json({});
}

beforeEach(() => {
  resetWorld();
  for (const [k, v] of [
    ['AIRTABLE_API_KEY', 'dummy'], ['AIRTABLE_BASE_ID', 'appTEST'], ['SENDGRID_API_KEY', 'dummy'],
    ['SESSION_SIGNING_SECRET', SIGNING_KEY], ['UPSTASH_REDIS_REST_URL', REDIS_URL], ['UPSTASH_REDIS_REST_TOKEN', 'dummy'],
  ]) process.env[k] = v;
  delete process.env.MAKE_MAILHOOK_EMAIL;
  delete process.env.URL;
  globalThis.fetch = fakeFetch;
});

globalThis.exports = {};
globalThis.module = { exports: globalThis.exports };
await import('../../../netlify/functions/bank-transfer-application.js');
const { handler } = globalThis.exports;

const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
function form(over = {}) {
  return {
    fullName: '攻撃 者', email: 'victim@example.test', transferDate: today, transferTime: '10:00',
    transferAmount: '49800', transferName: 'ｺｳｹﾞｷ', productName: 'Premium Annual (¥49,800/年)',
    paymentCompletedConfirm: true, timestamp: new Date().toISOString(), ...over,
  };
}
async function cookieFor(recordId) {
  const { token } = await createSession({
    secret: SIGNING_KEY, sub: recordId, plan: 'premium', venueAccess: 'all', now: Date.now(), ttlMs: 3600_000,
  });
  return `ak_session=${token}`;
}
async function call(body, cookie) {
  const r = await handler({
    httpMethod: 'POST', headers: cookie ? { cookie } : {}, body: JSON.stringify(body),
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
function tokenFromMail(mail) {
  const m = /#t=([A-Za-z0-9_-]{43})/.exec(mail.html);
  return m ? m[1] : null;
}

test('未ログインで既存のお客様のアドレス → レコードを 1 文字も書き換えない', async () => {
  const before = structuredClone(db.get('recVictim'));
  const r = await call(form());
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.deepEqual(db.get('recVictim'), before, '氏名・申込内容・PaymentConfirmed・Status が変わった');
  assert.equal(writes.length, 0, 'Airtable へ書き込んだ');
});

test('応答は登録の有無で同じ（アドレスの列挙をさせない）', async () => {
  const existing = await call(form({ email: 'victim@example.test' }));
  const fresh = await call(form({ email: 'nobody@example.test' }));
  assert.equal(existing.status, fresh.status);
  assert.deepEqual(existing.body, fresh.body);
  // 有料会員のアドレス（すでに持っている商品の判定に当たりうる）でも同じ
  const paid = await call(form({ email: 'paid@example.test', productName: 'Premium Sanrenpuku (¥10,000)', transferAmount: '10000' }));
  const paidFresh = await call(form({ email: 'nobody2@example.test', productName: 'Premium Sanrenpuku (¥10,000)', transferAmount: '10000' }));
  assert.equal(paid.status, paidFresh.status);
  assert.deepEqual(paid.body, paidFresh.body);
});

test('確定リンクはそのアドレス宛てにだけ届き、トークン本体は Redis に保存しない', async () => {
  await call(form());
  const confirmMails = mails.filter((m) => m.subject.includes('ご確認のお願い'));
  assert.equal(confirmMails.length, 1);
  assert.equal(confirmMails[0].to, 'victim@example.test');
  const token = tokenFromMail(confirmMails[0]);
  assert.ok(token, '確定リンクにトークンが無い');
  assert.ok(confirmMails[0].html.includes('/bank-transfer/confirm/#t='), 'トークンは # 以降に載せる');
  assert.ok(redis.has(pendingApplicationKey(token)));
  for (const k of redis.keys()) assert.ok(!k.includes(token), 'トークン本体が鍵に入っている');
  // 申込者（攻撃者）への応答にトークンは含まれない
  const r = await call(form({ email: 'victim@example.test' }));
  assert.ok(!JSON.stringify(r.body).includes('#t='));
});

test('本人が確定すると初めて反映される・1 回限り・推測したトークンは通らない', async () => {
  await call(form({ fullName: '本物 花子', productName: 'Premium Annual (¥49,800/年)' }));
  const token = tokenFromMail(mails.find((m) => m.subject.includes('ご確認のお願い')));

  const guess = await call({ action: 'confirm_application', token: 'A'.repeat(43) });
  assert.equal(guess.status, 404);
  assert.equal(writes.length, 0);

  const preview = await call({ action: 'preview_application', token });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.application.productName, 'Premium Annual (¥49,800/年)');
  assert.ok(!JSON.stringify(preview.body).includes('victim@example.test'), 'プレビューにアドレスを出さない');
  assert.equal(writes.length, 0, 'プレビューで書き込んだ');

  const ok = await call({ action: 'confirm_application', token });
  assert.equal(ok.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].recordId, 'recVictim');
  assert.equal(writes[0].fields.RequestedPlan, 'Premium');
  assert.equal(writes[0].fields.RequestedPlanType, 'Annual');
  assert.ok(!('プラン' in writes[0].fields) && !('有効期限' in writes[0].fields), '確定でも昇格はしない');
  assert.ok(mails.some((m) => m.subject.includes('本人確認済み')), '管理者へ本人確認済みの通知が無い');

  const again = await call({ action: 'confirm_application', token });
  assert.equal(again.status, 404, '同じリンクで 2 回反映できる');
  assert.equal(writes.length, 1);
});

test('「心当たりがない」で取り消すと、そのリンクでは反映できない', async () => {
  await call(form());
  const token = tokenFromMail(mails.find((m) => m.subject.includes('ご確認のお願い')));
  const c = await call({ action: 'cancel_application', token });
  assert.equal(c.status, 200);
  const r = await call({ action: 'confirm_application', token });
  assert.equal(r.status, 404);
  assert.equal(writes.length, 0);
});

test('別のお客様の確定リンクで自分以外のレコードは変わらない（他ユーザーへの影響なし）', async () => {
  const paidBefore = structuredClone(db.get('recPaid'));
  await call(form({ email: 'victim@example.test', fullName: '本物 花子' }));
  const token = tokenFromMail(mails.find((m) => m.subject.includes('ご確認のお願い')));
  await call({ action: 'confirm_application', token });
  assert.deepEqual(db.get('recPaid'), paidBefore);
  assert.ok(writes.every((w) => w.recordId === 'recVictim'));
});

test('ログイン中の本人は従来どおり自分のレコードを更新できる（正規の流れ）', async () => {
  const cookie = await cookieFor('recPaid');
  const r = await call(form({ email: 'paid@example.test', fullName: '会員 太郎', productName: 'Premium Lifetime (¥98,000)', transferAmount: '98000' }), cookie);
  assert.equal(r.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].recordId, 'recPaid');
  assert.equal(writes[0].fields.RequestedPlanType, 'Lifetime');
  assert.equal(db.get('recPaid').Status, 'active', 'active 会員を pending に落とした');
  assert.ok(!mails.some((m) => m.subject.includes('ご確認のお願い')), 'ログイン中の本人には確認は不要');
});

test('ログイン中に他人のアドレスで申し込むと 403・どちらのレコードも変わらない', async () => {
  const cookie = await cookieFor('recPaid');
  const before = structuredClone([...db.entries()]);
  const r = await call(form({ email: 'victim@example.test' }), cookie);
  assert.equal(r.status, 403);
  assert.deepEqual([...db.entries()], before);
  assert.equal(writes.length, 0);
});

test('新規のお客様（レコードなし）は従来どおり新規作成・pending', async () => {
  const r = await call(form({ email: 'new@example.test', fullName: '新規 次郎' }));
  assert.equal(r.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].fields.Email, 'new@example.test');
  assert.equal(writes[0].fields.Status, 'pending');
  assert.ok(!mails.some((m) => m.subject.includes('ご確認のお願い')));
});

test('確定前にレコードのアドレスが変わっていたら反映しない', async () => {
  await call(form());
  const token = tokenFromMail(mails.find((m) => m.subject.includes('ご確認のお願い')));
  db.set('recVictim', { ...db.get('recVictim'), Email: 'changed@example.test' });
  const r = await call({ action: 'confirm_application', token });
  assert.equal(r.status, 409);
  assert.equal(writes.length, 0);
});

test('Light / Premium Plus の未ログイン申込はアドレスに関係なく同じ応答で止まる', async () => {
  for (const productName of ['Light Annual (¥24,800)', 'Premium Plus (¥68,000)']) {
    const a = await call(form({ email: 'paid@example.test', productName }));
    const b = await call(form({ email: 'nobody@example.test', productName }));
    assert.equal(a.status, 403, productName);
    assert.deepEqual(a.body, b.body, productName);
    assert.equal(a.body.code, 'login_required');
  }
  assert.equal(writes.length, 0);
  assert.equal(mails.length, 0);
});

test('利用者の入力は HTML メールにエスケープして入る', async () => {
  await call(form({ email: 'new2@example.test', fullName: '<a href="https://evil.example">x</a>', remarks: '<script>1</script>' }));
  for (const m of mails) {
    assert.ok(!m.html.includes('<a href="https://evil.example">'), m.subject);
    assert.ok(!m.html.includes('<script>1</script>'), m.subject);
  }
});
