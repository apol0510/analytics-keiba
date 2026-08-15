/**
 * adminMarketingHandler.smoke.test.mjs — admin-marketing の**ハンドラを実際に呼ぶ**煙試験。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * ソース検査の guard は「何が書かれているか」しか見ない。
 * import 漏れのような**実行して初めて落ちる欠陥**は素通りし、本番で 500 になる。
 * 実際に 2026-08-02、`isMarketingJob` の import 漏れで `jobs` が本番 500 になった。
 * ここでは fetch を差し替えて**ネットワークなしでハンドラを起動**し、
 * 主要 action が 200 を返すことを確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-admin-secret';

/** Airtable / SendGrid への呼び出しを差し替える（**実 I/O を一切行わない**） */
function stubFetch(routes = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if (/api\.sendgrid\.com/.test(u)) {
      // 送信 API を叩いたら試験を落とす（admin は送信経路を持たない）
      throw new Error('admin must not call SendGrid');
    }
    for (const [pattern, body] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: true, status: 200, json: async () => ({ records: [] }) };
  };
  return calls;
}

async function invoke(payload) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

const JOB_ID = 'mkt-marketing-canary-v2-abc12345-1';
const scheduledRecords = {
  records: [{
    id: 'recJOB0000000001',
    fields: {
      JobId: JOB_ID, Status: 'PENDING', ScheduledFor: '2026-08-02T00:00:00.000Z',
      RecipientCount: 1, TargetPlan: 'campaign:marketing-canary', CreatedBy: 'admin-marketing',
      Notes: 'marketing campaign marketing-canary v2',
    },
  }],
};
const deliveryRecords = {
  records: [{
    id: 'recDEL0000000001',
    fields: {
      ScheduledEmailJobId: JOB_ID, EmailType: 'campaign', CampaignType: 'marketing-canary:v2',
      Status: 'queued', QueuedAt: '2026-08-02T00:00:00.000Z',
    },
  }],
};

test('smoke: jobs は 200 を返し、ジョブ一覧を組み立てられる（import 漏れを検知）', async () => {
  stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { statusCode, body } = await invoke({ action: 'jobs' });
  assert.equal(statusCode, 200, `jobs が ${statusCode} を返した: ${JSON.stringify(body).slice(0, 160)}`);
  assert.equal(Array.isArray(body.jobs), true);
  assert.equal(body.jobs.length, 1, 'マーケティングジョブを組み立てられていない');
  assert.equal(body.jobs[0].campaignId, 'marketing-canary');
  assert.equal(body.jobs[0].cancelable, true);
  assert.equal(typeof body.sendEnabled, 'boolean');
  assert.equal(typeof body.dispatchEnabled, 'boolean');
});

test('smoke: jobs の応答にメールアドレスを載せない', async () => {
  stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { body } = await invoke({ action: 'jobs' });
  assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(body)), false, '応答にアドレスが含まれる');
});

test('smoke: cancelJob は operationId が無ければ 400（書き込みに到達しない）', async () => {
  const calls = stubFetch({ ScheduledEmails: scheduledRecords });
  const { statusCode } = await invoke({ action: 'cancelJob', jobId: JOB_ID });
  assert.equal(statusCode, 400);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false, '検証前に書き込んでいる');
});

test('smoke: cancelJob は SENT のジョブを 409 で拒否する（送信済みを取り消さない）', async () => {
  const sent = { records: [{ ...scheduledRecords.records[0], fields: { ...scheduledRecords.records[0].fields, Status: 'SENT' } }] };
  const calls = stubFetch({ ScheduledEmails: sent });
  const { statusCode, body } = await invoke({ action: 'cancelJob', jobId: JOB_ID, operationId: 'op-1' });
  assert.equal(statusCode, 409);
  assert.equal(body.reason, 'already_sent');
  assert.equal(calls.some((c) => c.method === 'PATCH'), false, '送信済みジョブへ書き込んでいる');
});

test('smoke: cancelJob（PENDING）は queued の配信行とジョブだけを PATCH する', async () => {
  const calls = stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { statusCode, body } = await invoke({ action: 'cancelJob', jobId: JOB_ID, operationId: 'op-2' });
  assert.equal(statusCode, 200);
  assert.equal(body.cancelled, true);
  assert.equal(body.cancelledDeliveries, 1);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2, '想定外の書き込みがある');
  assert.equal(patches.some((c) => c.url.includes('Customers')), false, 'Customers を書き換えている');
});

test('smoke: 認証が無ければ 403（誰でも叩けない）', async () => {
  stubFetch({});
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'jobs' }) });
  assert.equal(res.statusCode, 403);
});

