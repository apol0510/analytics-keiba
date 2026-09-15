/**
 * prospectCanaryWiring.guard.test.mjs — prospect canary の**配線**を固定する
 *   node --test src/lib/marketing/prospectCanaryWiring.guard.test.mjs
 *
 * ## 守る契約
 *
 *   1. 下見は **本番の tick と同じ関数**（`runSequenceTick`）を通る（別ロジックを作らない）
 *   2. 下見は **予約（`claimDelivered`）より手前**で返る（下見で予約を焼かない）
 *   3. 下見は **Airtable / Redis へ 1 バイトも書かない**
 *   4. 絞り込みは**除外条件・冪等性・送信直前再検証を迂回しない**
 *   5. 既定（env 未設定）では**従来どおり全員**が対象
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const ADMIN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)),
  'utf8',
);

test('【重要】下見は本番の tick と同じ関数を通る（別ロジックを作っていない）', () => {
  assert.match(ADMIN, /import \{ runSequenceTick \} from '\.\/cron-campaign-sequence\.js'/);
  assert.match(ADMIN, /runSequenceTick\(\{[\s\S]{0,200}dryRun: true/, '下見が runSequenceTick を通っていない');
  assert.match(ADMIN, /action === 'sequenceTickPreview'/);
});

test('【重要】下見は予約（claimDelivered）より手前で返る', () => {
  const iDry = CRON.indexOf('if (isDry) {');
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iDry > 0, '下見の分岐が無い');
  assert.ok(iClaim > 0, '予約の呼び出しが無い');
  assert.ok(iDry < iClaim, '下見が予約より後ろにある（下見で予約を焼く）');
});

test('【重要】下見は書き込み経路へ到達しない', () => {
  // 下見の分岐から、その return までの間に書き込みが無いこと
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 900);
  for (const banned of ['claimDelivered', 'markDelivered', "method: 'POST'", "method: 'PATCH'", 'jobDeliveryStore.save']) {
    assert.equal(seg.includes(banned), false, `下見の中に書き込みがある: ${banned}`);
  }
  assert.match(seg, /sideEffects: 'none'/);
  assert.match(seg, /dryRun: true/);
});

test('【重要】ゲートが閉じていても下見はできるが、状態を必ず返す', () => {
  assert.match(CRON, /if \(!isDry && !gates\.allOpen\)/, '下見でゲートを無視していない形になっていない');
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 900);
  assert.match(seg, /gates: \{ allOpen: gates\.allOpen, missing: gates\.missing \}/,
    '下見の応答にゲートの状態が無い（開いていると誤解させる）');
});

test('【重要】絞り込みは「減らす」だけ。除外・冪等・再検証を迂回しない', () => {
  /**
   * 絞り込みは due が確定した後に適用される（対象を**増やす**経路が無い）。
   * ⚠️ 2026-09-15 に塊ごとの補充へ変えたので、この順序は塊の中で保たれている:
   *    既登録の除外 → 出所フィルタ → 許可リスト。
   */
  const i = CRON.indexOf('isSendable: async (chunk)');
  assert.ok(i > 0, '補充の判定が無い');
  const body = CRON.slice(i, i + 1600);
  const iDue = body.indexOf('chunk.filter((t) => !active.has(keyOfTarget(t)))');
  const iFilter = body.indexOf('applyAudienceFilter({');
  assert.ok(iDue > 0 && iFilter > iDue, '絞り込みが due 確定より前にある');
  // 既存の単一源をそのまま使っていること
  for (const keep of ['buildCampaignPlan(', 'claimDelivered(', 'fetchActiveDeliveryKeys(', 'fetchProviderSuppression(']) {
    assert.ok(CRON.includes(keep), `既存の経路が消えている: ${keep}`);
  }
});

test('【重要】既定（引数なし）では従来どおり全員が対象', () => {
  /**
   * ⚠️ 2026-09-14 に `resolveAudienceFilter(env)` から**引数**へ変えた。
   *    env で持つと `cron-drm-autostart` の `tickEnv = { ...env }` を通じて
   *    **DRM の入口にも効いてしまう**（本番で DRM の対象が 0 人になった）。
   *    ここを env 読みへ戻さないこと（`sequenceCanaryIsolation.test.mjs` も固定している）。
   */
  assert.match(CRON, /const audienceFilter = normalizeAudienceFilter\(sourceFilter\)/);
  assert.match(CRON, /sourceFilter = null,/, '引数で受け取っていない');
  const lib = readFileSync(fileURLToPath(new URL('./sequenceAudienceFilter.js', import.meta.url)), 'utf8');
  assert.match(lib, /return AUDIENCE_FILTER\.ALL;/, '既定が all でない');
});

test('下見の応答にアドレスを載せない', () => {
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 900);
  assert.equal(/recipients:|emails|Email\b/.test(seg), false, '下見の応答に宛先が混ざっている');
});
