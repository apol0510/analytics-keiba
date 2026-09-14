/**
 * drmRealPathWiring.guard.test.mjs — **実配信の経路**が反応を渡していることを固定する
 *   node --test src/lib/drm/drmRealPathWiring.guard.test.mjs
 *
 * 判定の正しさは `drmRealCampaignRouting.test.mjs` が見る。ここで見るのは**配線**。
 * 純粋関数が正しくても、Function が `responseByEmail` を渡さなければ
 * 本番は**線形のまま**で、DRM は 1 通も出し分けない（2026-09-14 まで実際にそうだった）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const ATTR = read('../../../netlify/functions/admin-drm-attribution.js');
const WEBHOOK = read('../../../netlify/functions/sendgrid-webhook.js');
const LOADER = read('./drmResponseLoader.js');

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

test('【配線】自動配信（cron）が反応を進行へ渡す', () => {
  const code = codeOnly(CRON);
  assert.match(code, /loadResponseByEmail\(\{/, 'cron が反応を読んでいない');
  assert.match(code, /responseByEmail: response\.ok \? response\.byEmail : undefined/,
    'cron が buildSequenceProgress へ反応を渡していない（線形のまま）');
});

test('【配線】管理画面の進行 API も同じ反応を使う（画面と実配信がズレない）', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /loadResponseByEmail\(\{/, '管理画面が反応を読んでいない');
  assert.match(code, /responseByEmail: response\.ok \? response\.byEmail : undefined/);
  // 効いたか / 効かなかった理由を必ず返す（黙って線形に戻らない）
  assert.match(code, /responseRouting: \{/);
  assert.match(code, /active: response\.ok === true/);
});

test('【配線】両経路が同じ loader を使う（別実装を作らない）', () => {
  for (const [name, src] of [['cron', CRON], ['admin', ADMIN]]) {
    assert.match(src, /from '\.\.\/\.\.\/src\/lib\/drm\/drmResponseLoader\.js'/,
      `${name} が drmResponseLoader を使っていない`);
  }
  // 連続配信の進行を出す経路では、反応の組み立ては loader の中だけ
  // （`action='drm'` の read-only コホート表示は従来どおり自前で畳んでよい）。
  assert.equal(/resolveResponseState\(/.test(codeOnly(CRON)), false,
    'cron が反応の判定を自前で実装している');
  const admin = codeOnly(ADMIN);
  const seq = admin.slice(admin.indexOf('async function handleSequence('));
  const seqBody = seq.slice(0, seq.indexOf('\nasync function ', 1));
  assert.ok(seqBody.includes('loadResponseByEmail('), 'handleSequence が loader を使っていない');
  assert.equal(/resolveResponseState\(/.test(seqBody), false,
    'handleSequence が反応の判定を自前で実装している');
});

test('【重要】索引の factory を正しい引数名で呼ぶ（例外が握り潰されて未計測に化けない）', () => {
  for (const [name, src] of [['admin', ADMIN], ['cron', CRON], ['attribution', ATTR], ['webhook', WEBHOOK]]) {
    const calls = src.match(/createDeliveryEventIndex\(\{[^}]*\}/g) || [];
    for (const c of calls) {
      assert.match(c, /\{\s*cmd\b/,
        `${name}: createDeliveryEventIndex は { cmd } を受け取る（redisCmd だと例外→常に未計測）`);
    }
  }
});

test('【安全】loader は読むだけ（書き込み・送信をしない）', () => {
  const code = codeOnly(LOADER);
  for (const bad of ['fetch(', 'PATCH', 'POST', 'sendgrid', 'SADD', 'HSET', 'DEL ']) {
    assert.equal(code.includes(bad), false, `loader が ${bad} を含んでいる（read-only ではない）`);
  }
});

test('【安全】反応が読めないときに 0 件として扱わない', () => {
  const code = codeOnly(LOADER);
  // 索引が読めない → byEmail は null（空 Map を渡すと「全員未開封」に化ける）
  assert.match(code, /INDEX_UNREADABLE/);
  assert.match(code, /ok: false, reason, byEmail: null/);
});

test('【安全】cron はゲート判定より前に索引へ接続しない', () => {
  const code = codeOnly(CRON);
  const gate = code.indexOf('readSequenceGates');
  const load = code.indexOf('loadResponseByEmail(');
  assert.ok(gate > 0 && load > gate, 'ゲート判定より前に反応を読んでいる');
});

// ══════════════════════════════════════════════════════════════════
//  入口の自動開始（無料登録 → DRM）
// ══════════════════════════════════════════════════════════════════

test('【配線】cron が入口の宣言とゲートを見て step1 を撃つ', () => {
  const code = codeOnly(CRON);
  assert.match(code, /resolveAutoStart\(base\)/, 'cron が入口の宣言を読んでいない');
  assert.match(code, /readAutoStartGate\(env\)/, 'cron が入口のゲートを読んでいない');
  assert.match(code, /planAutoStartEntries\(\{/, '入口の選定を純粋関数へ委ねていない');
  assert.match(code, /allowFirstStep: autoStartDecl !== null && autoStartGate\.open === true/,
    'step1 を無条件に撃てる状態になっている');
});

test('【安全】入口のゲートが閉じていれば候補を 1 件も読まない', () => {
  const code = codeOnly(CRON);
  const guard = code.indexOf('if (autoStartDecl && autoStartGate.open)');
  // 定義ではなく **呼び出し** がゲートの内側にあること
  const fetchCall = code.indexOf('await fetchAutoStartCandidates({');
  assert.ok(guard > 0, '入口のゲート判定が無い');
  assert.ok(fetchCall > guard, 'ゲート判定より前に候補を読んでいる');
  assert.equal((code.match(/await fetchAutoStartCandidates\(\{/g) || []).length, 1,
    '候補の取得が複数箇所にある');
});

test('【安全】入口の候補取得は Customers を絞って読む（全件走査しない）', () => {
  const code = codeOnly(CRON);
  assert.match(code, /filterByFormula: formula/);
  assert.match(code, /IS_AFTER\(CREATED_TIME\(\)/, '登録の新しい人だけに絞っていない');
  assert.match(code, /assertFetchComplete\(/, '読み切れないまま母集団として扱っている');
});

test('【安全】入口が読めなくても進行中の配信を止めない', () => {
  const code = codeOnly(CRON);
  const block = code.slice(code.indexOf('if (autoStartDecl && autoStartGate.open)'));
  assert.match(block.slice(0, 2500), /catch \(e\)/, '入口の失敗で tick 全体が落ちる');
});

test('【配線】入口を開けたか / 開けなかった理由を必ず返す', () => {
  const code = codeOnly(CRON);
  assert.match(code, /autoStart: autoStartReport/);
  assert.match(code, /summary\['入口'\] = autoStartReport/);
});

test('【安全】入口の判定を Function 側で作り直さない', () => {
  const code = codeOnly(CRON);
  for (const bad of ['hasPurchasedForCampaign(', 'matchesCampaignAudience(']) {
    assert.equal(code.includes(bad), false, `cron が ${bad} を自前で呼んでいる（判定の二重化）`);
  }
});
