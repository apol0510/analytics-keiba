#!/usr/bin/env node
/**
 * recalculate-umatan-archive-honsen-only.mjs
 *
 * AK馬単アーカイブを「公開本線のみ判定」（2026-07 仕様）へ再計算する安全スクリプト。
 * Premium で公開した本線相手だけを的中対象とし、内部保険 (抑え…)／（抑え…） は判定対象外にする。
 *
 * 特徴:
 *   - デフォルトは dry-run（--execute を明示しない限り archive を書き換えない）
 *   - 外部通信・token 不要。archive 内の bettingLines・着順・払戻だけで決定的に再計算
 *   - 判定は import 経路と同一の checkUmatanHit を再利用（南関=importResults.js / JRA=importResultsJra.js）
 *   - 投資額（5点固定）・レース数・並び順・metadata・bettingLines・着順・払戻元は不変
 *   - 再計算対象は的中結果に直接依存する集計値のみ（レース単位 isHit/hitLines、開催単位 hitRaces/missRaces/hitRate/totalPayout/returnRate/recoveryRate）
 *   - レガシー欠損（bettingLines/着順欠落）は再判定不能→据置。未知の欠損は自動停止
 *
 * 使い方:
 *   node scripts/recalculate-umatan-archive-honsen-only.mjs                 # dry-run(all)
 *   node scripts/recalculate-umatan-archive-honsen-only.mjs --scope=nankan  # 南関のみ dry-run
 *   node scripts/recalculate-umatan-archive-honsen-only.mjs --scope=jra
 *   node scripts/recalculate-umatan-archive-honsen-only.mjs --date=2026-07-01
 *   node scripts/recalculate-umatan-archive-honsen-only.mjs --execute       # 実書換え（要明示・本タスクでは未承認）
 */
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { checkUmatanHit as checkNankan } from './importResults.js';
import { checkUmatanHit as checkJra } from './importResultsJra.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');
const REPORT_DIR = '/tmp';
const BET_POINTS_PER_RACE = 5;
const BET_UNIT = 100;

// 再判定不能なレガシー既知開催（行レベル bettingLines/着順/払戻が欠落）。据置のみ・推測補完しない。
const KNOWN_LEGACY = [{ date: '2026-04-10', venue: '川崎' }];

export const SCOPES = {
  nankan: {
    label: '南関', file: 'archiveResults.json', check: checkNankan,
    expect: { entries: 58, races: 707, hitBefore: 521, hitAfter: 459, osaeDep: 62,
      payBefore: 1395690, payAfter: 989880, inv: 353500, roiBefore: 394.8, roiAfter: 280.0 },
  },
  jra: {
    label: 'JRA', file: 'archiveResultsJra.json', check: checkJra,
    expect: { entries: 40, races: 1332, hitBefore: 894, hitAfter: 712, osaeDep: 182,
      payBefore: 4177640, payAfter: 1971210, inv: 666000, roiBefore: 627.3, roiAfter: 296.0 },
  },
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const yen = (n) => '¥' + Number(n).toLocaleString();
// checkUmatanHit(bettingLine, result) は result.results[0/1].number 形式を要求するため archive race から shim
const shim = (r) => ({ results: [{ number: r?.result?.first?.number }, { number: r?.result?.second?.number }] });

const isLegacyKnown = (e) =>
  KNOWN_LEGACY.some((k) => k.date === (e.date || e.raceDate) && String(e.venue || '').includes(k.venue));
const raceUndecidable = (r) =>
  !(r.bettingLines && r.bettingLines.length) || r?.result?.first?.number == null || r?.result?.second?.number == null;

// 現行（本線+抑え）判定 — レポートの before 基準専用（import 経路の旧仕様と等価）。
function hitWithOsae(line, race) {
  const m = String(line).match(/^(\d+)[\-↔⇔→](.+)$/);
  if (!m) return false;
  const axis = parseInt(m[1]);
  const aite = m[2];
  const main = aite.replace(/[(（]抑え[^)）]*[)）]/g, '').split('.').map(Number).filter((n) => !isNaN(n));
  const om = aite.match(/[(（]抑え([0-9.]+)[)）]/);
  const osae = om ? om[1].split('.').map(Number).filter((n) => !isNaN(n)) : [];
  const all = [...main, ...osae];
  const f = race?.result?.first?.number, s = race?.result?.second?.number;
  if (!f || !s) return false;
  return (axis === f && all.includes(s)) || (all.includes(f) && axis === s);
}

/**
 * 1開催を本線のみ判定で再計算する。書き換え対象フィールドのみ更新し、他は不変・順序保持。
 * @returns {{legacy:boolean, entry:object, changed:boolean, changedFields:string[]}}
 */
