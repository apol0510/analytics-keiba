/**
 * campaignStepMeasurementWiring.test.mjs — Function 側の配線を固定する
 *   node --test src/lib/marketing/campaignStepMeasurementWiring.test.mjs
 *
 * 純粋関数が正しくても、Function が**古い束ね方のまま**なら本番は 0 件のまま。
 * ここでは「どちらの束ね方を選ぶか」の判断が 1 ページ版と全体版で**揃っている**こと、
 * そして計測の追加で**送信側へ触れていない**ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASTRO_ROOT = join(HERE, '..', '..', '..');
const FN = readFileSync(join(ASTRO_ROOT, 'netlify/functions/admin-marketing.js'), 'utf8');
const JOURNEY = readFileSync(join(HERE, 'journeyModel.js'), 'utf8');

/** `handleTouchMeasurementPage` / `handleTouchMeasurement` の本体だけを切り出す */
function bodyOf(name) {
  const start = FN.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `${name} が見つかりません`);
  const end = FN.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} の終端が取れません`);
  return FN.slice(start, end);
}

const PAGE = bodyOf('handleTouchMeasurementPage');
const WHOLE = bodyOf('handleTouchMeasurement');

test('【重要】1 ページ版と全体版が同じ基準で束ね方を選ぶ', () => {
  for (const [name, body] of [['page', PAGE], ['whole', WHOLE]]) {
    assert.match(body, /isJourneyCampaign\(base\.campaignId\)/,
      `${name}: campaign で束ね方を選んでいない`);
  }
});

test('【重要】journey でない campaign は campaign × step で数える', () => {
  assert.match(PAGE, /summarizeByCampaignStep\(/);
  assert.match(PAGE, /summarizeByTouch\(/, 'Light の経路は残っていること');
  assert.match(WHOLE, /scanAllStepPages/);
  assert.match(WHOLE, /scanAllTouchPages/, 'Light の経路は残っていること');
  assert.match(WHOLE, /buildInlineStepResult/);
});

test('【重要】どちらの束ね方で数えたかを応答に書く', () => {
  for (const [name, body] of [['page', PAGE], ['whole', WHOLE]]) {
    assert.match(body, /measurementMode:\s*journey \? 'journey-touch' : 'campaign-step'/,
      `${name}: measurementMode が無い`);
  }
});

test('【重要】計測は read-only のまま（送信・queue・対象選定に触れない）', () => {
  for (const [name, body] of [['page', PAGE], ['whole', WHOLE]]) {
    assert.match(body, /sideEffects: 'none'/, `${name}: read-only の宣言が無い`);
    for (const banned of [
      'buildDeliveryRecords', 'buildCampaignPlan', 'runSequenceTick',
      'planAutoStartEntries', 'enqueue', 'dispatch', 'sendCampaign',
    ]) {
      assert.ok(!body.includes(banned), `${name}: ${banned} を計測経路へ持ち込まない`);
    }
  }
});

test('【重要】journeyModel へ DRM の campaign を書き足していない', () => {
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence']) {
    assert.ok(!JOURNEY.includes(id), `journeyModel.js に ${id} が書かれている`);
  }
  assert.match(JOURNEY, /light-trial-to-premium-sequence/);
  assert.match(JOURNEY, /light-trial-post-expiry-sequence/);
});

test('走査スクリプトも Function と同じ基準で束ね方を選ぶ', () => {
  const script = readFileSync(join(ASTRO_ROOT, 'scripts/touch-measurement-scan.mjs'), 'utf8');
  assert.match(script, /isJourneyCampaign\(args\.campaign\)/);
  assert.match(script, /scanAllStepPages/);
  assert.match(script, /scanAllTouchPages/);
});
