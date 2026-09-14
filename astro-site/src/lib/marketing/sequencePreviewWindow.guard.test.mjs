/**
 * sequencePreviewWindow.guard.test.mjs — 下見は**窓で切り、1 バイトも書かない**
 *   node --test src/lib/marketing/sequencePreviewWindow.guard.test.mjs
 *
 * ## なぜ要るか（2026-09-14 実測）
 *
 * 下見を「本番と同じ `runSequenceTick` を通す」形にしたところ、母数が 1 万件規模のため
 * 同期 Function の 30 秒に収まらず **504（31 秒）** になった。
 * さらに当時の実装は、下見なのに
 *
 *   - 配信台帳の**走査カーソルを書いていた**（本番 tick の進み位置を動かす）
 *   - **集計（sequenceMetrics）も書いていた**
 *
 * 「read-only の下見」を名乗る以上どちらも許されない。窓で切り、書き込みを全部止める。
 *
 * ## 固定すること
 *
 *   1. 下見は**カーソルを読まない・書かない**
 *   2. 下見は**集計を書かない**
 *   3. 下見は**予約より手前**で返る（従来どおり）
 *   4. 窓（scope / offset / limit / digest / ledgerOffset / scanPages）が配線されている
 *   5. 続きの位置（`nextLedgerOffset` / `nextOffset`）を返す
 *   6. `digest` は prospect の読み込みへ渡る（変化したら fail closed で中止）
 *   7. 本番 tick は**従来どおり**（窓を渡さなければ挙動が変わらない）
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

test('【重要】下見はカーソルを書かない', () => {
  assert.match(CRON, /if \(!isDry\) await scanStore\.write\(campaignType, next\)/,
    '下見でもカーソルを書いている');
});

test('【重要】下見はカーソルを読まない（本番の進み位置に依存しない）', () => {
  assert.match(CRON, /const cursor = isDry\s*\?\s*\{ offset: \(win && win\.ledgerOffset\) \|\| null, pass: 0 \}/,
    '下見が保存カーソルを読んでいる');
});

test('【重要】下見は集計も書かない', () => {
  const i = CRON.indexOf('createSequenceMetricsStore({ redisCmd })');
  assert.ok(i > 0);
  const before = CRON.slice(Math.max(0, i - 400), i);
  assert.match(before, /if \(isDry\) throw new Error\('dry_run_skip_metrics'\)/,
    '下見で集計を書いている');
});

test('【重要】下見は予約より手前で返る（従来どおり）', () => {
  const iDry = CRON.indexOf('if (isDry) {');
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iDry > 0 && iClaim > iDry, '下見が予約より後ろにある');
});

/**
 * ⚠️ **ゲートの厳密な形は marketing 側で固定する**（2026-09-14）。
 *
 * `drm/drmEntryIsolation.test.mjs` は DRM 入口の不変条件を守るためのもので、
 * 共有 cron のゲート判定は `/!gates\.allOpen/` という**緩い形**で見ている。
 * 下見（`dryRun`）を足した側の責任として、**厳密な形**はここで見る。
 * こうしておけば、DRM 側の guard を書き換えずに済む（他セッションの契約を上書きしない）。
 */
test('【重要】実送信の経路はゲートが揃うまで進まない（下見だけが例外）', () => {
  assert.match(CRON, /if \(!isDry && !gates\.allOpen\)/, 'ゲートで止める分岐が消えている');
});

test('【重要】ゲートを迂回する分岐を作らない', () => {
  assert.doesNotMatch(CRON, /if \(gates\.allOpen \|\|/, 'ゲートを迂回する分岐が入っている');
  assert.doesNotMatch(CRON, /gates\.allOpen = /, 'ゲートの判定結果を書き換えている');
  // 下見は「書かない」ことでゲート免除が成立している。書き込みが混ざれば免除は成り立たない
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 2000);
  for (const banned of ['claimDelivered', 'markDelivered', "method: 'PATCH'", 'scanStore.write']) {
    assert.equal(seg.includes(banned), false, `下見の中に書き込みがある: ${banned}`);
  }
});

test('【重要】窓の指定が配線されている', () => {
  for (const k of ['scope', 'offset', 'limit', 'digest', 'ledgerOffset', 'scanPages']) {
    assert.ok(ADMIN.includes(`${k}:`), `admin 側に ${k} が無い`);
  }
  assert.match(ADMIN, /dryRun: true, preview,/, 'preview を渡していない');
  assert.match(CRON, /preview = null,/, 'tick 側が preview を受け取っていない');
});

test('【重要】続きの位置を返す（呼び出し側が全窓を合算できる）', () => {
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 2000);
  assert.match(seg, /nextLedgerOffset/, '台帳側の続きが無い');
  assert.match(seg, /nextOffset/, 'prospect 側の続きが無い');
  assert.match(seg, /digest: prospectInputs\.digest/, '指紋を返していない');
});

test('【重要】digest は prospect の読み込みへ渡る（変化したら中止できる）', () => {
  assert.match(CRON, /expectDigest: String\(win\.digest \|\| ''\)\.trim\(\) \|\| undefined/,
    'digest を渡していない');
});

test('【重要】scope で読む範囲を切る（見ない側は 1 件も読まない）', () => {
  assert.match(CRON, /const wantCustomer = !win \|\| previewScope === null \|\| previewScope === 'customer'/);
  assert.match(CRON, /const wantProspect = !win \|\| previewScope === null \|\| previewScope === 'prospect'/);
  // Customers 側を見ないときは台帳を 1 ページも読まない
  assert.match(CRON, /scan = wantCustomer[\s\S]{0,200}: \{ records: \[\], offset: null, partial: false, pages: 0 \}/);
  assert.match(CRON, /if \(!wantProspect\) prospectDegraded = 'preview_scope_customer'/);
});

test('【重要】本番 tick は窓を渡さなければ従来どおり', () => {
  // win は dryRun のときだけ効く
  assert.match(CRON, /const win = \(isDry && preview && typeof preview === 'object'\) \? preview : null/);
  // 台帳のページ上限は、渡されなければ従来の env 由来
  assert.match(CRON, /\? maxPagesOverride : resolvePagesPerTick\(process\.env\)/);
});

test('下見の応答に宛先を載せない', () => {
  const iDry = CRON.indexOf('if (isDry) {');
  const seg = CRON.slice(iDry, iDry + 2000);
  assert.equal(/recipients:|Recipients|\bemails\b/.test(seg), false, '下見の応答に宛先が混ざっている');
});
