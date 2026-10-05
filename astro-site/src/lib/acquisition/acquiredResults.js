/**
 * acquiredResults.js — 取得した予想の「結果」（的中／不的中／結果待ち）
 *
 * 2026-10-05 MK 確定（docs/PREDICTION_ACQUISITION.md §2-5）:
 *   取得時点の買い目（本文スナップショット）と、結果アーカイブの着順だけで判定する。推測で「的中」と出さない。
 *   - 馬単: 取得した買い目（通常＋絞り）のどれかで 1・2 着が当たっていれば的中。
 *           `→` は一方向（軸→相手のみ）、`↔` `⇔` `-` は双方向（importResults*.js の checkUmatanHit と同じ規則）。
 *           (抑え…) は馬単の判定に含めない。
 *   - 三連複: 取得した買い目（通常＋中心）のフォーメーション「軸 - 2列目 - 3列目(抑え…)」に 1〜3 着の組が含まれれば的中。
 *           抑えは 3 列目に含める（sanrenpukuBetting の buildCombos と同じ）。
 *   - 着順が無い（レース前・取込前）は pending。買い目が無い（見送り等）は none。
 *   - 払戻はアーカイブにある値だけを出す（無ければ金額を出さない）。
 *
 * 着順の出典: src/data/archiveResults.json（南関）・archiveResultsJra.json（中央）の result.first/second/third。
 * 三連複の払戻: archiveSanrenpukuResults(.Jra).json の races[].payout（通常買い目で的中した日のみ値がある）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const num = (v) => { const n = Number(String(v ?? '').replace(/R$/, '')); return Number.isFinite(n) ? n : null; };
const nums = (s) => String(s || '').split(/[.,・]/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
const rkey = (date, venueName, raceNumber) => `${date}|${venueName}|${raceNumber}`;

/** 馬単 1 行の的中判定（importResults*.js の checkUmatanHit と同じ規則・抑えは除外） */
export function umatanLineHits(line, first, second) {
  const m = String(line || '').match(/^\s*(\d+)\s*([\-↔⇔→])\s*(.+)$/);
  if (!m || !first || !second) return false;
  const axis = Number(m[1]);
  const partners = nums(m[3].replace(/[(（]抑え[^)）]*[)）]/g, ''));
  if (axis === first && partners.includes(second)) return true;
  return m[2] !== '→' && axis === second && partners.includes(first);
}

/** 三連複フォーメーション 1 行の的中判定（「軸 - 2列目 - 3列目(抑え…)」・抑えは 3 列目に含める） */
export function sanrenpukuLineHits(line, top3) {
  if (!Array.isArray(top3) || top3.length !== 3 || top3.some((n) => !n)) return false;
  const s = String(line || '');
  const osae = nums((s.match(/[(（]抑え([^)）]*)[)）]/) || [])[1]);
  const cols = s.replace(/[(（]抑え[^)）]*[)）]/g, '').split(/\s*-\s*/).map(nums);
  if (cols.length !== 3 || cols.some((c) => c.length === 0)) return false;
  const [a, b, c] = [cols[0], cols[1], [...cols[2], ...osae]];
  const want = top3.slice().sort((x, y) => x - y).join('-');
  for (const x of a) for (const y of b) for (const z of c) {
    if (x === y || y === z || x === z) continue;
    if ([x, y, z].sort((p, q) => p - q).join('-') === want) return true;
  }
  return false;
}

/** 結果アーカイブから「日付|会場名|レース番号」→ 着順・払戻 の索引を作る（純粋） */
export function buildResultIndex({ umatan = [], sanrenpuku = [] } = {}) {
  const idx = new Map();
  for (const day of Array.isArray(umatan) ? umatan : []) {
    for (const r of Array.isArray(day?.races) ? day.races : []) {
      const rn = num(r.raceNumber); const venue = r.venue || day.venue;
      const f = r.result?.first?.number, s = r.result?.second?.number, t = r.result?.third?.number;
      if (!day?.date || !venue || !rn || !f || !s) continue;
      idx.set(rkey(day.date, venue, rn), {
        first: Number(f), second: Number(s), third: t ? Number(t) : null,
        umatanPayout: Number(r.umatan?.payout) > 0 ? Number(r.umatan.payout) : null,
      });
    }
  }
  // 三連複の払戻（{YYYY}{MM}{DD} → 会場 1 つ or 配列）
  const visit = (date, v) => {
    for (const day of Array.isArray(v) ? v : [v]) {
      for (const r of Array.isArray(day?.races) ? day.races : []) {
        const rn = num(r.raceNumber); const venue = r.venue || day.venue;
        const hit = idx.get(rkey(date, venue, rn));
        if (hit && Number(r.payout) > 0) hit.sanrenpukuPayout = Number(r.payout);
      }
    }
  };
  for (const src of Array.isArray(sanrenpuku) ? sanrenpuku : [sanrenpuku]) {
    for (const [y, ms] of Object.entries(src || {})) for (const [m, ds] of Object.entries(ms || {})) {
      for (const [d, v] of Object.entries(ds || {})) visit(`${y}-${m}-${d}`, v);
    }
  }
  return idx;
}

