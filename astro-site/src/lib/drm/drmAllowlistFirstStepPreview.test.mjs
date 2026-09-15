/**
 * drmAllowlistFirstStepPreview.test.mjs — ゲートを閉じたまま step1 を**下見だけ**再現する
 *   node --test src/lib/drm/drmAllowlistFirstStepPreview.test.mjs
 *
 * ── なぜ要るか（2026-09-15 本番実測）────────────────────────────
 * step1 を自動で撃てるのは「入口の宣言があり、かつ入口ゲートが開いている」ときだけ。
 * production のゲートは**閉じたまま**確認したいので、そのまま下見を回すと
 * 「期限が来ているのは step1 の人だけ」→ `first_step_is_manual` で毎回中止し、
 * **窓を最後まで走査できない**。実際 2 窓目で止まり、しかも窓の情報が返らないので
 * 続きの位置が両方 null になり **`done: true` に見えていた**（部分を全体として扱う形）。
 *
 * ── 直し方 ────────────────────────────────────────────────────
 *   ① 中止した窓・窓の情報が欠けた窓は **fail closed**（`tick_aborted`）。絶対に done にしない
 *   ② `runSequenceTick` に **下見専用**の step1 スイッチを足す（env は偽装しない）
 *      - `dryRun: true` のときだけ効く
 *      - `dryRun: false` で渡されたら **1 件も積まずに中止**（live のゲートを迂回させない）
 *      - 使うのは `drmEntryAllowlistCheck` だけ。共有 tick・割引 3 本の挙動は不変
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planSequenceTick, TICK_ABORT } from '../marketing/sequenceAutomation.js';
import { buildSequenceProgress } from '../marketing/sequenceProgress.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from '../marketing/customerMarketingAudience.js';
import { runSequenceTick } from '../../../netlify/functions/cron-campaign-sequence.js';
import { checkEntryAllowlist } from '../../../netlify/functions/cron-drm-autostart.js';
import {
  digestRecordIds, judgeWindow, emptyWindowRun, mergeWindowRun, finalizeWindowRun, WINDOW_FAIL,
} from './drmAllowlistWindow.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const DRM = read('../../../netlify/functions/cron-drm-autostart.js');

const NOW = Date.UTC(2026, 8, 15, 3, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 3,
  subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'seq-firststep-test', version: 1, name: 'テスト',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true, sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

function customer(email) {
  const fields = { Email: email, Status: 'active' };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

/** まだ 1 通も受け取っていない人だけ = **step1 しか期限が来ていない**母集団 */
const step1OnlyProgress = () => buildSequenceProgress({
  campaign: CAMPAIGN,
  selected: [customer('a@example.com'), customer('b@example.com')],
  deliveries: [], brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(),
});

const OPEN_GATES = { allOpen: true, missing: [] };

// ══════════════════════════════════════════════════════════════════
//  ① step1 しか居ない母集団の扱い（判定の単一源）
// ══════════════════════════════════════════════════════════════════

