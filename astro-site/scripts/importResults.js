#!/usr/bin/env node

/**
 * 結果データ自動取り込み・的中判定スクリプト
 *
 * keiba-data-sharedから結果データを取得し、予想と照合して的中判定を行う
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';

import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw 廃止）。
// token 未設定は取得前に fatal（匿名 fallback 禁止）。private 化後も KEIBA_DATA_SHARED_TOKEN で読取可。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

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
 * 会場名正規化関数（南関版）
 */
function normalizeVenue(venue) {
  const venueMap = {
    '大井': 'OOI',
    '船橋': 'FUN',
    '川崎': 'KAW',
    '浦和': 'URA',
    'OOI': 'OOI',
    'FUN': 'FUN',
    'KAW': 'KAW',
    'URA': 'URA'
  };
  return venueMap[venue] || venue;
}

/**
 * keiba-data-sharedから結果データを取得
 * 統合ファイルがない場合は会場別ファイルをマージ
 */
export async function fetchSharedResults(date, venue = 'nankan', client = sharedClient) {
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
 * 会場別結果ファイルを取得してマージ（南関版）
 */
export async function fetchAndMergeVenueResults(date, year, month, client = sharedClient) {
  const venueCodes = ['OOI', 'FUN', 'KAW', 'URA']; // 大井・船橋・川崎・浦和

  const venues = [];
  let allRaces = [];

  for (const venueCode of venueCodes) {
    const venuePath = `nankan/results/${year}/${month}/${date}-${venueCode}.json`;

    // 会場別（任意）: 404 のみ未投入として skip。認証/権限/レート/5xx/timeout は throw（fatal 伝播）。
    // 旧実装の per-venue catch による silent skip を廃止し、取得失敗を握りつぶさない。
    const venueData = await client.fetchJson(venuePath, { ref: SHARED_REF, required: false });
    if (venueData === null) continue; // 404 = 未投入

    console.log(`   ✅ ${venueCode}: ${venueData.races?.length || 0}レース取得`);

    // 会場データを追加
    if (venueData.races) {
      allRaces = allRaces.concat(venueData.races);
      venues.push(venueData.venue || venueCode);
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
 * 予想データを読み込む（複数会場対応）
 */
function loadPrediction(date, venue) {
  const venueMap = {
    '大井': 'ooi',
    '船橋': 'funabashi',
    '川崎': 'kawasaki',
    '浦和': 'urawa'
  };
  const venueSlug = venueMap[venue] || 'ooi';

  // 優先順位1: 会場別ファイル（新形式）: predictions/2026-03-09-ooi.json
  const venueSpecificFileName = `${date}-${venueSlug}.json`;
  const venueSpecificPath = join(projectRoot, 'src', 'data', 'predictions', venueSpecificFileName);

  // 優先順位2: 古い形式（月別ディレクトリ）: predictions/2026/02/2026-02-04.json
  const [year, month] = date.split('-');
  const oldFormatPath = join(projectRoot, 'src', 'data', 'predictions', year, month, `${date}.json`);

  // 会場別ファイルから試す
  if (existsSync(venueSpecificPath)) {
    const content = readFileSync(venueSpecificPath, 'utf-8');
    return JSON.parse(content);
  }

  // 古い形式を試す
  if (existsSync(oldFormatPath)) {
    const content = readFileSync(oldFormatPath, 'utf-8');
    return JSON.parse(content);
  }

  // どちらも見つからない場合
  throw new Error(`予想データが見つかりません: ${venueSpecificPath} または ${oldFormatPath} (会場: ${venue})`);
}

/**
 * 馬単の的中判定
 */
function checkUmatanHit(bettingLine, result) {
  // 買い目解析: 区切り文字は -（旧）/ ↔（双方向新）/ →（片方向新）の3パターンに対応
  // 例: "4-1.11.2.5.7.9(抑え10.8.6)" / "5↔9.11.6.8.4" / "4→8.4.7.5.3"
  const match = bettingLine.match(/^(\d+)[\-↔→](.+)$/);
  if (!match) return false;

  const axis = parseInt(match[1]);
  const aitePart = match[2];

  // 本線相手馬を抽出
  const mainPart = aitePart.replace(/\(抑え.+\)/, '');
  const mainAite = mainPart.split('.').map(n => parseInt(n)).filter(n => !isNaN(n));

  // 抑え馬を抽出
  let osaeAite = [];
  const osaeMatch = aitePart.match(/\(抑え([0-9.]+)\)/);
  if (osaeMatch) {
    osaeAite = osaeMatch[1].split('.').map(n => parseInt(n)).filter(n => !isNaN(n));
  }

  // 全相手馬（本線+抑え）
  const allAite = [...mainAite, ...osaeAite];

  // 1着と2着を取得
  const first = result.results[0]?.number;
  const second = result.results[1]?.number;

  if (!first || !second) return false;

  // 馬単判定（2パターン）
  // パターン1: 軸が1着、相手が2着
  if (axis === first && allAite.includes(second)) {
    return true;
  }

  // パターン2: 相手が1着、軸が2着
  if (allAite.includes(first) && axis === second) {
    return true;
  }

  return false;
}

/**
 * 的中判定メイン処理（複数会場対応）
 */
function verifyResults(prediction, results) {
  const raceResults = [];

  // 予想データの形式を判定（新形式 or 旧形式）
  const predictionRaces = prediction.predictions || prediction.races || [];

  for (const race of results.races) {
    const raceNumber = race.raceNumber;
    const raceVenue = race.venue; // 結果データの会場

    // raceNumberを数値に正規化（"1R" → 1, 1 → 1）
    const normalizedRaceNumber = typeof raceNumber === 'string'
      ? parseInt(raceNumber.replace(/[^0-9]/g, ''))
      : raceNumber;

    // 【複数会場対応】予想データを検索（raceNumber + venue で一致判定）
    const predRace = predictionRaces.find(p => {
      const predRaceNum = p.raceInfo.raceNumber;
      const normalizedPredRaceNum = typeof predRaceNum === 'string'
        ? parseInt(predRaceNum.replace(/[^0-9]/g, ''))
        : predRaceNum;

      // raceNumberが一致しない場合はfalse
      if (normalizedPredRaceNum !== normalizedRaceNumber) {
        return false;
      }

      // 【重要】会場情報がある場合は会場も一致確認
      if (raceVenue && p.raceInfo.venue) {
        const predVenue = normalizeVenue(p.raceInfo.venue);
        const resVenue = normalizeVenue(raceVenue);
        return predVenue === resVenue;
      }

      // 会場情報がない場合はraceNumberのみで判定（後方互換性）
      return true;
    });

    if (!predRace) {
      console.log(`⚠️  ${raceNumber}R (${raceVenue || '会場不明'}) の予想データが見つかりません`);
      continue;
    }

    const bettingLines = predRace.bettingLines?.umatan || [];
    const hits = bettingLines.filter(line => checkUmatanHit(line, race));

    const first = race.results[0];
    const second = race.results[1];
    const third = race.results[2];

    // 馬単払戻金を取得
    const umatanPayout = race.payouts?.umatan?.[0] || null;
    const payoutAmount = umatanPayout?.payout || null;
    const payoutCombination = umatanPayout?.combination || null;

    raceResults.push({
      raceNumber,
      raceName: predRace.raceInfo?.raceName || race.raceName || '',
      venue: race.venue || predRace.raceInfo?.venue || '', // 会場情報追加
      result: {
        first: { number: first.number, name: first.name },
        second: { number: second.number, name: second.name },
        third: { number: third.number, name: third.name }
      },
      bettingLines,
      isHit: hits.length > 0,
      hitLines: hits,
      umatan: {
        combination: payoutCombination,
        payout: payoutAmount
      }
    });

    if (hits.length > 0) {
      const payoutInfo = payoutAmount ? ` (払戻: ${payoutAmount.toLocaleString()}円)` : '';
      console.log(`✅ ${raceNumber}R: 的中！ ${hits.join(', ')}${payoutInfo}`);
    } else {
      console.log(`❌ ${raceNumber}R: 不的中 (${first.number}-${second.number}-${third.number})`);
    }
  }

  return raceResults;
}

/**
 * archiveResults.jsonに保存（複数会場対応）
 */
function saveArchive(date, venue, raceResults, venues = []) {
  const archivePath = join(projectRoot, 'src', 'data', 'archiveResults.json');

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
  //   DP・目標回収率(165%等)・上限(200%等)は使用しない。的中候補は全件を公開実績へ算入する。
  //   買い目そのもの（双方向2段＋抑え）と的中判定は変更せず、投資点数のみ5点固定へ統一する。
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

  // race 単位にも betPoints / betType を埋め込む（archive UI が参照するため）。
  // 投資点数は全レース5点固定（表示買い目の実点数とは分離した回収率計算上の基準点数）。
  const enrichedRaces = raceResults.map(r => ({
    ...r,
    betType: r.betType || '馬単',
    betPoints: betPointsPerRace,
  }));

  const newEntry = {
    date,
    venue,
    venues: venues.length > 0 ? venues : undefined, // 複数会場の場合のみvenuesを追加
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

  // 新しいエントリを追加
  archive.unshift(newEntry);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 旧フォーマット混入チェック（再発防止）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const archiveJson = JSON.stringify(archive);
  const forbiddenKeys = ['raceResults', 'honmeiHit', 'umatanHit', 'sanrenpukuHit'];

  for (const key of forbiddenKeys) {
    if (archiveJson.includes(`"${key}"`)) {
      console.error(`\n❌ アーカイブフォーマットエラー検出！`);
      console.error(`   旧フォーマットキー「${key}」が混入しています`);
      console.error(`   archiveResults.json を確認してください\n`);
      throw new Error(`旧フォーマット「${key}」が混入しています（再発防止チェック）`);
    }
  }

  // 保存
  writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf-8');
  console.log(`\n💾 アーカイブ保存完了: ${archivePath}`);
  console.log(`   日付: ${date}`);
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
    } else {
      // デフォルト: JST今日
      const now = new Date();
      const jstNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      date = jstNow.toISOString().split('T')[0];
    }

    console.log(`📅 指定された日付: ${date}\n`);
    console.log(`━━━ ${date} 的中判定開始 ━━━\n`);

    // 1. 結果データ取得
    const results = await fetchSharedResults(date);
    const venue = results.venue || results.races[0]?.venue || '大井';
    const venues = results.venues || []; // 複数会場の場合

    // venue情報が取得できたか確認
    const venueSource = results.venue ? 'results.venue' : (results.races[0]?.venue ? 'races[0].venue' : 'デフォルト');
    const venueIsDefault = !results.venue && !results.races[0]?.venue;

    console.log(`\n✅ 結果データ取得完了`);
    console.log(`   会場: ${venue} (取得元: ${venueSource})`);
    if (venues.length > 0) {
      console.log(`   複数会場: ${venues.join('・')}`);
    }
    console.log(`   レース数: ${results.races.length}`);

    // venue情報がデフォルト値の場合、警告
    if (venueIsDefault) {
      console.warn(`\n⚠️  警告：venue情報が取得できませんでした（デフォルト値「${venue}」を使用）`);
      console.warn(`   結果データ構造を確認してください`);
      console.warn(`   予想データ読み込みに失敗する可能性があります\n`);
    }

    // 2. 【複数会場対応】予想データ読み込み
    console.log(`\n📖 予想データ読み込み中...`);
    let allPredictions = [];
    let loadErrors = [];

    // venues配列がある場合は各会場の予想データを読み込み
    if (venues.length > 0) {
      for (const venueName of venues) {
        try {
          const prediction = loadPrediction(date, venueName);
          allPredictions.push(prediction);
          console.log(`   ✅ ${venueName} 予想データ読み込み完了`);
        } catch (err) {
          loadErrors.push({ venue: venueName, error: err.message });
          console.log(`   ⚠️  ${venueName} 予想データが見つかりません`);
        }
      }
    } else {
      // 単一会場の場合（従来の処理）
      try {
        const prediction = loadPrediction(date, venue);
        allPredictions.push(prediction);
        console.log(`✅ 予想データ読み込み完了`);
      } catch (err) {
        loadErrors.push({ venue, error: err.message });
      }
    }

    // 予想データが1つも見つからない場合の処理
    if (allPredictions.length === 0) {
      const error = loadErrors[0];
      // 予想データがない場合、keiba-data-sharedに本当に存在しないか二重確認
      console.log(`⏭️  予想データが見つかりません: ${date}`);
      console.log(`   検索対象会場: ${loadErrors.map(e => e.venue).join(', ')}`);

      // 【複数会場対応】各会場の予想データが存在するか確認
      const [year, month] = date.split('-');
      const checkResults = [];

      for (const { venue: venueName, error: errMsg } of loadErrors) {
        const venueMap = { '大井': 'OOI', '船橋': 'FUN', '川崎': 'KAW', '浦和': 'URA' };
        const venueCode = venueMap[venueName] || venueName;
        const sharedPredictionPath = `nankan/predictions/${year}/${month}/${date}-${venueCode}.json`;

        try {
          console.log(`\n🔍 keiba-data-sharedの予想データ存在確認中（${venueName}）...`);
          // 認証付き Contents API（匿名 raw 廃止）。404=未存在、非null=存在。
          const predData = await sharedClient.fetchJson(sharedPredictionPath, { ref: SHARED_REF, required: false });

          if (predData !== null) {
            checkResults.push({ venue: venueName, exists: true });
            console.error(`   🚨 ${venueName}: 予想データが存在するのに読み込めませんでした！`);
          } else {
            checkResults.push({ venue: venueName, exists: false });
            console.log(`   ⏭️  ${venueName}: 予想データなし（SEO対策用の結果データのみ）`);
          }
        } catch (checkError) {
          // 診断目的の best-effort 確認。code のみログ（token・body は出さない）。
          checkResults.push({ venue: venueName, exists: null });
          console.warn(`   ⚠️  ${venueName}: 存在確認失敗（${checkError?.code || 'error'}）`);
        }
      }

      // いずれかの会場で予想データが存在する場合は異常
      const existingVenues = checkResults.filter(r => r.exists === true);
      if (existingVenues.length > 0) {
        console.error(`\n🚨 異常検知：予想データが存在するのに読み込めませんでした！`);
        console.error(`   会場: ${existingVenues.map(v => v.venue).join(', ')}`);
        console.error(`   エラー: ${loadErrors.map(e => e.error).join(', ')}\n`);

        // アラート送信
        await sendAlert('import-results-failure', date, {
          venues: existingVenues.map(v => v.venue),
          errors: loadErrors
        }, {
          timestamp: new Date().toISOString(),
          critical: true
        });

        // エラーとして終了（修正が必要）
        process.exit(1);
      }

      // すべての会場で予想データが存在しない場合は正常終了
      console.log(`   keiba-data-sharedにはSEO対策用の結果データのみ保存されています`);
      console.log(`   keiba-intelligenceでは的中判定をスキップします\n`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`⏭️  処理完了: 予想データなし（スキップ）`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(0); // 正常終了
    }

    // 3. 【複数会場対応】的中判定
    console.log(`\n🎯 的中判定実行中...`);
    console.log(`   予想データ: ${allPredictions.length}会場`);
    console.log(`   結果データ: ${results.races.length}レース\n`);

    // すべての予想データを統合
    const mergedPrediction = {
      predictions: allPredictions.flatMap(p => p.predictions || [])
    };

    const raceResults = verifyResults(mergedPrediction, results);

    // 4. アーカイブ保存
    const archiveEntry = saveArchive(date, venue, raceResults, venues);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ 的中判定完了！`);
    console.log(`   的中: ${archiveEntry.hitRaces}R / ${archiveEntry.totalRaces}R`);
    console.log(`   的中率: ${archiveEntry.hitRate}%`);
    console.log(`   買い目: ${archiveEntry.betPointsPerRace}点/レース`);
    console.log(`   投資額: ${archiveEntry.betAmount.toLocaleString()}円`);
    console.log(`   払戻額: ${archiveEntry.totalPayout.toLocaleString()}円`);
    console.log(`   回収率: ${archiveEntry.returnRate}%`);
    const profit = archiveEntry.totalPayout - archiveEntry.betAmount;
    const profitSign = profit >= 0 ? '+' : '';
    console.log(`   損益: ${profitSign}${profit.toLocaleString()}円`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // 5. 成功通知（無効化済み - エラー通知のみ維持）
    // 成功時のメール通知は不要のため削除（2026-03-24）

    // 6. 異常値検知・アラート送信
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

    // 7. Post-check: archiveResults.jsonに対象日が追加されたことを検証
    console.log(`\n🔍 Post-check: archiveResults.jsonを検証中...`);
    const archivePath = join(projectRoot, 'src', 'data', 'archiveResults.json');
    const archiveContent = readFileSync(archivePath, 'utf-8');
    const archive = JSON.parse(archiveContent);

    const foundEntry = archive.find(entry => entry.date === date);

    if (!foundEntry) {
      console.error(`\n❌ Post-check失敗: archiveResults.jsonに${date}が追加されていません！`);
      console.error(`   処理は完了したはずですが、何らかの理由でアーカイブに反映されていません。`);
      console.error(`   これは重大なエラーです。手動で確認してください。`);

      // CI環境の場合はアラート送信
      if (process.env.CI === 'true') {
        await sendAlert('archive-post-check-failed', date, {
          message: `${date}の処理は完了したがarchiveResults.jsonに追加されていない`,
          expectedDate: date,
          archiveLatestDate: archive[0]?.date || 'N/A'
        }, {
          venue,
          timestamp: new Date().toISOString(),
          critical: true
        });
      }

      process.exit(1);
    }

    console.log(`✅ Post-check成功: ${date}がarchiveResults.jsonに正常に追加されています`);
    console.log(`   的中率: ${foundEntry.hitRate}%`);
    console.log(`   回収率: ${foundEntry.returnRate}%`);

  } catch (error) {
    console.error(`\n❌ エラーが発生しました: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
