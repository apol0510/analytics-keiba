/**
 * plusNotifiedWiring.guard.test.mjs — 「案内」列が**画面まで通っている**ことを固定する
 *   node --test src/lib/premiumPlus/plusNotifiedWiring.guard.test.mjs
 *
 * 判定ロジック（`plusNotifiedStatus.js`）が正しくても、Function が呼ばなければ、
 * あるいは画面が描かなければ、運用者には何も見えない。**判定が正しいことと
 * 運用者が気づけることは別**なので、配線そのものを静的に押さえる。
 *
 * ここで壊れると「販売可なのに誰にも案内していない」を**誰も検知できない状態へ
 * 静かに戻る**。エラーは出ない。だから静的ガードにする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
const FN = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
const LIB = readFileSync(new URL('./plusNotifiedStatus.js', import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const FNC = strip(FN);
const PAGEC = strip(PAGE);

/**
 * 関数 1 本の本体だけを切り出す。**次の関数宣言の手前で止める**。
 * ファイル末尾まで取ると後続関数のコードを巻き込み、ガードが誤検知/見逃しになる。
 */
function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} が見つからない`);
  const after = src.slice(start + 1);
  const nextRel = after.search(/\n(?:async )?function [A-Za-z_$]/);
  return nextRel < 0 ? after : after.slice(0, nextRel);
}
const ATTACH = bodyOf(FNC, 'attachPlusNotified');

// ── Function 側 ────────────────────────────────────────────
test('【重要】list と lookup の両方が案内状態を返す', () => {
  assert.match(FNC, /async function attachPlusNotified\(/);
  const calls = FNC.match(/await attachPlusNotified\(/g) || [];
  assert.ok(calls.length >= 2, `attachPlusNotified の呼び出しが ${calls.length} 箇所（list と lookup の 2 経路が必要）`);
  const returns = FNC.match(/^\s*notified,$/gm) || [];
  assert.ok(returns.length >= 2, '応答に notified を含めていない経路がある');
});

test('【重要】配信履歴は名指しでしか引かない（全件走査を作らない）', () => {
  assert.match(FNC, /buildPlusDeliveryFormula\(/);
  // filterByFormula 無しで CampaignDeliveries を読む経路を作らない
  assert.match(ATTACH, /filterByFormula: formula/);
  assert.ok(!/listRecords[\s\S]{0,200}?body: JSON\.stringify\(\{\s*pageSize/.test(ATTACH),
    'formula 無しの listRecords が混ざっている');
});

test('【重要】取得が打ち切られたら不完全な結果を返さない', () => {
  assert.match(FNC, /assertFetchComplete\(\{ table: DELIVERIES_TABLE/);
  assert.match(FNC, /TARGETED_MAX_PAGES/);
});

test('【重要】読めなかったら全員「未確認」に倒す（0 通にしない）', () => {
  assert.match(ATTACH, /available: false/);
  assert.match(ATTACH, /catch/, '取得失敗を捕まえていない（500 で画面ごと落ちる）');
  assert.match(ATTACH, /return unavailable\('read_failed'\)/);
});

test('配信履歴のテーブル名を Customers と取り違えていない', () => {
  assert.match(FNC, /const DELIVERIES_TABLE = .*'CampaignDeliveries'/);
  assert.ok(!ATTACH.includes('CUSTOMERS_TABLE'), '案内の取得が Customers を読んでいる');
});

test('recordId とアドレスの両方で引く（片方だけだと取りこぼす）', () => {
  assert.match(ATTACH, /recordIds: g/);
  assert.match(ATTACH, /emails: g/);
});

test('ログにアドレス・レコード内容を出さない', () => {
  const logs = ATTACH.match(/console\.(log|error|warn)\([^)]*\)/g) || [];
  for (const l of logs) {
    assert.ok(!/r\.email|RecipientEmail|fields|records/.test(l), `ログに個人データが混ざっている: ${l}`);
  }
});

// ── 画面側 ────────────────────────────────────────────────
test('【重要】一覧に「案内」列がある（列ヘッダと本体の両方）', () => {
  assert.match(PAGE, /<th class="c-notified">案内<\/th>/);
  assert.match(PAGEC, /function notifiedCell\(/);
  assert.match(PAGEC, /tr\.appendChild\(notifiedCell\(r\)\)/);
});

test('【重要】「販売可なのに未案内」を要対応として明示する', () => {
  assert.match(PAGEC, /needsAction/);
  assert.match(PAGEC, /要対応/);
  assert.match(PAGEC, /function renderNotifyNote\(/);
  assert.match(PAGEC, /renderNotifyNote\(data\.notified\)/);
});

test('【重要】読み取れないときに「未案内」と書かない（二重送信を誘発する）', () => {
  const cell = PAGEC.slice(PAGEC.indexOf('function notifiedCell'));
  const head = cell.slice(0, cell.indexOf('n.state === '));
  assert.match(head, /!n \|\| !n\.available/);
  assert.match(head, /textContent = '未確認'/);
  assert.ok(!head.includes("'未案内'"), '取得できていないのに未案内と表示している');
});

test('検索・再読込の経路でも案内の集計を落とさない', () => {
  const merges = PAGEC.match(/notified: out\.notified \|\| lastData\.notified/g) || [];
  assert.ok(merges.length >= 2, `案内の引き継ぎが ${merges.length} 箇所（検索と再読込の 2 経路が必要）`);
});

test('案内・実閲覧・表示判定を同じ列にまとめていない', () => {
  for (const th of ['<th class="c-display">表示判定</th>', '<th class="c-realview">実閲覧</th>', '<th class="c-notified">案内</th>']) {
    assert.ok(PAGE.includes(th), `列が消えている: ${th}`);
  }
});

// ── 判定側の不変条件 ────────────────────────────────────────
test('案内済みの判定に sent 以外を数えない', () => {
  assert.match(LIB, /e\.status === 'sent'/);
  assert.ok(!/status === 'queued'\s*\|\|\s*e?\.?status === 'sent'/.test(LIB), 'queued を送信済みに数えている');
});

test('campaignId は catalog の premium-plus-offer に限定する', () => {
  assert.match(LIB, /PLUS_CAMPAIGN_IDS = Object\.freeze\(\['premium-plus-offer'\]\)/);
});
