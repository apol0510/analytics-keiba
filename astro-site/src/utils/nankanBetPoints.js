// nankanBetPoints.js — 南関 購入点数（案1: ユニーク実購入買い目数）算出の単一源
//
// 目的:
//   購入者に表示している買い目そのものから「実購入組数」を数える。
//   払戻から逆算する getBetPoints / decideSettlement とは無関係な、
//   投資額・回収率分母の正本候補（案1）。
//
// Phase 1 の制約:
//   - 現行の的中判定 / 買い目生成 / archive 生成 / 画面表示には **接続しない**。
//   - getBetPoints / decideSettlement は削除・変更しない（本モジュールは併設のみ）。
//
// 必須仕様:
//   - 馬単は「軸 ↔ 全相手」を双方向の順序付き組として展開する。
//   - 抑え・補欠（"(抑え…)" 括弧内）を相手に含める。
//   - 同一順序付き組は dedup する。
//   - 払戻額は入力に使わない。
//   - AK / KI で同一入力なら同一結果（このファイルの馬単部は両 repo でバイト一致）。
//   - 三連複は 3 頭を順序無視の組へ正規化し、本命軸・対抗軸間の重複を dedup する。
//   - 不正・欠損形式は黙って推測せず BetPointsParseError を throw する。
//
// 依存ゼロ（他モジュールを import しない）。Node 実行の scripts からも安全に読める。

// ── 共通エラー型 ──────────────────────────────────────────────
export class BetPointsParseError extends Error {
  constructor(message, value) {
    super(message);
    this.name = 'BetPointsParseError';
    this.value = value;
  }
}

// ── 馬単（AK/KI 共通・バイト一致必須）──────────────────────────
// 区切りは - (南関KI/旧) / ↔ (AK新) / → (旧片方向) / ⇔ (旧表示) を同一に扱う。
const UMATAN_LINE_RE = /^(\d+)\s*[-↔→⇔]\s*(.+)$/;

function toHorseNumbers(str, line) {
  const out = [];
  for (const tok of String(str).split('.')) {
    const t = tok.trim();
    if (t.length === 0) continue;
    const n = Number(t);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BetPointsParseError(`invalid horse number "${tok}"`, line);
    }
    out.push(n);
  }
  return out;
}

/**
 * 1 本の馬単買い目行を解析する。
 * 例: "10↔2.3.4.7.11(抑え5.9.12)" / "10-2.3.4.7.11(抑え5.9.12)"
 * @param {string} line
 * @returns {{axis:number, partners:number[]}} 相手は本線+抑えを結合し軸除外・dedup 済み
 * @throws {BetPointsParseError} 形式不正時
 */
export function parseUmatanLine(line) {
  if (typeof line !== 'string') throw new BetPointsParseError('umatan line must be a string', line);
  const m = line.match(UMATAN_LINE_RE);
  if (!m) throw new BetPointsParseError('malformed umatan line', line);
  const axis = Number(m[1]);
  const rest = m[2];
  const osaeMatch = rest.match(/\(抑え([0-9.]+)\)/);
  const mainPart = rest.replace(/\(抑え[0-9.]+\)/, '');
  const main = toHorseNumbers(mainPart, line);
  const osae = osaeMatch ? toHorseNumbers(osaeMatch[1], line) : [];
  const partners = [...new Set([...main, ...osae])].filter((n) => n !== axis);
  return { axis, partners };
}

/**
 * 馬単のユニーク順序付き組数（軸↔全相手・双方向・全行 dedup）を返す。
 * 払戻は使わない。
 * @param {string[]} lines bettingLines.umatan
 * @returns {number}
 * @throws {BetPointsParseError} lines が配列でない / 行が形式不正
 */
export function countUmatanUniquePoints(lines) {
  if (!Array.isArray(lines)) throw new BetPointsParseError('lines must be an array', lines);
  const pairs = new Set();
  for (const line of lines) {
    const { axis, partners } = parseUmatanLine(line);
    for (const p of partners) {
      pairs.add(`${axis}-${p}`);
      pairs.add(`${p}-${axis}`);
    }
  }
  return pairs.size;
}

