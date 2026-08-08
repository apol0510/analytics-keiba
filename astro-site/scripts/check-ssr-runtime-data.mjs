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
// 取込ラグ（予想だけ先に届き、featureScores/horseHistories が後追い）は日常的に起きる。
// 表示専用データはフォールバックがあり**ページは描画できる**ので fail にはしない。
// 「どの保持日でも引けない」= prune で消えた場合だけ fail にする。
const warn = (m) => console.log(`  ⚠️  ${m}`);

/** artifact のサブツリーに残っている日付（新しい順）と、日付→会場コード一覧 */
async function retainedByDate(sub, datePattern, codePattern) {
  const dir = join(fnDataDir, sub);
  const files = await listFiles(dir);
  const map = new Map();
  for (const f of files) {
    const d = datePattern.exec(f)?.[1];
    if (!d) continue;
    const code = codePattern ? codePattern.exec(f)?.[1] : null;
    if (!map.has(d)) map.set(d, new Set());
    if (code) map.get(d).add(code);
  }
  return { dates: [...map.keys()].sort().reverse(), codes: map };
}

/** ソース (src/data) 側に、その日付のファイルが何件あるか */
async function sourceCountFor(sub, date) {
  const dir = join(projectRoot, 'src', 'data', sub, ...date.split('-').slice(0, 2));
  const files = await listFiles(dir);
  return files.filter((f) => f.startsWith(`${date}-`)).length;
}

/**
 * 表示専用 loader の検査。要求日で引けなかったときは **ソースと突き合わせて**
 * 「取込ラグ」と「prune が消した」を区別する。この区別が無いと、
 * prune のバグが取込ラグに紛れて素通りする。
 *
 *  - 要求日で引ける                       → ok
 *  - 引けない × ソースにも無い            → warn（取込ラグ。ページは描画できる）
 *  - 引けない × **ソースには在る**        → ng（prune が消した＝退行）
 */
