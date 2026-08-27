/**
 * verify-prospect-migration.mjs — 移行後の検証（**read-only**）
 *
 *   ADMIN_SECRET=... node scripts/verify-prospect-migration.mjs [at]
 *
 * 索引の窓（`prospectSequenceCheck`）に分割して呼び、合算して最終判定を出す。
 * 判定そのものは単一源 `src/lib/marketing/prospectVerification.js`（純粋）が決める。
 *
 * ## ⚠️ 走査は止めない / 最終判定は fail closed
 *
 *   - 値を読めない人（`missing`）が居ても**走査は最後まで続ける**。
 *     窓は `scanned`（索引の消費件数）で進むので位置はずれない。
 *     途中で打ち切ると**全体で何件欠けているのかが分からなくなる**
 *   - **`missing` 合計が 1 件でもあれば Customers 削除可能判定は出さない**。
 *     何通目まで送ったかを確かめられていない相手の行を消すと、進行の復元手段が消える
 *
 * このスクリプトは**読み取りだけ**。Customers も Redis も 1 バイトも書かない。
 */
import { buildProspectVerificationVerdict, describeVerdict } from '../src/lib/marketing/prospectVerification.js';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CAMPAIGN = 'campaign-discount-free';
const LIMIT = 2000;
const MAX_WINDOWS = 40;
const MAX_ATTEMPTS = 3;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) {
  console.error('✖ ADMIN_SECRET が要る');
  process.exit(1);
}
const AT = process.argv[2] || '2026-08-31T09:00:00+09:00';

const call = (body) => fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const sum = (a, b) => {
  for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v;
  return a;
};

/** 索引を窓で走査する。**値の欠けを理由に打ち切らない**（最後まで読む）*/
async function walkOnce() {
  const windows = [];
  const t = {
    returned: 0, restoredDeliveries: 0, indexSize: null, pool: null,
    nowDue: 0, nowWaiting: 0, nowStopped: 0, nowCompleted: 0, nowDueByStep: {}, nowStop: {},
    atDue: 0, atDueByStep: {}, atStopped: 0, atStop: {},
    deliveredMax: 0, deliveredHist: {}, withOpens: 0,
  };
  let offset = 0;
  let digest = null;

  for (let i = 0; i < MAX_WINDOWS; i += 1) {
    const body = {
      action: 'prospectSequenceCheck', campaignId: CAMPAIGN, at: AT, offset, limit: LIMIT,
    };
    if (digest) body.digest = digest;
    // eslint-disable-next-line no-await-in-loop -- 窓は前の応答の nextOffset に依存する
    const r = await call(body);
    if (r.status === 409) return { retry: true };
    if (r.status !== 200 || !r.json) {
      console.error('✖ HTTP', r.status, JSON.stringify(r.json || {}).slice(0, 300));
      process.exit(1);
    }
    const j = r.json;
    digest = digest || j.window.digest;
    // ⚠️ 応答にアドレスを混ぜていないこと（PII を端末へ落とさない）
    if (JSON.stringify(j).includes('@')) {
      console.error('✖ 応答にアドレスが混ざっている');
      process.exit(1);
    }

    windows.push({
      offset: j.window.offset,
      // ⚠️ 応答の値をそのまま使う（ここで導出し直さない）。無ければ判定側が不許可にする
      scanned: j.window.scanned,
      returned: j.window.returned,
      missing: j.window.missing ?? 0,
      indexSize: j.window.indexSize,
      digest: j.window.digest,
      ok: true,
    });

    t.indexSize = j.window.indexSize;
    t.pool = j.pool;
    t.returned += j.window.returned;
    t.restoredDeliveries += j.ledger.restoredDeliveries;
    t.deliveredMax = Math.max(t.deliveredMax, j.delivered.max);
    t.withOpens += j.delivered.withOpens;
    sum(t.deliveredHist, j.delivered.histogram);
    if (j.now) {
      t.nowDue += j.now.due; t.nowWaiting += j.now.waiting;
      t.nowStopped += j.now.stopped; t.nowCompleted += j.now.completed;
      sum(t.nowDueByStep, j.now.dueByStep); sum(t.nowStop, j.now.byStopReason);
    }
    if (j.at && j.at.summary) {
      t.atDue += j.at.summary.due; t.atStopped += j.at.summary.stopped;
      sum(t.atDueByStep, j.at.summary.dueByStep); sum(t.atStop, j.at.summary.byStopReason);
    }

    offset = j.window.nextOffset;
    // ⚠️ 打ち切るのは**索引を読み切ったとき**だけ。値が欠けていても続ける
    if (offset === null || offset === undefined) break;
  }
  return { windows, totals: t };
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  // eslint-disable-next-line no-await-in-loop -- やり直しは直列
  const run = await walkOnce();
  if (run.retry) {
    console.error(`⚠️ 索引が変わった（attempt ${attempt}）→ 最初からやり直す`);
    continue;
  }

  const verdict = buildProspectVerificationVerdict({ windows: run.windows });
  console.log(JSON.stringify({ ...run.totals, verdict }, null, 1));
  console.log(describeVerdict(verdict));

  // ⚠️ **不許可なら非ゼロで落ちる。** 「消してよい」は許可のときしか出さない
  if (!verdict.customersDeletionAllowed) {
    console.error(`✖ 最終検証 FAIL: ${verdict.reasons.join(', ')}`);
    if (verdict.totals.missing > 0) {
      console.error(`   値を読めなかった prospect が ${verdict.totals.missing} 件ある。`
        + '   何通目まで送ったかを確かめられていないので、Customers は削除できない。');
    }
    process.exit(1);
  }
  console.log('✅ 最終検証 PASS（値の欠け 0・索引を最後まで走査）');
  process.exit(0);
}
console.error('✖ 3 回やり直しても索引が安定しなかった');
process.exit(1);
