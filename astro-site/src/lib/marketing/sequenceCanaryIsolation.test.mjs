/**
 * sequenceCanaryIsolation.test.mjs — **canary の設定を他 campaign へ漏らさない**
 *   node --test src/lib/marketing/sequenceCanaryIsolation.test.mjs
 *
 * ## なぜ要るか（2026-09-14 の本番事故）
 *
 * canary のために `MARKETING_SEQUENCE_SOURCE_FILTER=prospect` を **production env** へ置いた。
 * ところが `cron-drm-autostart` は
 *
 *     const tickEnv = { ...env, MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true', ... };
 *     await runSequenceTick({ env: tickEnv, campaignId });
 *
 * と **process env をまるごと引き継ぐ**。つまり
 *
 *   - DRM の入口（Customers が対象）にも `sourceFilter=prospect` が効き、
 *     **対象が黙って 0 人になる**
 *   - しかも DRM は `SCHEDULER_ENABLED: 'true'` を自分で合成するので、
 *     **`scheduler=false` にしても止まらない**
 *
 * 「scheduler を閉じてあるから無害」ではなかった。
 *
 * ## 固定すること
 *
 *   1. 絞り込みは **呼び出しの引数**でだけ決まる（**env から読まない**）
 *   2. したがって env に何が入っていても **他 campaign へ漏れない**
 *   3. canary は **campaign を明示**し、既定値で他 campaign を巻き込まない
 *   4. `expectedCount` と一致しなければ **1 件も積まない**（count drift は fail closed）
 *   5. `sourceFilter` を指定したのに別の出所が混ざったら **fail closed**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const DRM = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-drm-autostart.js', import.meta.url)),
  'utf8',
);
const ADMIN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)),
  'utf8',
);

test('【重要】絞り込みは env から読まない（他 campaign へ漏らさない）', () => {
  /**
   * ⚠️ ここが `resolveAudienceFilter(env)` に戻ると、DRM の `tickEnv = { ...env }` を
   *    通じて DRM の対象が黙って 0 人になる（2026-09-14 に本番で踏んだ）。
   */
  assert.doesNotMatch(CRON, /resolveAudienceFilter\(env\)/, 'env から絞り込みを読んでいる');
  assert.doesNotMatch(CRON, /MARKETING_SEQUENCE_SOURCE_FILTER/,
    'cron が絞り込みの env 名を参照している');
  // 引数で受け取る形になっていること
  assert.match(CRON, /sourceFilter = null,/, '絞り込みを引数で受け取っていない');
});

test('【重要】DRM は env をまるごと引き継ぐので、env 経由の設定は必ず漏れる', () => {
  // この事実自体は DRM 側の設計。だからこそ marketing 側が env を読まないことが要る
  assert.match(DRM, /const tickEnv = \{\s*\n?\s*\.\.\.env,/, 'DRM の env 引き継ぎが変わった');
  assert.match(DRM, /MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true'/,
    'DRM が scheduler を合成しなくなった（前提が変わったので読み直すこと）');
});

test('【重要】canary は campaign を明示する（既定で他 campaign を巻き込まない）', () => {
  assert.match(ADMIN, /action === 'sequenceCanaryRun'/, 'canary の入口が無い');
  const i = ADMIN.indexOf('async function handleSequenceCanaryRun');
  assert.ok(i > 0, 'canary ハンドラが無い');
  const body = ADMIN.slice(i, i + 4000);
  // campaignId は必須（既定値を持たない）
  assert.match(body, /if \(!CANARY_CAMPAIGNS\.has\(campaignId\)\)/, 'campaign の許可リストが無い');
  assert.doesNotMatch(body, /req\.campaignId \|\| '[a-z]/, 'campaignId に既定値がある');
});

test('【重要】count drift は fail closed（expectedCount と違えば 1 件も積まない）', () => {
  assert.match(CRON, /expectedCount = null,/, 'expectedCount を受け取っていない');
  assert.match(CRON, /abort: 'expected_count_mismatch'/, 'count drift で止めていない');
  // 予約より手前で止まること
  const iCheck = CRON.indexOf("abort: 'expected_count_mismatch'");
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iCheck > 0 && iCheck < iClaim, 'count drift の判定が予約より後ろにある');
});

test('【重要】出所が混ざったら fail closed', () => {
  assert.match(CRON, /abort: 'audience_source_mixed'/, '出所混入で止めていない');
  const iCheck = CRON.indexOf("abort: 'audience_source_mixed'");
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iCheck > 0 && iCheck < iClaim, '出所混入の判定が予約より後ろにある');
});

test('【重要】canary は通常経路を迂回しない', () => {
  const i = ADMIN.indexOf('async function handleSequenceCanaryRun');
  const body = ADMIN.slice(i, i + 4000);
  // 送信・キュー登録は runSequenceTick に委譲する（自前で作らない）
  assert.match(body, /runSequenceTick\(\{/, 'canary が tick を通っていない');
  for (const banned of ['sendgrid', 'SENDGRID_API_KEY', 'claimDelivered(', 'buildCampaignPlan(', 'performUpsert']) {
    assert.equal(body.includes(banned), false, `canary が経路を作り直している: ${banned}`);
  }
});

test('【重要】canary は 1 回限り（繰り返し送る作りにしない）', () => {
  const i = ADMIN.indexOf('async function handleSequenceCanaryRun');
  const body = ADMIN.slice(i, i + 4000);
  assert.equal(/for \(|while \(/.test(body), false, 'canary に繰り返しがある');
  assert.match(body, /apply === true/, '実行の明示が無い');
  assert.match(body, /CANARY_CONFIRM/, '確認文字列が無い');
});

test('【重要】canary は env を書き換えない（他 campaign へ影響させない）', () => {
  const i = ADMIN.indexOf('async function handleSequenceCanaryRun');
  const body = ADMIN.slice(i, i + 4000);
  assert.equal(/process\.env\.[A-Z_]+\s*=/.test(body), false, 'env を書き換えている');
  assert.doesNotMatch(body, /MARKETING_SEQUENCE_SOURCE_FILTER/, 'env 名に依存している');
});
