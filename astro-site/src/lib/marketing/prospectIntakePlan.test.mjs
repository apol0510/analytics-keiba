/**
 * prospectIntakePlan.test.mjs — Redis へ投入する内容の引き継ぎと、投入の安全条件
 *   node --test src/lib/marketing/prospectIntakePlan.test.mjs
 *
 * 守る条件:
 *   1. delivered は `sent` の行数だけ（`queued` を数えない = 打ち切りを早めない）
 *   2. 既送信の `DeliveryKey` をそのまま引き継ぐ（変えると二重送信）
 *   3. 反応の集計が無ければ **1 件も作らない**（開封した人を移さない）
 *   4. 移行対象（`migrate`）以外は 1 件も作らない
 *   5. 投入は env・確認文字列・反応の適用・parity の**4 つ全部**が揃って初めて許される
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  planProspectIntakeFromCustomers, summarizeDeliveriesForIntake,
  canIntake, INTAKE_BLOCK,
} from './prospectIntakePlan.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { MIGRATION_DECISION } from './prospectMigrationPlan.js';

const NOW = Date.UTC(2026, 7, 27);
const hashEmail = (e) => createHash('sha256').update(String(e), 'utf8').digest('hex');
const signalHash = (e) => hashEmail(e).slice(0, 32);

const imported = (email, over = {}) => ({
  id: `rec-${email}`,
  fields: { Email: email, Source: 'customer-import:imp-2026-08-09-001', 'プラン': 'Free', 'ポイント': 0, ...over },
});
const delivery = (email, key, status, sentAt) => ({
  fields: {
    EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email,
    Status: status, SentAt: sentAt,
  },
});

const noEngagement = { openHashes: new Set(), clickHashes: new Set() };

test('delivered は sent の行数だけ（queued を数えない）', () => {
  const d = [
    delivery('a@x.com', 'k1', 'sent', '2026-08-25T00:00:00Z'),
    delivery('a@x.com', 'k2', 'queued', '2026-08-26T00:00:00Z'),
    delivery('a@x.com', 'k3', 'failed', '2026-08-26T00:00:00Z'),
  ];
  const sum = summarizeDeliveriesForIntake(d).get('a@x.com');
  assert.equal(sum.sends, 2, 'sent + queued が試行');
  assert.equal(sum.delivered, 1, '⚠️ 届いた証拠があるのは sent だけ');
  assert.equal(sum.keys.size, 2, 'failed は台帳へ引き継がない');
});

test('最終送信時刻は最大値（次 step の間隔計算に使う）', () => {
  const sum = summarizeDeliveriesForIntake([
    delivery('a@x.com', 'k1', 'sent', '2026-08-20T00:00:00Z'),
    delivery('a@x.com', 'k2', 'sent', '2026-08-26T05:00:00Z'),
  ]).get('a@x.com');
  assert.equal(new Date(sum.lastSentAtMs).toISOString(), '2026-08-26T05:00:00.000Z');
});

test('引き継ぎ: sends / delivered / lastSentAt / DeliveryKey がそのまま入る', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('a@x.com')],
    deliveries: [delivery('a@x.com', 'k1', 'sent', '2026-08-26T01:00:00Z')],
    ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 1);
  const p = plan.prospects[0];
  assert.equal(p.email, 'a@x.com');
  assert.equal(p.batchId, 'imp-2026-08-09-001');
  assert.equal(p.sends, 1);
  assert.equal(p.delivered, 1);
  assert.equal(p.lastSentAt, '2026-08-26T01:00:00.000Z');
  assert.equal(p.state, PROSPECT_STATE.SENDING);
  assert.deepEqual(plan.ledgerKeys, ['k1'], '⚠️ 鍵はそのまま引き継ぐ（変えると二重送信）');
});

test('一度も送っていない人は NEW で入る', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('n@x.com')], deliveries: [],
    ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects[0].state, PROSPECT_STATE.NEW);
  assert.equal(plan.prospects[0].delivered, 0);
  assert.equal(plan.ledgerKeys.length, 0);
});

test('開封していた人は opens=1 で入る（あとで昇格対象になる）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('o@x.com')], deliveries: [],
    openHashes: new Set([signalHash('o@x.com')]), clickHashes: new Set(),
    hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects[0].opens, 1);
});

test('⚠️ 反応の集計を渡さなければ 1 件も作らない（開封した人を移さないため）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [imported('a@x.com')], deliveries: [], hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 0);
  assert.equal(plan.skipped.engagement_unavailable, 1);
});

test('⚠️ 移行対象以外は 1 件も作らない（理由別に数える）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [
      imported('a@x.com'),
      imported('b@x.com', { 'プラン': 'Premium' }),                    // 本人が動いた
      imported('c@x.com', { PremiumPlusEligibility: 'review' }),        // 運営付与のみ
      imported('d@x.com', { WithdrawalRequested: true }),               // 配信停止
      { id: 'e', fields: { Email: 'e@x.com', Source: 'nankan-analytics' } }, // 取り込み由来でない
    ],
    deliveries: [], ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 1);
  assert.equal(plan.prospects[0].email, 'a@x.com');
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_CONVERTED], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.REVIEW_OPERATOR_GRANT], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_SUPPRESSED], 1);
  assert.equal(plan.skipped[MIGRATION_DECISION.KEEP_NOT_IMPORTED], 1);
  assert.equal(plan.counts['対象'], 5);
  assert.equal(plan.counts['投入'], 1);
});

test('⚠️ batchId を復元できない行は投入しない（コホート判定が効かなくなる）', () => {
  const plan = planProspectIntakeFromCustomers({
    records: [{ id: 'x', fields: { Email: 'x@x.com', Source: 'customer-import:', 'プラン': 'Free' } }],
    deliveries: [], ...noEngagement, hashEmail, signalHash, nowMs: NOW,
  });
  assert.equal(plan.prospects.length, 0);
});

/* ── 投入の安全条件 ─────────────────────────────────────────── */

