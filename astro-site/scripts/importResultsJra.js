#!/usr/bin/env node

/**
 * 結果データ自動取り込み・的中判定スクリプト（中央競馬版）
 *
 * keiba-data-sharedから中央競馬の結果データを取得し、予想と照合して的中判定を行う
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';

import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';
import { exitDeferredOrFatal } from './lib/sharedCheckerSupport.mjs';

const LABEL = 'importResultsJra.js';

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw 廃止・token 未設定 fatal）。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// ── 特別競走名マスタ（UI 表示用 displayName の補完）──────────────
let SPECIALTY_RACE_MASTER = {};
try {
  const masterPath = join(projectRoot, 'src', 'data', 'specialty-race-master.json');
  if (existsSync(masterPath)) {
    const raw = JSON.parse(readFileSync(masterPath, 'utf-8'));
    SPECIALTY_RACE_MASTER = Object.fromEntries(
      Object.entries(raw).filter(([k]) => !k.startsWith('_'))
    );
  }
} catch (e) {
  console.warn(`⚠️  specialty-race-master.json 読み込み失敗: ${e.message}`);
}

const JRA_VENUE_TO_CODE = {
  '東京': 'TOK', '中山': 'NAK', '京都': 'KYO', '阪神': 'HAN',
  '中京': 'CHU', '小倉': 'KOK', '新潟': 'NII', '福島': 'FKS',
  '札幌': 'SAP', '函館': 'HKD',
};
function venueToCode(venue) {
  return JRA_VENUE_TO_CODE[venue] || venue || '';
}

const MOJIBAKE_MARKERS = ['鬟','逶','蛻','繝','縺','豁','譌','蜻','荵','窶','繧','繪','繡','繞','繦','譖','謇','蛟','蛛','蜈','�'];
function isMojibakeName(s) {
  if (!s) return false;
  const t = String(s);
  for (const m of MOJIBAKE_MARKERS) if (t.indexOf(m) >= 0) return true;
  const qat = t.match(/\?@/g);
  if (qat && qat.length >= 2) return true;
  if (/\?{3,}/.test(t)) return true;
  if (/@{3,}/.test(t)) return true;
  return false;
}

function isGenericVenueRaceName(name, venue, n) {
  if (!name) return true;
  const t = String(name).trim();
  if (!t) return true;
  return new RegExp(`^${venue || ''}\\s*${n}\\s*(R|レース)?$`).test(t);
}

function isCleanRaceName(s, venue, raceNumber) {
  if (!s) return false;
  const t = String(s).trim();
  if (!t) return false;
  if (isGenericVenueRaceName(t, venue, raceNumber)) return false;
  if (isMojibakeName(t)) return false;
  return true;
}

/**
 * displayName を生成（補完優先順）:
 *   ① raceName（クリーン）
 *   ② specialty-race-master.json （JV-Link 文字化け対策）
 *   ③ raceSubtitle（クリーン）
 *   ④ raceConditionName（条件戦名）
 *   ⑤ raceClass / raceCondition / title / name（互換）
 *   ⑥ fallback「{venue}{number}R」
 */
function buildDisplayName(race, venue, raceNumber) {
  const v = venue || '';
  const n = raceNumber;
  const fallback = `${v}${n}R`;

  if (isCleanRaceName(race.raceName, v, n)) {
    return String(race.raceName).trim();
  }
  const date = race.date ? String(race.date).trim() : '';
  const venueCode = venueToCode(v);
  if (date && venueCode && n != null) {
    const masterKey = `${date}-${venueCode}-${n}`;
    if (SPECIALTY_RACE_MASTER[masterKey]) return String(SPECIALTY_RACE_MASTER[masterKey]).trim();
  }
  if (isCleanRaceName(race.raceSubtitle, v, n)) return String(race.raceSubtitle).trim();
  if (isCleanRaceName(race.raceConditionName, v, n)) return String(race.raceConditionName).trim();
  for (const c of [race.raceClass, race.raceCondition, race.title, race.name]) {
    if (isCleanRaceName(c, v, n)) return String(c).trim();
  }
  return fallback;
}

// アラートメール送信URL（Netlify Function）
const ALERT_ENDPOINT = process.env.ALERT_ENDPOINT || 'https://keiba-intelligence.netlify.app/.netlify/functions/send-alert';
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

/**
 * アラートメール送信
 */
