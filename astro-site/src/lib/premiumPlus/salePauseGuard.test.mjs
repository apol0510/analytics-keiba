/**
 * salePauseGuard.test.mjs — 停止が**障害・キャッシュでも迂回されない**ことを固定する
 *   node --test src/lib/premiumPlus/salePauseGuard.test.mjs
 *
 * ## 完成条件
 *
 * 「明示的に一時停止された会員は、判定系の一時障害でも購入を迂回できない」
 *
 * かつ「Airtable 障害だけで通常会員まで一律停止しない」。
 * この 2 つを同時に満たすため、独立した 2 系統（Airtable / deny-marker）で判定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PAUSE_STATE, SALE_PAUSE_KEY,
  airtablePauseState, decideSalePaused, describePauseDecision,
  emailPauseKey, recordPauseKey, isPauseMarkerAvailable,
  readSalePauseMarker, writeSalePauseMarker, resolveSalePauseGate,
  enforceSalePause, closePlusChannel,
} from './salePauseGuard.js';
import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';

const ID = 'recPAUSEGUARD001';
const EMAIL = 'buyer@example.com';
const SECRET = 'test-signing-secret';

/** Redis を模す。`fail:true` で全コマンドを落とす */
function memRedis({ fail = false, slow = false } = {}) {
  const h = new Map();
  const cmd = async (args) => {
    if (fail) throw new Error('redis down');
    if (slow) await new Promise((r) => { setTimeout(r, 1500); });
    const [op, key, ...rest] = args;
    if (op === 'HSET') {
      for (let i = 0; i < rest.length; i += 2) h.set(`${key}|${rest[i]}`, rest[i + 1]);
      return 1;
    }
    if (op === 'HDEL') { for (const f of rest) h.delete(`${key}|${f}`); return 1; }
    if (op === 'HMGET') return rest.map((f) => (h.has(`${key}|${f}`) ? h.get(`${key}|${f}`) : null));
    return null;
  };
  return { cmd, h };
}

// ══════════════════════════════════════════════════════════════
//  3 値化 — 「分からない」を「販売中」に丸めない
// ══════════════════════════════════════════════════════════════

test('fields が読めないときは unknown（false に丸めない）', () => {
  assert.equal(airtablePauseState(null), PAUSE_STATE.UNKNOWN);
  assert.equal(airtablePauseState(undefined), PAUSE_STATE.UNKNOWN);
  assert.equal(airtablePauseState('nope'), PAUSE_STATE.UNKNOWN);
});

test('fields が読めれば paused / clear を返す', () => {
  assert.equal(airtablePauseState({ [PP_SALE_PAUSE_FIELDS.PAUSED]: true }), PAUSE_STATE.PAUSED);
  assert.equal(airtablePauseState({}), PAUSE_STATE.CLEAR);
});

// ══════════════════════════════════════════════════════════════
//  判定表（純粋）
// ══════════════════════════════════════════════════════════════

const P = PAUSE_STATE.PAUSED; const C = PAUSE_STATE.CLEAR; const U = PAUSE_STATE.UNKNOWN;

test('【重要】片方でも paused なら停止', () => {
  for (const [a, m] of [[P, C], [P, U], [P, P], [C, P], [U, P]]) {
    assert.equal(decideSalePaused(a, m), true, `airtable=${a} marker=${m} で停止していない`);
  }
});

test('【重要】片方が clear と答えられていれば販売（通常会員を障害で止めない）', () => {
  assert.equal(decideSalePaused(C, C), false);
  assert.equal(decideSalePaused(C, U), false, 'marker 障害で通常会員が止まった');
  assert.equal(decideSalePaused(U, C), false, 'Airtable 障害で通常会員が止まった');
});

test('【重要】双方 unknown は停止（停止を否定できない）', () => {
  assert.equal(decideSalePaused(U, U), true, 'fail open になっている');
});

test('判定理由が言語化される', () => {
  assert.match(describePauseDecision(P, C), /Airtable/);
  assert.match(describePauseDecision(C, P), /marker/);
  assert.match(describePauseDecision(U, U), /確認できない|fail closed/);
  assert.match(describePauseDecision(C, C), /停止していない/);
});

