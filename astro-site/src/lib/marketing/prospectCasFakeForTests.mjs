/**
 * prospectCasFakeForTests.mjs — `PROSPECT_CAS_LUA` と**同じ意味**をメモリ上で再現する（テスト専用）
 *
 * ⚠️ `*.test.mjs` ではないので `node --test` の対象にはならない。本番コードから import しないこと。
 * ⚠️ 本物の Lua 文字列の動作は別途 Lua VM で確かめている（PR 記載）。ここは各テストの
 *    偽 Redis が EVAL を受けられるようにするためのもの。判定の要点は本物と同じ:
 *    期待値（`ABSENT` / `V:` ＋ 読んだ生の値）が今も成り立つときだけ、その相手の書き込みを全部行う。
 */
import { PROSPECT_CAS_LUA } from './prospectStore.js';


/** EVAL の引数が prospect の CAS スクリプトか */
export function isProspectCasEval(args) {
  return Array.isArray(args) && String(args[0]).toUpperCase() === 'EVAL' && args[1] === PROSPECT_CAS_LUA;
}

/**
 * @param {string[]} args  `['EVAL', script, numkeys, ...KEYS, ...ARGV]`
 * @param {{get:(k:string)=>string|null, set:(k:string,v:string)=>void, del:(k:string)=>void,
 *          sadd:(k:string,m:string)=>void, srem:(k:string,m:string)=>void,
 *          has?:(k:string,m:string)=>boolean}} io  `has` があれば「所属が変わったか」（戻り値 2）も再現する
 * @returns {number[]}
 */
export function emulateProspectCas(args, io) {
  const numKeys = Number(args[2]);
  const KEYS = args.slice(3, 3 + numKeys).map(String);
  const ARGV = args.slice(3 + numKeys).map(String);
  const n = Number(ARGV[0]);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const kp = KEYS[3 + i * 2];
    const kb = KEYS[3 + i * 2 + 1];
    const a = 1 + i * 7;
    const [hash, expect, recOp, newRaw, act, eng, blk] = ARGV.slice(a, a + 7);
    const cur = io.get(kp);
    const ok = expect === 'ABSENT' ? (cur === null || cur === undefined) : (cur !== null && cur !== undefined && expect === `V:${cur}`);
    if (!ok) { out.push(0); continue; }
    if (recOp === 'SET') io.set(kp, newRaw);
    else if (recOp === 'DEL') io.del(kp);
    let moved = 0;
    const had = (k) => (typeof io.has === 'function' ? io.has(k, hash) : null);
    const move = (k, add) => {
      const before = had(k);
      if (add) io.sadd(k, hash); else io.srem(k, hash);
      const after = had(k);
      if (before !== null && before !== after) moved += 1;
    };
    if (act === '1') move(KEYS[0], true); else if (act === '0') move(KEYS[0], false);
    if (eng === '1') move(KEYS[1], true); else if (eng === '0') move(KEYS[1], false);
    if (blk !== '') { io.set(kb, blk); io.sadd(KEYS[2], hash); }
    out.push(moved > 0 ? 2 : 1);
  }
  return out;
}