async function sendAlert(type, date, details = {}, metadata = {}) {
  // CI環境でのみアラート送信（ローカル実行時はスキップ）
  if (!IS_CI) {
    console.log(`⏭️  ローカル実行のためアラート送信をスキップ`);
    return;
  }

  try {
    console.log(`📧 アラートメール送信中: ${type} (${date || 'N/A'})`);

    const response = await fetch(ALERT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type,
        date,
        details,
        metadata
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`アラート送信失敗: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    console.log(`✅ アラートメール送信成功: ${result.type}`);
  } catch (error) {
    console.error(`⚠️  アラートメール送信エラー（処理は継続）: ${error.message}`);
    // アラート送信失敗しても処理は継続（メイン処理に影響を与えない）
  }
}

/**
 * keiba-data-sharedから結果データを取得
 * 統合ファイルがない場合は会場別ファイルをマージ
 */
export async function fetchSharedResults(date, venue = 'jra', client = sharedClient) {
  const [year, month] = date.split('-');
  const path = `${venue}/results/${year}/${month}/${date}.json`;

  console.log(`📡 keiba-data-sharedから取得中: ${path}`);

  // 統合ファイル（任意）: 404 は会場別マージへフォールバック。
  // 認証/権限/レート/サーバ/タイムアウト等は SharedFetchError として throw（fatal・匿名 fallback なし）。
  const unified = await client.fetchJson(path, { ref: SHARED_REF, required: false });
  if (unified) {
    console.log(`✅ 取得成功: ${path}`);
    return unified;
  }

  // 統合ファイルがない場合、会場別ファイルをマージ
  console.log(`   統合ファイルが見つかりません。会場別ファイルを検索します...`);
  return await fetchAndMergeVenueResults(date, year, month, client);
}

/**
 * 会場別結果ファイルを取得してマージ
 */
export async function fetchAndMergeVenueResults(date, year, month, client = sharedClient) {
  // keiba-data-shared の公式 venue-codes に合わせる (福島=FKS, 函館=HKD)
  const venueCodesJRA = ['TOK', 'KYO', 'HAN', 'NAK', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];

  const venues = [];
  let allRaces = [];

  for (const venueCode of venueCodesJRA) {
    const venuePath = `jra/results/${year}/${month}/${date}-${venueCode}.json`;

    // 会場別（任意）: 404 のみ未投入として skip。認証/権限/レート/5xx/timeout は throw（fatal 伝播）。
    // 旧実装の per-venue catch による silent skip を廃止し、取得失敗を握りつぶさない。
    const venueData = await client.fetchJson(venuePath, { ref: SHARED_REF, required: false });
    if (venueData === null) continue; // 404 = 未投入

    console.log(`   ✅ ${venueCode}: ${venueData.races?.length || 0}レース取得`);

    // 会場データを追加（各レースに venue を注入。auto-fetch由来のJSONはrace-levelにvenueが無い）
    if (venueData.races) {
      const venueName = venueData.venue || venueCode;
      for (const r of venueData.races) {
        if (!r.venue) r.venue = venueName;
        allRaces.push(r);
      }
      venues.push(venueName);
    }
  }

  if (allRaces.length === 0) {
    throw new Error(`結果データが見つかりません: ${date}（統合ファイル・会場別ファイルともに存在しない）`);
  }

  console.log(`✅ 会場別ファイルからマージ完了: ${allRaces.length}レース（${venues.join('・')}）`);

  // 統合フォーマットで返す
  return {
    date: date,
    venue: venues.join('・'),
    totalRaces: allRaces.length,
    races: allRaces,
    venues: venues
  };
}

/**
 * 予想データを読み込む（JRA版）
 */
function loadPrediction(date, venue) {
  // JRA版: predictions/jra/YYYY/MM/YYYY-MM-DD.json
  const [year, month] = date.split('-');
  const jraPath = join(projectRoot, 'src', 'data', 'predictions', 'jra', year, month, `${date}.json`);

  if (existsSync(jraPath)) {
    const content = readFileSync(jraPath, 'utf-8');
    return JSON.parse(content);
  }

  // 見つからない場合
  throw new Error(`予想データが見つかりません: ${jraPath} (会場: ${venue})`);
}

/**
 * 買い目の点数を計算（表示用 / 公開向け）
 *
 * 運用ルール:
 *   1レースあたり 8〜12点。お客向けに見せる点数はこの範囲で統一する。
 *   「抑え」は内部保険であり公開点数には含めない。
 *
 * 的中判定は 2026-07 仕様変更で「公開本線のみ」を対象とする (checkUmatanHit)。
 *   抑えは公開点数にも的中判定にも含めない（表示と実績の基準一致）。
 * ここで返す値は archive 表示・saveArchive 集計用のみ。
 */
function calculateBettingPoints(bettingLine) {
  // 買い目解析: 区切り文字は -（旧）/ ↔（双方向新）/ →（片方向新）の3パターンに対応
  // 例: "9-16.13.2.3.8.11(抑え12.4.5.6.14.15.10)" / "5↔9.11.6.8.4" / "4→8.4.7.5.3"
  const match = bettingLine.match(/^(\d+)[\-↔→](.+)$/);
  if (!match) return 0;

  const aitePart = match[2];

  // 本線相手馬のみ抽出 (抑え括弧は除外)
  const mainPart = aitePart.replace(/\(抑え.+\)/, '');
  const mainAite = mainPart.split('.').filter(n => n.match(/^\d+$/));
  return mainAite.length;
}

/**
 * 馬単の的中判定（公開本線のみ・2026-07 仕様）
 *
 * Premium でユーザーへ公開した「本線相手」だけを的中対象とする。
 * 括弧内の内部保険 (抑え…)／（抑え…） は判定対象外（公開買い目とアーカイブ実績の基準を一致させる）。
 * 投資額は従来どおり全レース5点固定・保存 bettingLines.umatan の形式は不変（抑え表記は記録として残置）。
 * 区切り記号 -（旧）/ ↔・⇔（双方向）/ →（片方向）、半角/全角括弧に対応。
 * 例: "9-16.13.2.3.8.11(抑え12.4.5.6.14.15.10)" → 本線 16.13.2.3.8.11 のみで判定 / "5↔9.11.6.8.4"
 */
export function checkUmatanHit(bettingLine, result) {
  const match = String(bettingLine).match(/^(\d+)([\-↔⇔→])(.+)$/);
  if (!match) return false;

  const axis = parseInt(match[1]);
  const separator = match[2];
  const aitePart = match[3];

  // 本線相手馬のみ抽出（(抑え…)／（抑え…）は判定対象外）
  const mainPart = aitePart.replace(/[(（]抑え[^)）]*[)）]/g, '');
  const mainAite = mainPart.split('.').map(n => parseInt(n)).filter(n => !isNaN(n));

  // 1着と2着を取得
  const first = result.results[0]?.number;
  const second = result.results[1]?.number;

  if (!first || !second) return false;

  // → はメインレースの一方向馬単（本命→相手のみ）。↔ / ⇔ / -（旧・通常レース）は双方向。
  const oneWay = separator === '→';

  // パターン1: 軸が1着、本線相手が2着（順目）
  if (axis === first && mainAite.includes(second)) {
    return true;
  }

  // パターン2: 本線相手が1着、軸が2着（裏目）。一方向（→）のときは的中としない。
  if (!oneWay && mainAite.includes(first) && axis === second) {
    return true;
  }

  return false;
}

/**
 * 的中判定メイン処理
 */
function verifyResults(prediction, results) {
  const raceResults = [];

  // 予想データの形式を判定（新形式 venues[] or 旧形式 predictions/races[]）
  let predictionRaces = [];
  if (prediction.venues && Array.isArray(prediction.venues)) {
    // 新形式: venues[].predictions[] を全て展開
    for (const venueData of prediction.venues) {
      if (venueData.predictions && Array.isArray(venueData.predictions)) {
        predictionRaces = predictionRaces.concat(venueData.predictions);
      }
    }
  } else {
    // 旧形式: predictions or races
    predictionRaces = prediction.predictions || prediction.races || [];
  }

  for (const race of results.races) {
    const raceNumber = race.raceNumber;
    const raceVenue = race.venue; // 会場情報を取得

    // raceNumberを数値に正規化（"1R" → 1, 1 → 1）
    const normalizedRaceNumber = typeof raceNumber === 'string'
      ? parseInt(raceNumber.replace(/[^0-9]/g, ''))
      : raceNumber;

    // 会場名を正規化（略称対応）
    const normalizeVenue = (v) => {
      if (!v) return '';
      // keiba-data-shared 公式 venue-codes に合わせる (福島=FKS, 函館=HKD)
      const venueMap = {
        '京都': 'KYO', 'KYO': 'KYO',
        '小倉': 'KOK', 'KOK': 'KOK',
        '東京': 'TOK', 'TOK': 'TOK',
        '中山': 'NAK', 'NAK': 'NAK',
        '阪神': 'HAN', 'HAN': 'HAN',
        '新潟': 'NII', 'NII': 'NII',
        '札幌': 'SAP', 'SAP': 'SAP',
        '函館': 'HKD', 'HKD': 'HKD',
        '福島': 'FKS', 'FKS': 'FKS',
        '中京': 'CHU', 'CHU': 'CHU'
      };
      return venueMap[v] || v;
    };

    const normalizedRaceVenue = normalizeVenue(raceVenue);

    // 予想データを検索（raceNumberとvenueの両方で一致）
    const predRace = predictionRaces.find(p => {
      const predRaceNum = p.raceInfo.raceNumber;
      const normalizedPredRaceNum = typeof predRaceNum === 'string'
        ? parseInt(predRaceNum.replace(/[^0-9]/g, ''))
        : predRaceNum;

      // raceNumberが一致しない場合はスキップ
      if (normalizedPredRaceNum !== normalizedRaceNumber) return false;

      // venueも一致するか確認
      const predVenue = p.raceInfo.venue || p.venue;
      const normalizedPredVenue = normalizeVenue(predVenue);

      return normalizedPredVenue === normalizedRaceVenue;
    });

    if (!predRace) {
      console.log(`⚠️  ${raceVenue} ${raceNumber}Rの予想データが見つかりません`);
      continue;
    }

    const bettingLines = predRace.bettingLines?.umatan || [];
    const hits = bettingLines.filter(line => checkUmatanHit(line, race));

    // 買い目点数を計算（全ラインの本線合計 / 最大12点に cap）
    // 運用ルール: お客向け表示は 1レースあたり最大12点
    const rawPoints = bettingLines.reduce((sum, line) => sum + calculateBettingPoints(line), 0);
    const totalPoints = Math.min(rawPoints, 12);

    const first = race.results[0];
    const second = race.results[1];
    const third = race.results[2];

    // 馬単払戻金を取得
    const umatanPayout = race.payouts?.umatan?.[0] || null;
    const payoutAmount = umatanPayout?.payout || null;
    const payoutCombination = umatanPayout?.combination || null;

    // displayName: 特別競走名 > master > raceSubtitle > raceConditionName > 「{venue}{number}R」
    const displayName = buildDisplayName(race, raceVenue, normalizedRaceNumber);
    // raceName: 文字化けなら displayName で置換
    let storedRaceName = race.raceName;
    if (isMojibakeName(storedRaceName)) storedRaceName = displayName;
    const raceConditionName = race.raceConditionName ? String(race.raceConditionName).trim() : null;

    raceResults.push({
      raceNumber,
      raceName: storedRaceName,
      displayName,
      raceConditionName,
      venue: raceVenue, // 会場情報を追加
      result: {
        first: { number: first.number, name: first.name },
        second: { number: second.number, name: second.name },
        third: { number: third.number, name: third.name }
      },
      bettingLines,
      bettingPoints: totalPoints,
      isHit: hits.length > 0,
      hitLines: hits,
      umatan: {
        combination: payoutCombination,
        payout: payoutAmount
      }
    });

    if (hits.length > 0) {
      const payoutInfo = payoutAmount ? ` (払戻: ${payoutAmount.toLocaleString()}円)` : '';
      console.log(`✅ ${raceVenue} ${raceNumber}R: 的中！ ${hits.join(', ')}${payoutInfo}`);
    } else {
      console.log(`❌ ${raceVenue} ${raceNumber}R: 不的中 (${first.number}-${second.number}-${third.number})`);
    }
  }

  return raceResults;
}

/**
 * archiveResultsJra.jsonに保存
 */
function saveArchive(date, venue, raceResults) {
  const archivePath = join(projectRoot, 'src', 'data', 'archiveResultsJra.json');

  let archive = [];
  if (existsSync(archivePath)) {
    const content = readFileSync(archivePath, 'utf-8');
    archive = JSON.parse(content);
  }

  // 統計計算
  const totalRaces = raceResults.length;
  const hitRaces = raceResults.filter(r => r.isHit).length;
  const hitRate = totalRaces > 0 ? (hitRaces / totalRaces * 100).toFixed(1) : '0.0';

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 投資額計算（全レース1レース5点固定・実レース数ベース）
  //   1レース5点 × 100円。投資額 = 実レース数 × 5 × 100（採用有無に不依存の定数）。
  //   例: 12レース → 60点・6,000円 / 36レース → 180点・18,000円。
  //   DP・目標回収率(165%等)・上限(200%等)は使用しない。
  //   買い目そのもの（双方向2段＋抑え表記）と保存形式は不変。投資点数は5点固定を維持する。
  //   的中判定は 2026-07 仕様で「公開本線のみ（抑え除外）」へ変更済み（checkUmatanHit）。
  //   （旧・4段階可変点数方式 6/8/10/12 は廃止）詳細: BET_POINT_LOGIC.md 参照
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const BET_POINTS_PER_RACE = 5;

  const totalPayout = raceResults.reduce((sum, race) => {
    if (race.isHit && race.umatan.payout) {
      // 的中した場合、払戻金を加算
      // 的中するのは1点（100円）のみ、payoutは100円あたりの払戻金
      return sum + race.umatan.payout;
    }
    return sum;
  }, 0);

  const betPointsPerRace = BET_POINTS_PER_RACE;
  const betAmount = totalRaces * betPointsPerRace * 100;
  const returnRate = betAmount > 0 ? (totalPayout / betAmount) * 100 : 0;

  console.log(`\n📊 投資点数(5点固定): ${totalRaces}R × ${betPointsPerRace}点 = ${betAmount.toLocaleString()}円 / 払戻 ${totalPayout.toLocaleString()}円 → 回収率 ${returnRate.toFixed(1)}%`);

  // 最終的な回収率（小数点1桁）
  const finalReturnRate = returnRate.toFixed(1);

  // 会場リストを取得（重複排除・ソート）
  const venues = [...new Set(raceResults.map(r => r.venue))].sort();
  const venueDisplay = venues.join('・');

  // race 単位にも betPoints / betType を埋め込む（archive UI が参照するため）。
  // 投資点数は全レース5点固定（表示買い目の実点数とは分離した回収率計算上の基準点数）。
  const enrichedRaces = raceResults.map(r => ({
    ...r,
    betType: r.betType || '馬単',
    betPoints: betPointsPerRace,
  }));

  const newEntry = {
    date,
    venue: venueDisplay, // "京都・小倉・東京" のように表示
    venues: venues, // 配列として保存
    totalRaces,
    hitRaces,
    missRaces: totalRaces - hitRaces,
    hitRate: parseFloat(hitRate),
    betAmount,
    betPointsPerRace, // 追加: 実際の買い目点数を記録
    totalBetPoints: totalRaces * betPointsPerRace,
    totalInvestment: betAmount,
    totalPayout,
    returnRate: parseFloat(finalReturnRate),
    recoveryRate: parseFloat(finalReturnRate), // 旧フィールド互換
    races: enrichedRaces,
    verifiedAt: new Date().toISOString()
  };

  // 既存エントリを削除（同じ日付があれば上書き）
  archive = archive.filter(entry => entry.date !== date);

  // 新しいエントリを追加し、日付降順でソート (表示側も同順に依存)
  archive.push(newEntry);
  archive.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 旧フォーマット混入チェック（再発防止）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const archiveJson = JSON.stringify(archive);
  const forbiddenKeys = ['raceResults', 'honmeiHit', 'umatanHit', 'sanrenpukuHit'];

  for (const key of forbiddenKeys) {
    if (archiveJson.includes(`"${key}"`)) {
      console.error(`\n❌ アーカイブフォーマットエラー検出！`);
      console.error(`   旧フォーマットキー「${key}」が混入しています`);
      console.error(`   archiveResultsJra.json を確認してください\n`);
      throw new Error(`旧フォーマット「${key}」が混入しています（再発防止チェック）`);
    }
  }

  // 保存
  writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf-8');
  console.log(`\n💾 アーカイブ保存完了: ${archivePath}`);
  console.log(`   日付: ${date}`);
  console.log(`   会場: ${venueDisplay}`);
  console.log(`   的中: ${hitRaces}/${totalRaces}R (${hitRate}%)`);
  console.log(`   買い目: ${betPointsPerRace}点/レース`);
  console.log(`   投資額: ${betAmount.toLocaleString()}円`);
  console.log(`   払戻額: ${totalPayout.toLocaleString()}円`);
  console.log(`   回収率: ${finalReturnRate}%`);
  console.log(`   ✅ フォーマット検証: 正常`);

  return newEntry;
}

/**
 * メイン処理
 */
async function main() {
  try {
    // private 化後に備え、開始直後に token を必須化（未設定なら匿名 fallback せず即 fatal）。
    resolveSharedToken();

    // 引数から日付を取得
    const args = process.argv.slice(2);
    const dateIndex = args.indexOf('--date');

    let date;
    if (dateIndex !== -1 && args[dateIndex + 1]) {
      date = args[dateIndex + 1];
      // 会場コード（-TOK, -KYO等）を自動除去
      date = date.replace(/-[A-Z]{3}$/, '');
    } else {
      // デフォルト: JST今日
      const now = new Date();
      const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      date = jstNow.toISOString().split('T')[0];
    }

    console.log(`📅 指定された日付: ${date}\n`);
    console.log(`━━━ ${date} 中央競馬 的中判定開始 ━━━\n`);

    // 1. 結果データ取得
    const results = await fetchSharedResults(date);
    const venue = results.venue || results.races[0]?.venue || '大井';

    // venue情報が取得できたか確認
    const venueSource = results.venue ? 'results.venue' : (results.races[0]?.venue ? 'races[0].venue' : 'デフォルト');
    const venueIsDefault = !results.venue && !results.races[0]?.venue;

    console.log(`\n✅ 結果データ取得完了`);
    console.log(`   会場: ${venue} (取得元: ${venueSource})`);
    console.log(`   レース数: ${results.races.length}`);

    // venue情報がデフォルト値の場合、警告
    if (venueIsDefault) {
      console.warn(`\n⚠️  警告：venue情報が取得できませんでした（デフォルト値「${venue}」を使用）`);
      console.warn(`   結果データ構造を確認してください`);
      console.warn(`   予想データ読み込みに失敗する可能性があります\n`);
    }

    // 2. 予想データ読み込み
    console.log(`\n📖 予想データ読み込み中...`);
    let prediction;
    try {
      prediction = loadPrediction(date, venue);
      console.log(`✅ 予想データ読み込み完了`);
    } catch (error) {
      // ローカルに予想データがなければスキップ（analytics-keibaでは正常）
      console.log(`⏭️  ローカル予想なし → スキップ: ${date} (venue: ${venue})`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`⏭️  処理完了: 予想データなし（スキップ）`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(0); // 正常終了
    }

    // 3. 的中判定
    console.log(`\n🎯 的中判定実行中...\n`);
    const raceResults = verifyResults(prediction, results);

    // 4. アーカイブ保存
    const archiveEntry = saveArchive(date, venue, raceResults);

    // 会場別統計を計算
    const venueStats = new Map();
    raceResults.forEach(race => {
      const v = race.venue;
      if (!venueStats.has(v)) {
        venueStats.set(v, { total: 0, hit: 0, payout: 0 });
      }
      const stat = venueStats.get(v);
      stat.total++;
      if (race.isHit) {
        stat.hit++;
        stat.payout += race.umatan.payout || 0;
      }
    });

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ 的中判定完了！`);
    console.log(`   会場: ${archiveEntry.venue}`);
    console.log(`   的中: ${archiveEntry.hitRaces}R / ${archiveEntry.totalRaces}R`);
    console.log(`   的中率: ${archiveEntry.hitRate}%`);
    console.log(`\n   【会場別実績】`);
    venueStats.forEach((stat, venueName) => {
      const hitRate = stat.total > 0 ? ((stat.hit / stat.total) * 100).toFixed(1) : '0.0';
      console.log(`   - ${venueName}: ${stat.hit}/${stat.total}R (${hitRate}%) 払戻: ${stat.payout.toLocaleString()}円`);
    });
    console.log(`\n   買い目: ${archiveEntry.betPointsPerRace}点/レース`);
    console.log(`   投資額: ${archiveEntry.betAmount.toLocaleString()}円`);
    console.log(`   払戻額: ${archiveEntry.totalPayout.toLocaleString()}円`);
    console.log(`   回収率: ${archiveEntry.returnRate}%`);
    const profit = archiveEntry.totalPayout - archiveEntry.betAmount;
    const profitSign = profit >= 0 ? '+' : '';
    console.log(`   損益: ${profitSign}${profit.toLocaleString()}円`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // 5. 異常値検知・アラート送信
    if (archiveEntry.hitRate === 0 && archiveEntry.totalRaces >= 10) {
      console.log(`⚠️  異常値検知：的中率0%`);
      await sendAlert('zero-hit-rate', date, {
        hitRate: archiveEntry.hitRate,
        hitRaces: archiveEntry.hitRaces,
        totalRaces: archiveEntry.totalRaces,
        betAmount: archiveEntry.betAmount,
        totalPayout: archiveEntry.totalPayout,
        returnRate: archiveEntry.returnRate
      }, {
        venue,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    // 一時失敗(rate limit/timeout/5xx)は exit 75 で deferred、それ以外は fail-closed。
    exitDeferredOrFatal(error, { label: LABEL });
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