// ══════════════════════════════════════════════════════════════
//  marker の読み書き
// ══════════════════════════════════════════════════════════════

test('停止を書くと recordId・email の両方の鍵で引ける', async () => {
  const { cmd, h } = memRedis();
  const emailKey = emailPauseKey(EMAIL, SECRET);
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, emailKey, paused: true });
  assert.equal(h.get(`${SALE_PAUSE_KEY}|id:${ID}`), '1');
  assert.equal(h.get(`${SALE_PAUSE_KEY}|${emailKey}`), '1');

  // recordId だけでも email だけでも paused と読める
  assert.equal(await readSalePauseMarker({ redisCmd: cmd, recordId: ID }), PAUSE_STATE.PAUSED);
  assert.equal(await readSalePauseMarker({ redisCmd: cmd, emailKey }), PAUSE_STATE.PAUSED);
});

test('再開で両方の鍵が消える', async () => {
  const { cmd } = memRedis();
  const emailKey = emailPauseKey(EMAIL, SECRET);
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, emailKey, paused: true });
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, emailKey, paused: false });
  assert.equal(await readSalePauseMarker({ redisCmd: cmd, recordId: ID, emailKey }), PAUSE_STATE.CLEAR);
});

test('【重要】marker を読めないときは unknown（無い＝販売中と読まない）', async () => {
  const { cmd } = memRedis({ fail: true });
  assert.equal(await readSalePauseMarker({ redisCmd: cmd, recordId: ID }), PAUSE_STATE.UNKNOWN);
  // ストア未設定も unknown
  assert.equal(await readSalePauseMarker({ redisCmd: null, recordId: ID }), PAUSE_STATE.UNKNOWN);
  assert.equal(isPauseMarkerAvailable(null), false);
});

test('marker が遅いときは unknown（会員ページを待たせない）', async () => {
  const { cmd } = memRedis({ slow: true });
  const t0 = Date.now();
  const state = await readSalePauseMarker({ redisCmd: cmd, recordId: ID });
  assert.equal(state, PAUSE_STATE.UNKNOWN);
  assert.ok(Date.now() - t0 < 1400, '打ち切りが効いていない');
});

test('鍵が 1 つも無ければ unknown（全員 clear に倒さない）', async () => {
  const { cmd } = memRedis();
  assert.equal(await readSalePauseMarker({ redisCmd: cmd }), PAUSE_STATE.UNKNOWN);
  assert.equal(recordPauseKey(''), null);
  assert.equal(recordPauseKey(null), null);
});

test('email 鍵はアドレスそのものを含まない', () => {
  const k = emailPauseKey(EMAIL, SECRET);
  assert.ok(k && k.startsWith('em:'));
  assert.ok(!k.includes('buyer'), 'アドレスが鍵に露出している');
  assert.ok(!k.includes('example.com'));
  // 同じ入力は同じ鍵（大小・空白を吸収）
  assert.equal(emailPauseKey('  BUYER@Example.com ', SECRET), k);
  // 秘密が違えば別の鍵
  assert.notEqual(emailPauseKey(EMAIL, 'other'), k);
  // 秘密が無ければ引けない（null）
  assert.equal(emailPauseKey(EMAIL, ''), null);
  assert.equal(emailPauseKey('', SECRET), null);
});

test('marker 書き込みの失敗を正直に返す', async () => {
  const { cmd } = memRedis({ fail: true });
  const r = await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, paused: true });
  assert.equal(r.ok, false, '失敗を成功として返した');
  const noStore = await writeSalePauseMarker({ redisCmd: null, recordId: ID, paused: true });
  assert.equal(noStore.ok, false);
});

// ══════════════════════════════════════════════════════════════
//  gate（I/O 込み）— 迂回できないこと
// ══════════════════════════════════════════════════════════════

const paused = { [PP_SALE_PAUSE_FIELDS.PAUSED]: true };
const clear = { [PP_SALE_PAUSE_FIELDS.PAUSED]: false };

