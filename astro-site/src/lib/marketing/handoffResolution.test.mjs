/**
 * handoffResolution.test.mjs — 引き継ぎは**正の証拠**でしか消さない
 *   node --test src/lib/marketing/handoffResolution.test.mjs
 *
 * 消してよいのは「その付与 operation の対象者**全員**の Step1 が
 * 配信台帳に載っている」と確認できたときだけ。
 * 使ってはいけない根拠（本番で誤りが実証された）:
 *   - dry-run の「対象 0 件」   … まだ Airtable に見えていないだけのことがある
 *   - 関所の `outstandingStep1 === 0` … **同じ読み取り遅延で 0 に見える**（#362）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEmptyHandoff, HANDOFF_ACTION, MAX_EMPTY_HANDOFF_ATTEMPTS } from './handoffResolution.js';
import { proveHandoffQueued, PROOF_FAIL } from './handoffQueueProof.js';
import { normalizeRolloutState } from './rolloutPlan.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { getBrandConfig } from '../newsletter/brand-config.js';

const OP = 'light-trial-2026-08-18-b7';
const CAMPAIGN = getCampaign('light-trial-to-premium-sequence', { includeDisabled: true });
const BRAND = 'analytics-keiba';   // `lightTrialPlanLoader.js` の BRAND と同じ
const FROM = getBrandConfig(BRAND).defaultFromEmail;
const STEP1 = resolveSequenceStep(CAMPAIGN, 1);
const emails = ['a@example.com', 'b@example.com', 'c@example.com'];
const keyOf = (email) => computeCampaignDeliveryKey({ campaign: STEP1, recipientEmail: email, brand: BRAND, fromEmail: FROM });

/** Airtable の偽実装（Customers → 対象者 / CampaignDeliveries → 配信行） */
function fakeAirtable({ members = emails, deliveries = [], failCustomers = false, failDeliveries = false } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/Customers')) {
      if (failCustomers) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ records: members.map((e, i) => ({ id: `rec${i}`, fields: { Email: e } })) }) };
    }
    if (u.includes('/CampaignDeliveries')) {
      if (failDeliveries) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ records: deliveries }) };
    }
    return { ok: true, json: async () => ({ records: [] }) };
  };
}

const deliveryRow = (email, status = 'queued') => ({ fields: { DeliveryKey: keyOf(email), Status: status } });

const prove = (opts) => proveHandoffQueued({
  apiKey: 'k', baseId: 'b', operationId: OP, campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM,
  fetchImpl: fakeAirtable(opts),
});

// ── 1〜3: 正の証拠でしか畳まない ────────────────────────────────

test('【重要】queue 済みの証拠が無ければ handoff を保持（関所 0 でも消さない）', async () => {
  const proof = await prove({ deliveries: [] });     // 台帳に 1 件も無い
  assert.equal(proof.ok, false);
  assert.equal(proof.reason, PROOF_FAIL.NOT_ALL_QUEUED);
  // 関所が 0 に見えていても関係なく保持
  const v = resolveEmptyHandoff({ proof, attempts: 0 });
  assert.equal(v.action, HANDOFF_ACTION.RETRY, '証拠が無いのに畳んでいる');
});

test('【重要】読み取り遅延で対象者が 0 人に見えるときも保持（証明にしない）', async () => {
  const proof = await prove({ members: [] });
  assert.equal(proof.ok, false);
  assert.equal(proof.reason, PROOF_FAIL.NO_MEMBERS);
  assert.equal(resolveEmptyHandoff({ proof, attempts: 0 }).action, HANDOFF_ACTION.RETRY);
});

test('【重要】その operation の全員が queue 済みと確認できたら CLEAR', async () => {
  const proof = await prove({ deliveries: emails.map((e) => deliveryRow(e)) });
  assert.equal(proof.ok, true, `証明できていない: ${proof.reason}`);
  assert.equal(proof.members, 3);
  assert.equal(proof.queued, 3);
  assert.equal(resolveEmptyHandoff({ proof, attempts: 2 }).action, HANDOFF_ACTION.CLEAR);
  // sent でも積み終わりとみなす
  const sent = await prove({ deliveries: emails.map((e) => deliveryRow(e, 'sent')) });
  assert.equal(sent.ok, true);
});

