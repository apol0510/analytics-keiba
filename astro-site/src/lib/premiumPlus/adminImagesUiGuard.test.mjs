/**
 * adminImagesUiGuard.test.mjs — Premium Plus 画像アップロード画面（/admin/premium-plus-images/）の UI 契約
 *   node --test src/lib/premiumPlus/adminImagesUiGuard.test.mjs
 *
 * ## 数値欄は「直接入力」
 *
 * 2026-09-10 MK 指摘（`/admin/premium-plus-results/` から）:
 *
 * > 払い戻しと払い戻し単価の２箇所は直接入力するのでスクロールで数字を選択するのをやめたい
 * > /admin/premium-plus-images/ も同様に揃えて
 *
 * `type="number"` はスピナー / マウスホイール / 上下キーで**値が勝手に変わる**。
 * この画面の数値は
 *   - 払戻金額 … 1 桁違うと実績（最高払戻・的中時平均払戻）が狂う
 *   - version … 戻し先を間違えると**別の日の実績が本番へ出る**
 * ため、キーボードから打った値だけを受け取る。
 *
 * アップロード API 契約・Blobs・実績集計は対象外（UI のみ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(fileURLToPath(new URL('../../pages/admin/premium-plus-images.astro', import.meta.url)), 'utf8');

const NUMERIC_FIELDS = ['race', 'stake', 'payout', 'rollbackVer'];

test('数値欄が type="number" ではない（勝手に増減させない）', () => {
  for (const id of NUMERIC_FIELDS) {
    const m = PAGE.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `入力欄が見つからない: #${id}`);
    assert.doesNotMatch(m[0], /type="number"/, `#${id} が type="number" に戻っている`);
    assert.match(m[0], /type="text"/, `#${id} は type="text"`);
    assert.match(m[0], /inputmode="numeric"/, `#${id} はスマホでも数字キーパッドを出す`);
  }
});

test('数字以外は入力側で落とす（type="text" にした分の担保）', () => {
  assert.match(PAGE, /for \(const id of \['race', 'stake', 'payout', 'rollbackVer'\]\)/);
  assert.match(PAGE, /el\.value\.replace\(\/\[\^\\d\]\/g, ''\)/);
});

test('読み取りが Number() 直呼びに戻っていない（コンマ付きで NaN / 0 にしない）', () => {
  // Number('277,000') は NaN。必ず数字だけ取り出してから解釈する
  assert.match(PAGE, /const numOf = \(id\) =>/);
  for (const id of NUMERIC_FIELDS) {
    assert.doesNotMatch(PAGE, new RegExp(`Number\\(\\$\\('${id}'\\)\\.value`), `#${id} が Number() 直呼びに戻っている`);
  }
});

test('送信ペイロードの項目名を変えていない（API 契約は不変）', () => {
  for (const key of ['raceNumber:', 'stake:', 'payout:', 'imageBase64,']) {
    assert.ok(PAGE.includes(key), `送信ペイロードから消えている: ${key}`);
  }
  assert.match(PAGE, /const API = '\/\.netlify\/functions\/premium-plus-media'/);
});