export function recomputeEntry(entry, checkFn) {
  const races = entry.races || [];
  const undecidable = races.filter(raceUndecidable);
  if (undecidable.length > 0) {
    if (isLegacyKnown(entry) && undecidable.length === races.length) {
      return { legacy: true, entry, changed: false, changedFields: [] };
    }
    const err = new Error(
      `AUTO-STOP: 未知のレガシー欠損を検出 ${entry.date} ${entry.venue} (再判定不能レース ${undecidable.length}/${races.length})。推測補完せず停止します。`);
    err.autoStop = true;
    err.detail = { date: entry.date, venue: entry.venue, undecidable: undecidable.length, total: races.length };
    throw err;
  }

  let hitRaces = 0, totalPayout = 0;
  const newRaces = races.map((r) => {
    const sr = shim(r);
    const hitLines = (r.bettingLines || []).filter((l) => checkFn(l, sr));
    const isHit = hitLines.length > 0;
    if (isHit) { hitRaces++; if (r.umatan?.payout) totalPayout += r.umatan.payout; }
    return { ...r, isHit, hitLines }; // isHit/hitLines は既存キー→順序保持
  });

  const totalRaces = races.length;
  const betAmount = totalRaces * BET_POINTS_PER_RACE * BET_UNIT; // 5点固定（既存値と同一）
  const hitRate = totalRaces ? +(hitRaces / totalRaces * 100).toFixed(1) : 0;
  const returnRate = betAmount ? +(totalPayout / betAmount * 100).toFixed(1) : 0;

  // 既存キーのみ上書き（順序保持）。投資額系・並び順・metadata・bettingLines・着順・払戻元は不変。
  const newEntry = { ...entry, hitRaces, missRaces: totalRaces - hitRaces, hitRate,
    totalPayout, returnRate, recoveryRate: returnRate, races: newRaces };

  const changedFields = [];
  for (const k of ['hitRaces', 'missRaces', 'hitRate', 'totalPayout', 'returnRate', 'recoveryRate']) {
    if (JSON.stringify(entry[k]) !== JSON.stringify(newEntry[k])) changedFields.push(k);
  }
  let raceChanges = 0;
  entry.races.forEach((r, i) => { if (r.isHit !== newRaces[i].isHit || JSON.stringify(r.hitLines) !== JSON.stringify(newRaces[i].hitLines)) raceChanges++; });
  if (raceChanges) changedFields.push(`races[].isHit/hitLines×${raceChanges}`);

  return { legacy: false, entry: newEntry, changed: changedFields.length > 0, changedFields };
}

