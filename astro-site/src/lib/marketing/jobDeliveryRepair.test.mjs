/**
 * jobDeliveryRepair.test.mjs — **積みかけのジョブを壊さずに仕上げる**
 *   node --test src/lib/marketing/jobDeliveryRepair.test.mjs
 *
 * 守る条件:
 *   1. 元ジョブの `Recipients` が正本（計画を作り直さない）
 *   2. **既存の配信行は変更も削除もしない／既存の予約も release しない**
 *   3. 足りない鍵**だけ**を対象にする
 *   4. 全員ぶん読み戻せたときだけ `queue:unverified` を外す
 *   5. 1 通でも出ているジョブには触らない／読めなければ触らない（fail closed）
 *   6. 2 回実行しても安全／指定した jobId 以外に影響しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  canRepairJob, planJobDeliveryRepair, verifyRepairComplete, planClaimRelease,
  REPAIR_REJECT, REPAIR_CONFIRM, ACTIVE_DELIVERY_STATUS,
} from './jobDeliveryRepair.js';

const K = (n) => `key${String(n).padStart(4, '0')}`;
const mail = (n) => `u${n}@example.com`;
/** 本番と同じ形: 宛先 100 / 既存 queued 90 / 欠落 10 */
function scene({ total = 100, present = 90, status = 'queued' } = {}) {
  const recipients = Array.from({ length: total }, (_, i) => mail(i));
  const keyByEmail = new Map(recipients.map((e, i) => [e, K(i)]));
  const existingRows = Array.from({ length: present }, (_, i) => ({
    id: `recD${i}`, fields: { DeliveryKey: K(i), Status: status },
  }));
  return { recipients, keyByEmail, existingRows };
}
const job = (over = {}) => ([{
  id: 'recJob1',
  fields: { JobId: 'mkt-x-v1-abc-1', Status: 'PENDING', Notes: 'queue:unverified', ...over },
}]);

/* ── 1. 何が足りないかを決める ───────────────────────────── */

test('【要件】本番の形（宛先 100 / 既存 90）で、足りない 10 件だけを対象にする', () => {
  const p = planJobDeliveryRepair(scene());
  assert.equal(p.ok, true);
  assert.deepEqual(p.counts, { total: 100, present: 90, missing: 10 });
  assert.equal(p.missing.length, 10);
  // 既存 90 は対象に入らない
  for (const m of p.missing) assert.ok(Number(m.key.slice(3)) >= 90, `既存の鍵を対象にしている: ${m.key}`);
  assert.equal(p.expectedKeys.length, 100, '正本は元ジョブの 100 名');
});

test('⚠️【要件】既存行は「対象」に含めない（変更・削除の入力にしない）', () => {
  const p = planJobDeliveryRepair(scene());
  const missingKeys = new Set(p.missing.map((m) => m.key));
  for (let i = 0; i < 90; i += 1) {
    assert.equal(missingKeys.has(K(i)), false, `既存 ${K(i)} を触ろうとしている`);
  }
});

test('sent の行も「在る」とみなす（queued だけではない）', () => {
  const p = planJobDeliveryRepair(scene({ status: 'sent' }));
  assert.equal(p.counts.present, 90);
  assert.equal(ACTIVE_DELIVERY_STATUS.has('sent'), true);
});

test('⚠️【要件】cancelled の行が在る鍵は「不足」ではなく **衝突**（自動で直さない）', () => {
  const p = planJobDeliveryRepair(scene({ status: 'cancelled' }));
  assert.equal(p.ok, false, '⚠️ 巻き戻し済みの行を queued へ復活させようとしている');
  assert.equal(p.reason, REPAIR_REJECT.NON_ACTIVE_ROW);
  assert.equal(p.conflictCount, 90);
});

test('⚠️ 2 回目は対象 0 件（全部揃っていれば何もしない）', () => {
  const p = planJobDeliveryRepair(scene({ present: 100 }));
  assert.equal(p.counts.missing, 0);
  assert.deepEqual(p.missing, []);
});

