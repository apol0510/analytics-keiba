/**
 * sessionRefresh.test.mjs — セッション refresh（v1→v2 移行・絶対 TTL・sessionStart 引継ぎ）
 *   node --test src/lib/auth/sessionRefresh.test.mjs
 *
 * PR-B2 の必須テスト 20 項目を網羅する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,       // v1 発行（後方互換の生成）
  createSessionV2,     // v2 発行
  verifySession,
  VERIFY_REJECT,
} from './session.js';
import { validatePayload, PAYLOAD_REJECT } from './sessionPayload.js';
import {
  decideRefresh,
  resolveCarriedSessionStart,
  REFRESH_DECISION,
  REFRESH_REJECT,
} from './sessionRefresh.js';
import { issuePaidSessionCookie, DEFAULT_SESSION_TTL_MS } from './sessionIssuance.js';
import { MEMBER_TYPE } from './memberResolution.js';
import { ABSOLUTE_SESSION_TTL_MS, MAX_SESSION_TTL_MS } from './constants.js';

const NOW = 1_750_000_000_000;
const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const subtle = globalThis.crypto.subtle;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const paidMember = (over = {}) => ({
  memberType: MEMBER_TYPE.PAID,
  normalizedPlan: 'premium-sanrenpuku',
  venueAccess: ['jra', 'nankan'],
  sessionVersion: 0,
  recordId: 'recPAID',
  ...over,
});

// v1 トークン（sessionStart 無し）を発行して verify で payload を取り出す
async function issueV1Payload(over = {}) {
  const { token } = await createSession({
    secret: SECRET,
    sub: 'recPAID',
    plan: 'premium-sanrenpuku',
    venueAccess: ['jra', 'nankan'],
    sessionVersion: 0,
    now: NOW,
    ttlMs: DEFAULT_SESSION_TTL_MS,
    subtle,
    ...over,
  });
  const v = await verifySession({ token, secret: SECRET, now: NOW, subtle });
  assert.equal(v.ok, true, 'v1 発行→検証は通る');
  return { token, payload: v.payload };
}

async function issueV2Payload(over = {}) {
  const { token, payload } = await createSessionV2({
    secret: SECRET,
    sub: 'recPAID',
    plan: 'premium-sanrenpuku',
    venueAccess: ['jra', 'nankan'],
    sessionVersion: 0,
    now: NOW,
    ttlMs: DEFAULT_SESSION_TTL_MS,
    subtle,
    ...over,
  });
  return { token, payload };
}

// ─── v1 → v2 移行 ───────────────────────────────────────────

test('#1 v1 有効セッションを v2 へ移行できる（reissue）', async () => {
  const { payload } = await issueV1Payload();
  const d = decideRefresh({ payload, membership: paidMember(), now: NOW + 1 * MIN });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  // v1 は sessionStart が無いので移行時刻が新しい起点になる
  assert.equal(d.sessionStart, NOW + 1 * MIN);
  assert.equal(d.plan, 'premium-sanrenpuku');
});

test('#2 v1 期限切れは移行できない（verifySession で弾かれる）', async () => {
  const { token } = await issueV1Payload();
  // idle 期限（DEFAULT_SESSION_TTL_MS）超過
  const v = await verifySession({ token, secret: SECRET, now: NOW + DEFAULT_SESSION_TTL_MS + MIN, subtle });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PAYLOAD_REJECT.EXPIRED);
});

test('#3 v1 署名改竄は移行できない', async () => {
  const { token } = await issueV1Payload();
  const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
  const v = await verifySession({ token: tampered, secret: SECRET, now: NOW, subtle });
  assert.equal(v.ok, false);
  assert.equal(v.reason, VERIFY_REJECT.SIGNATURE_INVALID);
});

test('#4 v1 sessionVersion 不一致は移行できない', async () => {
  const { payload } = await issueV1Payload({ sessionVersion: 0 });
  const d = decideRefresh({ payload, membership: paidMember({ sessionVersion: 1 }), now: NOW + 1 * MIN });
  assert.equal(d.decision, REFRESH_DECISION.REJECT);
  assert.equal(d.reason, REFRESH_REJECT.SESSION_VERSION_MISMATCH);
});

// ─── v2 新規・引継ぎ ────────────────────────────────────────

test('#5 新規 v2 は sessionStart === issuedAt', async () => {
  const { payload } = await issueV2Payload();
  assert.equal(payload.v, 2);
  assert.equal(payload.sessionStart, payload.issuedAt);
  assert.equal(payload.sessionStart, NOW);
});

test('#6 v2 refresh 後も sessionStart が変わらない', async () => {
  const { payload } = await issueV2Payload(); // sessionStart = NOW
  const refreshAt = NOW + DEFAULT_SESSION_TTL_MS - MIN; // idle 失効直前（閾値5分以下）→ reissue
  const d = decideRefresh({ payload, membership: paidMember(), now: refreshAt });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  assert.equal(d.sessionStart, NOW, 'sessionStart は初回のまま');
});

test('#7 複数回 refresh しても絶対上限は延長されない', async () => {
  let payload = (await issueV2Payload()).payload; // sessionStart = NOW
  let issuedAt = NOW;
  // 各 Cookie の idle 失効直前で reissue を繰り返し、各回の sessionStart が NOW 固定であることを確認
  for (let k = 1; k <= 3; k++) {
    const at = issuedAt + DEFAULT_SESSION_TTL_MS - MIN;
    const d = decideRefresh({ payload, membership: paidMember(), now: at });
    assert.equal(d.decision, REFRESH_DECISION.REISSUE);
    assert.equal(d.sessionStart, NOW, `refresh ${k} 回目でも sessionStart 不変`);
    // 次ラウンド用に payload を作り直す（issuedAt=at, sessionStart 引継ぎ）
    const built = await createSessionV2({
      secret: SECRET, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
      sessionVersion: 0, now: at, ttlMs: d.ttlMs, sessionStart: d.sessionStart, subtle,
    });
    payload = built.payload;
    issuedAt = at;
  }
  // 絶対上限を跨いだ時点で reject
  const past = NOW + ABSOLUTE_SESSION_TTL_MS + MIN;
  const d = decideRefresh({ payload, membership: paidMember(), now: past });
  assert.equal(d.decision, REFRESH_DECISION.REJECT);
  assert.equal(d.reason, REFRESH_REJECT.ABSOLUTE_EXPIRED);
});

test('#8 絶対上限の直前（範囲内）は refresh 可能', async () => {
  const { payload } = await issueV2Payload();
  const at = NOW + ABSOLUTE_SESSION_TTL_MS - MIN; // 絶対上限の 1 分前
  const d = decideRefresh({ payload, membership: paidMember(), now: at });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
});

test('#9 sessionStart から絶対上限ちょうどで拒否', async () => {
  const { payload } = await issueV2Payload();
  const d = decideRefresh({ payload, membership: paidMember(), now: NOW + ABSOLUTE_SESSION_TTL_MS });
  assert.equal(d.decision, REFRESH_DECISION.REJECT);
  assert.equal(d.reason, REFRESH_REJECT.ABSOLUTE_EXPIRED);
});

test('#10 sessionStart から絶対上限超で拒否', async () => {
  const { payload } = await issueV2Payload();
  const d = decideRefresh({ payload, membership: paidMember(), now: NOW + ABSOLUTE_SESSION_TTL_MS + MIN });
  assert.equal(d.decision, REFRESH_DECISION.REJECT);
  assert.equal(d.reason, REFRESH_REJECT.ABSOLUTE_EXPIRED);
});

test('#11 refresh 後の ttl は idle 上限（満額・絶対期限まで余裕あり）', async () => {
  const { payload } = await issueV2Payload();
  const at = NOW + DEFAULT_SESSION_TTL_MS - MIN; // idle 失効直前・絶対期限まで余裕あり
  const d = decideRefresh({ payload, membership: paidMember(), now: at });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  assert.ok(d.ttlMs <= DEFAULT_SESSION_TTL_MS, 'ttl は idle 上限以内');
  assert.equal(d.ttlMs, DEFAULT_SESSION_TTL_MS); // 絶対期限まで余裕があるので満額
});

test('#12 refresh 後の expiresAt が absolute 期限を越えない', async () => {
  const { payload } = await issueV2Payload();
  // 絶対期限の 10 分前に refresh → ttl は残り 10 分に丸められる
  const at = NOW + ABSOLUTE_SESSION_TTL_MS - 10 * MIN;
  const d = decideRefresh({ payload, membership: paidMember(), now: at });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  assert.equal(d.ttlMs, 10 * MIN);
  assert.ok(at + d.ttlMs <= NOW + ABSOLUTE_SESSION_TTL_MS, 'expiresAt は absolute を越えない');
});

// ─── payload 検証（スキーマ移行） ────────────────────────────

test('#13 sessionStart が未来なら拒否', async () => {
  // sessionStart > issuedAt を強制した v2 payload を手組み → validatePayload で弾く
  const payload = {
    v: 2, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 0, issuedAt: NOW, expiresAt: NOW + DEFAULT_SESSION_TTL_MS,
    sessionStart: NOW + 5 * MIN, // issuedAt より未来
  };
  const r = validatePayload(payload, { now: NOW, maxTtlMs: MAX_SESSION_TTL_MS });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAYLOAD_REJECT.SESSION_START_AFTER_ISSUED);
});

test('#13b sessionStart == issuedAt だが now より未来 → future 判定', async () => {
  const future = NOW + 20 * MIN;
  const payload = {
    v: 2, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 0, issuedAt: future, expiresAt: future + DEFAULT_SESSION_TTL_MS,
    sessionStart: future,
  };
  // now は過去。issuedAt も未来なので ISSUED_IN_FUTURE が先に立つ（どちらでも「未来拒否」）
  const r = validatePayload(payload, { now: NOW, maxTtlMs: MAX_SESSION_TTL_MS });
  assert.equal(r.ok, false);
  assert.ok(
    r.reason === PAYLOAD_REJECT.ISSUED_IN_FUTURE || r.reason === PAYLOAD_REJECT.SESSION_START_IN_FUTURE,
  );
});

test('#14 sessionStart 欠落の v2 は拒否', async () => {
  const payload = {
    v: 2, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 0, issuedAt: NOW, expiresAt: NOW + DEFAULT_SESSION_TTL_MS,
  };
  const r = validatePayload(payload, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAYLOAD_REJECT.MISSING_SESSION_START);
});

test('#15 v2 に未知キーがあれば拒否', async () => {
  const payload = {
    v: 2, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 0, issuedAt: NOW, expiresAt: NOW + DEFAULT_SESSION_TTL_MS,
    sessionStart: NOW, evil: 'x',
  };
  const r = validatePayload(payload, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAYLOAD_REJECT.UNEXPECTED_FIELD);
});

test('#15b v1 に sessionStart が来たら拒否（版跨ぎ混入）', async () => {
  const payload = {
    v: 1, sub: 'recPAID', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 0, issuedAt: NOW, expiresAt: NOW + DEFAULT_SESSION_TTL_MS,
    sessionStart: NOW,
  };
  const r = validatePayload(payload, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAYLOAD_REJECT.UNEXPECTED_FIELD);
});

// ─── Airtable 側の状態反映 ─────────────────────────────────

test('#16 退会・停止・期限切れ（membership != PAID）なら拒否', async () => {
  const { payload } = await issueV2Payload();
  for (const mt of [MEMBER_TYPE.FREE, MEMBER_TYPE.DENIED]) {
    const d = decideRefresh({
      payload,
      membership: { memberType: mt, normalizedPlan: null, venueAccess: [], sessionVersion: 0, recordId: 'recPAID' },
      now: NOW + 16 * MIN,
    });
    assert.equal(d.decision, REFRESH_DECISION.REJECT);
    assert.equal(d.reason, REFRESH_REJECT.NOT_PAID);
  }
});

test('#17 plan 降格を旧 Cookie の plan で上書きしない（membership の plan を採用）', async () => {
  // 旧 Cookie は premium-sanrenpuku。Airtable では light に降格 → light は paid だが別ティア
  const { payload } = await issueV2Payload({ plan: 'premium-sanrenpuku' });
  const d = decideRefresh({
    payload,
    membership: paidMember({ normalizedPlan: 'light', venueAccess: ['jra'] }),
    now: NOW + DEFAULT_SESSION_TTL_MS - MIN,
  });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  assert.equal(d.plan, 'light', '再発行 plan は Airtable 最新（降格後）');
  assert.deepEqual(d.venueAccess, ['jra']);
});

test('#18 free / Light を paid として再発行しない（free は membership が PAID にならない）', async () => {
  const { payload } = await issueV2Payload();
  // Airtable 上 free（memberType FREE）→ reject
  const d = decideRefresh({
    payload,
    membership: { memberType: MEMBER_TYPE.FREE, normalizedPlan: 'free', venueAccess: [], sessionVersion: 0, recordId: 'recPAID' },
    now: NOW + 16 * MIN,
  });
  assert.equal(d.decision, REFRESH_DECISION.REJECT);
  assert.equal(d.reason, REFRESH_REJECT.NOT_PAID);
});

// ─── Cookie 属性・keep ─────────────────────────────────────

test('#19 reissue 後の Cookie 属性が維持される（HttpOnly/Secure/SameSite=Lax/Path=/）', async () => {
  const { payload } = await issueV2Payload();
  const at = NOW + DEFAULT_SESSION_TTL_MS - MIN;
  const d = decideRefresh({ payload, membership: paidMember(), now: at });
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
  const issued = await issuePaidSessionCookie({
    membership: paidMember(), secret: SECRET, now: at, ttlMs: d.ttlMs, sessionStart: d.sessionStart, subtle,
  });
  assert.equal(issued.ok, true);
  assert.match(issued.cookie, /^ak_session=/);
  assert.match(issued.cookie, /HttpOnly/);
  assert.match(issued.cookie, /Secure/);
  assert.match(issued.cookie, /SameSite=Lax/);
  assert.match(issued.cookie, /Path=\//);
  // 再発行トークンは v2 で sessionStart を引き継ぐ
  const v = await verifySession({ token: issued.token, secret: SECRET, now: at, subtle });
  assert.equal(v.ok, true);
  assert.equal(v.payload.v, 2);
  assert.equal(v.payload.sessionStart, NOW);
});

test('#20 refresh 不要時（残 TTL 十分）は keep（Set-Cookie を返さない）', async () => {
  const { payload } = await issueV2Payload(); // expiresAt = NOW + 20分
  const at = NOW + 5 * MIN; // 残 15分 > 閾値5分
  const d = decideRefresh({ payload, membership: paidMember(), now: at });
  assert.equal(d.decision, REFRESH_DECISION.KEEP);
});

// ─── 補助 ─────────────────────────────────────────────────

test('resolveCarriedSessionStart: v2 は payload.sessionStart / v1 は now', async () => {
  assert.equal(resolveCarriedSessionStart({ v: 2, sessionStart: 123 }, NOW), 123);
  assert.equal(resolveCarriedSessionStart({ v: 1 }, NOW), NOW);
  assert.equal(resolveCarriedSessionStart(null, NOW), NOW);
});

test('不正入力（payload なし / now 非数）は reject(invalid_input)', () => {
  assert.equal(decideRefresh({ payload: null, membership: paidMember(), now: NOW }).reason, REFRESH_REJECT.INVALID_INPUT);
  assert.equal(decideRefresh({ payload: { v: 2 }, membership: paidMember(), now: NaN }).reason, REFRESH_REJECT.INVALID_INPUT);
});

test('v1 は残 TTL が多くても常に reissue（v2 へ移行）', async () => {
  const { payload } = await issueV1Payload();
  const d = decideRefresh({ payload, membership: paidMember(), now: NOW + 1 * MIN }); // 残19分
  assert.equal(d.decision, REFRESH_DECISION.REISSUE);
});
