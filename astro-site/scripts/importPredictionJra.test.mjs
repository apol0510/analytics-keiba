/**
 * importPredictionJra.test.mjs — JRA 予想取込の認証/±1日/中身date検証/失敗伝播の契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importPredictionJra.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRacebookData,
  fetchSharedPrediction,
  buildSourceComputerIndexMap,
} from './importPredictionJra.js';
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
/** Contents API URL から shared path を取り出す */
function pathOf(url) {
  const m = decodeURIComponent(url).match(/contents\/(.+?)\?ref=/);
  return m ? m[1] : '';
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const DATE = '2026-05-16', Y = '2026', M = '05';
const RB_DIR = `jra/racebook/${Y}/${M}`;
const rbFile = (name) => `${RB_DIR}/${name}`;
function entry(name, dir = RB_DIR) {
  return { name, path: `${dir}/${name}`, sha: 'sha-' + name, size: 1234, type: 'file' };
}
/** racebook 1会場ぶんの最小ファイル中身 */
function rbContent(internalDate, track, raceNumber = 1) {
  return { date: internalDate, track, races: [{ raceNumber, horses: [{ number: 1, name: '馬A' }] }] };
}

test('1. ±1日探索: 当日ファイル名が無くても前日付ファイル名（中身 date=当日）を救済採用', async () => {
  // ファイル名は前日（2026-05-15）だが中身 date は当日（2026-05-16）→ ±1日マージで拾い、ガード通過
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry('2026-05-15-TOK.json')]);
    if (p === rbFile('2026-05-15-TOK.json')) return mkRes(200, rbContent(DATE, '東京'));
    return mkRes(404, 'nf');
  });
  const out = await fetchRacebookData(DATE, 'jra', client);
  assert.equal(out.venues.length, 1);
  assert.equal(out.venues[0].venue, '東京');
});

test('2. 中身 date 不一致のファイルは RACEBOOK-GUARD で除外される', async () => {
  // 当日 TOK は中身 date 一致で採用 / 前日 NII は中身 date=2026-05-15 ≠ 指定日 → 除外
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry('2026-05-16-TOK.json'), entry('2026-05-15-NII.json')]);
    if (p === rbFile('2026-05-16-TOK.json')) return mkRes(200, rbContent(DATE, '東京'));
    if (p === rbFile('2026-05-15-NII.json')) return mkRes(200, rbContent('2026-05-15', '新潟'));
    return mkRes(404, 'nf');
  });
  const out = await fetchRacebookData(DATE, 'jra', client);
  assert.equal(out.venues.length, 1, '中身 date 不一致の新潟は除外される');
  assert.equal(out.venues[0].venue, '東京');
});

test('3. merge順維持: 指定日完全一致(diff0)を ±1日(diff1)より先にマージする', async () => {
  // listing は [TOK(前日名), NII(当日名)] の順だが、closeness ソートで NII(diff0)→TOK(diff1) になる
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry('2026-05-15-TOK.json'), entry('2026-05-16-NII.json')]);
    if (p === rbFile('2026-05-15-TOK.json')) return mkRes(200, rbContent(DATE, '東京'));
    if (p === rbFile('2026-05-16-NII.json')) return mkRes(200, rbContent(DATE, '新潟'));
    return mkRes(404, 'nf');
  });
  const out = await fetchRacebookData(DATE, 'jra', client);
  assert.deepEqual(out.venues.map(v => v.venue), ['新潟', '東京']);
});

test('4. 同一会場の重複は exact-date を優先し ±1日は dedup でスキップ', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry('2026-05-15-TOK.json'), entry('2026-05-16-TOK.json')]);
    // 前日名(中身当日)は 2R / 当日名は 1R。exact-date(1R) が採用されるはず
    if (p === rbFile('2026-05-15-TOK.json')) return mkRes(200, rbContent(DATE, '東京', 2));
    if (p === rbFile('2026-05-16-TOK.json')) return mkRes(200, rbContent(DATE, '東京', 1));
    return mkRes(404, 'nf');
  });
  const out = await fetchRacebookData(DATE, 'jra', client);
  assert.equal(out.venues.length, 1);
  assert.equal(out.venues[0].races[0].raceInfo.raceNumber, '1R', 'exact-date を優先');
});

test('5. ディレクトリ 404 は次候補へ（optional skip）= null を返す', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchRacebookData(DATE, 'jra', client), null);
});

test('6. 統合 predictions 単一ファイル 404 は null（未投入=正常）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchSharedPrediction(DATE, 'jra', client), null);
});

test('7. ディレクトリ listing の 401 は fallback せず fatal（部分書き込みなし）', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchRacebookData(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('8. 一覧済みファイルの取得異常(403/通信)は skip せず fatal', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === RB_DIR) return mkRes(200, [entry('2026-05-16-TOK.json')]);
    return mkRes(403, 'forbidden', { 'x-ratelimit-remaining': '9' });
  });
  await assert.rejects(fetchRacebookData(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

test('9. 500 は fatal（5xx で fallback しない）', async () => {
  const client = clientWith(() => mkRes(500, 'e'), { retries: 1 });
  await assert.rejects(fetchSharedPrediction(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

test('10. timeout は fatal', async () => {
  const client = clientWith(() => { const e = new Error('a'); e.name = 'AbortError'; throw e; }, { retries: 1 });
  await assert.rejects(fetchSharedPrediction(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

test('11. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, []));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchRacebookData(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0, 'token 無しでは fetch を呼ばない');
});

test('12. computer ディレクトリ 404 は null（optional skip）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await buildSourceComputerIndexMap(DATE, 'jra', client), null);
});

test('13. token・Bearer が error message/stack へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchRacebookData(DATE, 'jra', client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    return !hay.includes(SECRET) && !/Bearer\s/i.test(hay);
  });
});
