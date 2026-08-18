/**
 * handoffResolution.test.mjs — 引き継ぎは「**全員解決済み**」を正に確認できたときだけ消す
 *   node --test src/lib/marketing/handoffResolution.test.mjs
 *
 * 使ってはいけない根拠（本番で誤りが実証された）:
 *   - dry-run の「対象 0 件」          … まだ Airtable に見えていないことがある
 *   - 関所 `outstandingStep1 === 0`    … 同じ読み取り遅延で 0 に見える（#362）
 *   - 「全員 queued/sent」             … **正当に除外された 1 名**で永久に解決しない
 *
 * 「解決済み」の定義は既存の単一源（`evaluateStep1Barrier`）に任せる。
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
import { AUTOGRANT_SOURCE } from '../comeback/lightTrialBarrier.js';

const OP = 'light-trial-2026-08-18-b7';
const CAMPAIGN = getCampaign('light-trial-to-premium-sequence', { includeDisabled: true });
const BRAND = 'analytics-keiba';           // `lightTrialPlanLoader.js` の BRAND と同じ
const FROM = getBrandConfig(BRAND).defaultFromEmail;
const STEP1 = resolveSequenceStep(CAMPAIGN, 1);
const NOW = Date.UTC(2026, 7, 18, 10, 0, 0);
const UNTIL = new Date(NOW + 20 * 86400_000).toISOString();

const keyOf = (email) => computeCampaignDeliveryKey({
  campaign: STEP1, recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** 体験中の受信者（送れる人） */
const member = (email, over = {}) => ({
  id: `rec${email.replace(/\W/g, '')}`,
  fields: {
    Email: email,
    LightGrantOp: OP,
    LightGrantedAt: new Date(NOW - 3600_000).toISOString(),
    LightGrantUntil: UNTIL,
    UnsubscribedAnalyticsKeiba: false,
    // 関所の対象は「自動付与で配った人」だけ（既存契約）
    ComebackGrantSource: AUTOGRANT_SOURCE,
    ...over,
  },
});

const deliveryRow = (email, status = 'queued') => ({
  fields: {
    DeliveryKey: keyOf(email), Status: status, EmailType: 'campaign',
    CampaignType: `${CAMPAIGN.campaignId}:v${CAMPAIGN.version}`,
  },
});

function fakeAirtable({ members = [], deliveries = [], failCustomers = false, failDeliveries = false } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/Customers')) {
      if (failCustomers) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ records: members }) };
    }
    if (u.includes('/CampaignDeliveries')) {
      if (failDeliveries) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ records: deliveries }) };
    }
    return { ok: true, json: async () => ({ records: [] }) };
  };
}

const prove = ({
  members = [], deliveries = [], failCustomers = false, failDeliveries = false,
  blacklist = [], suppressed = [], blacklistFails = false, suppressionFails = false,
} = {}) => proveHandoffQueued({
  apiKey: 'k', baseId: 'b', sendgridApiKey: 'sg', operationId: OP,
  campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  fetchImpl: fakeAirtable({ members, deliveries, failCustomers, failDeliveries }),
  deps: {
    // ⚠️ mock は**実物の戻り値の形**に合わせる。`loadBlacklistEmails()` は失敗しても
    //    例外を投げず `{ emails: new Set(), status: <失敗理由> }` を返す（空 Set は truthy）
    loadBlacklistEmails: async () => (blacklistFails
      ? { emails: new Set(), status: 'network-error' }
      : { emails: new Set(blacklist), status: 'enabled' }),
    fetchProviderSuppression: async () => (suppressionFails
      ? { ok: false, emails: null }
      : { ok: true, emails: new Set(suppressed) }),
  },
});

// ── 1. 198 queued + 2 恒久 suppression → 解決できる ──────────────────

test('【重要】200 名中 198 queued + 2 名が既存契約上の除外 → handoff は解決できる', async () => {
  const all = Array.from({ length: 200 }, (_, i) => `u${i}@example.com`);
  const sent = all.slice(0, 198);
  const suppressed = all.slice(198);           // 配信基盤の停止リスト（既存単一源）
  const proof = await prove({
    members: all.map((e) => member(e)),
    deliveries: sent.map((e) => deliveryRow(e)),
    suppressed,
  });
  assert.equal(proof.ok, true, `解決できていない: ${proof.reason} / ${JSON.stringify(proof.byReason)}`);
  assert.equal(proof.members, 200);
  assert.equal(proof.outstanding, 0);
  assert.equal(proof.byReason.step1_queued, 198);
  assert.equal(proof.byReason.provider_suppressed, 2, '除外を解決として数えていない');
  assert.equal(resolveEmptyHandoff({ proof, attempts: 1 }).action, HANDOFF_ACTION.CLEAR);
});

// ── 2. 除外対象は送らない ────────────────────────────────────────

test('【重要】除外対象へ無理に送らない（解決＝送信ではない）', async () => {
  const target = 'sup@example.com';
  const proof = await prove({ members: [member(target)], deliveries: [], suppressed: [target] });
  assert.equal(proof.ok, true);
  assert.equal(proof.byReason.provider_suppressed, 1);
  assert.equal(proof.byReason.step1_queued, undefined, '除外者を送信済みとして数えている');
  // 配信停止（blacklist）も同じ（既存の `resolveCustomerMarketing` が判定）
  const unsub = await prove({
    members: [member('x@example.com', { UnsubscribedAnalyticsKeiba: true })], deliveries: [],
  });
  assert.equal(unsub.ok, true);
  assert.equal(unsub.byReason.not_sendable, 1);
});