// ── 複数選択フィルター（配列契約）──────────────────────────────
// 画面は条件を配列で送る。**許可値以外は 400 で止める**（想定外の条件で顧客を抽出させない）。

test('smoke: customers は配列の条件を受け付ける（同項目 OR / 項目間 AND）', async () => {
  stubFetch({});
  const { statusCode, body } = await invoke({
    action: 'customers',
    contract: ['expired', 'none'],
    plan: ['premium', 'light'],
    lastLogin: ['login:30d', 'login:never'],
  });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 160));
  assert.deepEqual(body.appliedFilters.contract, ['expired', 'none']);
  assert.deepEqual(body.appliedFilters.plan, ['premium', 'light']);
  // 未指定は "all"（＝条件なし）
  assert.equal(body.appliedFilters.marketing, 'all');
});

test('smoke: customers は旧形式（単一文字列）も受け付ける', async () => {
  stubFetch({});
  const { statusCode, body } = await invoke({ action: 'customers', contract: 'expired' });
  assert.equal(statusCode, 200);
  assert.deepEqual(body.appliedFilters.contract, ['expired']);
});

test('smoke: customers は許可値以外を 400 で拒否する', async () => {
  const calls = stubFetch({});
  const { statusCode, body } = await invoke({ action: 'customers', contract: ['expired', "' OR 1=1"] });
  assert.equal(statusCode, 400);
  assert.match(String(body.error || ''), /contract/);
  assert.equal(calls.length, 0, '検証前に Airtable を読んでいる');
});

test('smoke: 同じ値を何度送っても 1 条件に潰れる（重複で件数を増やさない）', async () => {
  stubFetch({});
  const many = Array.from({ length: 40 }, () => 'expired');
  const { statusCode, body } = await invoke({ action: 'customers', contract: many });
  assert.equal(statusCode, 200);
  assert.deepEqual(body.appliedFilters.contract, ['expired']);
});

// ── 文面編集（今回送る分だけ）の API 契約 ─────────────────────────
// 「確認した文面だけが送れる」ことを、ハンドラを実際に呼んで確かめる。

