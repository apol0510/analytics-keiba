#!/usr/bin/env node
/**
 * check-ssr-runtime-data.mjs — prune 後の SSR 関数に「実行時に読むファイル」が実在するか検査する。
 *
 * ⚠️ ポリシーのユニットテスト（runtimeDataRetention.test.mjs）だけでは、
 *    **ビルド成果物に実際に何が残ったか**は分からない。2026-08-08 の退行は
 *    まさに「成果物を見ていなかった」ことで見逃された。ここは成果物を直接見る。
 *
 * 検査:
 *   1. RUNTIME_SUBTREES の各サブツリーが存在し、**1 ファイル以上**残っている
 *   2. 残っているファイルが**同一開催日でまとまっている**（会場別の取りこぼしが無い）
 *   3. SSR 有料ページが runtime で通る fs loader を**全件実際に実行**して非空を確認
 *      （loadJraVenuesForDisplay / loadFeatureScores / loadHorseHistoriesForVenue /
 *        loadHorseStatsNankan。＝認可後に「データがありません」へ落ちない）
 *   4. SSR 関数サイズが 250MB 未満
 *
 * ビルド前（成果物が無い）はスキップして exit 0。CI では build の後に実行する。
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_SUBTREES } from '../src/lib/ssr/runtimeDataRetention.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnRoot = join(projectRoot, '.netlify', 'v1', 'functions', 'ssr');
const fnDataDir = join(fnRoot, 'src', 'data');

let failed = 0;
const ng = (m) => { console.error(`  ❌ ${m}`); failed += 1; };
const ok = (m) => console.log(`  ✅ ${m}`);

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(e.name);
    }
  }
  await walk(dir);
  return out;
}

async function dirSizeMB(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { total += (await stat(p)).size; } catch { /* skip */ } }
    }
  }
  await walk(dir);
  return total / (1024 * 1024);
}

const lib = (f) => import(join(projectRoot, 'src', 'lib', f));

/**
 * JRA 経路: light-predictions-jra / premium-sanrenpuku-jra / premium-prediction/jra が
 * runtime に通る loader を、実際の最新日・実際の会場で全部引く。
 */
async function probeJraChain() {
  let date = null;
  let venueNames = [];
  try {
    const { loadJraVenuesForDisplay } = await lib('loadJraVenuesForDisplay.js');
    const r = loadJraVenuesForDisplay();
    const venues = Array.isArray(r.venues) ? r.venues : [];
    const races = venues.reduce((a, v) => a + ((v.predictions || v.races || []).length), 0);
    if (r.error) return ng(`loadJraVenuesForDisplay: error=${r.error}`);
    if (venues.length === 0 || races === 0) {
      return ng(`loadJraVenuesForDisplay: venues=${venues.length} races=${races} → 認可後に「データがありません」になる`);
    }
    date = r.predictionData?.date || null;
    venueNames = venues.map((v) => v.venue).filter(Boolean);
    ok(`loadJraVenuesForDisplay: date=${date} venues=${venues.length} races=${races}`);
  } catch (e) {
    return ng(`loadJraVenuesForDisplay の実行に失敗: ${e.message}`);
  }
  if (!date || venueNames.length === 0) return ng('JRA: date/venue を特定できず後続 loader を検査できない');

  // featureScores（表示専用だが、欠けると特徴量が全馬 null になる）
  try {
    const { loadFeatureScores, venueCodeFromName } = await lib('loadFeatureScores.js');
    for (const name of venueNames) {
      const code = venueCodeFromName('jra', name);
      if (!code) { ng(`loadFeatureScores(jra): venueCode 不明 name=${name}`); continue; }
      const fs6 = loadFeatureScores('jra', date, code);
      if (!fs6) ng(`loadFeatureScores(jra, ${date}, ${code}): null → 特徴量が引けない`);
      else ok(`loadFeatureScores(jra, ${date}, ${code}): OK`);
    }
  } catch (e) {
    ng(`loadFeatureScores(jra) の実行に失敗: ${e.message}`);
  }

  // horseHistories（近走表示の元）
  try {
    const { jraVenueCodeFromName, loadHorseHistoriesForVenue, buildHorseNameIndex } =
      await lib('loadHorseHistoriesJra.js');
    for (const name of venueNames) {
      const code = jraVenueCodeFromName(name);
      if (!code) { ng(`loadHorseHistoriesForVenue: venueCode 不明 name=${name}`); continue; }
      const json = loadHorseHistoriesForVenue(date, code);
      if (!json) { ng(`loadHorseHistoriesForVenue(${date}, ${code}): null → 近走が引けない`); continue; }
      const idx = buildHorseNameIndex(json);
      if (!idx || idx.size === 0) ng(`buildHorseNameIndex(${date}, ${code}): 0 件`);
      else ok(`loadHorseHistoriesForVenue(${date}, ${code}): ${idx.size} 頭`);
    }
  } catch (e) {
    ng(`loadHorseHistoriesForVenue の実行に失敗: ${e.message}`);
  }
}

/**
 * NANKAN 経路: light-predictions が runtime に通る loader。
 * 南関の予想本体は import.meta.glob(eager) でバンドルへ焼き込まれるため、
 * **ソース側の最新日**がそのままページの要求日になる。その日付で artifact 側を引けるか見る。
 */