/* ── 2. fail closed ─────────────────────────────────────── */

test('⚠️【要件】配信行を読めなければ「不足」と決めつけない', () => {
  const s = scene();
  const p = planJobDeliveryRepair({ ...s, existingRows: null });
  assert.equal(p.ok, false);
  assert.equal(p.reason, REPAIR_REJECT.ROWS_UNAVAILABLE);
});

test('⚠️【要件】計算した鍵に無い行が混ざっていたら中止（別物を掴んでいる）', () => {
  const s = scene();
  s.existingRows.push({ id: 'recAlien', fields: { DeliveryKey: 'keyFOREIGN', Status: 'queued' } });
  const p = planJobDeliveryRepair(s);
  assert.equal(p.ok, false);
  assert.equal(p.reason, REPAIR_REJECT.KEY_MISMATCH);
  assert.deepEqual(p.foreignRows, ['recAlien']);
});

test('⚠️ 鍵を作れない宛先が 1 人でも居れば中止（部分的に進めない）', () => {
  const s = scene({ total: 10, present: 5 });
  s.keyByEmail.delete(mail(7));
  const p = planJobDeliveryRepair(s);
  assert.equal(p.ok, false);
  assert.equal(p.reason, REPAIR_REJECT.STEP_UNRESOLVED);
});

test('⚠️ 宛先が無ければ中止', () => {
  assert.equal(planJobDeliveryRepair({ recipients: [], keyByEmail: new Map(), existingRows: [] }).reason,
    REPAIR_REJECT.NO_RECIPIENTS);
  assert.equal(planJobDeliveryRepair().reason, REPAIR_REJECT.NO_RECIPIENTS);
});

/* ── 3. どのジョブなら触ってよいか ───────────────────────── */

test('【要件】PENDING ＋ 印つき ＋ 未送信 のときだけ仕上げる', () => {
  const g = canRepairJob({ rows: job(), isMarketing: true, hasUnverified: true });
  assert.equal(g.ok, true);
  assert.equal(g.recordId, 'recJob1');
});

test('⚠️【要件】1 通でも出ているジョブには触らない', () => {
  for (const over of [{ SentCount: 1 }, { Status: 'SENT' }, { Status: 'EXECUTING' }]) {
    const g = canRepairJob({ rows: job(over), isMarketing: true, hasUnverified: true });
    assert.equal(g.ok, false, `${JSON.stringify(over)} を触ろうとしている`);
    assert.equal(g.reason, REPAIR_REJECT.ALREADY_SENT);
  }
});

test('⚠️ 印が無いジョブ（確認済み）は対象外', () => {
  const g = canRepairJob({ rows: job({ Notes: 'marketing campaign x v1' }), isMarketing: true, hasUnverified: false });
  assert.equal(g.reason, REPAIR_REJECT.NOT_UNVERIFIED);
});

test('⚠️ marketing 以外・見つからない・重複・読めない は触らない', () => {
  assert.equal(canRepairJob({ rows: job(), isMarketing: false, hasUnverified: true }).reason,
    REPAIR_REJECT.NOT_MARKETING);
  assert.equal(canRepairJob({ rows: [], isMarketing: true, hasUnverified: true }).reason,
    REPAIR_REJECT.NOT_FOUND);
  assert.equal(canRepairJob({ rows: [...job(), ...job()], isMarketing: true, hasUnverified: true }).reason,
    REPAIR_REJECT.DUPLICATE_ROWS);
  assert.equal(canRepairJob({ rows: null, isMarketing: true, hasUnverified: true }).reason,
    REPAIR_REJECT.ROWS_UNAVAILABLE);
  assert.equal(canRepairJob().reason, REPAIR_REJECT.ROWS_UNAVAILABLE);
});

