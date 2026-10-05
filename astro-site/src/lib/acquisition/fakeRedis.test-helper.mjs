/** テスト用の最小 Redis（SET NX / GET / MGET / HSETNX / HGET / HGETALL / DEL）。本番コードから import しない */
export function makeFakeRedis({ failOn } = {}) {
  const strings = new Map(); const hashes = new Map(); const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const [cmd, k, a, b] = args;
    if (failOn && failOn(cmd)) throw new Error('redis_500');
    switch (cmd) {
      case 'SET': if (b === 'NX' && strings.has(k)) return null; strings.set(k, a); return 'OK';
      case 'GET': return strings.has(k) ? strings.get(k) : null;
      case 'MGET': return args.slice(1).map((x) => (strings.has(x) ? strings.get(x) : null));
      case 'HSETNX': { const h = hashes.get(k) || new Map(); hashes.set(k, h); if (h.has(a)) return 0; h.set(a, b); return 1; }
      case 'HGET': return hashes.get(k)?.get(a) ?? null;
      case 'HGETALL': return [...(hashes.get(k) || new Map()).entries()].flat();
      default: throw new Error(`unsupported ${cmd}`);
    }
  };
  fn.strings = strings; fn.hashes = hashes; fn.calls = calls;
  return fn;
}