// ── 三連複（AK 専用）─────────────────────────────────────────
/**
 * 3 頭組を順序無視のキーへ正規化する。
 * @param {number[]} triple
 * @returns {string} 昇順 "a-b-c"
 * @throws {BetPointsParseError} 3 頭でない / 数値でない / 重複頭
 */
export function normalizeTriple(triple) {
  if (!Array.isArray(triple) || triple.length !== 3) {
    throw new BetPointsParseError('triple must contain exactly 3 numbers', triple);
  }
  const nums = triple.map((n) => Number(n));
  for (const n of nums) {
    if (!Number.isInteger(n) || n <= 0) throw new BetPointsParseError('invalid horse number in triple', triple);
  }
  if (new Set(nums).size !== 3) throw new BetPointsParseError('triple has duplicate horse numbers', triple);
  return nums.slice().sort((a, b) => a - b).join('-');
}

/**
 * 複数軸の三連複買い目（triple 配列の配列）を dedup してユニーク組数を返す。
 * 例: countSanrenpukuUniquePoints([honmeiAxis.lines, taikouAxis.lines])
 * @param {number[][][]} lineArrays 軸ごとの triple 配列
 * @returns {number}
 * @throws {BetPointsParseError}
 */
export function countSanrenpukuUniquePoints(lineArrays) {
  if (!Array.isArray(lineArrays)) throw new BetPointsParseError('lineArrays must be an array', lineArrays);
  const set = new Set();
  for (const lines of lineArrays) {
    if (!Array.isArray(lines)) throw new BetPointsParseError('each axis must be an array of triples', lines);
    for (const triple of lines) set.add(normalizeTriple(triple));
  }
  return set.size;
}

// axis × c2 × c3 の順序無視 3 頭組（軸・重複除外）を生成する。
function buildTriples(axis, c2pool, c3pool) {
  const seen = new Map();
  for (const a of c2pool) {
    if (a == null || a === axis) continue;
    for (const b of c3pool) {
      if (b == null || b === axis || b === a) continue;
      const key = [axis, a, b].slice().sort((x, y) => x - y).join('-');
      seen.set(key, [axis, a, b].slice().sort((x, y) => x - y));
    }
  }
  return [...seen.values()];
}

/**
 * archive 保存の三連複表示文字列を triple 配列へ復元する。
 * 例: "1 - 6.8.12 - 6.8.12.11.5.2(抑え9.7)"
 * @param {string} line
 * @returns {number[][]}
 * @throws {BetPointsParseError} 形式不正時
 */
export function parseSanrenpukuLine(line) {
  if (typeof line !== 'string') throw new BetPointsParseError('sanrenpuku line must be a string', line);
  const parts = line.split(' - ');
  if (parts.length < 3) throw new BetPointsParseError('malformed sanrenpuku line', line);
  const axis = Number(parts[0].trim());
  if (!Number.isInteger(axis) || axis <= 0) throw new BetPointsParseError('bad sanrenpuku axis', line);
  const c2 = toHorseNumbers(parts[1], line);
  const c3str = parts.slice(2).join(' - ');
  const nonosae = toHorseNumbers(c3str.split('(')[0], line);
  const osaeMatch = c3str.match(/\(抑え([0-9.]+)\)/);
  const osae = osaeMatch ? toHorseNumbers(osaeMatch[1], line) : [];
  const c3 = [...new Set([...nonosae, ...osae])];
  return buildTriples(axis, c2, c3);
}

/**
 * 三連複の表示文字列（本命軸・対抗軸など）配列から、軸間 dedup 済みユニーク組数を返す。
 * @param {Array<string|null|undefined>} lineStrings
 * @returns {number}
 * @throws {BetPointsParseError} 非空文字列が形式不正な場合
 */
export function countSanrenpukuUniqueFromStrings(lineStrings) {
  if (!Array.isArray(lineStrings)) throw new BetPointsParseError('lineStrings must be an array', lineStrings);
  const axes = lineStrings.filter((s) => typeof s === 'string' && s.trim().length > 0).map(parseSanrenpukuLine);
  return countSanrenpukuUniquePoints(axes);
}