function runScope(scopeKey, opts) {
  const s = SCOPES[scopeKey];
  const path = join(DATA_DIR, s.file);
  const raw = readFileSync(path, 'utf-8');
  const beforeSha = sha256(raw);
  const arch = JSON.parse(raw);

  const entries = opts.date ? arch.filter((e) => (e.date || e.raceDate) === opts.date) : arch;

  // §A 判定基準比較（判定可能レース基準・レガシーは bettingLines 空→両方式0で自然に除外）
  let A_races = 0, A_before = 0, A_after = 0, A_osae = 0, A_payBefore = 0, A_payAfter = 0, A_inv = 0;
  // §B 実ファイル差分（stored → after）
  const perEntry = []; const legacyEntries = []; const osaeRows = []; const changedFieldSet = new Set();
  const newArch = [];

  for (const e of arch) {
    const inScope = !opts.date || (e.date || e.raceDate) === opts.date;
    const rc = recomputeEntry(e, s.check);
    newArch.push(rc.entry);
    if (!inScope) continue;

    if (rc.legacy) {
      legacyEntries.push({ date: e.date, venue: e.venue, totalRaces: e.totalRaces,
        storedHit: e.hitRaces, storedPayout: e.totalPayout, storedRoi: e.returnRate,
        note: '再判定不能（bettingLines/着順欠落）→据置。全期間件数には含む。ROI集計は現状値(0%)据置。' });
    }

    for (const r of (e.races || [])) {
      A_races++; A_inv += BET_POINTS_PER_RACE * BET_UNIT;
      const bl = r.bettingLines || [];
      const bHit = bl.some((l) => hitWithOsae(l, r));
      const aHit = bl.some((l) => s.check(l, shim(r)));
      const pay = r.umatan?.payout || 0;
      if (bHit) { A_before++; A_payBefore += pay; }
      if (aHit) { A_after++; A_payAfter += pay; }
      if (bHit && !aHit) {
        A_osae++;
        const parsed = bl.map((l) => {
          const m = String(l).match(/^(\d+)[\-↔⇔→](.+)$/); if (!m) return '';
          const main = m[2].replace(/[(（]抑え[^)）]*[)）]/g, '').replace(/\.$/, '');
          const om = m[2].match(/[(（]抑え([0-9.]+)[)）]/);
          return { honsen: `${m[1]}↔${main}`, osae: om ? om[1] : '' };
        }).filter(Boolean);
        osaeRows.push({ scope: s.label, date: e.date, venue: e.venue, R: r.raceNumber,
          lines: bl.join(' / '),
          honsen: parsed.map((p) => p.honsen).join(' / '),
          osae: parsed.map((p) => p.osae).filter(Boolean).join(' / '),
          first: r.result?.first?.number, second: r.result?.second?.number, payout: pay,
          cur: '的中', hon: '不的中' });
      }
    }

    const after = rc.entry;
    perEntry.push({ date: e.date, venue: e.venue, totalRaces: e.totalRaces, legacy: rc.legacy,
      hitBefore: e.hitRaces, hitAfter: after.hitRaces,
      payBefore: e.totalPayout, payAfter: after.totalPayout,
      roiBefore: e.returnRate, roiAfter: after.returnRate,
      changed: rc.changed, changedFields: rc.changedFields.join('; ') });
    rc.changedFields.forEach((f) => changedFieldSet.add(f.replace(/×\d+$/, '')));
  }

  const A_roiBefore = A_inv ? +(A_payBefore / A_inv * 100).toFixed(1) : 0;
  const A_roiAfter = A_inv ? +(A_payAfter / A_inv * 100).toFixed(1) : 0;

  // 書き換えは --execute のときだけ。dry-run では絶対に書かない。
  let afterSha = beforeSha, wrote = false;
  if (opts.execute && !opts.date) {
    const out = JSON.stringify(newArch, null, 2);
    writeFileSync(path, out, 'utf-8');
    afterSha = sha256(readFileSync(path, 'utf-8'));
    wrote = true;
  } else {
    afterSha = sha256(readFileSync(path, 'utf-8')); // 再読込で不変を確認
  }

  return { scopeKey, s, path, beforeSha, afterSha, wrote,
    A: { races: A_races, before: A_before, after: A_after, osae: A_osae,
      payBefore: A_payBefore, payAfter: A_payAfter, inv: A_inv, roiBefore: A_roiBefore, roiAfter: A_roiAfter,
      entries: entries.length },
    perEntry, legacyEntries, osaeRows, changedFields: [...changedFieldSet] };
}

function validate(res) {
  if (res.scopeKey === undefined) return [];
  const problems = [];
  const opts = res._opts || {};
  if (opts.date) return problems; // 単日は全期間期待値と照合しない
  const e = res.s.expect, A = res.A;
  const chk = (name, got, want) => { if (got !== want) problems.push(`${res.s.label} ${name}: 実測 ${got} ≠ 期待 ${want}`); };
  chk('対象開催数', A.entries, e.entries);
  chk('対象レース数', A.races, e.races);
  chk('現行的中(本線+抑え)', A.before, e.hitBefore);
  chk('本線のみ的中', A.after, e.hitAfter);
  chk('抑え依存的中', A.osae, e.osaeDep);
  chk('現行払戻', A.payBefore, e.payBefore);
  chk('本線のみ払戻', A.payAfter, e.payAfter);
  chk('投資額', A.inv, e.inv);
  chk('現行ROI', A.roiBefore, e.roiBefore);
  chk('本線のみROI', A.roiAfter, e.roiAfter);
  return problems;
}