test('⚠️ CANCELLED / 未知の状態も触らない', () => {
  assert.equal(canRepairJob({ rows: job({ Status: 'CANCELLED' }), isMarketing: true, hasUnverified: true }).reason,
    REPAIR_REJECT.NOT_PENDING);
});

/* ── 4. 揃ったときだけ印を外す ───────────────────────────── */

test('⚠️【要件】100/100 読み戻せたときだけ ok', () => {
  const exp = Array.from({ length: 100 }, (_, i) => K(i));
  assert.equal(verifyRepairComplete({ expectedKeys: exp, verifiedKeys: new Set(exp) }).ok, true);
});

test('⚠️ 1 件でも欠ければ ok にしない', () => {
  const exp = Array.from({ length: 100 }, (_, i) => K(i));
  const got = new Set(exp.slice(0, 99));
  const v = verifyRepairComplete({ expectedKeys: exp, verifiedKeys: got });
  assert.equal(v.ok, false);
  assert.equal(v.missing, 1);
});

test('⚠️ 読み戻せなければ ok にしない（「分からない」を「揃った」に倒さない）', () => {
  const exp = [K(0)];
  assert.equal(verifyRepairComplete({ expectedKeys: exp, verifiedKeys: null }).ok, false);
  assert.equal(verifyRepairComplete({ expectedKeys: exp }).ok, false);
  assert.equal(verifyRepairComplete().ok, false);
});

/* ── 5. guard: Function 側 ───────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const src = adminSrc.slice(
  adminSrc.indexOf('async function handleCampaignJobRepair'),
  adminSrc.indexOf('async function handleCampaignDeliveryRewire'),
);

test('⚠️ guard: 下見が既定で、jobId 必須・確認文字列つき', () => {
  assert.ok(src.length > 300, 'handler が見つからない');
  assert.match(adminSrc, /action === 'campaignJobRepair'/);
  assert.match(src, /const dryRun = !apply;/, '⚠️ 既定が下見でない');
  assert.match(src, /if \(!jobId\)/, '⚠️ jobId 必須になっていない');
  assert.equal(REPAIR_CONFIRM, 'REPAIR CAMPAIGN JOB');
  assert.match(src, /REPAIR_CONFIRM/);
});

test('⚠️【要件】guard: 既存の予約を release せず、足りない鍵だけ claim する', () => {
  // claim は「足りない鍵」だけ
  assert.match(src, /keys: plan\.missing\.map\(\(m\) => m\.key\)/,
    '⚠️ 全鍵を claim しようとしている');
  /*
   * release の対象は **書き込みを試みたかどうか**で変わる。
   *   - 書き込み **前**（顧客を引けない / 組み立て不足）… まだ 1 行も書いていないので
   *     `claimedKeys` を全部戻してよい
   *   - 書き込み **後**（upsert が throw）… 前半 batch は書けている可能性があるので
   *     **`rel.release`（行が無いと確かめられた鍵）だけ**
   */
  const upsertAt = src.indexOf('await upsertDeliveries(');
  assert.ok(upsertAt > 0, 'upsertDeliveries の呼び出しが見つからない');
  const before = src.slice(0, upsertAt);
  const after = src.slice(upsertAt);
  const target = (t) => [...t.matchAll(/releaseClaims\(\{[^}]*keys: ([a-zA-Z.]+)/g)].map((m) => m[1]);
  for (const t of target(before)) {
    assert.equal(t, 'claimedKeys', `⚠️ 書き込み前の release 対象が想定と違う: ${t}`);
  }
  assert.deepEqual(target(after), ['rel.release'],
    `⚠️ 書き込み後の release が「行が無いと確かめられた鍵」だけになっていない: ${JSON.stringify(target(after))}`);
});

