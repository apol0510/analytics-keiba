/**
 * mediaKeys.js — Blobs キー設計 + checksum + テスト用インメモリストア（atomic 条件付き書き込み対応）
 *
 * 競合制御は Netlify Blobs 10.7.9 の atomic conditional write を使う:
 *   - create-only（onlyIfNew / If-None-Match:*）… manifests/{manifestId} と画像の二重書き込みを防ぐ
 *   - CAS（onlyIfMatch:<etag> / If-Match）        … manifest-current ポインタの切替を直列化する
 * サーバー側で条件判定される（412→modified:false）ため、read-then-write の TOCTOU にならない。
 *
 * 保存構造（immutable manifest / UUID キー / 論理削除のみ）:
 *   images/{date}/{checksum}          … 画像本体（checksum immutable）
 *   manifests/{manifestId}            … manifest 本体（manifestId は UUID。連番を物理キーにしない）
 *   manifest-current                  … { manifestId, logicalVersion } のポインタ
 *   operations/{operationId}          … 冪等記録
 *   audit/{operationId}               … 監査記録
 *
 *   ※ manifest の物理キーを連番 version にしないのは、pointer 切替失敗で残った orphan が
 *      「同じ次番号」を焼いて後続更新を詰まらせる事故を構造的に無くすため。UUID なら次 writer は
 *      常に別キーを生成でき、orphan は後続更新を一切阻害しない（公開もされない）。
 *
 * 注入ストア I/F（本番は Netlify Blobs を、テストは createMemoryStore をアダプト）:
 *   getJSONWithEtag(key)              -> { value, etag }         （無ければ {value:null, etag:null}）
 *   getBytes(key)                     -> { bytes, metadata }|null
 *   setJSON(key, obj)                 -> void                     （無条件・audit/op 用）
 *   setJSONIfNew(key, obj)            -> { modified, etag }       （create-only）
 *   setJSONIfMatch(key, obj, etag)    -> { modified, etag }       （CAS）
 *   setBytesIfNew(key, bytes, meta)   -> { modified }             （immutable 画像）
 */

export const mediaKeys = Object.freeze({
  current: () => 'manifest-current',
  manifest: (manifestId) => `manifests/${manifestId}`,
  image: (date, checksum) => `images/${date}/${checksum}`,
  operation: (operationId) => `operations/${operationId}`,
  audit: (operationId) => `audit/${operationId}`,
});

/** SHA-256 を hex で返す（WebCrypto。node:crypto に依存しない）。 */
export async function sha256hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('subtle unavailable');
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * テスト用インメモリストア。Blobs の atomic 条件付き書き込みを再現する。
 * opts.shouldFail(op, key) が true → その書き込みを throw（失敗時不変性テスト用）。
 * store.calls に全アクセスを記録。
 */
export function createMemoryStore(opts = {}) {
  const shouldFail = typeof opts.shouldFail === 'function' ? opts.shouldFail : () => false;
  const jsonMap = new Map(); // key -> { value, etag }
  const bytesMap = new Map(); // key -> { bytes, metadata, etag }
  const calls = [];
  let etagSeq = 0;
  const nextEtag = () => `etag-${++etagSeq}`;

  return {
    calls,
    async getJSONWithEtag(key) {
      calls.push(['getJSONWithEtag', key]);
      const rec = jsonMap.get(key);
      return rec ? { value: cloneJson(rec.value), etag: rec.etag } : { value: null, etag: null };
    },
    async getBytes(key) {
      calls.push(['getBytes', key]);
      const v = bytesMap.get(key);
      return v ? { bytes: v.bytes.slice(), metadata: { ...v.metadata } } : null;
    },
    async setJSON(key, obj) {
      calls.push(['setJSON', key]);
      if (shouldFail('setJSON', key)) throw new Error(`inject setJSON fail: ${key}`);
      jsonMap.set(key, { value: cloneJson(obj), etag: nextEtag() });
    },
    async setJSONIfNew(key, obj) {
      calls.push(['setJSONIfNew', key]);
      if (shouldFail('setJSONIfNew', key)) throw new Error(`inject setJSONIfNew fail: ${key}`);
      if (jsonMap.has(key)) return { modified: false };
      const etag = nextEtag();
      jsonMap.set(key, { value: cloneJson(obj), etag });
      return { modified: true, etag };
    },
    async setJSONIfMatch(key, obj, expectedEtag) {
      calls.push(['setJSONIfMatch', key]);
      if (shouldFail('setJSONIfMatch', key)) throw new Error(`inject setJSONIfMatch fail: ${key}`);
      const rec = jsonMap.get(key);
      if (!rec || rec.etag !== expectedEtag) return { modified: false };
      const etag = nextEtag();
      jsonMap.set(key, { value: cloneJson(obj), etag });
      return { modified: true, etag };
    },
    async setBytesIfNew(key, bytes, metadata) {
      calls.push(['setBytesIfNew', key]);
      if (shouldFail('setBytesIfNew', key)) throw new Error(`inject setBytesIfNew fail: ${key}`);
      if (bytesMap.has(key)) return { modified: false };
      const view = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
      bytesMap.set(key, { bytes: view, metadata: { ...(metadata || {}) }, etag: nextEtag() });
      return { modified: true };
    },
    _json: jsonMap,
    _bytes: bytesMap,
  };
}