function csv(rows, header, mapRow) {
  return [header, ...rows.map(mapRow)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opts = {
    execute: args.includes('--execute'),
    scope: (args.find((a) => a.startsWith('--scope=')) || '--scope=all').split('=')[1],
    date: (args.find((a) => a.startsWith('--date=')) || '--date=').split('=')[1] || null,
  };
  const scopes = opts.scope === 'all' ? ['nankan', 'jra'] : [opts.scope];
  if (scopes.some((k) => !SCOPES[k])) { console.error(`不正な --scope: ${opts.scope}`); process.exit(2); }

  console.log(`\n━━━ AK馬単アーカイブ 本線のみ再計算 (${opts.execute ? 'EXECUTE' : 'DRY-RUN'}) scope=${opts.scope} date=${opts.date || '全期間'} ━━━`);
  if (!opts.execute) console.log('※ dry-run: archive JSON は書き換えません。\n');

  const results = [];
  let allProblems = [];
  for (const k of scopes) {
    let res;
    try {
      res = runScope(k, opts);
    } catch (err) {
      if (err.autoStop) { console.error(`\n🛑 ${err.message}`); process.exit(3); }
      throw err;
    }
    res._opts = opts;
    results.push(res);
    const A = res.A;
    console.log(`\n【${res.s.label}】(${res.wrote ? '書換え実行' : '未書換え'})`);
    console.log(`  対象開催 ${A.entries} / レース ${A.races}`);
    console.log(`  的中   現行(本線+抑え) ${A.before} → 本線のみ ${A.after}   抑え依存 ${A.osae}`);
    console.log(`  払戻   ${yen(A.payBefore)} → ${yen(A.payAfter)}  (差 ${yen(A.payAfter - A.payBefore)})`);
    console.log(`  投資額 ${yen(A.inv)} (5点固定・不変)`);
    const hr = (n) => (A.races ? (n / A.races * 100).toFixed(1) : '0.0');
    console.log(`  ROI    ${A.roiBefore}% → ${A.roiAfter}%   的中率 ${hr(A.before)}% → ${hr(A.after)}%`);
    if (res.legacyEntries.length) res.legacyEntries.forEach((l) => console.log(`  ⏸️ レガシー据置: ${l.date} ${l.venue} — ${l.note}`));
    console.log(`  SHA256 before ${res.beforeSha.slice(0, 16)}… / after ${res.afterSha.slice(0, 16)}… → ${res.beforeSha === res.afterSha ? '不変' : '変化'}`);
    const problems = validate(res);
    allProblems = allProblems.concat(problems);
  }

  // レポート出力（/tmp）
  const tag = opts.date ? `-${opts.date}` : '';
  for (const res of results) {
    const perCsv = csv(res.perEntry,
      '日付,会場,レース数,legacy,現行的中,本線のみ的中,現行払戻,本線のみ払戻,現行ROI,本線のみROI,変更フィールド',
      (e) => [e.date, e.venue, e.totalRaces, e.legacy, e.hitBefore, e.hitAfter, e.payBefore, e.payAfter, e.roiBefore, e.roiAfter, `"${e.changedFields}"`].join(','));
    writeFileSync(join(REPORT_DIR, `umatan-honsen-${res.scopeKey}-before-after${tag}.csv`), perCsv, 'utf-8');
  }
  const allOsae = results.flatMap((r) => r.osaeRows);
  writeFileSync(join(REPORT_DIR, `umatan-honsen-osae-dependent${tag}.csv`),
    csv(allOsae, '商品,日付,会場,R,保存買い目,公開本線部分,抑え部分,1着,2着,払戻,現行判定,本線のみ判定',
      (r) => [r.scope, r.date, r.venue, r.R, `"${r.lines}"`, `"${r.honsen}"`, `"${r.osae}"`, r.first, r.second, r.payout, r.cur, r.hon].join(',')), 'utf-8');
  const fieldsTxt = results.map((r) => `【${r.s.label}】変更予定フィールド: ${r.changedFields.join(', ') || '(なし)'}`).join('\n');
  writeFileSync(join(REPORT_DIR, `umatan-honsen-changed-fields${tag}.txt`), fieldsTxt, 'utf-8');
  const legacyTxt = results.flatMap((r) => r.legacyEntries.map((l) => `${r.s.label} ${l.date} ${l.venue}: ${l.note} (storedHit=${l.storedHit}, storedPayout=${l.storedPayout}, storedROI=${l.storedRoi}%)`)).join('\n') || '(なし)';
  writeFileSync(join(REPORT_DIR, `umatan-honsen-legacy${tag}.txt`), legacyTxt, 'utf-8');
  const shaTxt = results.map((r) => `${r.s.label} ${r.s.file}\n  before SHA256: ${r.beforeSha}\n  after  SHA256: ${r.afterSha}\n  archive JSON: ${r.beforeSha === r.afterSha ? '不変（未書換え）' : '変化（書換え実行）'}`).join('\n');
  writeFileSync(join(REPORT_DIR, `umatan-honsen-sha${tag}.txt`), shaTxt, 'utf-8');

  console.log(`\nレポート出力: ${REPORT_DIR}/umatan-honsen-*${tag}.{csv,txt}`);

  if (allProblems.length) {
    console.error(`\n🛑 期待値不一致で停止:\n  - ${allProblems.join('\n  - ')}`);
    process.exit(4);
  }
  console.log(`\n✅ ${opts.execute ? '書換え完了' : 'dry-run 完了（archive 不変）'} — 期待値一致。`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