// ── 3. 未解決が 1 名でも残れば保持 ───────────────────────────────

test('【重要】queued でも恒久除外でもない 1 名が残れば handoff 保持', async () => {
  const ok1 = 'a@example.com';
  const pending = 'b@example.com';
  const proof = await prove({
    members: [member(ok1), member(pending)],
    deliveries: [deliveryRow(ok1)],
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.reason, PROOF_FAIL.NOT_ALL_RESOLVED);
  assert.equal(proof.outstanding, 1);
  assert.equal(resolveEmptyHandoff({ proof, attempts: 0 }).action, HANDOFF_ACTION.RETRY);
});

// ── 4. 一時的・不明な除外を勝手に完了扱いしない ─────────────────────

test('【重要】判定材料に出てこない事情を勝手に「解決」にしない', async () => {
  // 送信可能なのに台帳へ行が無い人は **未解決**（「たぶん送ったはず」にしない）
  const proof = await prove({ members: [member('c@example.com')], deliveries: [] });
  assert.equal(proof.ok, false);
  assert.equal(proof.outstanding, 1);
  // skipped / failed の行は「積み終わった」に数えない
  const skipped = await prove({
    members: [member('d@example.com')], deliveries: [deliveryRow('d@example.com', 'skipped')],
  });
  assert.equal(skipped.ok, false, 'skipped を解決として数えている');
});

// ── 5. 除外情報が読めない → fail closed ──────────────────────────

test('【重要】停止リスト / ブラックリストが読めなければ証明しない', async () => {
  const noSup = await prove({ members: [member('e@example.com')], suppressionFails: true });
  assert.equal(noSup.ok, false);
  assert.equal(noSup.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
  const noBl = await prove({ members: [member('e@example.com')], blacklistFails: true });
  assert.equal(noBl.ok, false);
  assert.equal(noBl.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
  // 台帳・対象者が読めないときも同じ
  assert.equal((await prove({ failCustomers: true })).reason, PROOF_FAIL.MEMBERS_UNREADABLE);
  assert.equal((await prove({ members: [member('f@example.com')], failDeliveries: true })).reason,
    PROOF_FAIL.DELIVERIES_UNREADABLE);
  // 対象者が 0 人に見えるのも証明にしない（読み取り遅延）
  assert.equal((await prove({ members: [] })).reason, PROOF_FAIL.NO_MEMBERS);
  for (const p of [{ ok: false, reason: 'x' }]) {
    assert.equal(resolveEmptyHandoff({ proof: p, attempts: 0 }).action, HANDOFF_ACTION.RETRY);
  }
});

// ── 6. 他 operation の鍵では解決しない ──────────────────────────

test('【重要】他 operation・他バッチの配信行では解決しない', async () => {
  const mine = 'g@example.com';
  const proof = await prove({
    members: [member(mine)],
    deliveries: [deliveryRow('someone-else@example.com')],   // 別バッチの行
  });
  assert.equal(proof.ok, false);
  assert.equal(proof.outstanding, 1, '別バッチの行を自分の解決として数えている');
});

// ── 7〜8. 保持したまま停止 / 状態 ───────────────────────────────

test('【重要】証明できない状態が続けば handoff を残したまま auto-stop', async () => {
  const proof = await prove({ members: [member('h@example.com')], deliveries: [] });
  let attempts = 0;
  let last = null;
  for (let i = 0; i < MAX_EMPTY_HANDOFF_ATTEMPTS + 1; i += 1) {
    last = resolveEmptyHandoff({ proof, attempts });
    attempts = last.attempts;
    if (last.action === HANDOFF_ACTION.STOP) break;
  }
  assert.equal(last.action, HANDOFF_ACTION.STOP);
  assert.match(last.reason, /^handoff_unproven:/);
});

test('【重要】運転手の配線（関所 0 を根拠にしない・停止時に消さない）', () => {
  const src = readRel('netlify/functions/cron-marketing-rollout.js');
  assert.ok(src.includes('proveHandoffQueued'), '正の証拠を取っていない');
  const call = src.slice(src.indexOf('const verdict = resolveEmptyHandoff({'), src.indexOf('if (verdict.action === HANDOFF_ACTION.CLEAR)'));
  assert.ok(call.includes('proof'), '判定に証明を渡していない');
  assert.equal(/outstandingStep1/.test(call), false, '関所の値を畳む根拠に使っている');
  const stopBlock = src.slice(src.indexOf('// 解決しない = 人に見せる'), src.indexOf('const res = { ok: true, jobIds'));
  assert.equal(/pendingHandoffOps: \[\]/.test(stopBlock), false, '停止時に引き継ぎを消している');
});

test('証明は既存の単一源を再利用し、読むだけ・PII を持ち出さない', () => {
  const lib = readRel('src/lib/marketing/handoffQueueProof.js');
  assert.ok(lib.includes('evaluateStep1Barrier'), '解決判定を自前で実装している');
  assert.ok(lib.includes('resolveCustomerMarketing'), '送信可否を自前で判定している');
  assert.ok(lib.includes('fetchProviderSuppression'), '停止リストの単一源を使っていない');
  assert.equal(/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(lib), false, '書き込みをしている');
  assert.ok(lib.includes('MAX_PAGES'), '走査上限が無い');
});

test('再試行回数は状態へ保存できる（PII なし）', () => {
  assert.equal(normalizeRolloutState({ handoffEmptyAttempts: 2 }).handoffEmptyAttempts, 2);
  assert.equal(normalizeRolloutState({}).handoffEmptyAttempts, 0);
});

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
