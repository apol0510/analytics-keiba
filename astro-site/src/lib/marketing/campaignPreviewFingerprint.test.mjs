/**
 * campaignPreviewFingerprint.test.mjs — **確認した中身と送る中身が同じ**ことを保証する
 *   node --test src/lib/marketing/campaignPreviewFingerprint.test.mjs
 *
 * ## 背景（2026-08-27 の事故）
 *
 * repair が `queue:unverified` まで外した直後、`cron-marketing-rollout`（5 分ごと）が
 * background dispatcher を起動し **100 通が自動送信**された。
 * 対策として 3 段階へ分けた:
 *   ① repair … 不足行の補完だけ（**印は絶対に外さない**）
 *   ② preview … 印を保持したまま「外したら何人か」を read-only で確認
 *   ③ promote … 件数 **と** 指紋が一致したときだけ印を外す
 *
 * 守る条件:
 *   1. 件数が同じでも**送る相手が入れ替われば**指紋が変わる
 *   2. 並び順には依存しない
 *   3. 件数・指紋・確認文字列が揃わなければ promote を通さない
 *   4. アドレスを材料にしない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildPreviewFingerprint, verifyPromotePreview,
  PROMOTE_REJECT, PROMOTE_CONFIRM, PREVIEW_FINGERPRINT_VERSION,
} from './campaignPreviewFingerprint.js';

const K = (n) => `dk${String(n).padStart(6, '0')}`;
const base = (over = {}) => buildPreviewFingerprint({
  jobId: 'mkt-x-v1-abc-1',
  send: [K(1), K(2), K(3)],
  skip: [{ deliveryKey: K(4), reason: 'unsubscribed' }],
  ...over,
});

/* ── 1. 指紋の性質 ───────────────────────────────────────── */

test('【要件】並び順が違っても同じ指紋（同じ集合なら同じ）', () => {
  const a = base();
  const b = base({ send: [K(3), K(1), K(2)] });
  assert.equal(a.ok, true);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.wouldSend, 3);
  assert.equal(a.wouldSkip, 1);
});

test('⚠️【要件】件数が同じでも相手が 1 人入れ替われば指紋が変わる', () => {
  const a = base();
  const b = base({ send: [K(1), K(2), K(9)] });   // 3 人のまま 1 人差し替え
  assert.equal(a.wouldSend, b.wouldSend, '前提: 件数は同じ');
  assert.notEqual(a.fingerprint, b.fingerprint, '⚠️ 相手が変わったのに指紋が同じ');
});

