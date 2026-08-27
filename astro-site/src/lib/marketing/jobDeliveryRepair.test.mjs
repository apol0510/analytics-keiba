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
  canRepairJob, planJobDeliveryRepair, verifyRepairComplete,
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

test('cancelled は「在る」とみなさない（巻き戻し済み）', () => {
  const p = planJobDeliveryRepair(scene({ status: 'cancelled' }));
  assert.equal(p.counts.present, 0);
  assert.equal(p.counts.missing, 100);
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
  // release は「自分が取った鍵で書き込みに失敗したとき」だけ
  const releases = [...src.matchAll(/releaseClaims\(\{[^}]*keys: ([a-zA-Z.]+)/g)].map((m) => m[1]);
  assert.deepEqual(releases, ['claimedKeys'],
    `⚠️ release の対象が想定と違う: ${JSON.stringify(releases)}`);
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
