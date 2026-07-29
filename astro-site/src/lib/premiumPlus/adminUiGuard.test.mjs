/**
 * adminUiGuard.test.mjs — Premium Plus 販売管理画面（/admin/premium-plus-eligibility/）の UI 契約
 *   node --test src/lib/premiumPlus/adminUiGuard.test.mjs
 *
 * UI 刷新で **write 契約 / preview 契約 / 安全機構**が壊れていないことを source レベルで固定する。
 * （画面は prerender=true の静的ページなので、配信 HTML = このソースそのもの）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');

// ── API 契約（UI 刷新で payload を変えない）────────────────────────
test('write payload が変わっていない（action/update の 4 キー）', () => {
  assert.match(PAGE, /call\(\{\s*action:\s*'update',\s*recordId:\s*r\.recordId,\s*plusAction,\s*reason:\s*memoInput\.value\s*\}\)/);
  // 4 操作の値も不変
  for (const a of ["'staged'", "'immediate'", "'review'", "'blocked'"]) {
    assert.ok(PAGE.includes(a), `plusAction が無い: ${a}`);
  }
});

test('list / preview の payload が変わっていない', () => {
  assert.match(PAGE, /action:\s*'list',\s*onlyReview:/);
  assert.match(PAGE, /action:\s*'preview',[\s\S]{0,200}?recordId:\s*pvRecordId/);
  assert.match(PAGE, /atMin:\s*\$\('pvTime'\)\.value === '' \? null : Number/);
  assert.match(PAGE, /phaseDaysAgo:\s*\$\('pvPhase'\)\.value === '' \? null : Number/);
});

test('管理者認証（x-admin-secret）と secret の非表示を維持', () => {
  assert.match(PAGE, /'x-admin-secret':\s*secret/);
  assert.match(PAGE, /type="password"\s+id="secret"/);
  // secret を画面に描画しない
  assert.doesNotMatch(PAGE, /textContent\s*=\s*secret/);
  assert.doesNotMatch(PAGE, /innerHTML[^\n]*secret/);
});

// ── 安全機構（既存仕様の維持）────────────────────────────────────
test('「今すぐ販売可」の確認ダイアログを維持', () => {
  assert.match(PAGE, /window\.confirm\(/);
  assert.match(PAGE, /この会員は即時PHASE 4となり、価格と購入CTAが表示されます。/);
  // confirm は immediate のときだけ
  assert.match(PAGE, /if \(plusAction === 'immediate'\)\s*\{[\s\S]{0,120}window\.confirm/);
});

test('二重送信防止を維持（busy フラグ + 行内ボタン一括 disable）', () => {
  assert.match(PAGE, /dataset\.busy === '1'\) return/);
  assert.match(PAGE, /buttons\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/);
});

test('fail closed: 書込 gate が無効ならボタンを押せない', () => {
  assert.match(PAGE, /b\.disabled = !data\.writeEnabled \|\| isCurrent \|\| !!extraDisabled/);
  assert.match(PAGE, /mkBtn\('immediate',[^)]*!data\.overrideEnabled\)/);
});

// ── 新 UI 要件 ───────────────────────────────────────────────────
test('状態バッジ 5 種と分類ロジックがある', () => {
  for (const k of ['review', 'staged', 'sale', 'immediate', 'blocked']) {
    assert.ok(PAGE.includes(`.badge.${k}`), `バッジ CSS が無い: ${k}`);
  }
  assert.match(PAGE, /function classify\(r\)/);
  assert.match(PAGE, /if \(r\.eligibility === 'blocked'\) return STATE\.blocked;/);
  assert.match(PAGE, /if \(r\.overrideApplied\) return STATE\.immediate;/);
  assert.match(PAGE, /return r\.phase === 4 \? STATE\.sale : STATE\.staged;/);
});

test('フィルター 7 種と Email 検索がある（クライアント側のみ）', () => {
  for (const label of ['すべて', '保留', '販売可', '即時販売', '販売対象外', 'ROUTE A', 'ROUTE B']) {
    assert.ok(PAGE.includes(`label: '${label}'`), `フィルターが無い: ${label}`);
  }
  assert.match(PAGE, /id="q"[^>]*placeholder="Email で検索"/);
  assert.match(PAGE, /String\(r\.email \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/);
  // 検索・フィルターは再描画のみ。API を呼ばない
  assert.match(PAGE, /\$\('q'\)\.addEventListener\('input', render\)/);
  assert.doesNotMatch(PAGE, /addEventListener\('input',\s*load\)/);
});

test('並び順: 保留 → 販売可/段階公開中 → 即時販売 → 販売対象外、同群は最終更新の新しい順', () => {
  assert.match(PAGE, /order:\s*1[\s\S]{0,200}order:\s*2[\s\S]{0,200}order:\s*2[\s\S]{0,200}order:\s*3[\s\S]{0,200}order:\s*4/);
  assert.match(PAGE, /classify\(a\)\.order - classify\(b\)\.order/);
  assert.match(PAGE, /return ub\.localeCompare\(ua\);/);
});

test('顧客カード: ラベル付きの情報グリッド（1 行連結表示を使わない）', () => {
  for (const k of ['プラン', '三連複', 'Route', 'PHASE', 'Premium経過', '販売許可日', '最終更新']) {
    assert.ok(PAGE.includes(`fact('${k}'`), `情報項目が無い: ${k}`);
  }
  // 旧: 「プラン: … / 三連複: … / route: …」の 1 行連結を復活させない
  assert.doesNotMatch(PAGE, /'プラン: '\s*\+/);
  assert.doesNotMatch(PAGE, /join\('　\/　'\)/);
});

test('操作を 通常 / 強い の 2 グループに分ける', () => {
  assert.match(PAGE, /ops-label'[\s\S]{0,80}'通常操作'/);
  assert.match(PAGE, /ops-label'[\s\S]{0,80}'強い操作'/);
  assert.ok(PAGE.includes('ops-danger'), '危険操作グループが無い');
});

test('現在の状態と同じ操作は disabled（適用中を明示）', () => {
  assert.match(PAGE, /mkBtn\('staged',[^)]*isStagedNow\)/);
  assert.match(PAGE, /mkBtn\('review',[^)]*r\.eligibility === 'review'\)/);
  assert.match(PAGE, /mkBtn\('immediate',[^)]*isImmediate/);
  assert.match(PAGE, /mkBtn\('blocked',[^)]*r\.eligibility === 'blocked'\)/);
  assert.match(PAGE, /現在この状態です（適用中）/);
  assert.ok(PAGE.includes('即時販売を適用中'));
  assert.ok(PAGE.includes('段階公開で適用中'));
});

test('管理接続パネルは折りたたみ、接続済み表示がある', () => {
  assert.match(PAGE, /<details class="conn"/);
  assert.ok(PAGE.includes('管理API 接続済み'));
  assert.match(PAGE, /id="reload"[^>]*class="btn-reload"/);
});

test('サマリーは優先度順（即時販売 / 販売可 / 保留 が先、ROUTE は補助）', () => {
  const i = (s) => PAGE.indexOf(s);
  assert.ok(i("['即時販売', c.immediate") < i("['販売可', c.eligible"));
  assert.ok(i("['販売可', c.eligible") < i("['保留', c.review"));
  assert.ok(i("['保留', c.review") < i("['ROUTE A', c.routeA"));
  assert.match(PAGE, /\['ROUTE A', c\.routeA, 'sub'\]/);
});

test('表示プレビューを維持し、上部に要点をまとめる', () => {
  assert.ok(PAGE.includes('表示プレビュー'));
  assert.ok(PAGE.includes('管理者プレビュー / 実顧客には影響しません'));
  for (const k of ['現在 PHASE', '受付状態', '商品ページ', '価格・CTA', 'purchaseEnabled']) {
    assert.ok(PAGE.includes(`cell('${k}'`), `プレビュー要点が無い: ${k}`);
  }
});

test('Email は省略表示 + title で全文を確認できる', () => {
  assert.match(PAGE, /text-overflow:\s*ellipsis/);
  assert.match(PAGE, /em\.title = r\.email/);
});

test('レスポンシブ対応（狭い画面のブレークポイントがある）', () => {
  assert.match(PAGE, /@media \(max-width: 860px\)/);
  assert.match(PAGE, /@media \(max-width: 640px\)/);
});

// ── read-only / 非破壊 ───────────────────────────────────────────
test('画面から Customers を直接触らない（API 以外の書込経路が無い）', () => {
  assert.doesNotMatch(PAGE, /api\.airtable\.com/);
  assert.doesNotMatch(PAGE, /method:\s*'(PATCH|PUT|DELETE)'/);
  // fetch は管理 Function のみ
  const fetches = PAGE.match(/fetch\(([^)]*)/g) || [];
  for (const f of fetches) assert.match(f, /API|premium-plus-eligibility/, `想定外の fetch: ${f}`);
});

test('顧客データを URL に載せない（recordId をクエリに出さない）', () => {
  assert.doesNotMatch(PAGE, /location\.(search|href)\s*=/);
  assert.doesNotMatch(PAGE, /history\.(push|replace)State/);
  assert.doesNotMatch(PAGE, /\?record=/);
});