test('【重要】Airtable が停止と言えば marker を読まずに停止', async () => {
  let called = 0;
  const cmd = async () => { called += 1; return null; };
  const g = await resolveSalePauseGate({ fields: paused, recordId: ID, redisCmd: cmd });
  assert.equal(g.paused, true);
  assert.equal(called, 0, '不要な Redis 往復が発生している');
});

test('【重要】キャッシュ済みの古い fields（停止前）でも marker が停止を効かせる', async () => {
  // これが 10 分キャッシュの穴。fields は「停止していない」と言っているが marker は停止中
  const { cmd } = memRedis();
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, paused: true });
  const g = await resolveSalePauseGate({ fields: clear, recordId: ID, redisCmd: cmd });
  assert.equal(g.paused, true, '古いキャッシュで停止が迂回された');
  assert.equal(g.marker, PAUSE_STATE.PAUSED);
});

test('【重要】Airtable 障害でも marker で停止が効く（recordId 不明・email のみ）', async () => {
  const { cmd } = memRedis();
  const emailKey = emailPauseKey(EMAIL, SECRET);
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, emailKey, paused: true });
  // Airtable が落ちて fields も recordId も取れない状況
  const g = await resolveSalePauseGate({
    fields: null, recordId: null, email: EMAIL,
    env: { SESSION_SIGNING_SECRET: SECRET }, redisCmd: cmd,
  });
  assert.equal(g.paused, true, 'Airtable 障害で停止が迂回された');
});

test('【重要】Airtable 障害でも通常会員は購入できる（一律停止にしない）', async () => {
  const { cmd } = memRedis();
  const g = await resolveSalePauseGate({
    fields: null, recordId: ID, email: EMAIL,
    env: { SESSION_SIGNING_SECRET: SECRET }, redisCmd: cmd,
  });
  assert.equal(g.paused, false, 'Airtable 障害だけで通常会員まで止めている');
  assert.equal(g.airtable, PAUSE_STATE.UNKNOWN);
  assert.equal(g.marker, PAUSE_STATE.CLEAR);
});

test('【重要】marker 障害でも通常会員は購入できる', async () => {
  const { cmd } = memRedis({ fail: true });
  const g = await resolveSalePauseGate({ fields: clear, recordId: ID, redisCmd: cmd });
  assert.equal(g.paused, false, 'Redis 障害だけで通常会員まで止めている');
});

test('【重要】両系統とも読めないときは停止（fail closed）', async () => {
  const { cmd } = memRedis({ fail: true });
  const g = await resolveSalePauseGate({ fields: null, recordId: ID, redisCmd: cmd });
  assert.equal(g.paused, true, '双方障害で fail open になっている');
  assert.match(g.why, /確認できない|fail closed/);
});

test('未設定会員（フィールドも marker も無い）は通常どおり販売', async () => {
  const { cmd } = memRedis();
  const g = await resolveSalePauseGate({ fields: {}, recordId: ID, redisCmd: cmd });
  assert.equal(g.paused, false);
});

// ══════════════════════════════════════════════════════════════
//  表示側の実施点
// ══════════════════════════════════════════════════════════════

const plusView = () => ({
  channel: 'plus', reason: 'auto_plus_sale',
  plus: { allowed: true, showTeaser: true, showProductPage: true, showPurchaseCta: true, purchaseEnabled: true, phase: 4, intake: 'open' },
  plusRelease: { allowed: true, showTeaser: true, showProductPage: true, showPurchaseCta: true, purchaseEnabled: true, phase: 4, intake: 'open', salePaused: false },
});

test('【重要】停止中は plus の面が全部閉じる', async () => {
  const { cmd } = memRedis();
  await writeSalePauseMarker({ redisCmd: cmd, recordId: ID, paused: true });
  const out = await enforceSalePause({ view: plusView(), fields: clear, recordId: ID, redisCmd: cmd });
  assert.equal(out.channel, 'none');
  assert.equal(out.reason, 'plus_sale_paused');
  assert.equal(out.plus.showProductPage, false, '商品ページが開いたまま');
  assert.equal(out.plus.purchaseEnabled, false, '購入できるまま');
  assert.equal(out.plusRelease.showPurchaseCta, false);
  assert.equal(out.plusRelease.salePaused, true);
});