async function probeDisplayData({ label, sub, datePattern, codePattern, wantDate, wantCodes, load }) {
  const { dates, codes } = await retainedByDate(sub, datePattern, codePattern);
  if (dates.length === 0) return ng(`${label}: ${sub} に日付付きファイルが 0 → prune で消えている`);

  const tryDate = (d, only) => {
    // 要求日は「実際に出走する会場」で検査する（会場の取りこぼしを見逃さない）。
    // 他日は成果物の実在会場で代用する（その日どこが開催だったか分からないため）。
    const cs = only && only.length ? only : [...(codes.get(d) || [])];
    if (cs.length === 0) return null;
    const missing = cs.filter((c) => !load(d, c));
    return missing.length === 0 ? cs : null;
  };

  const hit = tryDate(wantDate, wantCodes);
  if (hit) return ok(`${label}: ${wantDate} × ${hit.join('/')} OK`);

  const inSource = await sourceCountFor(sub, wantDate);
  if (inSource > 0) {
    return ng(`${label}: ${wantDate} 分はソースに ${inSource} 件あるのに成果物から引けない`
      + ' → prune が消した（退行）');
  }
  const alt = dates.find((d) => d !== wantDate && tryDate(d));
  if (alt) {
    return warn(`${label}: ${wantDate} 分はソースにも未取込（取込ラグ）。${alt} は引けるので prune は健全。`
      + ' 表示はフォールバックへ落ちるがページは描画できる');
  }
  ng(`${label}: 保持している ${dates.length} 開催日のどれでも引けない → prune で消えている`);
}

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

  // featureScores / horseHistories は**表示専用**（欠けてもフォールバックで描画できる）。
  // 予想本体と別便で届くため、最新日だけ未取込という状態が日常的に起きる。
  try {
    const { loadFeatureScores, venueCodeFromName } = await lib('loadFeatureScores.js');
    const wantCodes = venueNames.map((n) => venueCodeFromName('jra', n));
    if (wantCodes.some((c) => !c)) ng(`loadFeatureScores(jra): venueCode 不明 ${venueNames.join('/')}`);
    await probeDisplayData({
      label: 'loadFeatureScores(jra)',
      sub: 'featureScores/jra',
      datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
      codePattern: /^\d{4}-\d{2}-\d{2}-([A-Z]+)\.json$/,
      wantDate: date,
      wantCodes,
      load: (d, c) => loadFeatureScores('jra', d, c),
    });
  } catch (e) {
    ng(`loadFeatureScores(jra) の実行に失敗: ${e.message}`);
  }

  try {
    const { jraVenueCodeFromName, loadHorseHistoriesForVenue, buildHorseNameIndex } = await lib('loadHorseHistoriesJra.js');
    await probeDisplayData({
      label: 'loadHorseHistoriesForVenue',
      sub: 'horseHistories/jra',
      datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
      codePattern: /^\d{4}-\d{2}-\d{2}-([A-Z]+)\.json$/,
      wantDate: date,
      wantCodes: venueNames.map((n) => jraVenueCodeFromName(n)).filter(Boolean),
      load: (d, c) => {
        const json = loadHorseHistoriesForVenue(d, c);
        return json ? buildHorseNameIndex(json)?.size > 0 : false;
      },
    });
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

    await probeDisplayData({
      label: 'loadFeatureScores(nankan)',
      sub: 'featureScores/nankan',
      datePattern: /^(\d{4}-\d{2}-\d{2})-[A-Z]+\.json$/,
      codePattern: /^\d{4}-\d{2}-\d{2}-([A-Z]+)\.json$/,
      wantDate: date,
      wantCodes: [code],
      load: (d, c) => loadFeatureScores('nankan', d, c),
    });

    // horseStats はレース単位。artifact に残っている当日ファイルから raceNo/horseNumber を取り、
    // ページと同じ引数形（date/venue/raceNo/horseNumber）で loader を実行する。
    const { loadHorseStatsNankan } = await lib('loadHorseStatsNankan.js');
    const statsRoot = join(fnDataDir, 'horseStats', 'nankan');
    const all = await listFiles(statsRoot);
    const PAT = /^(\d{4}-\d{2}-\d{2})-([A-Z]+)-R(\d{2})\.json$/;

    const runOne = async (fileName) => {
      const m = PAT.exec(fileName);
      if (!m) return false;
      const [, d, v] = m;
      const dir = join(statsRoot, ...d.split('-').slice(0, 2));
      const sj = JSON.parse(await readFile(join(dir, fileName), 'utf-8'));
      const raceNo = Number(sj.raceNo);
      const horseNumber = sj.horses?.[0]?.horseNumber;
      if (horseNumber == null) return false;
      const r = loadHorseStatsNankan({ date: d, venue: v, raceNo, horseNumber });
      return r?.ok === true && !!r.horseStats
        ? `${d} ${v} R${raceNo} #${horseNumber}` : false;
    };

    const wanted = all.filter((f) => f.startsWith(`${date}-${code}-R`)).sort();
    const srcRaces = await sourceCountFor('horseStats/nankan', date);
    if (wanted.length > 0 && srcRaces > 0 && wanted.length < srcRaces) {
      ng(`loadHorseStatsNankan: ${date}-${code} がソース ${srcRaces} レースに対し成果物 ${wanted.length} レース`
        + ' → prune がレース単位で取りこぼしている');
    }
    const hit = wanted.length ? await runOne(wanted[0]) : false;
    if (hit) {
      ok(`loadHorseStatsNankan: ${hit} OK`);
    } else {
      const inSource = await sourceCountFor('horseStats/nankan', date);
      if (inSource > 0) {
        ng(`loadHorseStatsNankan: ${date}-${code} 分はソースに ${inSource} 件あるのに成果物から引けない`
          + ' → prune が消した（退行）');
      } else {
        const others = all.filter((f) => PAT.test(f) && !f.startsWith(`${date}-`)).sort().reverse();
        let alt = false;
        for (const f of others) { alt = await runOne(f); if (alt) break; }
        if (alt) {
          warn(`loadHorseStatsNankan: ${date}-${code} 分はソースにも未取込（取込ラグ）。${alt} は引けるので prune は健全。`
            + ' 表示はフォールバックへ落ちるがページは描画できる');
        } else {
          ng('loadHorseStatsNankan: 保持しているどの開催日でも引けない → prune で消えている');
        }
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