const okPlan = { prospects: [{ email: 'a@x.com' }] };

test('⚠️ 4 つ全部そろって初めて投入できる', () => {
  assert.equal(canIntake({
    writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true, plan: okPlan,
  }).allowed, true);

  for (const missing of ['writeEnabled', 'confirmed', 'engagementApplied', 'parityOk']) {
    const args = {
      writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true, plan: okPlan,
    };
    args[missing] = false;
    const r = canIntake(args);
    assert.equal(r.allowed, false, `${missing} が false でも投入できてしまう`);
    assert.equal(r.reasons.length, 1);
  }
});

test('⚠️ 投入対象 0 件を「成功」にしない', () => {
  const r = canIntake({
    writeEnabled: true, confirmed: true, engagementApplied: true, parityOk: true,
    plan: { prospects: [] },
  });
  assert.equal(r.allowed, false);
  assert.deepEqual(r.reasons, [INTAKE_BLOCK.NOTHING_TO_WRITE]);
});

test('既定（引数なし）は投入不可', () => {
  assert.equal(canIntake().allowed, false);
});

/* ── Function 側の配線（guard）──────────────────────────────── */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)), 'utf8');

test('guard: 投入は env で閉じており、既定は下見だけ', () => {
  assert.match(FN, /PROSPECT_MIGRATION_ENABLED/);
  assert.match(FN, /const dryRun = req\.apply !== true/, '既定が書き込みになっている');
  assert.match(FN, /canIntake\(/, '安全条件の単一源を通っていない');
});

test('⚠️ guard: 投入はページ単位の parity を確かめてから書く', () => {
  assert.match(FN, /computePageParity/);
  assert.match(FN, /parityOk: parity\.ok/, 'parity の結果がゲートへ渡っていない');
});

test('⚠️ guard: 投入経路が Customers を削除していない', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const j = FN.indexOf('function computePageParity');
  assert.ok(i > 0 && j > i);
  const body = FN.slice(i, j);
  assert.doesNotMatch(body, /method:\s*'DELETE'/, '投入で Customers を消している');
  assert.doesNotMatch(body, /records\[\]=/, '削除クエリらしきものがある');
  assert.match(body, /customersDeleted: 0/);
});

