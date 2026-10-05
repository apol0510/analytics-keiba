/**
 * freePreviewCta.guard.test.mjs
 *
 * 2026-08-20 確定: `/free-prediction/` は「無料予想」ではなく **有料版のプレビュー**。
 * 2026-10-04 MK 確定: プレビューは `/predictions/`（Premium 本利用）と**同一デザイン・同一部品**
 *   （PremiumRaceBoard mode="preview"）。違いは権限状態と CTA だけ（docs/PREDICTION_ACQUISITION.md §2-4）。
 *
 * 守る条件（旧プレビューから継続）:
 *   - 無料登録 CTA で有料 CTA と競合させない／全頭解放ゲートを復活させない
 *   - 有料 CTA（/pricing/）を持つ
 *   - プレビューであることをページ上部で伝える（PREVIEW バナー）
 *   - 有料項目（買い目・AI 総合指数・役割分類）の実データを描画しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const PAGES = ['nankan', 'jra'].map((c) => ({
  name: c,
  src: readFileSync(join(ROOT, `src/pages/free-prediction/${c}.astro`), 'utf-8'),
}));

const BOARD = readFileSync(join(ROOT, 'src/components/acquisition/PremiumRaceBoard.astro'), 'utf-8');
const LIST = readFileSync(join(ROOT, 'src/components/acquisition/AcquisitionRaceList.astro'), 'utf-8');
const BODY = readFileSync(join(ROOT, 'src/components/acquisition/AcquiredPredictionBody.astro'), 'utf-8');
const PREVIEW_VIEW = readFileSync(join(ROOT, 'src/pages/free-prediction/view.astro'), 'utf-8');
const PREVIEW_CONTENT = readFileSync(join(ROOT, 'src/lib/acquisition/previewContent.js'), 'utf-8');

test('無料登録で解放する CTA・全頭解放ゲートを置かない', () => {
  for (const { name, src } of PAGES) {
    for (const w of ['locked-free', '無料登録で全頭を見る', '出走全頭をフル解放', 'cta-badge-free', 'free-member-unlock-content', '/free-signup/']) {
      assert.equal(src.includes(w), false, `${name}: ${w} がある`);
    }
  }
  for (const w of ['/free-signup/', 'locked-free']) assert.equal(BOARD.includes(w), false, `board: ${w}`);
});

test('Premium と同じ部品で描画する（違いは mode だけ）', () => {
  for (const { name, src } of PAGES) {
    assert.match(src, new RegExp(`<PremiumRaceBoard mode="preview" venue="${name}"`), `${name}: 共通部品を使っていない`);
  }
  assert.match(read('src/pages/predictions/index.astro'), /<PremiumRaceBoard mode="premium" venue="all"/);
  assert.match(read('src/pages/free-prediction/all.astro'), /<PremiumRaceBoard mode="preview" venue="all"/);
  for (const c of ['jra', 'nankan']) assert.match(read(`src/pages/premium-prediction/${c}.astro`), new RegExp(`<PremiumRaceBoard mode="premium" venue="${c}"`));
  // 部品の中でカード・タブは 1 つ（モードで分けて別実装を持たない）
  assert.equal((BOARD.match(/<AcquisitionRaceList /g) || []).length, 1);
  assert.equal((BOARD.match(/<AcquisitionVenueTabs /g) || []).length, 1);
});

test('有料 CTA（/pricing/）を Premium の取得ボタンと同じ位置に置く', () => {
  const preview = LIST.slice(LIST.indexOf('{isPreview ? ('), LIST.indexOf(') : r.acquired ? ('));
  assert.match(preview, /<a class="ag-cta ag-cta-premium acq-btn acq-btn-preview" href="\/pricing\/">Premiumで予想を取得<\/a>/);
  assert.match(preview, /この予想を取得するにはPremium/);
  for (const { name, src } of PAGES) assert.ok(src.includes('href="/pricing/"'), `${name}: 料金ページへの導線が無い`);
});

test('プレビューであることをページ上部で伝える（Premiumを体験）', () => {
  const banner = BOARD.indexOf('class="ag-glass ag-tint-violet preview-banner"');
  assert.ok(banner > -1, '上部バナーが無い');
  assert.ok(banner < BOARD.indexOf('<AcquisitionVenueTabs'), 'バナーが会場タブより後ろ');
  assert.ok(banner < BOARD.indexOf('<AcquisitionRaceList'), 'バナーが一覧より後ろ');
  const seg = BOARD.slice(banner, banner + 700);
  assert.ok(seg.includes('PREVIEW'), 'バナーのラベルが無い');
  assert.ok(seg.includes('Premiumを体験'), '見出しが無い');
  assert.ok(seg.includes('1 件ずつ取得'), '取得の説明が無い');
  assert.ok(seg.includes('/pricing/'), 'バナーから料金ページへ行けない');
});

test('有料項目の実データを描画しない（一覧・プレビュー詳細とも）', () => {
  for (const { name, src } of PAGES) {
    for (const w of ['bettingLines', 'computerIndex', 'getHorseAiIndex', 'buildPredictionContent', 'AcquiredPredictionBody']) assert.equal(src.includes(w), false, `${name}: ${w}`);
  }
  // プレビュー詳細は buildPreviewContent だけ（取得後本文・スナップショットを使わない）
  assert.match(PREVIEW_VIEW, /buildPreviewContent\(/);
  for (const w of ['buildPredictionContent', 'readAcquired', 'loadAcquiredView', 'acquisitionStore']) assert.equal(PREVIEW_VIEW.includes(w), false, `view: ${w}`);
  for (const w of ['bettingLines', 'umatan', 'aiIndex', 'getHorseAiIndex', 'computerIndex', ' pt']) assert.equal(PREVIEW_CONTENT.replace(/\/\*[\s\S]*?\*\//, '').includes(w), false, `previewContent: ${w}`);
  // 部品のプレビュー分岐は買い目をダミーのモザイクで描く
  assert.match(BODY, /class="betting-teaser ag-inset"/);
  assert.match(BODY, /\.betting-teaser \{[^}]*filter: blur\(/);
});

// ─── サイト全体の呼び方 ───────────────────────────────────────

test('/free-prediction/ を「無料予想」と呼ばない（呼び名は AI予想プレビュー）', () => {
  const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf-8');
  const hub = readFileSync(join(ROOT, 'src/pages/free-prediction/index.astro'), 'utf-8');
  const home = readFileSync(join(ROOT, 'src/pages/index.astro'), 'utf-8');

  // /free-prediction/ へのリンクに「無料予想」というラベルを付けない。
  // （2026-08-20 以降「無料予想」は /free/ を指す名前になった）
  for (const [name, src] of [['BaseLayout', layout], ['free-prediction/index', hub], ['index', home]]) {
    const bad = [...src.matchAll(/href="\/free-prediction\/[^"]*"[^>]*>([^<]*)</g)]
      .map((m) => m[1])
      .filter((label) => label.includes('無料予想') || label.includes('無料AI予想'));
    assert.deepEqual(bad, [], `${name}: /free-prediction/ のリンクに「無料予想」ラベルが付いている`);
  }
  assert.equal(hub.includes('無料AI予想'), false, '入口ページの見出しが「無料AI予想」に戻っている');
  assert.ok(layout.includes('AI予想プレビュー'), 'ナビの名称が入っていない');
  assert.ok(hub.includes('AI予想プレビュー'), '入口ページの名称が入っていない');
});

test('「無料予想」というラベルは /free/ を指す', () => {
  const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf-8');
  assert.ok(/href="\/free\/[^"]*"[^>]*>[^<]*無料予想/.test(layout)
    || /href="\/free\/[^"]*"[\s\S]{0,160}?無料予想/.test(layout),
    'ナビの「無料予想」が /free/ を指していない');
});

test('トップページから /free/ へ到達できる', () => {
  const home = readFileSync(join(ROOT, 'src/pages/index.astro'), 'utf-8');
  for (const href of ['/free/jra/', '/free/nankan/']) {
    assert.ok(home.includes(href), `トップページに ${href} への導線が無い`);
  }
  // 「無料で〜予想を見る」系のボタンは無料ページへ向ける
  const bad = [...home.matchAll(/href="(\/free-prediction\/[^"]*)"[^>]*>\s*([^<]*)/g)]
    .filter(([, , label]) => /無料で.*予想を見る/.test(label));
  assert.deepEqual(bad.map((m) => m[1]), [], '「無料で〜予想を見る」が有料版プレビューへ向いている');
});

test('2 ページの title を「無料予想」にしない', () => {
  for (const { name, src } of PAGES) {
    const m = src.match(/title=(?:"([^"]*)"|\{`([^`]*)`\})/);
    assert.ok(m, `${name}: title が読めない`);
    const title = m[1] || m[2] || '';
    assert.equal(title.includes('無料予想'), false, `${name}: title が実態と食い違っている: ${title}`);
  }
});

test('2 ページの description が「無料公開」と言わない', () => {
  for (const { name, src } of PAGES) {
    const m = src.match(/description=(?:"([^"]*)"|\{`([^`]*)`\})/);
    assert.ok(m, `${name}: description が読めない`);
    const desc = m[1] || m[2] || '';
    assert.equal(/無料(?:公開|予想|で提供)/.test(desc), false,
      `${name}: description が実態と食い違っている: ${desc}`);
    assert.ok(desc.includes('プレビュー'), `${name}: description にプレビューの明示が無い`);
  }
});
