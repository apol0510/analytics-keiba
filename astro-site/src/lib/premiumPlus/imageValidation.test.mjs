/**
 * imageValidation.test.mjs — 画像検証（magic bytes / 寸法 / サイズ / checksum）
 *   node --test src/lib/premiumPlus/imageValidation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateImage, detectFormat, decodeBase64Image, IMAGE_REJECT, IMAGE_LIMITS } from './imageValidation.js';
import { makePng, makePngHeader, makeJpeg, makeWebp } from './testHelpers.mjs';

test('PNG を検出し寸法・checksum を返す', async () => {
  const r = await validateImage(makePng(200, 150));
  assert.equal(r.ok, true);
  assert.equal(r.format, 'png');
  assert.equal(r.contentType, 'image/png');
  assert.equal(r.width, 200);
  assert.equal(r.height, 150);
  assert.match(r.checksum, /^[0-9a-f]{64}$/);
});

test('JPEG / WebP も検出する', async () => {
  const j = await validateImage(makeJpeg(300, 200));
  assert.equal(j.ok, true); assert.equal(j.format, 'jpeg'); assert.equal(j.width, 300);
  const w = await validateImage(makeWebp(250, 120));
  assert.equal(w.ok, true); assert.equal(w.format, 'webp'); assert.equal(w.width, 250);
});

// #31 MIME 偽装拒否: content-type 申告に関係なく magic bytes で判定
test('#31 MIME 偽装（PNG 申告の実 SVG）→ 拒否', async () => {
  const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const r = await validateImage(svg);
  assert.equal(r.ok, false);
  assert.equal(r.reason, IMAGE_REJECT.UNSUPPORTED_FORMAT);
});

// #32 SVG/HTML 拒否
test('#32 HTML / JS を拒否', async () => {
  const html = new TextEncoder().encode('<!doctype html><html><body><script>alert(1)</script></body></html><!-- padding padding padding -->');
  assert.equal((await validateImage(html)).reason, IMAGE_REJECT.UNSUPPORTED_FORMAT);
  const js = new TextEncoder().encode('function x(){return 1}; // ' + 'padding '.repeat(10));
  assert.equal((await validateImage(js)).reason, IMAGE_REJECT.UNSUPPORTED_FORMAT);
  assert.equal(detectFormat(new TextEncoder().encode('<svg')), null);
});

// #33 サイズ超過拒否
test('#33 サイズ上限超過 → 拒否', async () => {
  const big = new Uint8Array(IMAGE_LIMITS.MAX_BYTES + 1);
  big.set(makePng(100, 100).slice(0, 33));
  assert.equal((await validateImage(big)).reason, IMAGE_REJECT.TOO_LARGE);
});

test('小さすぎ / 空 → 拒否', async () => {
  assert.equal((await validateImage(new Uint8Array(0))).reason, IMAGE_REJECT.EMPTY);
  assert.equal((await validateImage(new Uint8Array(10))).reason, IMAGE_REJECT.TOO_SMALL);
});

test('寸法が範囲外 → 拒否（構造検査より前で弾く）', async () => {
  assert.equal((await validateImage(makePngHeader(10, 10))).reason, IMAGE_REJECT.DIMENSIONS_OUT_OF_RANGE);
  assert.equal((await validateImage(makePngHeader(9000, 9000))).reason, IMAGE_REJECT.DIMENSIONS_OUT_OF_RANGE);
});

test('magic は正しいがヘッダ破損 → corrupt', async () => {
  // PNG シグネチャだけで IHDR 無し
  const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(60).fill(0)]);
  assert.equal((await validateImage(broken)).reason, IMAGE_REJECT.CORRUPT);
});

// #9 ヘッダ正常でも本体が途中欠損 → truncated（構造検査で検知）
test('#9 本体途中欠損（PNG/JPEG/WebP）→ truncated', async () => {
  const png = makePng(200, 150);
  assert.equal((await validateImage(png.slice(0, png.length - 10))).reason, IMAGE_REJECT.TRUNCATED); // IEND 欠損
  const jpg = makeJpeg(300, 200);
  assert.equal((await validateImage(jpg.slice(0, jpg.length - 2))).reason, IMAGE_REJECT.TRUNCATED); // EOI 欠損
  const webp = makeWebp(250, 120);
  assert.equal((await validateImage(webp.slice(0, webp.length - 16))).reason, IMAGE_REJECT.TRUNCATED); // RIFF サイズ不整合
});

// PNG チャンク内容の破損（CRC 不一致）→ truncated 扱いで拒否
test('PNG の内容破損（CRC 不一致）→ 拒否', async () => {
  const png = makePng(200, 150);
  png[png.length - 6] ^= 0xff; // IEND 近傍の 1 バイトを破壊
  const r = await validateImage(png);
  assert.equal(r.ok, false);
  assert.equal(r.reason, IMAGE_REJECT.TRUNCATED);
});

test('完全な PNG/JPEG/WebP は構造検査を通る', async () => {
  assert.equal((await validateImage(makePng(200, 150))).ok, true);
  assert.equal((await validateImage(makeJpeg(300, 200))).ok, true);
  assert.equal((await validateImage(makeWebp(250, 120))).ok, true);
});

test('同一バイトは同一 checksum（冪等キーの基礎）', async () => {
  const a = await validateImage(makePng(200, 150));
  const b = await validateImage(makePng(200, 150));
  assert.equal(a.checksum, b.checksum);
  const c = await validateImage(makePng(201, 150));
  assert.notEqual(a.checksum, c.checksum);
});

test('decodeBase64Image は data URL / 素 base64 を受ける', () => {
  const png = makePng(200, 150);
  const b64 = Buffer.from(png).toString('base64');
  assert.equal(decodeBase64Image(`data:image/png;base64,${b64}`).length, png.length);
  assert.equal(decodeBase64Image(b64).length, png.length);
  assert.equal(decodeBase64Image(''), null);
});