/**
 * 取得記録 1 件の結果
 * @returns {{ status: 'hit'|'miss'|'pending'|'none', betType?: string, combination?: string, payout?: number|null, order?: number[] }}
 * order = [1着, 2着, 3着]（着順が分かったときだけ。3着は無いことがある）
 */
export function judgeAcquired({ entry, content, index }) {
  if (!entry || !content) return { status: 'pending' };
  const res = index?.get(rkey(entry.date, entry.venueName, Number(entry.raceNumber)));
  if (entry.product === 'srp') {
    const lines = [...(content.sanrenpuku?.normal || []), content.sanrenpuku?.center].filter((l) => l && l.line).map((l) => l.line);
    if (!lines.length) return { status: 'none', betType: '三連複' };
    if (!res || !res.third) return { status: 'pending', betType: '三連複' };
    const top3 = [res.first, res.second, res.third];
    const hit = lines.some((l) => sanrenpukuLineHits(l, top3));
    return hit
      ? { status: 'hit', betType: '三連複', combination: top3.slice().sort((a, b) => a - b).join('-'), payout: res.sanrenpukuPayout ?? null, order: top3 }
      : { status: 'miss', betType: '三連複', order: top3 };
  }
  const lines = [...(content.umatan?.normal || []), content.umatan?.narrowed].filter((l) => l && l.line).map((l) => l.line);
  if (!lines.length) return { status: 'none', betType: '馬単' };
  if (!res) return { status: 'pending', betType: '馬単' };
  const hit = lines.some((l) => umatanLineHits(l, res.first, res.second));
  const order = [res.first, res.second, res.third].filter(Boolean);
  return hit
    ? { status: 'hit', betType: '馬単', combination: `${res.first}→${res.second}`, payout: res.umatanPayout ?? null, order }
    : { status: 'miss', betType: '馬単', order };
}

// 実行時の索引（デプロイ単位でしか変わらないので、温まった関数の中ではメモリに持つ）
let cached = null;
export function loadResultIndex({ root } = {}) {
  if (cached && !root) return cached;
  const base = join(root || process.cwd(), 'src', 'data');
  const read = (f) => { try { return JSON.parse(readFileSync(join(base, f), 'utf8')); } catch { return null; } };
  const umatan = [...(read('archiveResults.json') || []), ...(read('archiveResultsJra.json') || [])];
  const sanrenpuku = [read('archiveSanrenpukuResults.json'), read('archiveSanrenpukuResultsJra.json')].filter(Boolean);
  const idx = buildResultIndex({ umatan, sanrenpuku });
  if (!root) cached = idx;
  return idx;
}

/**
 * 結果の集計（取得履歴ページの成績）。分母は「結果が出た予想」だけ（結果待ち・買い目なしは含めない）。
 * 払戻は 100 円あたりの配当（アーカイブの値）。合計や回収率は出さない（買った点数・金額は会員ごとに違うため）。
 */
export function summarizeResults(results) {
  const list = Object.values(results || {}).filter(Boolean);
  const hits = list.filter((r) => r.status === 'hit');
  const settled = hits.length + list.filter((r) => r.status === 'miss').length;
  const payouts = hits.map((r) => Number(r.payout)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    settled,
    hits: hits.length,
    pending: list.filter((r) => r.status === 'pending').length,
    hitRate: settled ? Math.round((hits.length / settled) * 1000) / 10 : null,
    maxPayout: payouts.length ? Math.max(...payouts) : null,
  };
}