test('停止していなければ view はそのまま', async () => {
  const { cmd } = memRedis();
  const v = plusView();
  const out = await enforceSalePause({ view: v, fields: clear, recordId: ID, redisCmd: cmd });
  assert.equal(out.channel, 'plus');
  assert.equal(out.plus.purchaseEnabled, true);
});

test('【重要】plus 以外の会員では marker を読まない（余計な往復・巻き添えを作らない）', async () => {
  let called = 0;
  const cmd = async () => { called += 1; return null; };
  const srp = { channel: 'sanrenpuku', sanrenpuku: { allowed: true } };
  const out = await enforceSalePause({ view: srp, fields: clear, recordId: ID, redisCmd: cmd });
  assert.equal(out, srp, '三連複の view が書き換えられた');
  assert.equal(called, 0);
});

test('閉じた view は三連複の導線を壊さない', () => {
  const v = { ...plusView(), sanrenpuku: { allowed: true, showCta: true } };
  const closed = closePlusChannel(v);
  assert.deepEqual(closed.sanrenpuku, { allowed: true, showCta: true });
});

// ══════════════════════════════════════════════════════════════
//  配線ガード
// ══════════════════════════════════════════════════════════════

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('【重要】4 つの表示経路すべてで停止を確認している', () => {
  for (const [name, rel] of [
    ['dashboard CTA (/api/upsell.json)', '../../pages/api/upsell.json.js'],
    ['三連複ページ予告 (/api/premium-plus-stage.json)', '../../pages/api/premium-plus-stage.json.js'],
    ['/premium-plus/', '../../pages/premium-plus.astro'],
    ['/premium-plus-v2/', '../../pages/premium-plus-v2.astro'],
  ]) {
    const src = read(rel);
    assert.match(src, /enforceSalePause\(/, `${name} が停止を確認していない`);
    assert.match(src, /salePauseGuard\.js/, `${name} が単一源を使っていない`);
  }
});

test('【重要】申込 Function が 2 系統で判定し、読めないときに通さない', () => {
  const apply = read('../../../netlify/functions/bank-transfer-application.js');
  assert.match(apply, /resolveSalePauseGate\(/);
  assert.match(apply, /code: 'sale_paused'/);
  // 旧 fail open（読めなければ通す）が復活していないこと
  const seg = apply.slice(apply.indexOf('会員単位の販売 一時停止'), apply.indexOf("code: 'sale_paused'"));
  assert.ok(!/読めなかったときは\*\*止めない\*\*/.test(seg), 'fail open のコメント/実装が戻っている');
  // email を渡している（Airtable 障害で recordId が無くても marker を引くため）
  assert.match(seg, /email,/);
});

test('【重要】停止操作は marker ストアが無ければ受け付けない（deny-list の完全性）', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  const seg = fn.slice(fn.indexOf('async function handleSetSalePause'));
  assert.match(seg, /isPauseMarkerAvailable\(markerCmd\)/);
  assert.match(seg, /pause_marker_unavailable/);
  // 停止は marker → Airtable の順
  const iMarker = seg.indexOf('writeSalePauseMarker(');
  const iPatch = seg.indexOf("method: 'PATCH'");
  assert.ok(iMarker > 0 && iPatch > iMarker, '停止で Airtable を先に書いている（marker 未作成のまま停止扱いになる）');
  // 再開で marker を消せなければ「停止したまま」と返す
  assert.match(seg, /pause_marker_clear_failed/);
  assert.match(seg, /stillPaused: true/);
});

test('管理画面は再開失敗を「再開しました」と言わない', () => {
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  assert.match(page, /out\.stillPaused/);
  assert.match(page, /停止したままです/);
  // Airtable 直編集の注意を出している
  assert.match(page, /deny-marker/);
});