// ── 4: 他 operation / 他バッチの証拠では畳まない ─────────────────

test('【重要】他 operation・他バッチの配信行では CLEAR しない', async () => {
  // 別人（別バッチ）の行しか無い
  const other = await prove({ deliveries: [deliveryRow('zzz@example.com')] });
  assert.equal(other.ok, false);
  assert.equal(other.queued, 0, '別バッチの行を自分のものとして数えている');
  // 一部だけ積み終わっていても畳まない
  const partial = await prove({ deliveries: [deliveryRow(emails[0]), deliveryRow(emails[1])] });
  assert.equal(partial.ok, false);
  assert.equal(partial.queued, 2);
  assert.equal(partial.members, 3);
  assert.equal(resolveEmptyHandoff({ proof: partial, attempts: 0 }).action, HANDOFF_ACTION.RETRY);
});

test('skipped / failed の行は「積み終わった」と数えない', async () => {
  const proof = await prove({ deliveries: emails.map((e) => deliveryRow(e, 'skipped')) });
  assert.equal(proof.ok, false);
  assert.equal(proof.queued, 0);
});

// ── 5: 確認不能が続けば handoff を残したまま止める ────────────────

test('【重要】確認不能が続いたら handoff を残したまま auto-stop', async () => {
  const unreadable = await prove({ failDeliveries: true });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, PROOF_FAIL.DELIVERIES_UNREADABLE);
  let attempts = 0;
  let last = null;
  for (let i = 0; i < MAX_EMPTY_HANDOFF_ATTEMPTS + 1; i += 1) {
    last = resolveEmptyHandoff({ proof: unreadable, attempts });
    attempts = last.attempts;
    if (last.action === HANDOFF_ACTION.STOP) break;
  }
  assert.equal(last.action, HANDOFF_ACTION.STOP);
  assert.match(last.reason, /^handoff_unproven:/, `理由が残っていない: ${last.reason}`);
  // 顧客が読めないときも同じ
  const noCust = await prove({ failCustomers: true });
  assert.equal(noCust.reason, PROOF_FAIL.MEMBERS_UNREADABLE);
});

// ── 実装の配線・安全性 ──────────────────────────────────────────

test('【重要】運転手は証明を取ってから判定している（関所 0 を根拠にしない）', () => {
  const src = readRel('netlify/functions/cron-marketing-rollout.js');
  assert.ok(src.includes('proveHandoffQueued'), '正の証拠を取っていない');
  const call = src.slice(src.indexOf('const verdict = resolveEmptyHandoff({'), src.indexOf('if (verdict.action === HANDOFF_ACTION.CLEAR)'));
  assert.ok(call.includes('proof'), '判定に証明を渡していない');
  assert.equal(/outstandingStep1/.test(call), false, '関所の値を畳む根拠に使っている');
  // 止めるときも引き継ぎを消さない
  const stopBlock = src.slice(src.indexOf('// 解決しない = 人に見せる'), src.indexOf('const res = { ok: true, jobIds'));
  assert.equal(/pendingHandoffOps: \[\]/.test(stopBlock), false, '停止時に引き継ぎを消している');
});

test('証明は読むだけ・PII を持ち出さない', () => {
  const lib = readRel('src/lib/marketing/handoffQueueProof.js');
  assert.equal(/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(lib), false, '書き込みをしている');
  assert.ok(lib.includes('MAX_PAGES'), '走査上限が無い');
  // 戻り値に PII を入れない
  const proofShape = { ok: true, reason: null, members: 3, queued: 3 };
  assert.deepEqual(Object.keys(proofShape).sort(), ['members', 'ok', 'queued', 'reason']);
});

test('再試行回数は状態へ保存できる（PII なし）', () => {
  assert.equal(normalizeRolloutState({ handoffEmptyAttempts: 2 }).handoffEmptyAttempts, 2);
  assert.equal(normalizeRolloutState({}).handoffEmptyAttempts, 0);
});

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
