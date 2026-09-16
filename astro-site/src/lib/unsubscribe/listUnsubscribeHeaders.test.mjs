/**
 * listUnsubscribeHeaders.test.mjs — 配信停止ヘッダの単一源と、全送信経路の配線を固定する。
 *   node --test src/lib/unsubscribe/listUnsubscribeHeaders.test.mjs
 *
 * 守りたいこと（2026-09-16 / 実害から）:
 *   Apple Mail は `List-Unsubscribe` に mailto が併記されていると mailto を選ぶ。
 *   その結果 `unsubscribe@keiba.link` にメールが届くだけで AK の状態は変わらず、
 *   **人が受信箱を見て手で止める運用**が必要になっていた。mailto を全経路から外す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  buildListUnsubscribeHeaders, buildUnsubscribeUrl, listUnsubscribeHeadersFor,
  ONE_CLICK_POST_VALUE, DEFAULT_BRAND,
} from './listUnsubscribeHeaders.js';

const FUNCTIONS_DIR = fileURLToPath(new URL('../../../netlify/functions/', import.meta.url));
const read = (f) => readFileSync(join(FUNCTIONS_DIR, f), 'utf8');

// ── 単一源の中身 ────────────────────────────────────────────────

test('ヘッダは 2 本そろって出る（片方だけではワンクリックにならない）', () => {
  const h = buildListUnsubscribeHeaders('https://example.test/u?email=a%40b.c&brand=analytics-keiba');
  assert.equal(h['List-Unsubscribe'], '<https://example.test/u?email=a%40b.c&brand=analytics-keiba>');
  assert.equal(h['List-Unsubscribe-Post'], ONE_CLICK_POST_VALUE);
  assert.equal(Object.keys(h).length, 2);
});

test('【本件】mailto を絶対に含めない', () => {
  const h = listUnsubscribeHeadersFor({ email: 'someone@example.test' });
  assert.ok(!/mailto:/i.test(h['List-Unsubscribe']), 'mailto が混ざっている（Apple Mail が mailto を選ぶ）');
});

test('https 以外は組み立てない（壊れたヘッダで送らない）', () => {
  for (const bad of ['', null, undefined, 'http://example.test/u', 'mailto:unsubscribe@keiba.link']) {
    assert.throws(() => buildListUnsubscribeHeaders(bad), `${bad} を通している`);
  }
});

test('URL は受信者ごと（email と brand が入る・エスケープされる）', () => {
  const url = buildUnsubscribeUrl({ email: 'a+b@example.test' });
  assert.match(url, /^https:\/\//);
  assert.match(url, /email=a%2Bb%40example\.test/);
  assert.match(url, new RegExp(`brand=${DEFAULT_BRAND}`));
});

// ── 全送信経路の配線 ────────────────────────────────────────────

/** `List-Unsubscribe` を出している Function を実ファイルから探す（素通り防止） */
function sendingFunctions() {
  return readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /List-Unsubscribe|buildListUnsubscribeHeaders|listUnsubscribeHeadersFor/.test(read(f)));
}

test('配信停止ヘッダを出す Function を検出できている（セレクタ陳腐化の検知）', () => {
  const files = sendingFunctions();
  assert.ok(files.length >= 5, `検出 ${files.length} 件は少なすぎる（${files.join(', ')}）`);
});

test('【本件】どの送信経路も mailto を併記しない', () => {
  const offenders = sendingFunctions().filter((f) => /mailto:\s*unsubscribe/i.test(read(f)));
  assert.deepEqual(offenders, [],
    `mailto を併記している経路がある: ${offenders.join(', ')}（Apple Mail が mailto を選び、人手対応が必要になる）`);
});

test('【本件】ヘッダを自前で組み立てず単一源を使う', () => {
  const offenders = sendingFunctions().filter((f) => {
    const src = read(f);
    const usesSingleSource = /buildListUnsubscribeHeaders|listUnsubscribeHeadersFor/.test(src);
    // 自前でヘッダ名を書いている（= 単一源を迂回している）
    const handRolled = /['"]List-Unsubscribe['"]\s*:/.test(src);
    return handRolled && !usesSingleSource;
  });
  assert.deepEqual(offenders, [], `単一源を迂回している: ${offenders.join(', ')}`);
});

test('ワンクリックの合図は送信側と受信側で同じ文字列', async () => {
  const { parseUnsubscribeRequest, REQUEST_KIND } = await import('./parseUnsubscribeRequest.js');
  const r = parseUnsubscribeRequest({
    contentType: 'application/x-www-form-urlencoded',
    rawBody: ONE_CLICK_POST_VALUE, // 送信側が宣言した値をそのまま投げ返す
    query: { email: 'a@b.test', brand: DEFAULT_BRAND },
  });
  assert.equal(r.kind, REQUEST_KIND.ONE_CLICK, '送信側の宣言を受信側が受理できていない');
});
