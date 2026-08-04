/**
 * deliveryTracking.guard.test.mjs — 「計測を有効にしたらログインできなくなった」を構造的に防ぐ
 *   node --test src/lib/crm/deliveryTracking.guard.test.mjs
 *
 * ── 何を守っているか（2026-08-04 の実測にもとづく）────────────────────
 * 開封・クリックを AK の台帳へ入れるには配信基盤側の設定変更が要る。このとき
 * **クリック計測はアカウント全体で有効化してはいけない**。
 *
 * アカウント設定を ON にすると、1 通ごとの `tracking_settings` で opt-out していない
 * 送信経路すべてで本文リンクが配信基盤のリダイレクタへ書き換わる。実測で opt-out して
 * いない経路には `send-magic-link`（**15 分・単回使用のログイントークン**）が含まれる。
 * 書き換わると、リンク検査ボットの先読みだけでトークンが消費され、本人がクリックした
 * ときには**ログインできない**。
 *
 * そこで:
 *   1. ログインメールは per-message でクリック計測を明示的に切る（アカウント設定より優先）
 *   2. マーケティング配信だけが per-message でクリック計測を有効化できる
 *   3. その有効化は env による明示操作（既定 OFF）。コードに true を直書きしない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isMarketingClickTrackingEnabled } from '../marketing/marketingDispatchGate.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MAGIC = read('../../../netlify/functions/send-magic-link.js');
const DISPATCH = read('../../../netlify/functions/marketing-campaign-dispatch.js');

/** 空白・改行・引用符の揺れを吸収して探す */
const squash = (s) => s.replace(/\s+/g, '').replace(/'/g, '"');

// ── 1. ログインリンクは絶対に書き換えさせない ──────────────────

test('guard: ログインメールはクリック計測を明示的に切っている', () => {
  const s = squash(MAGIC);
  assert.ok(s.includes('clickTracking:{enable:false'),
    'send-magic-link が click tracking を opt-out していない（アカウント設定 ON でトークンが書き換わる）');
});

test('guard: ログインメールでクリック計測を有効化していない', () => {
  const s = squash(MAGIC);
  assert.equal(s.includes('clickTracking:{enable:true'), false, 'ログインリンクを書き換える設定になっている');
  assert.equal(s.includes('enableText:true'), false, 'テキストリンクまで書き換える設定になっている');
});

test('guard: ログインリンクはトークンを含むという前提が消えていない', () => {
  assert.match(MAGIC, /auth\/verify\?token=/, 'トークン付き URL の生成が消えている（前提が変わったら本 guard を見直す）');
});

// ── 2. マーケティング配信だけが有効化できる ────────────────────

test('guard: マーケティング配信は per-message で計測を指定する', () => {
  const s = squash(DISPATCH);
  assert.ok(s.includes('tracking_settings:{'), 'per-message の計測指定が無い（アカウント設定任せになっている）');
  assert.ok(s.includes('open_tracking:{enable:true}'), '開封計測を per-message で指定していない');
});

test('guard: クリック計測を true 直書きしていない（env 経由のみ）', () => {
  const s = squash(DISPATCH);
  assert.equal(s.includes('click_tracking:{enable:true'), false, 'クリック計測を無条件に有効化している');
  assert.match(DISPATCH, /isMarketingClickTrackingEnabled\(process\.env\)/,
    'env ゲートを経由していない');
});

test('guard: クリック計測ゲートは既定 OFF', () => {
  assert.equal(isMarketingClickTrackingEnabled({}), false);
  assert.equal(isMarketingClickTrackingEnabled({ MARKETING_CLICK_TRACKING_ENABLED: 'false' }), false);
  assert.equal(isMarketingClickTrackingEnabled({ MARKETING_CLICK_TRACKING_ENABLED: 'TRUE' }), false,
    '大文字を true 扱いしている（env の綴り揺れで意図せず有効化される）');
  assert.equal(isMarketingClickTrackingEnabled(null), false);
  assert.equal(isMarketingClickTrackingEnabled({ MARKETING_CLICK_TRACKING_ENABLED: 'true' }), true);
});

// ── 3. 計測のために送信経路を増やさない ────────────────────────

test('guard: 計測の都合で新しい送信経路を作っていない', () => {
  // 計測を入れるついでに別の送信先・別の API を足すと、送信の単一源が崩れる
  const sends = DISPATCH.match(/api\.sendgrid\.com\/v3\/mail\/send/g) || [];
  assert.equal(sends.length, 1, `mail/send の呼び出しが ${sends.length} 箇所ある（1 箇所に保つ）`);
});