test('⚠️ guard: 既存 prospect を上書きしない（追加は absent のときだけ）', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const body = FN.slice(i, i + 9000);
  assert.match(body, /store\.addManyIfAbsent\(/);
  assert.doesNotMatch(body, /store\.write\(/, '上書き経路を直接呼んでいる');
});

test('⚠️ guard: 台帳へ書いたあと読み戻して確かめている', () => {
  const i = FN.indexOf('async function handleProspectIntake');
  const body = FN.slice(i, i + 9000);
  assert.match(body, /markDelivered\(/);
  assert.match(body, /filterDelivered\(/);
  assert.match(body, /unverified/);
});

test('guard: Customers は 1 ページずつ・取り込み由来だけを名指しで読む', () => {
  assert.match(FN, /fetchCustomersPage/);
  assert.match(FN, /LEFT\(\{Source\}/, '取り込み由来だけに絞っていない（全件走査になる）');
});

/* ── まとめ書き（投入の実体）──────────────────────────────── */

import { createProspectStore, emailHash, PROSPECT_ROOT } from './prospectStore.js';
import { buildProspect, PROSPECT_STATE as PS, applySuppression } from './prospectPolicy.js';

/** MGET / SET / SADD / SREM / EXISTS だけを持つ fake Redis */
function fakeRedis({ failOn = null } = {}) {
  const kv = new Map(); const sets = new Map();
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    if (failOn === op) throw new Error('redis down');
    if (op === 'MGET') return args.slice(1).map((k) => (kv.has(k) ? kv.get(k) : null));
    if (op === 'GET') return kv.has(args[1]) ? kv.get(args[1]) : null;
    if (op === 'SET') { kv.set(args[1], args[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(args[1]); return 1; }
    if (op === 'EXISTS') return kv.has(args[1]) ? 1 : 0;
    if (op === 'SADD') { let n = 0; for (const m of args.slice(2)) if (!setOf(args[1]).has(m)) { setOf(args[1]).add(m); n += 1; } return n; }
    if (op === 'SREM') { let n = 0; for (const m of args.slice(2)) if (setOf(args[1]).delete(m)) n += 1; return n; }
    if (op === 'SMEMBERS') return [...setOf(args[1])];
    if (op === 'SCARD') return setOf(args[1]).size;
    return 'OK';
  };
  const pipeline = async (cmds) => { const out = []; for (const c of cmds) out.push(await cmd(c)); return out; };
  return { cmd, pipeline, kv, sets };
}

const mk = (email) => {
  const p = buildProspect({ email, nowMs: NOW, batchId: 'b1', source: 'csv' });
  p.state = PS.NEW;
  return p;
};

test('まとめ書き: 新規だけ追加し、読み戻して確かめる', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const res = await store.addManyIfAbsent([mk('a@x.com'), mk('b@x.com')]);
  assert.deepEqual(res, { added: 2, existed: 0, blocked: 0, failed: 0, unverified: 0, reindexed: 0 });
  assert.equal((await store.load('a@x.com')).email, 'a@x.com');
  assert.deepEqual((await store.activeHashes()).sort(), [emailHash('a@x.com'), emailHash('b@x.com')].sort());
});

test('⚠️ まとめ書き: 既にあるレコードは上書きしない（送信回数を消さない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const p = mk('a@x.com'); p.sends = 3; p.delivered = 2; p.state = PS.SENDING;
  await store.addManyIfAbsent([p]);
  const again = await store.addManyIfAbsent([mk('a@x.com')]);   // sends 0 の新品
  assert.deepEqual(again, { added: 0, existed: 1, blocked: 0, failed: 0, unverified: 0, reindexed: 1 });
  const cur = await store.load('a@x.com');
  assert.equal(cur.sends, 3, '上書きされている');
  assert.equal(cur.delivered, 2);
});

test('⚠️ まとめ書き: 抑止台帳に載っている相手は復活させない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  await store.addIfAbsent(mk('z@x.com'));
  await store.recordSuppression({ email: 'z@x.com', nowMs: NOW, reason: 'bounce' });
  await store.purge(emailHash('z@x.com'));
  const res = await store.addManyIfAbsent([mk('z@x.com')]);
  assert.equal(res.blocked, 1);
  assert.equal(res.added, 0);
});

test('⚠️ まとめ書き: 読めない・書けないときは throw（部分結果を成功にしない）', async () => {
  for (const failOn of ['MGET', 'SADD']) {
    const r = fakeRedis({ failOn });
    const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => store.addManyIfAbsent([mk('a@x.com')]), `failOn=${failOn} で throw していない`);
  }
});

test('⚠️ まとめ書き: 配信候補以外の状態は受け付けない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  const sup = applySuppression({ prospect: mk('a@x.com'), nowMs: NOW, reason: 'bounce' }).prospect;
  await assert.rejects(() => store.addManyIfAbsent([sup]));
});

