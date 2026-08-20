/**
 * fakeRedisForTests.mjs — テストから Upstash REST を差し替えるための最小実装
 *
 * ⚠️ **テスト専用**（`*.test.mjs` ではないので `node --test` の対象にはならない）。
 *    本番コードから import しないこと。
 *
 * キュー登録・tick・送信の排他は Redis（Upstash REST）を使う。排他は
 * **取れなければ書かない**（fail closed）ので、Redis を用意しないテストでは
 * live 経路が 503 になる。ここでは `SET NX EX` / `INCR` / `EVAL`（検証・更新・解放）
 * だけを、実物と同じ意味でメモリ上に再現する。
 */

export const FAKE_REDIS_URL = 'https://fake-upstash.test';
export const FAKE_REDIS_TOKEN = 'fake-upstash-token';

/** テストの `beforeEach` で env に入れる値 */
export const FAKE_REDIS_ENV = Object.freeze({
  UPSTASH_REDIS_REST_URL: FAKE_REDIS_URL,
  UPSTASH_REDIS_REST_TOKEN: FAKE_REDIS_TOKEN,
});

export function isFakeRedisUrl(url) {
  return String(url || '').startsWith(FAKE_REDIS_URL);
}

/**
 * Upstash REST 互換のメモリ実装を作る。
 *
 * @param {(payload: any) => any} makeResponse テスト側の Response 生成関数
 * @returns {{handle: (init: any) => any, store: Map<string,string>}}
 */
export function createFakeRedis(makeResponse) {
  const store = new Map();
  let fence = 0;

  const handle = (init) => {
    let args = [];
    try { args = JSON.parse((init && init.body) || '[]'); } catch { args = []; }
    const op = String(args[0] || '').toUpperCase();

    if (op === 'INCR') { fence += 1; return makeResponse({ result: fence }); }
    if (op === 'GET') return makeResponse({ result: store.has(args[1]) ? store.get(args[1]) : null });
    if (op === 'DEL') { store.delete(args[1]); return makeResponse({ result: 1 }); }
    if (op === 'EXPIRE') return makeResponse({ result: 1 });
    if (op === 'SET') {
      const [, key, value, ...rest] = args;
      const nx = rest.map((r) => String(r).toUpperCase()).includes('NX');
      if (nx && store.has(key)) return makeResponse({ result: null });   // 取れない = 他が持っている
      store.set(key, String(value));
      return makeResponse({ result: 'OK' });
    }
    if (op === 'EVAL') {
      // KEYS[1] = 鍵、ARGV[1] = token。実物の Lua と同じ判定だけを再現する
      const key = args[3];
      const token = String(args[4]);
      const cur = store.has(key) ? store.get(key) : null;
      const script = String(args[1] || '');
      if (script.includes('DEL')) {                       // release
        if (cur === null) return makeResponse({ result: 'LOST' });
        if (cur !== token) return makeResponse({ result: 'STOLEN' });
        store.delete(key);
        return makeResponse({ result: 'OK' });
      }
      if (script.includes('EXPIRE')) {                    // renew
        if (cur === null) return makeResponse({ result: 'LOST' });
        if (cur !== token) return makeResponse({ result: 'STOLEN' });
        return makeResponse({ result: 'OK' });
      }
      // verify
      if (cur === null) return makeResponse({ result: 'LOST' });
      return makeResponse({ result: cur === token ? 'OK' : 'STOLEN' });
    }
    return makeResponse({ result: null });
  };

  return { handle, store };
}

export default createFakeRedis;
