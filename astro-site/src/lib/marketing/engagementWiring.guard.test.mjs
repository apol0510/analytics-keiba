/**
 * engagementWiring.guard.test.mjs — 反応なし除外が**実送信経路に繋がっている**ことの検査
 *   node --test src/lib/marketing/engagementWiring.guard.test.mjs
 *
 * ── なぜソースを検査するのか ──────────────────────────────────
 * 2026-08-10 に判定（`engagementPolicy.js`）と送信計画側の guard は入ったが、
 * **Function 側が Map を渡していなかった**ため、実際には 1 人も除外されていなかった。
 * 判定モジュールの単体テストは全部通るのに効いていない、という状態を再発させない。
 *
 * ここで検査するのは「配線されているか」であって、判定の正しさではない
 * （判定は engagementGuard.test.mjs / engagementPlanIntegration.test.mjs）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const WEBHOOK = read('../../../netlify/functions/sendgrid-webhook.js');
const SEGMENTS = read('../crm/audienceSegments.js');
const PLAN_VIEW = read('./campaignPlanView.js');
const SEND = read('./campaignSend.js');
const GUARD = read('./engagementGuard.js');

/** コメント行を除いた実コード（コメント内の文字列で合格しないように） */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}

// ── 送信計画への配線 ────────────────────────────────────────
test('【配線】admin-marketing が buildCampaignPlan へ engagementByEmail を渡す', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /buildCampaignPlan\(\{[\s\S]*?engagementByEmail:/,
    'buildCampaignPlan の呼び出しに engagementByEmail が無い（= guard が素通りする）');
  assert.match(code, /buildCampaignPlan\(\{[\s\S]*?engagementThresholds:/);
});

test('【配線】渡す値は engagementGuard の判定結果（Function 側で判定し直さない）', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /resolveEngagementView\(/);
  assert.match(code, /engagementByEmail:\s*engagementView\.engagementByEmail/);
  assert.match(code, /engagementThresholds:\s*engagementView\.thresholds/);
  // 閾値を Function へ直書きしない（単一源は engagementPolicy.js）
  assert.equal(/delivered\s*>=\s*\d+/.test(code), false);
  assert.equal(/lowEngagementSends:\s*\d+/.test(code), false);
});

test('【配線】dry-run と実 enqueue は同じ 1 か所を通る（判定が食い違わない）', () => {
  const code = codeOnly(ADMIN);
  const calls = code.match(/buildCampaignPlan\(\{/g) || [];
  assert.equal(calls.length, 1, `buildCampaignPlan の呼び出しが ${calls.length} か所ある`);
  const views = code.match(/resolveEngagementView\(\{/g) || [];
  assert.ok(views.length >= 1);
  // live 側は dry-run の fingerprint と一致しなければ中止する（対象のすり替え防止）
  assert.match(code, /planFingerprint/);
});

test('【配線】送信計画は Map を渡されたときだけ除外する（既定は素通り）', () => {
  assert.match(SEND, /if \(engagementByEmail instanceof Map\)/);
  assert.match(SEND, /MK_EXCLUSION\.ENGAGEMENT_BLOCKED/);
});

// ── 下見（セグメント）への配線 ──────────────────────────────
test('【配線】セグメントの「送信できる人数」からも engagement 除外が引かれる', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /engagementBlockedEmails:\s*engagementView\.applied\s*\?\s*engagementView\.blockedEmails\s*:\s*null/,
    '適用できないときに Set を渡すと誤除外になる');
  const seg = codeOnly(SEGMENTS);
  assert.match(seg, /engagementBlocked\.has\(e\)/);
  assert.match(seg, /SEG_EXCLUDE\.ENGAGEMENT_BLOCKED/);
  // Set が渡されない限り 1 人も除外しない
  assert.match(seg, /engagementBlockedEmails instanceof Set \? engagementBlockedEmails : new Set\(\)/);
});

test('【表示】除外理由のラベルがサーバー・画面の両方にある（未知コードで実行不可にしない）', () => {
  assert.match(SEND, /engagement_blocked:\s*'/);
  assert.match(PLAN_VIEW, /engagement_blocked:\s*'/);
  assert.match(SEGMENTS, /engagement_blocked:\s*'/);
});

test('【表示】画面へ「適用中か・何人除外か・閾値・期間」を返す', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /engagementResponse\(/);
  assert.match(code, /blockedThisPlan/);
  assert.match(code, /blockedBySegment/);
});

// ── 反応の記録（webhook）────────────────────────────────────
test('【配線】webhook が受信イベントを engagement 集計へ畳む', () => {
  const code = codeOnly(WEBHOOK);
  assert.match(code, /createEngagementSignalStore/);
  assert.match(code, /store\.record\(\{ events: sinkEvents/);
});

test('【安全】集計の書き込み失敗で webhook を落とさない', () => {
  const code = codeOnly(WEBHOOK);
  const idx = code.indexOf('createEngagementSignalStore');
  assert.ok(idx > 0);
  // 直前に try が、直後に catch がある（握り潰す形になっている）
  assert.ok(code.lastIndexOf('try {', idx) > 0);
  assert.ok(code.indexOf('} catch {', idx) > idx);
});

// ── fail closed の骨格 ──────────────────────────────────────
test('【fail closed】適用可の条件がすべてコード上に存在する', () => {
  for (const re of [
    /s\.available !== true/,              // 集計を読めない
    /measurement\.open !== 'enabled'/,    // 開封を計測していない・不明
    /openRecorded <= 0/,                  // 開封の記録が無い
    /now - lastEventAtMs > maxAge/,       // 受信が途絶えている
    /m === 'off'/,                        // 緊急停止
  ]) assert.match(GUARD, re, `fail closed 条件が消えている: ${re}`);
});

test('【fail closed】期間は記録開始より前へ戻せない', () => {
  assert.match(GUARD, /Math\.max\(startedAtMs, parsed\)/);
});

test('【禁止】Airtable の EmailEvents 全件走査へ戻していない', () => {
  const code = codeOnly(GUARD) + codeOnly(read('./engagementSignalStore.js'));
  assert.equal(/EmailEvents/.test(code), false, '削除済みテーブルの全件走査へ戻してはいけない');
});