test('⚠️ 除外理由が変われば指紋が変わる（同じ人でも扱いが違う）', () => {
  const a = base();
  const b = base({ skip: [{ deliveryKey: K(4), reason: 'provider_suppressed' }] });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('⚠️ 送る/送らないが入れ替われば指紋が変わる', () => {
  const a = base();
  const b = base({ send: [K(1), K(2), K(4)], skip: [{ deliveryKey: K(3), reason: 'unsubscribed' }] });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('jobId が違えば指紋が変わる（別ジョブの確認を流用させない）', () => {
  assert.notEqual(base().fingerprint, base({ jobId: 'mkt-x-v1-zzz-1' }).fingerprint);
});

test('指紋には版が入る（材料の作り方を変えたら古い指紋を通さない）', () => {
  assert.ok(base().fingerprint.startsWith(`${PREVIEW_FINGERPRINT_VERSION}:`));
});

test('⚠️ 送る相手の鍵が欠けていたら指紋を作らない', () => {
  const r = buildPreviewFingerprint({ jobId: 'j', send: [K(1), ''], skip: [] });
  assert.equal(r.ok, false);
  assert.equal(r.fingerprint, null);
});

test('⚠️ jobId が無ければ作らない / 引数が無くても例外にしない', () => {
  assert.equal(buildPreviewFingerprint({ jobId: '', send: [], skip: [] }).ok, false);
  assert.equal(buildPreviewFingerprint().ok, false);
});

test('⚠️【要件】アドレスを材料にしない（モジュールがアドレスを受け取らない）', () => {
  const src = readFileSync(fileURLToPath(new URL('./campaignPreviewFingerprint.js', import.meta.url)), 'utf8');
  assert.equal(/recipientEmail|RecipientEmail|\bemail\b/.test(src), false,
    '⚠️ アドレスを材料にしている');
  for (const m of src.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []) {
    assert.fail(`⚠️ アドレスが埋まっている: ${m}`);
  }
});

/* ── 2. promote の確認契約 ───────────────────────────────── */

const cur = { ok: true, fingerprint: 'v1:abc', wouldSend: 10, wouldSkip: 2 };
const ask = (over = {}) => verifyPromotePreview({
  confirmed: true, expectedWillSend: 10, previewFingerprint: 'v1:abc', current: cur, ...over,
});

test('【要件】件数と指紋の両方が一致したときだけ通る', () => {
  assert.equal(ask().ok, true);
});

test('⚠️【要件】件数が同じでも指紋が違えば通さない', () => {
  const r = ask({ previewFingerprint: 'v1:zzz' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(PROMOTE_REJECT.FINGERPRINT_CHANGED));
});

test('⚠️【要件】指紋が同じでも件数が違えば通さない', () => {
  const r = ask({ expectedWillSend: 9 });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes(PROMOTE_REJECT.COUNT_CHANGED));
});

test('⚠️ 確認文字列・件数・指紋のどれが欠けても通さない', () => {
  assert.ok(ask({ confirmed: false }).reasons.includes(PROMOTE_REJECT.NOT_CONFIRMED));
  assert.ok(ask({ expectedWillSend: undefined }).reasons.includes(PROMOTE_REJECT.MISSING_EXPECTED));
  assert.ok(ask({ previewFingerprint: '' }).reasons.includes(PROMOTE_REJECT.MISSING_FINGERPRINT));
  assert.equal(verifyPromotePreview().ok, false);
});

test('⚠️【要件】いまの preview を取れなければ通さない（状態不明で解除しない）', () => {
  for (const c of [null, undefined, { ok: false }, { ok: true, fingerprint: '' }]) {
    const r = ask({ current: c });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes(PROMOTE_REJECT.PREVIEW_UNAVAILABLE));
  }
});

test('確認文字列は画面から流し込めない値', () => {
  assert.equal(PROMOTE_CONFIRM, 'PROMOTE CAMPAIGN JOB');
});

/* ── 3. guard: Function 側 ───────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const promoteSrc = adminSrc.slice(
  adminSrc.indexOf('async function handleCampaignJobPromote'),
  adminSrc.indexOf('async function handleCampaignJobRepair'),
);

test('⚠️ guard: promote は 4 つ（jobId / 件数 / 指紋 / 確認文字列）を要求する', () => {
  assert.ok(promoteSrc.length > 300, 'handler が見つからない');
  assert.match(adminSrc, /action === 'campaignJobPromote'/);
  assert.match(promoteSrc, /req\.expectedWillSend/);
  assert.match(promoteSrc, /req\.previewFingerprint/);
  assert.match(promoteSrc, /PROMOTE_CONFIRM/);
  assert.match(promoteSrc, /verifyPromotePreview\(/);
});

test('⚠️ guard: promote は同じ dispatcher で preview を取り直す（判定を二重に書かない）', () => {
  assert.match(promoteSrc, /dispatchHandlerForPreview\(/, '⚠️ 判定を自前で書き直している');
  assert.match(promoteSrc, /dryRun: true/, '⚠️ preview 取得が dry-run でない');
});

test('⚠️ guard: 不一致は 409 で何も変えない', () => {
  assert.match(promoteSrc, /if \(!verdict\.ok\) \{[\s\S]*json\(409/, '⚠️ 不一致でも進んでいる');
  assert.match(promoteSrc, /unverifiedCleared: false, sideEffects: 'none'/);
});

test('⚠️ guard: promote の前提（PENDING / 印あり / 未送信）を canRepairJob で固める', () => {
  assert.match(promoteSrc, /canRepairJob\(/, '⚠️ 前提を確認していない');
});

test('⚠️【要件】guard: 応答に rollout / dispatch 状態と自動送信の警告を出す', () => {
  assert.match(promoteSrc, /MARKETING_ROLLOUT_ENABLED/);
  assert.match(promoteSrc, /MARKETING_CAMPAIGN_DISPATCH_ENABLED/);
  assert.match(promoteSrc, /autoSendPossible/);
  assert.match(promoteSrc, /自動送信され得ます/, '⚠️ 解除後に送られ得ることを伝えていない');
});

test('⚠️【要件】guard: rollout の read-only 表示に state と gate を出す', () => {
  assert.match(adminSrc, /rolloutState: state \? \{/, '⚠️ rollout state を出していない');
  for (const k of ['killed:', 'stage:', 'alwaysArmed:', 'armedFor:', 'pendingJobIds:']) {
    assert.ok(adminSrc.includes(k), `⚠️ ${k} を出していない`);
  }
  assert.match(adminSrc, /gates: \{[\s\S]*rolloutEnabled/, '⚠️ env ゲートを出していない');
});
