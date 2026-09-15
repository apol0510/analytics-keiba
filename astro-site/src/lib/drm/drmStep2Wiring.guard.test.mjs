/**
 * drmStep2Wiring.guard.test.mjs — DRM の step2 以降を**共有シーケンスの通常経路**で進める配線
 *   node --test src/lib/drm/drmStep2Wiring.guard.test.mjs
 *
 * 判定が正しくても、Function 側の配線が違えば本番は動かない（あるいは事故る）。
 * ここでは「どこで誰が決めるか」を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const DRM_CRON = read('../../../netlify/functions/cron-drm-autostart.js');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CATALOG = read('../marketing/campaignCatalog.js');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

// ══════════════════════════════════════════════════════════════════
//  ① 母集団の宣言は campaign 側（env でも引数の既定でもない）
// ══════════════════════════════════════════════════════════════════

test('【最重要】母集団の宣言は campaign 側の SSOT から読む', () => {
  const c = code(CRON);
  assert.match(c, /resolveAudienceSource\(base\)/, 'campaign の宣言を読んでいない');
  assert.ok(!/audienceSource/.test(c.replace(/resolveAudienceSource/g, '')),
    'Function 側で宣言を組み立て直している');
});

test('【最重要】宣言を env から読まない（入口へ漏れる経路を作らない）', () => {
  const c = code(CRON);
  assert.ok(!/env\.[A-Z_]*AUDIENCE/.test(c), '母集団の宣言を env から読んでいる');
  assert.ok(!/MARKETING_SEQUENCE_SOURCE_FILTER/.test(c), 'env の絞り込みが復活している');
});

test('【最重要】宣言と引数が食い違ったら広げずに止める', () => {
  const c = code(CRON);
  assert.match(c, /TICK_ABORT\.AUDIENCE_SOURCE_CONFLICT/);
  // 宣言がある campaign では宣言が勝つ（引数で広げられない）
  assert.match(c, /declaredSource !== AUDIENCE_FILTER\.ALL[\s\S]{0,80}\? declaredSource/);
});

test('【最重要】Customers 限定の campaign では prospect を 1 件も読まない', () => {
  const c = code(CRON);
  assert.match(c, /const customerOnly = resolveAudienceSource\(base\) === AUDIENCE_FILTER\.CUSTOMER/);
  assert.match(c, /if \(wantProspect && !customerOnly && prospectStore && prospectLedger\)/,
    'prospect の読み取りが宣言で止まっていない');
});

test('【最重要】DRM 3 本が Customers 限定を宣言している（catalog の実物）', () => {
  for (const id of ['free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence']) {
    const i = CATALOG.indexOf(`campaignId: '${id}'`);
    assert.ok(i > 0, `${id} が catalog に無い`);
    const block = CATALOG.slice(i, i + 6000);
    assert.match(block, /audienceSource: 'customer'/, `${id} に宣言が無い`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② step1 の gate は弱めない
// ══════════════════════════════════════════════════════════════════

test('【最重要】step1 を撃てる条件は変えていない', () => {
  const c = code(CRON);
  assert.match(c, /allowFirstStep: autoStartDecl !== null && \(autoStartGate\.open === true \|\| dryFirstStep\)/);
  assert.match(c, /previewAllowFirstStep === true && !isDry/, 'live で下見スイッチを止めていない');
});

test('【最重要】入口の候補を読むのは入口ゲートが開いているときだけ（下見を除く）', () => {
  const c = code(CRON);
  assert.match(c, /const buildEntryRows = autoStartDecl !== null && \(autoStartGate\.open \|\| dryFirstStep\)/);
});

test('【重要】入口の env は step1 専用のまま（step2 以降の条件に混ぜない）', () => {
  const c = code(CRON);
  // 入口ゲートを読むのは 1 か所だけ（SSOT は `drmAutoStart.readAutoStartGate`）
  assert.equal((c.match(/readAutoStartGate\(/g) || []).length, 1, '入口ゲートを複数箇所で読んでいる');
  assert.ok(!/MARKETING_DRM_AUTOSTART_ENABLED/.test(c), 'Function が env 名を直接読んでいる');
  /**
   * 入口ゲートの値（`open`）を見てよいのは
   *   ① 入口の候補を組み立てるか（`buildEntryRows`）
   *   ② step1 を選べるか（`allowFirstStep`）
   *   ③ 入口の状態を応答へ載せるか（`autoStartReport`）
   * の 3 用途だけ。step2 以降の条件へ混ぜない。
   */
  const lines = c.split('\n').filter((l) => l.includes('autoStartGate.open'));
  assert.ok(lines.length > 0, '入口ゲートを使っていない');
  for (const l of lines) {
    const allowed = /open:/.test(l) || /previewOnly/.test(l)
      || /buildEntryRows/.test(l) || /allowFirstStep/.test(l);
    assert.ok(allowed, `入口ゲートが想定外の判断に使われている: ${l.trim()}`);
  }
  // 期限・次 step・上限の判断に入口ゲートが混ざっていないこと
  for (const other of ['nextSendAtMs', 'maxRecipients', 'resolveMaxSends']) {
    const i = c.indexOf(other);
    if (i < 0) continue;
    const seg = c.slice(Math.max(0, i - 200), i + 200);
    assert.ok(!seg.includes('autoStartGate'), `${other} の判断に入口ゲートが混ざっている`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ③ 既存の安全装置をそのまま通る
// ══════════════════════════════════════════════════════════════════

test('【最重要】除外・冪等・再検証の単一源を迂回していない', () => {
  for (const keep of [
    'buildSequenceProgress(', 'planSequenceTick(', 'buildCampaignPlan(',
    'buildDeliveryRecords(', 'computeCampaignDeliveryKey', 'claimDelivered(',
    'fetchActiveDeliveryKeys(', 'fetchProviderSuppression(', 'loadResponseByEmail(',
    'loadBlacklistEmails(', 'resolveMaxRecipientsPerTick(',
  ]) {
    assert.ok(CRON.includes(keep), `既存の経路が消えている: ${keep}`);
  }
});

test('【最重要】多重起動は tick 鍵で止める（fail closed）', () => {
  const c = code(CRON);
  assert.match(c, /createDispatchLock\(\{/);
  assert.match(c, /SEQUENCE_TICK_LOCK_ID/);
  assert.match(c, /tick_lock_unavailable/, '鍵を取れないときに積まない形になっていない');
  const iLock = c.indexOf('lock.acquire({');
  const iTick = c.indexOf('runSequenceTick({ env: process.env');
  assert.ok(iLock > 0 && iTick > iLock, '鍵を取る前に tick している');
});

test('【重要】積む直前の fail closed を予約より手前に置いている', () => {
  const c = code(CRON);
  const iClaim = c.indexOf('.claimDelivered(');
  for (const guard of ['audience_source_mixed', 'expected_count_mismatch', 'assertWithinAllowlist({']) {
    const i = c.indexOf(guard);
    assert.ok(i > 0, `${guard} が無い`);
    assert.ok(i < iClaim, `${guard} が予約より後ろにある`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ④ R2 の最終 recipient を副作用 0 で確かめる経路
// ══════════════════════════════════════════════════════════════════

test('【最重要】R2 の下見は既存 sequenceTickPreview を使う（新しい action を作らない）', () => {
  assert.match(ADMIN, /action === 'sequenceTickPreview'/, '既存の下見が無い');
  // campaignId を受け取り、窓契約をそのまま渡している
  const i = ADMIN.indexOf('async function handleSequenceTickPreview(');
  const fn = ADMIN.slice(i, ADMIN.indexOf('\n}\n', i));
  for (const k of ['scope', 'offset', 'limit', 'digest', 'ledgerOffset', 'scanPages']) {
    assert.ok(fn.includes(`${k}:`), `窓の ${k} を渡していない`);
  }
  assert.match(fn, /dryRun: true/, '下見になっていない');
  assert.match(fn, /sideEffects: 'none'/);
  // R2 専用の新しい送信系 action を足していない
  assert.ok(!/action === 'r2/i.test(ADMIN), 'R2 専用の別経路を作っている');
});

test('【最重要】下見は予約より手前で返る（書き込みが構造的に起きない）', () => {
  const c = code(CRON);
  const iDry = c.indexOf('if (isDry) {');
  const iClaim = c.indexOf('.claimDelivered(');
  assert.ok(iDry > 0 && iClaim > iDry, '下見の return が予約より後ろにある');
});

test('【重要】下見の応答で最終対象の出所と人数が読める', () => {
  // 許可リスト適用**後**の出所内訳（prospect が 0 であることを目で確かめる）
  assert.match(CRON, /最終対象の出所/);
  // 人数は既存の要約（`describeAudiencePreview`）をそのまま広げて返している
  assert.match(CRON, /\.\.\.audienceView/, '下見の応答に人数の要約を載せていない');
  const lib = read('../marketing/sequenceAudienceFilter.js');
  assert.match(lib, /'絞り込み後に送る人数'/, '人数の要約が単一源から消えている');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ DRM の入口 Function は step2 を扱わない（役割を混ぜない）
// ══════════════════════════════════════════════════════════════════

test('【重要】入口 Function は step1 の入口だけを担う', () => {
  const c = code(DRM_CRON);
  assert.match(c, /planAutoStartEntries\(\{/);
  assert.match(c, /entryAllowlist: seen\.recordIds/, '入口の許可リストを渡していない');
  // 入口は「まだ受け取っていない人」しか渡さないので、step2 の対象は構造的に入らない
  assert.ok(!/allowFirstStep/.test(c), '入口 Function が step の選択を作り直している');
});