test('【最重要】step1 only + allowFirstStep なし → 従来どおり first_step_is_manual', () => {
  const plan = planSequenceTick({
    progress: step1OnlyProgress(), gates: OPEN_GATES,
    maxRecipients: 50, allowFirstStep: false,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL);
});

test('【最重要】step1 only + allowFirstStep あり → step1 を対象にできる', () => {
  const plan = planSequenceTick({
    progress: step1OnlyProgress(), gates: OPEN_GATES,
    maxRecipients: 50, allowFirstStep: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 1);
  assert.equal(plan.recordIds.length, 2);
});

// ══════════════════════════════════════════════════════════════════
//  ② live では絶対に迂回できない
// ══════════════════════════════════════════════════════════════════

test('【最重要】live で下見スイッチを渡しても step1 ゲートを突破できない', async () => {
  const out = await runSequenceTick({
    env: {
      MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
      MARKETING_CAMPAIGN_ENABLED: 'true',
      MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
      MARKETING_DRM_AUTOSTART_ENABLED: 'true',
      AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b',
    },
    now: NOW, campaignId: 'free-signup-onboarding',
    dryRun: false,
    previewAllowFirstStep: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.abort, TICK_ABORT.FIRST_STEP_OVERRIDE_IN_LIVE);
  assert.equal(out.sideEffects, 'none');
});

test('【最重要】live の中止は I/O へ進む前（Airtable も SendGrid も触らない）', () => {
  const body = CRON.slice(CRON.indexOf('const isDry = dryRun === true;'));
  const abortAt = body.indexOf('FIRST_STEP_OVERRIDE_IN_LIVE');
  const gatesAt = body.indexOf('readSequenceGates(env, now)');
  assert.ok(abortAt > 0, '中止が入っていない');
  assert.ok(gatesAt > abortAt, 'ゲートを読むより後ろで中止している');
  // Airtable / SendGrid を触るより手前であること
  assert.ok(body.indexOf('fetchProviderSuppression(') > abortAt);
});

test('【重要】下見スイッチを使うのは drmEntryAllowlistCheck だけ', () => {
  const uses = (src) => (src.match(/previewAllowFirstStep: true/g) || []).length;
  assert.equal(uses(DRM), 1, 'DRM 側で 1 か所だけ');
  assert.equal(uses(CRON), 0, '共有 tick は使わない');
  const fnStart = DRM.indexOf('export async function checkEntryAllowlist(');
  const fnEnd = DRM.indexOf('\n}\n', fnStart);
  assert.ok(DRM.slice(fnStart, fnEnd).includes('previewAllowFirstStep: true'),
    '確認経路の中に無い');
});

test('【重要】env を偽装しない（応答のゲートは閉じたまま）', () => {
  // 入口の報告は**実際のゲート状態**を出す
  assert.match(CRON, /open: autoStartGate\.open/);
  assert.match(CRON, /missing: autoStartGate\.missing/);
  // 下見で組み立てただけなら印を付ける
  assert.match(CRON, /previewOnly: true/);
  // 合成した env を作っていない
  assert.ok(!/MARKETING_DRM_AUTOSTART_ENABLED:\s*'true'/.test(CRON));
});

// ══════════════════════════════════════════════════════════════════
//  ③ 中止した窓を「読み切った」と言わない
// ══════════════════════════════════════════════════════════════════

const CAMPAIGN_ID = 'free-signup-onboarding';
const IDS = ['recS1', 'recS2', 'recS3', 'recS4'];
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' };
const preview = async () => ({
  ok: true, campaignId: CAMPAIGN_ID, version: 1, scanned: 36, considered: 36,
  wouldEnter: IDS.length, recordIds: [...IDS], capped: false, carriedOver: 0, skipped: {},
});

/** 本番で実際に返ってきた「中止した窓」の形（`window` ごと無い） */
const abortedTick = async () => ({
  ok: false, abort: TICK_ABORT.FIRST_STEP_MANUAL, step: 1,
  autoStart: { declared: true, open: false, missing: ['MARKETING_DRM_AUTOSTART_ENABLED'] },
  sideEffects: 'none', dryRun: true,
  gates: { allOpen: false, missing: ['MARKETING_SEQUENCE_SCHEDULER_ENABLED'] },
});

test('【最重要】下見が中止した窓を done: true にしない', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: NOW, campaignId: CAMPAIGN_ID, window: { offset: 2000, limit: 2000 },
    deps: { previewEntry: preview, runSequenceTick: abortedTick },
  });
  assert.equal(out.next.done, false, '中止を読み切りと扱っている');
  assert.equal(out.ok, false);
  assert.ok(out.violations.includes(WINDOW_FAIL.TICK_ABORTED));
  assert.equal(out.window.present, false);
  assert.equal(out.tick.abort, TICK_ABORT.FIRST_STEP_MANUAL, '中止理由を隠さない');
  assert.equal(out.sideEffects, 'none');
});

test('【最重要】中止した窓が混ざったら走査全体も不合格', () => {
  const planner = { count: 4, digest: digestRecordIds(IDS) };
  let acc = emptyWindowRun();
  acc = mergeWindowRun(acc, {
    planner, finalRecipients: 0, done: false,
    verdict: judgeWindow({ plannerCount: 4, finalRecipients: 0, outsideAllowlist: 0, prospectInFinal: 0, tickOk: true, windowPresent: true }),
  });
  acc = mergeWindowRun(acc, {
    planner, finalRecipients: 0, done: false,
    verdict: judgeWindow({ plannerCount: 4, finalRecipients: 0, outsideAllowlist: 0, prospectInFinal: 0, tickOk: false, windowPresent: false }),
  });
  const out = finalizeWindowRun(acc);
  assert.equal(out.allowlistHolds, false);
  assert.ok(out.violations.includes(WINDOW_FAIL.TICK_ABORTED));
});

test('【重要】窓の情報が欠けているだけでも fail closed', () => {
  const v = judgeWindow({
    plannerCount: 4, finalRecipients: 0, outsideAllowlist: 0, prospectInFinal: 0,
    tickOk: true, windowPresent: false,
  });
  assert.equal(v.ok, false);
  assert.ok(v.violations.includes(WINDOW_FAIL.TICK_ABORTED));
});

// ══════════════════════════════════════════════════════════════════
//  ④ ゲート閉のまま窓を最後まで走査できる（本番で詰まった形）
// ══════════════════════════════════════════════════════════════════

const INDEX_SIZE = 11971;
const LIMIT = 2000;