test('⚠️【要件】guard: 既存の配信行を消さない・書き換えない', () => {
  for (const banned of ['deleteCustomerRecord', 'cancelDeliveries', 'rollbackQueue', "'cancelled'", 'DELETE']) {
    assert.equal(src.includes(banned), false, `⚠️ 既存行を壊す経路がある: ${banned}`);
  }
  // 行を足すのは claim できた分だけ
  assert.match(src, /plan\.missing\.filter\(\(m\) => claimedSet\.has\(m\.key\)\)/);
});

test('⚠️【要件】guard: 揃ったときだけ印を外す', () => {
  assert.match(src, /if \(verified\.ok\) \{[\s\S]*promotedAfterRepair = await promoteVerifiedJobs/,
    '⚠️ 揃う前に印を外している');
  assert.match(src, /verifyRepairComplete\(/);
});

test('⚠️ guard: 指定した jobId だけを見る（他ジョブに触れない）', () => {
  assert.match(src, /filterByFormula: `\{JobId\}='\$\{jobId\}'`/, '⚠️ jobId で絞っていない');
  assert.equal(/PENDING'\)/.test(src), false, '⚠️ 送信待ちジョブを一括で拾っている');
});

test('⚠️ guard: 元ジョブの Recipients を正本にする（計画を作り直さない）', () => {
  assert.match(src, /splitRecipients\(f\.Recipients\)/);
  for (const banned = 'planFingerprint', x = [banned]; x.length; x.pop()) {
    assert.equal(src.includes(banned), false, '⚠️ 計画を作り直している（JobId が変わる）');
  }
});

/* ── 6. 非 active 行は「不足」ではなく衝突（performUpsert が上書きするため）── */

test('⚠️【要件】failed / skipped / 空 の行が在る鍵も衝突として止める', () => {
  for (const st of ['failed', 'skipped', 'bounced', '']) {
    const p = planJobDeliveryRepair(scene({ total: 10, present: 3, status: st }));
    assert.equal(p.ok, false, `${st || '(空)'} を不足として扱っている`);
    assert.equal(p.reason, REPAIR_REJECT.NON_ACTIVE_ROW);
    assert.equal(p.conflicts[0].status, st || '(空)');
  }
});

test('⚠️【要件】同じ DeliveryKey の行が 2 つ以上あれば fail closed', () => {
  const s2 = scene({ total: 10, present: 3 });
  s2.existingRows.push({ id: 'recDup', fields: { DeliveryKey: K(0), Status: 'queued' } });
  const p = planJobDeliveryRepair(s2);
  assert.equal(p.ok, false);
  assert.equal(p.reason, REPAIR_REJECT.DUPLICATE_DELIVERY_ROWS);
  assert.deepEqual(p.conflictKeys, [K(0)]);
});

test('active な行だけなら従来どおり不足を数える（回帰）', () => {
  const p = planJobDeliveryRepair(scene());
  assert.equal(p.ok, true);
  assert.equal(p.counts.missing, 10);
});

/* ── 7. 書き込み失敗時に「成功済みの鍵」を絶対に release しない ────── */

test('⚠️【要件】前半 batch 成功＋後半 batch 失敗：書けた鍵は release しない', () => {
  // 30 件 claim して、最初の 20 件（2 batch）が書けたところで失敗した状況
  const claimedKeys = Array.from({ length: 30 }, (_, i) => K(100 + i));
  const rowsAfter = claimedKeys.slice(0, 20).map((k, i) => ({ id: `recW${i}`, fields: { DeliveryKey: k } }));
  const r = planClaimRelease({ claimedKeys, rowsAfter });
  assert.equal(r.ok, true);
  assert.equal(r.keep.length, 20, '⚠️ 書けた鍵を戻そうとしている（二重送信の芽）');
  assert.equal(r.release.length, 10);
  for (const k of claimedKeys.slice(0, 20)) {
    assert.equal(r.release.includes(k), false, `⚠️ 書けた鍵 ${k} を release している`);
  }
  for (const k of claimedKeys.slice(20)) assert.ok(r.release.includes(k));
});

test('⚠️【要件】読み戻せなければ 1 つも release しない（状態不明）', () => {
  const claimedKeys = [K(200), K(201)];
  const r = planClaimRelease({ claimedKeys, rowsAfter: null });
  assert.equal(r.ok, false);
  assert.deepEqual(r.release, [], '⚠️ 状態が分からないのに予約を戻している');
  assert.deepEqual(r.keep, claimedKeys);
  assert.equal(r.reason, REPAIR_REJECT.ROWS_UNAVAILABLE);
});

test('1 件も書けていなければ全部戻す（本来の release）', () => {
  const claimedKeys = [K(300), K(301)];
  const r = planClaimRelease({ claimedKeys, rowsAfter: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.release, claimedKeys);
  assert.deepEqual(r.keep, []);
});

test('全部書けていれば 1 つも戻さない', () => {
  const claimedKeys = [K(400), K(401)];
  const rowsAfter = claimedKeys.map((k, i) => ({ id: `recA${i}`, fields: { DeliveryKey: k } }));
  const r = planClaimRelease({ claimedKeys, rowsAfter });
  assert.deepEqual(r.release, []);
  assert.equal(r.keep.length, 2);
});

test('claim が 0 件なら何もしない', () => {
  assert.deepEqual(planClaimRelease({ claimedKeys: [], rowsAfter: null }).release, []);
  assert.equal(planClaimRelease().ok, true);
});

test('⚠️ guard: handler は「行が無いと確かめられた鍵」だけ release する', () => {
  assert.match(src, /planClaimRelease\(\{ claimedKeys, rowsAfter: rowsAfterFail \}\)/,
    '⚠️ 書き込み失敗時に read-back していない');
  assert.match(src, /keys: rel\.release/, '⚠️ release の対象が claimedKeys のままになっている');
  // ⚠️ **書き込みを試みたあと**に claimedKeys をまとめて戻していないこと
  const afterUpsert = src.slice(src.indexOf('await upsertDeliveries('));
  assert.equal(/releaseClaims\(\{ \.\.\.scope, keys: claimedKeys \}\)/.test(afterUpsert), false,
    '⚠️ 書き込み後に claimedKeys をまとめて release している');
  assert.match(src, /queue:unverified` は付いたまま/, '⚠️ fail closed の明示が無い');
});

/* ── 8. 配信行の組み立て（本番で 422 になった実バグ）────────────────
 *
 * ⚠️ `buildDeliveryRecords` が要るのは **`{ email, deliveryKey, recordId }`** と
 *    **`email → { jobId, recordId }`** の Map。`deliveryKey` を渡し忘れると
 *    `DeliveryKey: undefined` の行を作ろうとして **Airtable が 422** を返す
 *    （`performUpsert` のマージキーが空になるため）。2026-08-27 の本番 apply で発生。
 */

test('⚠️【要件】guard: 配信行に deliveryKey と job オブジェクトを渡している', () => {
  assert.match(src, /deliveryKey: m\.key/,
    '⚠️ deliveryKey を渡していない（DeliveryKey が undefined になり 422）');
  assert.match(src, /\{ jobId, recordId: gate\.recordId \}/,
    '⚠️ jobIdByEmail に文字列を渡している（buildDeliveryRecords は job.jobId を読む）');
  assert.match(src, /recordId: customerIdByEmail\.get\(m\.email\)/,
    '⚠️ CustomerRecordId を埋めていない');
});

test('⚠️【要件】guard: 組み立てた件数が合わなければ書かずに予約を戻す', () => {
  assert.match(src, /records\.length !== toCreate\.length/,
    '⚠️ 一部だけ組み立てられても書きに行く（黙って欠ける）');
  assert.match(src, /delivery_record_build_incomplete/);
});

test('⚠️ guard: 顧客を引けなければ書かずに予約を戻す', () => {
  assert.match(src, /customers_unavailable/);
  assert.match(src, /if \(customerIdByEmail === null\)/);
});
