/**
 * drmEntryBackground.test.mjs — **入口の重い処理は Background だけが実行する**
 *   node --test src/lib/drm/drmEntryBackground.test.mjs
 *
 * ── 背景（2026-09-14 本番実測）────────────────────────────────
 * 入口の live を同期 Function で走らせたら **HTTP 504（gateway timeout）**。
 * 書き込みは 1 件も起きなかった（queue 0 / 送信 0）が完走できなかった。
 * scheduled Function は 30 秒で切られるので日次経路も同じ。
 * → 手動 live も日次自動も**同じ Background へ委譲**する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DRM_ENTRY_PAYLOAD_KEYS, DRM_ENTRY_BACKGROUND, DISPATCH_FAIL,
  buildRunId, buildDrmEntryPayload, triggerDrmEntryBackground,
} from './drmEntryDispatch.js';
import {
  DRM_TICK_LOCK_TTL_SEC, BACKGROUND_MAX_RUNTIME_SEC, DRM_TICK_LOCK_ID,
} from '../../../netlify/functions/cron-drm-autostart.js';
import { SEQUENCE_TICK_LOCK_ID } from '../../../netlify/functions/cron-campaign-sequence.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CRON = read('../../../netlify/functions/cron-drm-autostart.js');
const BG = read('../../../netlify/functions/drm-entry-background.js');
const SEQ_CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ══════════════════════════════════════════════════════════════════
//  ① 排他：鍵が Background の実行時間を覆う
// ══════════════════════════════════════════════════════════════════

test('【最重要】入口の鍵は Background の最大実行時間より長い（途中で切れない）', () => {
  assert.equal(BACKGROUND_MAX_RUNTIME_SEC, 900, 'Netlify Background の上限が変わったら見直す');
  assert.ok(DRM_TICK_LOCK_TTL_SEC > BACKGROUND_MAX_RUNTIME_SEC,
    `鍵の TTL(${DRM_TICK_LOCK_TTL_SEC}s) が Background の最大実行時間(${BACKGROUND_MAX_RUNTIME_SEC}s)を覆っていない`
    + '（途中で切れると二重 enqueue になる）');
});

test('【最重要】共有 cron の 240 秒をそのまま流用していない', () => {
  // #526 が共有 cron に入れた TTL（240）をそのまま使うと Background の途中で切れる
  assert.notEqual(DRM_TICK_LOCK_TTL_SEC, 240, '共有 cron と同じ TTL を流用している');
  assert.ok(DRM_TICK_LOCK_TTL_SEC >= 960);
});

test('【重要】鍵の名前は共有 cron と別（互いを塞き止めない）', () => {
  assert.notEqual(DRM_TICK_LOCK_ID, SEQUENCE_TICK_LOCK_ID);
  assert.equal(DRM_TICK_LOCK_ID, 'tick:drm-autostart');
});

test('【安全】鍵は Background 側の実行経路で取られる', () => {
  // 鍵を取るのは runDrmEntry の live 経路。Background だけがそこへ入る
  const code = codeOnly(CRON);
  assert.match(code, /lock\.acquire\(\{ jobId: DRM_TICK_LOCK_ID, ttlSec: DRM_TICK_LOCK_TTL_SEC \}\)/);
  assert.match(code, /entry_busy/);
});

// ══════════════════════════════════════════════════════════════════
//  ② payload に人を入れない
// ══════════════════════════════════════════════════════════════════

test('【最重要】payload はアドレスも recordId も持たない', () => {
  assert.deepEqual([...DRM_ENTRY_PAYLOAD_KEYS], ['campaignId', 'expectedCount', 'manual', 'runId']);
  const p = buildDrmEntryPayload({
    campaignId: 'free-signup-onboarding', expectedCount: 16, manual: true, runId: 'r1',
    // 混ぜようとしても通らない
    emails: ['a@example.com'], recordIds: ['rec1'], subject: 'x',
  });
  assert.deepEqual(Object.keys(p).sort(), ['campaignId', 'expectedCount', 'manual', 'runId']);
  const s = JSON.stringify(p);
  assert.equal(s.includes('@'), false, 'payload にアドレスが入っている');
  assert.equal(s.includes('rec1'), false, 'payload に recordId が入っている');
});

test('【安全】runId に PII を含めない', () => {
  const id = buildRunId({ nowMs: Date.UTC(2026, 8, 14, 5, 30), suffix: 'admin' });
  assert.match(id, /^drm-\d{8}\d{6}-admin$/);
  assert.equal(id.includes('@'), false);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 起動は 202 を受けて終わり（結果を待たない・body を読まない）
// ══════════════════════════════════════════════════════════════════

test('【重要】202 を成功として扱い、body を読まない', async () => {
  let called = null;
  let bodyRead = 0;
  const res = { status: 202, ok: false, json: async () => { bodyRead += 1; return {}; } };
  const r = await triggerDrmEntryBackground({
    env: { MARKETING_ADMIN_SECRET: 's', URL: 'https://example.test' },
    payload: buildDrmEntryPayload({ campaignId: 'c', expectedCount: 1, manual: true, runId: 'r' }),
    fetchImpl: async (url, init) => { called = { url, init }; return res; },
  });
  assert.equal(r.ok, true, '202 を失敗扱いしている');
  assert.equal(bodyRead, 0, 'Background の body を読んでいる（返らない契約）');
  assert.match(called.url, new RegExp(`/${DRM_ENTRY_BACKGROUND}$`));
  assert.equal(called.init.headers['x-admin-secret'], 's', '内部認証を付けていない');
});

test('【安全】secret が無ければ起動しない', async () => {
  let called = 0;
  const r = await triggerDrmEntryBackground({
    env: {}, payload: buildDrmEntryPayload({ campaignId: 'c', expectedCount: 1, manual: true, runId: 'r' }),
    fetchImpl: async () => { called += 1; return { status: 202, ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DISPATCH_FAIL.NO_SECRET);
  assert.equal(called, 0);
});

test('【安全】起動に失敗したら「積んでいない」と分かる形で返す', async () => {
  const r = await triggerDrmEntryBackground({
    env: { MARKETING_ADMIN_SECRET: 's' },
    payload: buildDrmEntryPayload({ campaignId: 'c', expectedCount: 1, manual: true, runId: 'r' }),
    fetchImpl: async () => { throw new Error('network'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, DISPATCH_FAIL.TRIGGER_FAILED);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 委譲の配線（両方の経路が同じ Background を使う）
// ══════════════════════════════════════════════════════════════════

test('【配線】手動 live は Background を起動するだけ（同期で完走させない）', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmEntryRun(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  assert.match(body, /triggerDrmEntryBackground\(\{/, 'Background へ渡していない');
  assert.match(body, /json\(202, \{/, '202 を返していない');
  // live 経路で runDrmEntry を完走させない（下見だけ同期）
  assert.match(body, /dryRun: true, manual: true/, '下見の同期経路が無い');
  const live = body.slice(body.indexOf('if (expectedCount === null'));
  assert.equal(live.includes('runDrmEntry('), false, 'live で同期に完走させている（504 に戻る）');
});

test('【配線】日次 cron も Background を起動するだけ', () => {
  const code = codeOnly(CRON);
  const i = code.indexOf('export default async function handler()');
  const body = code.slice(i);
  assert.match(body, /triggerDrmEntryBackground\(\{/, 'Background へ渡していない');
  assert.equal(body.includes('await runDrmEntry('), false,
    'scheduled が重い処理を完走させている（30 秒で切れる）');
});

test('【配線】重い処理を実行するのは Background だけ', () => {
  assert.match(BG, /import \{ runDrmEntry \} from '\.\/cron-drm-autostart\.js'/);
  const code = codeOnly(BG);
  assert.match(code, /await runDrmEntry\(\{/, 'Background が既存の単一源を呼んでいない');
  assert.match(code, /dryRun: false/);
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ Background 側で改めて全部確認する（短絡しない）
// ══════════════════════════════════════════════════════════════════

test('【最重要】Background は候補を受け取らず読み直す（送信直前再検証を短絡しない）', () => {
  const code = codeOnly(BG);
  // payload から人を読まない
  for (const bad of ['body.emails', 'body.recordIds', 'body.recipients', 'body.candidates']) {
    assert.equal(code.includes(bad), false, `Background が ${bad} を受け取っている`);
  }
  // 判定・選定を作り直さない（すべて runDrmEntry 経由）
  for (const bad of ['planAutoStartEntries(', 'runSequenceTick(', 'buildDeliveryRecords(',
    'buildScheduledEmailFields(', 'computeCampaignDeliveryKey(', 'readDrmEntryGates(']) {
    assert.equal(code.includes(bad), false, `Background が ${bad} を作り直している`);
  }
});

test('【安全】Background は公開 URL なので secret を必須にする', () => {
  const code = codeOnly(BG);
  assert.match(code, /x-admin-secret/);
  assert.match(code, /403/);
  assert.match(code, /503/);
});

test('【重要】Background は結果を返さず 202（台帳とログで確認する契約）', () => {
  const code = codeOnly(BG);
  const returns = code.match(/return json\((\d+)/g) || [];
  assert.ok(returns.includes('return json(202'), '202 を返していない');
  // 成功結果を body で返していない（返すのは accepted と runId だけ）
  const finalReturn = code.slice(code.lastIndexOf('return json(202'));
  assert.match(finalReturn, /accepted: true, runId/);
  assert.equal(/entered|enqueued|previewed/.test(finalReturn), false, '結果を body で返している');
  assert.match(code, /event: 'done'/, '結果をログへ残していない');
});

// ══════════════════════════════════════════════════════════════════
//  ⑥ 既存契約は不変
// ══════════════════════════════════════════════════════════════════

test('【不変】共有 cron（#521 / #523 / #526）を変更していない', () => {
  const code = codeOnly(SEQ_CRON);
  assert.match(code, /SEQUENCE_TICK_LOCK_ID = 'tick:campaign-sequence'/);
  assert.match(code, /readSequenceGates\(env, now\)/);
  /**
   * ⚠️ 2026-09-14 変更: `resolveAudienceFilter(env)` → 引数 `sourceFilter`。
   *    絞り込みを env で持つと、この下の「DRM 経路は出所フィルタを触らない」が
   *    **字面では通るのに実際は破れる**（`tickEnv = { ...env }` で DRM へ流れ、
   *    本番で DRM の対象が 0 人になった）。**意図は不変**＝フィルタは在り、適用される。
   */
  assert.match(code, /normalizeAudienceFilter\(sourceFilter\)/);
  assert.equal(code.includes('drm-entry-background'), false);
  assert.equal(code.includes('runDrmEntry'), false);
});

test('【不変】新しい送信ループを作っていない', () => {
  for (const [name, src] of [['background', codeOnly(BG)], ['dispatch helper', codeOnly(read('./drmEntryDispatch.js'))]]) {
    for (const bad of ['sendgrid', 'SENDGRID_API_KEY', 'performUpsert', 'ScheduledEmails']) {
      assert.equal(src.toLowerCase().includes(bad.toLowerCase()), false,
        `${name} が ${bad} を含む（送信ループのコピー）`);
    }
  }
});