test('smoke: preview は既定文面・上限・差し込みを返す（送信はしない）', async () => {
  const calls = stubFetch({});
  const { statusCode, body } = await invoke({ action: 'preview', campaignId: 'marketing-canary' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(typeof body.defaults.subject, 'string');
  assert.ok(body.defaults.body.length > 0, '既定本文を返していない');
  assert.equal(body.limits.subjectMax > 0, true);
  assert.deepEqual(body.placeholders.map((p) => p.token), ['{{salutation}}']);
  assert.ok(body.preview.html.includes('山田 様'), '完成形プレビューになっていない');
  // 配信停止はメールのフッターに必ず入る。プレビューでは**サンプル URL**で見せ、
  // 実顧客ごとの配信停止 URL（functions/unsubscribe?email=…）は出さない。
  assert.ok(body.preview.html.includes('配信を停止する'), 'フッターに配信停止が無い');
  assert.ok(body.preview.html.includes(body.preview.unsubscribePreviewUrl), 'サンプル URL になっていない');
  assert.equal(/functions\/unsubscribe\?email=/.test(body.preview.html), false,
    'プレビューに実顧客の配信停止 URL を出している');
  assert.equal(body.preview.html.includes('{{unsubscribeUrl}}'), false, '印が未解決のまま');
  assert.equal(typeof body.contentHash, 'string');
  assert.equal(body.contentEdited, false);
  assert.equal(calls.length, 0, 'プレビューで外部 API を叩いている');
});

test('【重要】24 通すべてを送らずに確認できる（管理者の事前レビュー）', async () => {
  // ⚠️ 24 通は **2 フェーズ**に分かれている（体験中 6 + 体験終了後 18）。
  //    運用者は「通し番号 1〜24」で確認したいので、両方をつないで見る。
  const PHASES = [
    { campaignId: 'light-trial-to-premium-sequence', steps: 6 },
    { campaignId: 'light-trial-post-expiry-sequence', steps: 18 },
  ];
  const seen = new Set();
  let touch = 0;
  for (const phase of PHASES) {
    for (let step = 1; step <= phase.steps; step += 1) {
      touch += 1;
      // eslint-disable-next-line no-await-in-loop
      const { statusCode, body } = await invoke({
        action: 'preview', campaignId: phase.campaignId, step,
      });
      assert.equal(statusCode, 200, `${touch} 通目が確認できない: ${JSON.stringify(body).slice(0, 200)}`);
      assert.equal(body.step, step, `${touch} 通目の step 指定が効いていない`);
      assert.ok(body.subject && body.subject.length > 0, `${touch} 通目に件名が無い`);
      assert.ok(body.preview && body.preview.html && body.preview.text, `${touch} 通目の完成形が無い`);
      assert.equal(/\{\{[a-zA-Z]+\}\}/.test(body.preview.html), false,
        `${touch} 通目に未解決の差し込みが残っている`);
      assert.ok(body.preview.html.includes('配信を停止する'), `${touch} 通目に配信停止が無い`);
      assert.ok(body.notice.includes('送信しません'), `${touch} 通目が送信しない旨を示していない`);
      seen.add(body.subject);
    }
  }
  assert.equal(touch, 24, '24 通そろっていない');
  assert.equal(seen.size, 24, '件名が重複している（同じ文面を送っている）');
});

test('各フェーズの上限を超えた文面は確認できない（存在しない通を作らない）', async () => {
  const over = await invoke({ action: 'preview', campaignId: 'light-trial-to-premium-sequence', step: 7 });
  assert.equal(over.statusCode, 400, '体験中フェーズに 7 通目がある');
  const overPost = await invoke({ action: 'preview', campaignId: 'light-trial-post-expiry-sequence', step: 19 });
  assert.equal(overPost.statusCode, 400, '終了後フェーズに 19 通目がある');
});

test('smoke: preview は編集した文面でも同じレンダラーで描く', async () => {
  stubFetch({});
  const { statusCode, body } = await invoke({
    action: 'preview', campaignId: 'marketing-canary',
    subject: '【KEIBA Analytics】編集した件名', body: '{{salutation}}\n\n編集した本文です。',
  });
  assert.equal(statusCode, 200);
  assert.equal(body.subject, '【KEIBA Analytics】編集した件名');
  assert.ok(body.preview.html.includes('編集した本文です。'));
  assert.equal(body.contentEdited, true);
});

test('smoke: 危険な文面は 400（HTML / 未定義変数 / 空件名）', async () => {
  stubFetch({});
  const cases = [
    { subject: '件名', body: '{{salutation}}\n<script>alert(1)</script>' },
    { subject: '件名', body: '{{salutation}}\n{{plan}}' },
    { subject: '   ', body: '{{salutation}}\n本文' },
    { subject: '件名', body: '   ' },
  ];
  for (const c of cases) {
    const { statusCode } = await invoke({ action: 'preview', campaignId: 'marketing-canary', ...c });
    assert.equal(statusCode, 400, `${JSON.stringify(c)} が通ってしまう`);
  }
});

test('smoke: 文面を変えると contentHash が変わる（同じなら同じ）', async () => {
  stubFetch({});
  const a = await invoke({ action: 'preview', campaignId: 'marketing-canary' });
  const b = await invoke({ action: 'preview', campaignId: 'marketing-canary' });
  assert.equal(a.body.contentHash, b.body.contentHash, '同じ文面で hash が変わる');
  const c = await invoke({
    action: 'preview', campaignId: 'marketing-canary',
    subject: a.body.defaults.subject, body: `${a.body.defaults.body}\n\n追記`,
  });
  assert.notEqual(c.body.contentHash, a.body.contentHash, '文面を変えても hash が同じ');
});

test('smoke: 確認した文面と違う hash では送信登録しない（409・Airtable を読まない）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const calls = stubFetch({});
  const { statusCode, body } = await invoke({
    action: 'send', campaignId: 'marketing-canary',
    recordIds: ['rec1'], planFingerprint: 'x'.repeat(64),
    subject: '件名', body: '{{salutation}}\n\n本文', contentHash: 'deadbeefdeadbeef',
  });
  delete process.env.MARKETING_CAMPAIGN_ENABLED;
  assert.equal(statusCode, 409, JSON.stringify(body).slice(0, 200));
  assert.match(String(body.error || ''), /文面/);
  assert.equal(calls.length, 0, '文面を確かめる前に顧客データを読んでいる');
});

test('smoke: 検証に落ちる文面では送信登録に進めない（400・Airtable を読まない）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const calls = stubFetch({});
  const { statusCode } = await invoke({
    action: 'send', campaignId: 'marketing-canary',
    recordIds: ['rec1'], planFingerprint: 'x'.repeat(64),
    subject: '件名', body: '{{salutation}}\n\n<script>x</script>', contentHash: 'whatever',
  });
  delete process.env.MARKETING_CAMPAIGN_ENABLED;
  assert.equal(statusCode, 400);
  assert.equal(calls.length, 0);
});
