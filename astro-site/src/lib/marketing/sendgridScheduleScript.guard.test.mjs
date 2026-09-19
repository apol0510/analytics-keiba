/**
 * sendgridScheduleScript.guard.test.mjs — 予約スクリプトの**危ない書き方**を固定する
 *
 * スクリプトを import すると本番 API を叩くので、ここは本文を読んで確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../../../scripts/sendgrid-schedule-single-sends.mjs', import.meta.url), 'utf8');
/** コメントを除いた本文（説明文と実装を混同しない） */
const CODE = SRC.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** SendGrid を叩く口だけを切り出す */
const SG = CODE.slice(CODE.indexOf('const sg = async'), CODE.indexOf('const admin ='));

test('触るのは singlesends / lists の GET と PUT だけ', () => {
  assert.match(SRC, /const ALLOWED = \['\/v3\/marketing\/singlesends', '\/v3\/marketing\/lists'\]/);
  assert.match(SRC, /if \(!\['GET', 'PUT'\]\.includes\(method\)\) throw/);
  for (const banned of ['DELETE', "'POST'", '/v3/mail/send']) {
    assert.equal(SG.includes(banned), false, `SendGrid の口が ${banned} を持っている`);
  }
  assert.equal(CODE.includes('/v3/mail/send'), false, 'メール送信 API を持っている');
});

test('既定は下見（--apply と合言葉の両方でだけ予約する）', () => {
  assert.match(SRC, /if \(!apply\) \{[\s\S]*?process\.exit\(0\)/);
  assert.match(SRC, /if \(confirm !== CONFIRM\) fail\(/);
  assert.match(SRC, /const CONFIRM = 'SCHEDULE AK SINGLE SENDS'/);
});

test('予約前の 5 点を満たさなければ予約しない', () => {
  for (const guard of [
    /if \(actionable !== 0\) fail\(/,
    /if \(A - PROVIDER_REJECTED !== Lsum\) fail\(/,
    /if \(expect !== L\[n - 1\]\) fail\(/,
    /if \(drafts !== 27\) fail\(/,
    /if \(already !== 0\) fail\(/,
    /if \(engine !== 'sendgrid'\) fail\(/,
    /if \(missing > 0\) fail\(/,
  ]) assert.match(SRC, guard);
});

test('開始日時が過去なら予約しない', () => {
  assert.match(SRC, /if \(startMs < Date\.now\(\)\) fail\('開始日時が過去です'\)/);
});

test('予約後に 27 件すべてを GET で検証する', () => {
  assert.match(SRC, /Date\.parse\(d\.send_at\) === Date\.parse\(sendAt\)/);
  assert.match(SRC, /d\.status === 'scheduled'/);
  assert.match(SRC, /ok === 27/);
});

test('受信者のアドレスを扱わない（通数・日時・list 名だけ）', () => {
  // contact を引く経路そのものを持たない
  assert.equal(/contacts\/search|\/marketing\/contacts|RecipientEmail|\bemails\b/.test(CODE), false);
  // `email_config`（送信元の設定）以外で email という語を使っていない
  const hits = [...CODE.matchAll(/email[A-Za-z_]*/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(hits)].sort(), ['email_config']);
});

test('新しい配送基盤を作らない（常駐・定期実行・自前送信を持たない）', () => {
  for (const banned of ['setInterval', 'setTimeout', 'node-cron', 'sendMail', 'nodemailer', '@sendgrid/mail']) {
    assert.equal(CODE.includes(banned), false, `${banned} を持っている`);
  }
  // 送信の引き金は SendGrid の schedule だけ（即時送信の経路を持たない）
  assert.equal(/\/singlesends\/[^`']*\/(send|trigger)/.test(CODE), false);
});
