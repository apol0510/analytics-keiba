/**
 * importPrediction.test.mjs — 南関 予想取込の認証/候補順/失敗伝播の契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importPrediction.test.mjs
 *
 * 注: ±1日マージ / 中身 date 検証ガード（RACEBOOK-GUARD）は JRA 側固有ロジックのため
 *     importPredictionJra.test.mjs で検証する（南関 fetchRacebookData は指定日完全一致のみ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchVenuePredictions,
  fetchRacebookData,
  fetchSharedPrediction,
  fetchEntriesData,
  fetchRacebookPastRaces,
} from './importPrediction.js';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const noSleep = async () => {};

function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
  fn.calls = calls;
  return fn;
}
function pathOf(url) {
  const m = decodeURIComponent(url).match(/contents\/(.+?)\?ref=/);
  return m ? m[1] : '';
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const DATE = '2026-05-08', Y = '2026', M = '05';
const PRED_DIR = `nankan/predictions/${Y}/${M}`;
const RB_DIR = `nankan/racebook/${Y}/${M}`;
function entry(name, dir) {
  return { name, path: `${dir}/${name}`, sha: 'sha-' + name, size: 1234, type: 'file' };
}

test('1. fetchVenuePredictions: ディレクトリ一覧 + 会場別ファイルを listing 順でマージ', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === PRED_DIR) return mkRes(200, [entry(`${DATE}-OOI.json`, PRED_DIR), entry(`${DATE}-FUN.json`, PRED_DIR)]);
    if (p === `${PRED_DIR}/${DATE}-OOI.json`) return mkRes(200, { venue: '大井', races: [{ raceNumber: 1 }] });
    if (p === `${PRED_DIR}/${DATE}-FUN.json`) return mkRes(200, { venue: '船橋', races: [{ raceNumber: 1 }] });
    return mkRes(404, 'nf');
  });
  const out = await fetchVenuePredictions(DATE, 'nankan', '', client);
  assert.equal(out.totalVenues, 2);
  assert.deepEqual(out.venues.map(v => v.venue), ['大井', '船橋'], 'merge順維持');
});

test('2. fetchVenuePredictions: ディレクトリ 404 は次候補へ（optional skip）= null', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchVenuePredictions(DATE, 'nankan', '', client), null);
});

test('3. fetchSharedPrediction: 統合単一ファイル 404 は null（未投入=正常）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchSharedPrediction(DATE, 'nankan', client), null);
});

test('4. fetchRacebookData: ディレクトリ 404 は null（次候補へ）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchRacebookData(DATE, 'nankan', client), null);
});

test('5. fetchRacebookData: 一覧済みファイルの 401 は skip せず fatal（部分書き込みなし）', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry(`${DATE}-OOI.json`, RB_DIR)]);
    return mkRes(401, 'bad');
  });
  await assert.rejects(fetchRacebookData(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('6. ディレクトリ listing の 401 は fallback せず fatal', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchVenuePredictions(DATE, 'nankan', '', client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('7. 403(forbidden) は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'f', { 'x-ratelimit-remaining': '9' }));
  await assert.rejects(fetchEntriesData(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

test('8. rate limit(403/remaining 0) は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'rate', { 'x-ratelimit-remaining': '0' }), { retries: 1 });
  await assert.rejects(fetchEntriesData(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
});

test('9. 500 は fatal', async () => {
  const client = clientWith(() => mkRes(500, 'e'), { retries: 1 });
  await assert.rejects(fetchSharedPrediction(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

test('10. fetchRacebookPastRaces: 旧実装の silent null 化を廃止 → 401 は fatal（握りつぶさない）', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry(`${DATE}-OOI.json`, RB_DIR)]);
    return mkRes(401, 'bad');
  });
  await assert.rejects(fetchRacebookPastRaces(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('11. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, []));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchVenuePredictions(DATE, 'nankan', '', client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0, 'token 無しでは fetch を呼ばない');
});

test('12. token・Bearer が error message/stack へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchVenuePredictions(DATE, 'nankan', '', client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    return !hay.includes(SECRET) && !/Bearer\s/i.test(hay);
  });
});