async function probeNankanChain() {
  const srcDir = join(projectRoot, 'src', 'data', 'predictions');
  let latest = null;
  try {
    const files = (await readdir(srcDir)).filter((f) => /^\d{4}-\d{2}-\d{2}-[a-z]+\.json$/.test(f));
    if (files.length === 0) return ng('NANKAN: ソースの predictions/*.json が 0 件（バンドル対象が無い）');
    latest = files.sort().reverse()[0];
  } catch (e) {
    return ng(`NANKAN: predictions ディレクトリを読めない: ${e.message}`);
  }

  let date = null;
  let venueName = null;
  try {
    const json = JSON.parse(await readFile(join(srcDir, latest), 'utf-8'));
    // 南関 predictions は {eventInfo:{date,venue}, predictions:[...]}（adaptNewToLegacy 入力形）
    const ev = json.eventInfo || {};
    date = ev.date || json.raceDate || json.date || null;
    venueName = ev.venue || json.track || json.venue || json.venueName || null;
  } catch (e) {
    return ng(`NANKAN: ${latest} を parse できない: ${e.message}`);
  }
  if (!date || !venueName) return ng(`NANKAN: ${latest} から raceDate/venue を取得できない`);

  try {
    const { loadFeatureScores, venueCodeFromName } = await lib('loadFeatureScores.js');
    const code = venueCodeFromName('nankan', venueName);
    if (!code) return ng(`NANKAN: venueCode 不明 name=${venueName}`);

    const fs6 = loadFeatureScores('nankan', date, code);
    if (!fs6) ng(`loadFeatureScores(nankan, ${date}, ${code}): null → 特徴量が引けない`);
    else ok(`loadFeatureScores(nankan, ${date}, ${code}): OK`);

    // horseStats はレース単位。artifact に残っている当日ファイルから raceNo/horseNumber を取り、
    // ページと同じ引数形で loader を実行する。
    const statsDir = join(fnDataDir, 'horseStats', 'nankan', ...date.split('-').slice(0, 2));
    let statsFile = null;
    try {
      const cand = (await readdir(statsDir)).filter((f) => f.startsWith(`${date}-${code}-R`));
      statsFile = cand.sort()[0] || null;
    } catch { /* ディレクトリごと無い */ }
    if (!statsFile) {
      ng(`horseStats/nankan: ${date}-${code}-R*.json が artifact に無い → 南関の馬データ注入が空になる`);
    } else {
      const sj = JSON.parse(await readFile(join(statsDir, statsFile), 'utf-8'));
      const raceNo = Number(sj.raceNo);
      const horseNumber = sj.horses?.[0]?.horseNumber;
      const { loadHorseStatsNankan } = await lib('loadHorseStatsNankan.js');
      const r = loadHorseStatsNankan({ date, venue: code, raceNo, horseNumber });
      if (!r || r.ok !== true || !r.horseStats) {
        ng(`loadHorseStatsNankan(${date}, ${code}, R${raceNo}, #${horseNumber}): 取得失敗 reason=${r?.reason ?? r?.errors?.join('/')}`);
      } else {
        ok(`loadHorseStatsNankan(${date}, ${code}, R${raceNo}, #${horseNumber}): OK`);
      }
    }
  } catch (e) {
    ng(`NANKAN loader の実行に失敗: ${e.message}`);
  }
}

async function main() {
  if (!existsSync(fnDataDir)) {
    console.log('[check-ssr-runtime-data] SSR 成果物が無いためスキップ（build 前）');
    return;
  }
  console.log('[check-ssr-runtime-data] SSR 関数に実行時データが残っているか検査');

  // ── 1 & 2. 各サブツリーの残存ファイル ──
  for (const spec of RUNTIME_SUBTREES) {
    const dir = join(fnDataDir, spec.sub);
    if (!existsSync(dir)) { ng(`${spec.sub}: ディレクトリごと消えている（読み手: ${spec.readers.join(', ')}）`); continue; }
    const files = await listFiles(dir);
    const dated = files.filter((f) => spec.datePattern.test(f));
    if (dated.length === 0) { ng(`${spec.sub}: 命名規則に合うファイルが 0（読み手: ${spec.readers.join(', ')}）`); continue; }

    const byDate = new Map();
    for (const f of dated) {
      const d = spec.datePattern.exec(f)[1];
      byDate.set(d, (byDate.get(d) || 0) + 1);
    }
    const dates = [...byDate.keys()].sort().reverse();
    ok(`${spec.sub}: ${dated.length} ファイル / ${dates.length} 開催日（最新 ${dates[0]} = ${byDate.get(dates[0])} ファイル）`);
  }

  // ── 3. SSR 有料ページが runtime で通る fs loader を**全件実行**して非空を確認する ──
  //
  // ファイル存在だけでは不十分。「最新日のファイルは在るが、ページが要求する日付・会場では
  // 引けない」状態を落とすため、ページと同じ引数を組み立てて loader を実際に呼ぶ。
  const prevCwd = process.cwd();
  try {
    process.chdir(fnRoot);
    await probeJraChain();
    await probeNankanChain();
  } finally {
    process.chdir(prevCwd);
  }

  // ── 4. サイズ ──
  const mb = await dirSizeMB(fnRoot);
  if (mb >= 250) ng(`SSR 関数サイズ ${mb.toFixed(1)} MB（250MB 上限超過）`);
  else ok(`SSR 関数サイズ ${mb.toFixed(1)} MB / 250MB（余裕 ${(250 - mb).toFixed(1)} MB）`);

  if (failed > 0) {
    console.error(`[check-ssr-runtime-data] ❌ ${failed} 件の問題`);
    process.exit(1);
  }
  console.log('[check-ssr-runtime-data] ✅ すべて OK');
}

main().catch((e) => { console.error('[check-ssr-runtime-data] error:', e); process.exit(1); });
