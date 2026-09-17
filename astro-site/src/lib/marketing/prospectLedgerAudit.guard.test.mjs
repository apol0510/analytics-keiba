/**
 * prospectLedgerAudit.guard.test.mjs — **診断経路が read-only のままであること**を固定する
 *   node --test src/lib/marketing/prospectLedgerAudit.guard.test.mjs
 *
 * この action は「Redis の予約と Airtable の配信行のズレ」を**数えるだけ**のもの。
 * 直す・消す・送るへ育ってしまうと、本番データを壊す経路になる。
 *
 * 守る条件:
 *   1. 書き込み系の HTTP メソッド（POST での作成 / PATCH / DELETE）を使わない
 *   2. アドレス・`DeliveryKey`・recordId を返さない
 *   3. 打ち切り・読み取り失敗を**成功として返さない**（fail closed）
 *   4. admin secret の認可を通る経路にだけ生えている
 *   5. tick と**同じ active 判定**（queued / sent）を使う
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ACTIVE_STATUSES } from './prospectLedgerConsistency.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');

/** 説明コメントで grep が誤爆しないように、コメントを外した本体だけを見る */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** `handleProspectLedgerAudit` と、そこから呼ぶ取得関数の本体だけを切り出す */
function bodyOf(name, src = ADMIN) {
  const i = src.indexOf(`async function ${name}(`);
  assert.ok(i > 0, `${name} が見つからない`);
  const rest = src.slice(i);
  const end = rest.indexOf('\n}\n');
  return codeOnly(rest.slice(0, end > 0 ? end : 4000));
}

/* ── ① 配線されている ──────────────────────────────────────────── */

test('【最重要】action として配線されている', () => {
  assert.match(codeOnly(ADMIN), /action === 'prospectLedgerAudit'/, 'action が生えていない');
  assert.match(ADMIN, /async function handleProspectLedgerAudit\(/, 'ハンドラが無い');
});

/* ── ② 書き込まない ────────────────────────────────────────────── */

test('【最重要】診断経路は書き込まない（PATCH / DELETE / レコード作成をしない）', () => {
  for (const fn of ['handleProspectLedgerAudit', 'fetchDeliveryStatusByKeys', 'countJobStatuses']) {
    const body = bodyOf(fn);
    assert.equal(/method:\s*'PATCH'/.test(body), false, `${fn} が PATCH している`);
    assert.equal(/method:\s*'DELETE'/.test(body), false, `${fn} が DELETE している`);
    assert.equal(/records:\s*\[/.test(body), false, `${fn} がレコードを書いている`);
    assert.equal(/performUpsert/.test(body), false, `${fn} が upsert している`);
    // Redis へも書かない（予約・カーソル・集合を触らない）
    assert.equal(/claimDelivered|markDelivered|releaseClaims|setFullRequired|'SET'|SADD|SREM/.test(body), false,
      `${fn} が Redis を書き換えている`);
  }
});

test('【最重要】送信経路を呼ばない', () => {
  const body = bodyOf('handleProspectLedgerAudit');
  assert.equal(/sendgrid|mail\/send|dispatch|queueStep|enqueue/i.test(body), false, '送信側を呼んでいる');
});

/* ── ③ PII を返さない ──────────────────────────────────────────── */

test('【最重要】応答にアドレス・DeliveryKey・recordId を載せない', () => {
  const i = ADMIN.indexOf('async function handleProspectLedgerAudit(');
  const body = ADMIN.slice(i, ADMIN.indexOf('async function fetchDeliveryStatusByKeys('));
  /**
   * 応答（`json(200, {...})`）の組み立て部分だけを見る。
   *
   * ⚠️ **文字列リテラルは外してから**見る。`notice` に
   *    「DeliveryKey は返しません」と**説明として**書いてあるだけで落ちてしまい、
   *    説明を消すほうへ直してしまうため（守りたいのは**キー名**であって語の不在ではない）。
   */
  const res = body.slice(body.lastIndexOf('return json(200, {'));
  const fieldsOnly = res.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
  assert.equal(/emails?\s*:/.test(fieldsOnly), false, '応答にアドレスを入れている');
  assert.equal(/deliveryKeys?\s*:|DeliveryKeys?\s*:/.test(fieldsOnly), false, '応答に DeliveryKey を入れている');
  assert.equal(/recordIds?\s*:/.test(fieldsOnly), false, '応答に recordId を入れている');
  assert.match(res, /counts/, '件数を返していない');
  assert.match(res, /sideEffects: 'none'/, '副作用ゼロを明示していない');
});

/* ── ④ fail closed ────────────────────────────────────────────── */

test('【最重要】Redis を読めなければ数えない（0 件と混同しない）', () => {
  const body = bodyOf('handleProspectLedgerAudit');
  assert.match(body, /redisPresent === null/, '読めなかった場合の分岐が無い');
  assert.match(body, /503/, '読めなかったのに 200 で返している');
});

test('【最重要】Airtable を読み切れなければ部分集計を出さない', () => {
  const body = bodyOf('handleProspectLedgerAudit');
  assert.match(body, /!airtable\.complete/, '打ち切りの判定が無い');
  assert.match(body, /502/, '打ち切りなのに 200 で返している');
  const fetcher = bodyOf('fetchDeliveryStatusByKeys');
  assert.match(fetcher, /complete: false/, '取得側が打ち切りを返せない');
});

test('【最重要】ジョブ集計は打ち切りを成功にしない', () => {
  const body = bodyOf('countJobStatuses');
  assert.match(body, /truncated: true/, '打ち切りを complete:false にしていない');
});

test('【最重要】索引が途中で変わったら 409 でやり直させる', () => {
  const body = bodyOf('handleProspectLedgerAudit');
  assert.match(body, /INDEX_CHANGED/, '索引の変化を検知していない');
  assert.match(body, /409/, 'やり直しを促していない');
});

/* ── ⑤ tick と同じ判定 ────────────────────────────────────────── */

test('【最重要】active の定義が tick（fetchActiveDeliveryKeys）と一致する', () => {
  const i = CRON.indexOf('async function fetchActiveDeliveryKeys(');
  const body = codeOnly(CRON.slice(i, i + 1600));
  // tick 側は queued / sent だけを active として扱う
  assert.match(body, /st === 'queued' \|\| st === 'sent'/, 'tick 側の判定が変わった');
  assert.deepEqual([...ACTIVE_STATUSES], ['queued', 'sent'], '診断側の判定が tick とズレている');
});

test('【最重要】診断は CampaignType で絞らない（列が空の古い行を取りこぼさない）', () => {
  const body = bodyOf('fetchDeliveryStatusByKeys');
  assert.equal(/CampaignType/.test(body), false, 'CampaignType で絞ると古い行を見落とす');
  assert.match(body, /DeliveryKey/, 'DeliveryKey で名指ししていない');
});

/* ── ⑥ 認可 ───────────────────────────────────────────────────── */

test('【最重要】admin secret の認可より後ろに置かれている', () => {
  const src = codeOnly(ADMIN);
  const auth = src.search(/x-admin-secret|isAuthorized|requireAdmin|Forbidden/);
  const dispatch = src.indexOf("action === 'prospectLedgerAudit'");
  assert.ok(auth > 0, '認可の判定が見つからない');
  assert.ok(auth < dispatch, '認可より手前に action が生えている');
});
