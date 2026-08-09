/**
 * magicLinkTtl.guard.test.mjs — マジックリンク有効期限の単一源を強制する
 *   node --test src/lib/auth/magicLinkTtl.guard.test.mjs
 *
 * 2026-08-09 の障害:
 *   有効期限が 15 分だったため、Yahoo 側の配信遅延（実測 21〜75 分の滞留）で
 *   **届いた時点でトークンが期限切れ**になり、有料会員がログインできなかった。
 *   同時刻の gmail / docomo / au は遅延 0%。yahoo.co.jp / ymail.ne.jp だけで発生。
 *
 * send-magic-link.js は CommonJS で ESM の定数を import できないため、
 * 値が 2 箇所に存在する。**ズレると案内分数と実際の期限が食い違う**ので、
 * ここで一致を強制する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAGIC_LINK_TTL_MINUTES, MAGIC_LINK_TTL_MS } from './constants.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sender = read('../../../netlify/functions/send-magic-link.js');
const verifyPage = read('../../pages/auth/verify.astro');

test('ESM 定数の分とミリ秒が整合する', () => {
  assert.equal(MAGIC_LINK_TTL_MS, MAGIC_LINK_TTL_MINUTES * 60 * 1000);
});

test('send-magic-link.js の TTL が ESM 定数と一致する', () => {
  const m = sender.match(/const MAGIC_LINK_TTL_MINUTES\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'send-magic-link.js に MAGIC_LINK_TTL_MINUTES が無い');
  assert.equal(Number(m[1]), MAGIC_LINK_TTL_MINUTES,
    `送信側 ${m[1]} 分 と 定数 ${MAGIC_LINK_TTL_MINUTES} 分 がズレている`);
});

test('送信側は定数から期限を計算する（数値の直書きをしない）', () => {
  assert.match(sender, /new Date\(Date\.now\(\) \+ MAGIC_LINK_TTL_MS\)/);
  assert.doesNotMatch(sender, /Date\.now\(\)\s*\+\s*15\s*\*\s*60\s*\*\s*1000/,
    '15 分が直書きで残っている');
});

test('メール文面の分数も定数から出す（直書きしない）', () => {
  assert.match(sender, /\$\{MAGIC_LINK_TTL_MINUTES\}分間有効/);
  assert.doesNotMatch(sender, /このリンクは\s*15\s*分間有効/);
});

test('期限切れ画面の分数も定数から出す', () => {
  assert.match(verifyPage, /define:vars=\{\{\s*TTL_MIN:\s*MAGIC_LINK_TTL_MINUTES\s*\}\}/);
  assert.match(verifyPage, /有効期限（\$\{TTL_MIN\}分）/);
  assert.doesNotMatch(verifyPage, /有効期限（15分）/, '15 分が直書きで残っている');
});

test('配信遅延に耐える長さがある（30 分以上）', () => {
  // 2026-08-09 の実測滞留は最大 75 分。最低でも 30 分は必要。
  assert.ok(MAGIC_LINK_TTL_MINUTES >= 30,
    `TTL ${MAGIC_LINK_TTL_MINUTES} 分は配信遅延に耐えられない`);
});

test('無期限にはしない（単回使用でも上限は設ける）', () => {
  assert.ok(MAGIC_LINK_TTL_MINUTES <= 24 * 60, 'TTL が長すぎる');
});