test('まとめ書き: 名前空間の外へは書かない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  await store.addManyIfAbsent([mk('a@x.com')]);
  for (const k of r.kv.keys()) assert.ok(String(k).startsWith(PROSPECT_ROOT), `${k} が名前空間の外`);
  for (const k of r.sets.keys()) assert.ok(String(k).startsWith(PROSPECT_ROOT), `${k} が名前空間の外`);
});

test('pipeline が無くても正しく書ける（退避経路）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });   // pipeline なし
  const res = await store.addManyIfAbsent([mk('a@x.com')]);
  assert.equal(res.added, 1);
});

test('guard: 投入ハンドラはまとめ書きを使っている（1 件ずつだと時間切れになる）', () => {
  assert.match(FN, /addManyIfAbsent\(/);
  const i = FN.indexOf('async function handleProspectIntake');
  const body = FN.slice(i, i + 9000);
  assert.doesNotMatch(body, /for \(const p of plan\.prospects\)/, '1 件ずつ書いている');
});

test('⚠️【本番で起きた】レコードはあるが索引に無い行を、索引へ載せ直す', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  await store.addManyIfAbsent([mk('a@x.com'), mk('b@x.com')]);

  // gateway timeout で SET は通ったが SADD が走らなかった状態を作る
  await r.cmd(['SREM', 'ak:prospect:index:active', emailHash('a@x.com')]);
  assert.equal((await store.activeHashes()).length, 1, '前提: 索引から 1 件消えている');
  assert.notEqual(await store.load('a@x.com'), null, '前提: レコード自体は残っている');

  const res = await store.addManyIfAbsent([mk('a@x.com'), mk('b@x.com')]);
  assert.equal(res.added, 0);
  assert.equal(res.existed, 2);
  assert.equal(res.reindexed, 2, '既存ぶんを索引へ載せ直していない');
  assert.equal((await store.activeHashes()).length, 2, '⚠️ 配信候補から永久に外れたまま');
});

test('⚠️ 索引の載せ直しは配信候補の状態にだけ効く（除外済みを復活させない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd, pipeline: r.pipeline });
  await store.addIfAbsent(mk('s@x.com'));
  await store.recordSuppression({ email: 's@x.com', nowMs: NOW, reason: 'bounce' });
  assert.equal((await store.activeHashes()).length, 0, '前提: 除外済みは索引に居ない');

  // 抑止台帳に載っているので blocked。索引へ戻さない
  const res = await store.addManyIfAbsent([mk('s@x.com')]);
  assert.equal(res.blocked, 1);
  assert.equal(res.reindexed, 0);
  assert.deepEqual(await store.activeHashes(), []);
});
