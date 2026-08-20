/**
 * freePreviewCta.guard.test.mjs
 *
 * 2026-08-20 確定: `/free-prediction/` は「無料予想」ではなく **有料版のプレビュー**。
 *   - 無料登録による全頭解放 CTA を撤廃した
 *   - 未登録でも出走全頭と ○▲△ が見える（ゲート撤廃）
 *   - 残る CTA は **有料 1 枚のみ**
 *   - 有料項目（pt / AI総合指数 / 役割 / 買い目）のマスクは**従来どおり維持**
 *
 * ここを戻すと「未登録は◎しか見えないのに解除手段が無い」壊れた状態になるため、
 * 復活を検知できるように固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PAGES = ['nankan', 'jra'].map((c) => ({
  name: c,
  src: readFileSync(join(ROOT, `src/pages/free-prediction/${c}.astro`), 'utf-8'),
}));

test('無料登録で解放する CTA を置かない', () => {
  for (const { name, src } of PAGES) {
    assert.equal(src.includes('locked-free'), false, `${name}: 無料 CTA のクラスが残っている`);
    assert.equal(src.includes('無料登録で全頭を見る'), false, `${name}: 無料 CTA の文言が残っている`);
    assert.equal(src.includes('出走全頭をフル解放'), false, `${name}: 無料 CTA の見出しが残っている`);
    assert.equal(src.includes('cta-badge-free'), false, `${name}: 無料 CTA のバッジが残っている`);
  }
});

test('全頭解放ゲートを復活させない（未登録でも全頭・印が見える）', () => {
  for (const { name, src } of PAGES) {
    assert.equal(
      src.includes('free-member-unlock-content" style="display: none;"'), false,
      `${name}: 既定で隠すゲートが復活している`,
    );
    // 未登録で隠す JS を復活させない
    assert.equal(/free-member-unlock-content'\)[\s\S]{0,200}isRegistered \? 'block' : 'none'/.test(src), false,
      `${name}: 未登録で隠す JS が復活している`);
    assert.equal(src.includes("includes('全頭')"), false, `${name}: 全頭解放鍵の制御が残っている`);
  }
});

test('有料 CTA は残す（1 枚のみ）', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes('locked-paid'), `${name}: 有料 CTA が消えている`);
    assert.ok(src.includes('AI予測買い目'), `${name}: 有料 CTA の見出しが無い`);
    assert.ok(src.includes('/pricing/'), `${name}: 料金ページへの導線が無い`);
    const count = (src.match(/class="locked-content/g) || []).length;
    assert.equal(count, 1, `${name}: CTA は 1 枚だけにする（現在 ${count} 枚）`);
  }
});

test('CTA が 1 枚になったレイアウトに変えている（2 枚並びの grid を残さない）', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes('.access-control-section .locked-content.locked-paid'),
      `${name}: 1 枚用のスタイルが無い`);
    assert.ok(/\.access-control-section\s*\{[^}]*display:\s*block/.test(src),
      `${name}: 2 枚並びの grid のままになっている`);
  }
});

test('有料版プレビューであることをページ内で伝える', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes('preview-note'), `${name}: CTA 横の注記が無い`);
    assert.ok(src.includes('有料版のプレビュー'), `${name}: 位置づけの説明が無い`);
  }
});

test('プレビューであることをページ上部で伝える（CTA まで読まないと分からない状態にしない）', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes('preview-banner'), `${name}: 上部バナーが無い`);
    // 各レースの CTA より前（＝ページ上部）に置かれていること
    const banner = src.indexOf('class="preview-banner"');
    const firstCta = src.indexOf('locked-content locked-paid');
    assert.ok(banner > -1 && firstCta > -1, `${name}: 位置を判定できない`);
    assert.ok(banner < firstCta, `${name}: バナーが CTA より後ろにある（上部に置くこと）`);
    // ヘッダー直後に置く（会場タブやレース一覧より前）
    const header = src.indexOf('class="header-section"');
    assert.ok(header > -1 && header < banner, `${name}: ヘッダーより前に出ている`);
    const races = src.indexOf('venue-selector');
    if (races > -1) assert.ok(banner < races, `${name}: 会場タブより後ろにある`);
  }
});

test('上部バナーは有料への導線を持つ', () => {
  for (const { name, src } of PAGES) {
    const i = src.indexOf('class="preview-banner"');
    const seg = src.slice(i, i + 1200);
    assert.ok(seg.includes('/pricing/'), `${name}: バナーから料金ページへ行けない`);
    assert.ok(seg.includes('PREVIEW'), `${name}: バナーのラベルが無い`);
  }
});

test('有料項目のマスクは維持する（プレビュー化で緩めない）', () => {
  for (const { name, src } of PAGES) {
    assert.ok(src.includes('masked-eval'), `${name}: マスクのクラスが消えている`);
    assert.ok(src.includes('stat-value-masked'), `${name}: 指数マスクの打ち消しが消えている`);
    assert.ok(src.includes('betting-teaser'), `${name}: 買い目のダミー表示が消えている`);
    // 買い目の実データを出していない
    assert.equal(/bettingLines/.test(src), false, `${name}: 買い目の実データを描画している`);
  }
});


// ─── サイト全体の呼び方 ───────────────────────────────────────

test('ナビ・フッター・入口ページで /free-prediction/ を「無料予想」と呼ばない', () => {
  const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf-8');
  const hub = readFileSync(join(ROOT, 'src/pages/free-prediction/index.astro'), 'utf-8');
  for (const [name, src] of [['BaseLayout', layout], ['free-prediction/index', hub]]) {
    assert.equal(src.includes('無料予想'), false,
      `${name}: /free-prediction/ は有料版プレビュー。「無料予想」と呼ばない`);
    assert.equal(src.includes('無料AI予想'), false, `${name}: 「無料AI予想」も同様`);
  }
  assert.ok(layout.includes('AI予想プレビュー'), 'ナビの名称が入っていない');
  assert.ok(hub.includes('AI予想プレビュー'), '入口ページの名称が入っていない');
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
