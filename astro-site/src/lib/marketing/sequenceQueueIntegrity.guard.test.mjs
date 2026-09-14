/**
 * sequenceQueueIntegrity.guard.test.mjs — **キュー登録が「書けたつもり」で終わらない**
 *   node --test src/lib/marketing/sequenceQueueIntegrity.guard.test.mjs
 *
 * ## 何が起きたか（2026-09-09〜09-14 の本番障害）
 *
 * `cron-campaign-sequence` の配信台帳 upsert は、**`fetch` の戻り値を一切見ていなかった**。
 * さらに `buildDeliveryRecords` へ渡す `jobIdByEmail` が
 * **`email → jobId(文字列)`** になっており（正しくは `email → { jobId, recordId }`）、
 * `ScheduledEmailJobId` の**無い**配信行が出来ていた。
 *
 * 本番実測（`campaign-discount-free:v1` / 2026-09-14）:
 *
 *   - `queued` 3,855 行のうち **3,854 行が `ScheduledEmailJobId` 欠落**
 *   - dispatcher はその行を引けず（`indexDeliveriesByRecipient` は JobId で引く）、
 *     全員 `delivery_not_found` 相当で skip ＝ **step2 は 1 通も出ない**
 *   - 既送信として数えられないので 10 分ごとに積み直し、
 *     PENDING ジョブ **4,307 件 / 宛先スロット 179,250**（3,771 名 × 42〜46 回）
 *
 * ## ここで固定すること
 *
 *   1. 台帳 upsert の**応答を見る**
 *   2. 書いたあと**読み戻して確かめる**
 *   3. 確かめられなければ**作ったジョブを取り消す**（送られないようにする）
 *   4. 積む前に**名指しで**既存の配信行を突き合わせる（窓の外を見落とさない）
 *   5. `jobIdByEmail` に文字列を入れない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);

test('【重要】配信台帳の upsert は応答を見る（投げっぱなしにしない）', () => {
  // upsert の呼び出しが `const res = await fetch(...)` の形になっていること
  const i = SRC.indexOf("performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }");
  assert.ok(i > 0, 'upsert の呼び出しが見つからない');
  const around = SRC.slice(Math.max(0, i - 600), i + 400);
  assert.match(around, /const res = await fetch\(/, '戻り値を受け取っていない');
  assert.match(SRC, /if \(!res \|\| !res\.ok\) \{ upsertFailed = /, '応答の失敗を拾っていない');
});

test('【重要】書いたあと読み戻して確かめる', () => {
  assert.match(SRC, /verifiedKeys = await fetchActiveDeliveryKeys\(/, '読み戻しが無い');
  assert.match(SRC, /verifiedKeys === null \|\| missingKeys > 0/, '不足を検知していない');
});

test('【重要】確かめられなければ、作ったジョブを取り消す（送らせない）', () => {
  assert.match(SRC, /cancelCreatedJobs\(\{ KEY, BASE, jobs: createdJobs, reason: 'delivery_rows_unconfirmed' \}\)/);
  assert.match(SRC, /Status: 'CANCELLED'/, 'ジョブを取り消す実装が無い');
  // 巻き戻すときは prospect の予約も戻す（戻さないと二度と送られない）
  assert.match(SRC, /releaseClaimedKeys\(prospectLedger, scope, \[\.\.\.claimedKeys\]\)/);
});

test('【重要】`jobIdByEmail` には `{ jobId, recordId }` を入れる（文字列を入れない）', () => {
  assert.match(SRC, /jobIdByEmail\.set\(r\.email, \{ jobId, recordId: jobRecordId \}\)/);
  assert.doesNotMatch(SRC, /jobIdByEmail\.set\(r\.email, jobId\)/, '旧実装（文字列）に戻っている');
});

test('【重要】積む前に、名指しで既存の配信行を突き合わせる（窓の外を見落とさない）', () => {
  assert.match(SRC, /activeKeys = await fetchActiveDeliveryKeys\(/);
  // 名前は変わってよいが、**活きている鍵を除いてから積む**ことは変えない
  assert.match(SRC, /allTargets\.filter\(\(t\) => !activeKeys\.has\(keyOfTarget\(t\)\)\)/);
  // 読めなければ積まない
  assert.match(SRC, /if \(activeKeys === null\) \{/);
  assert.match(SRC, /abort: 'delivery_ledger_unreadable'/);
});

test('【重要】`queued` / `sent` だけを「既にある」と数える（cancelled は積み直せる）', () => {
  const i = SRC.indexOf('async function fetchActiveDeliveryKeys');
  assert.ok(i > 0);
  const fn = SRC.slice(i, i + 1800);
  assert.match(fn, /st === 'queued' \|\| st === 'sent'/);
  assert.doesNotMatch(fn, /st === 'cancelled'/, 'cancelled を既送信に数えている');
});

test('【重要】組み立てで落ちた行があれば書かない（数が合わなければ中止）', () => {
  assert.match(SRC, /deliveryRecords\.length !== airtableRecipients\.length/);
  assert.match(SRC, /abort: 'delivery_records_dropped'/);
});

test('この Function は Customers を書かない（送信処理から会員・課金を触らない）', () => {
  assert.doesNotMatch(SRC, /CUSTOMERS_TABLE\)}\/[^\n]*`,\s*\{\s*method: 'PATCH'/);
  for (const field of ['プラン', 'PlanType', '有効期限', 'LifetimeSanrenpuku', 'Status: \'active\'']) {
    assert.ok(!SRC.includes(`fields: { ${field}`), `${field} を書いている`);
  }
});