/** ゲート閉・step1 only でも、下見スイッチのおかげで窓を返せる tick */
function tickStep1Only(calls) {
  return async (args) => {
    calls.push(args);
    // ⚠️ スイッチが渡っていなければ、本番と同じく中止する
    if (args.previewAllowFirstStep !== true) return abortedTick();
    const offset = Number(args.preview.offset) || 0;
    const scanned = Math.min(LIMIT, Math.max(0, INDEX_SIZE - offset));
    const nextOffset = offset + scanned < INDEX_SIZE ? offset + scanned : null;
    return {
      ok: true, dryRun: true, step: 1, campaignId: CAMPAIGN_ID, sideEffects: 'none',
      // ⚠️ ゲートは**閉じたまま**表示する
      gates: { allOpen: false, missing: ['MARKETING_SEQUENCE_SCHEDULER_ENABLED'] },
      autoStart: { declared: true, open: false, previewOnly: true, entered: 4 },
      'この tick の候補': scanned + 4,
      'うち prospect': scanned,
      'うち Customers': 4,
      '絞り込み後に送る人数': 4,
      entryAllowlist: { 許可人数: 4, 許可リスト外で除外: scanned, 許可リスト外の残り: 0 },
      最終対象の出所: { prospect: 0, Customers: 4, 出所不明: 0 },
      window: {
        scope: null, ledgerPages: 2, nextLedgerOffset: null,
        prospect: { indexSize: INDEX_SIZE, digest: 'dg1', scanned, offset, nextOffset },
        prospectSkipped: null,
      },
    };
  };
}

test('【最重要】ゲート閉 + step1 only でも窓を最後まで走査できる', async () => {
  const calls = [];
  const tick = tickStep1Only(calls);
  let acc = emptyWindowRun();
  let expectPlanner = null;
  let window = { limit: LIMIT, scanPages: 2 };
  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- cursor 方式なので直列
    const out = await checkEntryAllowlist({
      env: ENV, now: NOW, campaignId: CAMPAIGN_ID, window, expectPlanner,
      deps: { previewEntry: preview, runSequenceTick: tick },
    });
    seen.push(out);
    acc = mergeWindowRun(acc, {
      planner: { count: out.plannerCount, digest: out.plannerDigest },
      finalRecipients: out.finalRecipients,
      verdict: judgeWindow({
        plannerCount: out.plannerCount, finalRecipients: out.finalRecipients,
        outsideAllowlist: out.entryAllowlist['許可リスト外の残り'],
        prospectInFinal: out['最終対象の出所'].prospect,
        prospectSkipped: out.window.prospectSkipped,
        tickOk: out.tick.ok, windowPresent: out.window.present,
      }),
      done: out.next.done,
    });
    if (out.next.done) break;
    expectPlanner = { count: out.plannerCount, digest: out.plannerDigest };
    window = { limit: LIMIT, scanPages: 2, offset: out.next.offset, digest: out.next.digest, ledgerOffset: out.next.ledgerOffset };
  }
  const run = finalizeWindowRun(acc);

  assert.ok(seen.length >= 6, `窓が刻まれていない（${seen.length} 窓）`);
  assert.equal(run.complete, true, '読み切っていない');
  assert.equal(run.allowlistHolds, true);
  assert.deepEqual(run.violations, []);
  assert.equal(run.planner.count, 4);
  assert.equal(run.planner.digest, digestRecordIds(IDS));
  // ⚠️ 足していない（6 窓 × 4 名 = 24 にならない）
  assert.equal(run.maxFinalInWindow, 4);

  for (const w of seen) {
    assert.equal(w['最終対象の出所'].prospect, 0);
    assert.equal(w.entryAllowlist['許可リスト外の残り'], 0);
    assert.ok(w.finalRecipients <= w.plannerCount);
    assert.equal(w.sideEffects, 'none');
    assert.equal(w.plannerDigest, digestRecordIds(IDS));
    // ⚠️ ゲートは閉じたまま表示される
    assert.equal(w.gates.entryOpen, false);
  }
  // 確認経路は毎回スイッチを渡している
  assert.ok(calls.every((c) => c.previewAllowFirstStep === true));
  assert.ok(calls.every((c) => c.dryRun === true));
});

test('【最重要】読み切るまでは complete も allowlistHolds も true にしない', () => {
  const planner = { count: 4, digest: digestRecordIds(IDS) };
  let acc = emptyWindowRun();
  acc = mergeWindowRun(acc, {
    planner, finalRecipients: 4, done: false,
    verdict: judgeWindow({ plannerCount: 4, finalRecipients: 4, outsideAllowlist: 0, prospectInFinal: 0, tickOk: true, windowPresent: true }),
  });
  const out = finalizeWindowRun(acc);
  assert.equal(out.complete, false);
  assert.equal(out.allowlistHolds, false);
});
