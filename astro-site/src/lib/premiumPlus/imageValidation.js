/**
 * imageValidation.js — 画像実データ検証（純粋・WebCrypto のみ）
 *
 * MIME 申告を信用せず magic bytes で形式を判定する。PNG / JPEG / WebP のみ許可し、
 * SVG / HTML / JS / 実行形式などは allow-list 非該当として全て拒否する。
 * サイズ上下限・寸法上下限・ヘッダ破損を検査し、checksum(SHA-256) を計算して返す。
 */

import { sha256hex } from './mediaKeys.js';

export const IMAGE_LIMITS = Object.freeze({
  MAX_BYTES: 5 * 1024 * 1024,
  MIN_BYTES: 64,
  MIN_DIM: 50,
  MAX_DIM: 6000,
});

export const IMAGE_REJECT = Object.freeze({
  EMPTY: 'empty',
  TOO_SMALL: 'too_small',
  TOO_LARGE: 'too_large',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  CORRUPT: 'corrupt',
  TRUNCATED: 'truncated', // ヘッダは正常だが本体が途中欠損 / チャンク不整合
  DIMENSIONS_OUT_OF_RANGE: 'dimensions_out_of_range',
});

const CONTENT_TYPE = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function u8(input) {
  if (input instanceof Uint8Array) return input;
  if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

/** magic bytes から形式を判定。allow-list 非該当は null（＝拒否）。 */
export function detectFormat(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // WebP: 'RIFF' .... 'WEBP'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

function readPngDimensions(b) {
  // IHDR は先頭シグネチャ(8) + length(4) + 'IHDR'(4) の直後。width=16..19, height=20..23（BE）
  if (b.length < 24) return null;
  if (!(b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52)) return null; // 'IHDR'
  const width = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  const height = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readJpegDimensions(b) {
  let i = 2; // FF D8 の直後
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // SOF0..SOF15（C4=DHT, C8=JPG, CC=DAC を除く）に高さ・幅
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segLen = (b[i + 2] << 8) | b[i + 3];
    if (isSof) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    if (segLen < 2) return null;
    i += 2 + segLen;
  }
  return null;
}

function readWebpDimensions(b) {
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === 'VP8 ') {
    // lossy: 0x9D 0x01 0x2A の後に 14bit width/height
    const start = 20;
    if (b.length < start + 6) return null;
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    const width = ((b[27] << 8) | b[26]) & 0x3fff;
    const height = ((b[29] << 8) | b[28]) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    // lossless: signature 0x2F の後 14bit ずつ
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === 'VP8X') {
    // extended: canvas width-1 / height-1 が 24bit LE（offset 24 / 27）
    if (b.length < 30) return null;
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

function readDimensions(format, b) {
  if (format === 'png') return readPngDimensions(b);
  if (format === 'jpeg') return readJpegDimensions(b);
  if (format === 'webp') return readWebpDimensions(b);
  return null;
}

// --- 構造完全性検査（ヘッダは正常だが途中欠損・破損の検出） ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG: 全チャンクを歩き、長さ整合・CRC 一致・末尾 IEND を検証（truncation / 破損検知）。 */
function verifyPng(b) {
  let p = 8; // シグネチャ後
  let sawIhdr = false;
  let sawIend = false;
  while (p + 12 <= b.length) {
    const len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    if (len < 0) return false;
    const typeStart = p + 4;
    const dataStart = p + 8;
    const crcStart = dataStart + len;
    if (crcStart + 4 > b.length) return false; // 途中欠損
    const type = String.fromCharCode(b[typeStart], b[typeStart + 1], b[typeStart + 2], b[typeStart + 3]);
    if (type === 'IHDR') sawIhdr = true;
    const expected = (b[crcStart] << 24) | (b[crcStart + 1] << 16) | (b[crcStart + 2] << 8) | b[crcStart + 3];
    if ((crc32(b, typeStart, crcStart) >>> 0) !== (expected >>> 0)) return false; // 内容破損
    p = crcStart + 4;
    if (type === 'IEND') { sawIend = true; break; }
  }
  return sawIhdr && sawIend && p === b.length; // 末尾ぴったりで IEND 終端
}

/** JPEG: マーカーを SOS まで歩き整合を確認し、末尾 EOI(FFD9) を要求（truncation 検知）。 */
function verifyJpeg(b) {
  const n = b.length;
  if (n < 4 || b[n - 2] !== 0xff || b[n - 1] !== 0xd9) return false; // EOI が末尾に無い＝途中欠損
  let i = 2;
  while (i + 1 < n) {
    if (b[i] !== 0xff) return false;
    const m = b[i + 1];
    if (m === 0xd9) return true;
    if (m === 0xda) return true; // SOS 到達（以降は entropy。末尾 EOI は確認済み）
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; } // standalone
    if (i + 3 >= n) return false;
    const segLen = (b[i + 2] << 8) | b[i + 3];
    if (segLen < 2) return false;
    i += 2 + segLen;
  }
  return false;
}

/** WebP: RIFF サイズ整合 + チャンクの敷き詰め整合（truncation 検知）。 */
function verifyWebp(b) {
  const n = b.length;
  if (n < 20) return false;
  const riffSize = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24);
  if (riffSize !== n - 8) return false; // 宣言サイズと実サイズ不一致＝途中欠損
  let p = 12;
  while (p + 8 <= n) {
    const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (size < 0) return false;
    let next = p + 8 + size;
    if (size & 1) next += 1; // 奇数はパディング 1
    if (next > n) return false;
    p = next;
  }
  return p === n;
}

function verifyStructure(format, b) {
  if (format === 'png') return verifyPng(b);
  if (format === 'jpeg') return verifyJpeg(b);
  if (format === 'webp') return verifyWebp(b);
  return false;
}

/**
 * 画像バイト列を検証し checksum を計算する。
 * @returns {Promise<{ok:true, format, contentType, width, height, byteSize, checksum}|{ok:false, reason}>}
 */
export async function validateImage(input, { subtle } = {}) {
  const bytes = u8(input);
  if (!bytes || bytes.length === 0) return { ok: false, reason: IMAGE_REJECT.EMPTY };
  if (bytes.length < IMAGE_LIMITS.MIN_BYTES) return { ok: false, reason: IMAGE_REJECT.TOO_SMALL };
  if (bytes.length > IMAGE_LIMITS.MAX_BYTES) return { ok: false, reason: IMAGE_REJECT.TOO_LARGE };

  const format = detectFormat(bytes);
  if (!format) return { ok: false, reason: IMAGE_REJECT.UNSUPPORTED_FORMAT };

  const dims = readDimensions(format, bytes);
  if (!dims) return { ok: false, reason: IMAGE_REJECT.CORRUPT };
  if (
    dims.width < IMAGE_LIMITS.MIN_DIM || dims.height < IMAGE_LIMITS.MIN_DIM ||
    dims.width > IMAGE_LIMITS.MAX_DIM || dims.height > IMAGE_LIMITS.MAX_DIM
  ) {
    return { ok: false, reason: IMAGE_REJECT.DIMENSIONS_OUT_OF_RANGE };
  }

  // 構造完全性: ヘッダは正常でも本体が途中欠損 / 破損していれば拒否
  if (!verifyStructure(format, bytes)) return { ok: false, reason: IMAGE_REJECT.TRUNCATED };

  const checksum = await sha256hex(bytes, subtle);
  return {
    ok: true,
    format,
    contentType: CONTENT_TYPE[format],
    width: dims.width,
    height: dims.height,
    byteSize: bytes.length,
    checksum,
    bytes,
  };
}

/** data URL / 素の base64 を Uint8Array に。失敗は null。 */
export function decodeBase64Image(imageBase64) {
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) return null;
  const match = imageBase64.match(/^data:([^;]+);base64,(.*)$/s);
  const base64 = match ? match[2] : imageBase64;
  try {
    const bin = typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
