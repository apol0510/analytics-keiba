#!/usr/bin/env node
/**
 * previewNankanBetPoints.mjs (analytics-keiba) — 【READ-ONLY / Phase 3 dry-run】
 *
 * 既存 archive を **一切書き換えず**、案1（ユニーク実購入買い目数）で
 * 購入点数・投資額・回収率を再計算し、現行値との差分だけを出力する。
 *
 *   - 対象: 南関のみ（馬単 archiveResults.json / 三連複 archiveSanrenpukuResults.json）
 *   - JRA（archiveResultsJra.json）は対象外・参照しない
 *   - 的中件数・払戻は既存 archive 値を維持（払戻から点数を逆算しない）
 *   - 書き込み関数を持たない（fs.writeFile 等は import しない）
 *
 * 実行: node scripts/previewNankanBetPoints.mjs   （astro-site 直下から）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countUmatanUniquePoints,
  countSanrenpukuUniqueFromStrings,
  BetPointsParseError,
} from '../src/utils/nankanBetPoints.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const yen = (n) => `¥${Number(n).toLocaleString()}`;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

// ── 馬単 ──
function previewUmatan() {
  const arch = readJson(join(DATA, 'archiveResults.json'));
  let curInv = 0, newInv = 0, pay = 0; const unrecalc = [];
  for (const e of arch) {
    let uniq = 0, missing = 0, bad = 0;
    for (const r of e.races || []) {
      const lines = r.bettingLines;
      if (!Array.isArray(lines) || lines.length === 0) { missing++; continue; }
      try { uniq += countUmatanUniquePoints(lines); }
      catch (err) { if (err instanceof BetPointsParseError) bad++; else throw err; }
    }
    if (missing || bad) unrecalc.push(`${e.date}(欠${missing}/不正${bad})`);
    curInv += (e.totalInvestment || e.betAmount || 0);
    newInv += uniq * 100;
    pay += (e.totalPayout || 0);
  }
  return { label: 'AK 馬単', span: [arch[arch.length - 1]?.date, arch[0]?.date], days: arch.length, curInv, newInv, pay, unrecalc };
}

// ── 三連複（本命軸+対抗軸 dedup）──
function previewSanrenpuku() {
  const a = readJson(join(DATA, 'archiveSanrenpukuResults.json'));
  const days = [];
  for (const y of Object.keys(a)) for (const m of Object.keys(a[y])) for (const d of Object.keys(a[y][m])) days.push({ date: `${y}-${m}-${d}`, ...a[y][m][d] });
  let curInv = 0, newInv = 0, pay = 0; const unrecalc = []; let recalcDays = 0;
  for (const e of days) {
    let uniq = 0, spec = 0, noSpec = 0;
    for (const r of e.races || []) {
      const strs = [r.normalHonmeiAxis?.line, r.normalTaikouAxis?.line].filter(Boolean);
      if (strs.length === 0) { noSpec++; continue; }
      try { uniq += countSanrenpukuUniqueFromStrings(strs); spec++; }
      catch (err) { if (err instanceof BetPointsParseError) noSpec++; else throw err; }
    }
    if (spec === 0) { unrecalc.push(e.date); continue; }
    recalcDays++;
    curInv += (e.totalBetPoints || 0) * 100;
    newInv += uniq * 100;
    pay += (e.totalPayout || 0);
  }
  return { label: 'AK 三連複', span: [days[0]?.date, days[days.length - 1]?.date], days: days.length, recalcDays, curInv, newInv, pay, unrecalc };
}

function report(r) {
  console.log(`\n================= ${r.label} =================`);
  console.log(`対象期間: ${r.span[0]} 〜 ${r.span[1]}  日数: ${r.days}${r.recalcDays != null ? ` (再計算可 ${r.recalcDays})` : ''}`);
  const curRR = r.curInv > 0 ? (r.pay / r.curInv * 100).toFixed(1) : 'n/a';
  const newRR = r.newInv > 0 ? (r.pay / r.newInv * 100).toFixed(1) : 'n/a';
  console.log(`現行 投資額=${yen(r.curInv)} → 回収率 ${curRR}%`);
  console.log(`案1  投資額=${yen(r.newInv)} → 回収率 ${newRR}%   (分母不足 ${yen(r.newInv - r.curInv)})`);
  console.log(`総払戻(不変)=${yen(r.pay)}`);
  if (r.unrecalc.length) console.log(`再計算不能/欠損 ${r.unrecalc.length}件: ${r.unrecalc.slice(0, 40).join(', ')}${r.unrecalc.length > 40 ? ' …' : ''}`);
}

console.log('【READ-ONLY dry-run】既存 archive は書き換えません（南関のみ / JRA 非対象）');
report(previewUmatan());
report(previewSanrenpuku());
