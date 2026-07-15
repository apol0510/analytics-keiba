/**
 * testHelpers.mjs — テスト補助（*.test.mjs ではないので node --test では実行されない）。
 * 構造的に完全な PNG/JPEG/WebP バイト列と会員 Cookie を生成する。
 */
import zlib from 'node:zlib';
import { createSessionV2 } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';

export const TEST_SECRET = 'premium-plus-test-secret-32chars-minimum!!';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function be32(n) { return Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function le32(n) { return Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}

/** 構造的に完全な PNG（IHDR + IDAT(zlib) + IEND, CRC 正）。 */
export function makePng(width, height = Math.round(width * 0.75)) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]));
  const raw = Buffer.alloc(height * (1 + width * 4)); // フィルタ0 + RGBA ゼロ
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return new Uint8Array(Buffer.concat([sig, ihdr, idat, iend]));
}

/** IHDR だけの PNG（寸法範囲テスト用・構造検査には到達しない）。 */
export function makePngHeader(width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]));
  return new Uint8Array(Buffer.concat([sig, ihdr, Buffer.alloc(40)]));
}

/** 構造的に完全な JPEG（SOI + SOF0 + SOS + entropy + EOI）。 */
export function makeJpeg(width, height = Math.round(width * 0.75)) {
  const soi = [0xff, 0xd8];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const entropy = new Array(48).fill(0x00);
  const eoi = [0xff, 0xd9];
  return new Uint8Array([...soi, ...sof, ...sos, ...entropy, ...eoi]);
}

/** 構造的に完全な WebP（VP8X + フィラーチャンク, RIFF サイズ正）。 */
export function makeWebp(width, height, padData = 48) {
  const w = width - 1, h = height - 1;
  const vp8xData = Buffer.from([0, 0, 0, 0, w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255]);
  const vp8x = Buffer.concat([Buffer.from('VP8X', 'ascii'), le32(vp8xData.length), vp8xData]);
  const fill = Buffer.concat([Buffer.from('FILL', 'ascii'), le32(padData), Buffer.alloc(padData)]);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, fill]);
  const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), le32(body.length), body]);
  return new Uint8Array(riff);
}

/** 会員 Cookie ヘッダ文字列。 */
export async function mintCookieHeader({ plan, now = 1_800_000_000_000, ttlMs = 20 * 60 * 1000, sessionStart, sub = 'recTEST', secret = TEST_SECRET }) {
  const { token } = await createSessionV2({
    sub, plan, venueAccess: ['jra', 'nankan'], sessionVersion: 1,
    now, ttlMs, sessionStart: sessionStart ?? now, secret,
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}
