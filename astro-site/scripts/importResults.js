#!/usr/bin/env node

/**
 * 結果データ自動取り込み・的中判定スクリプト
 *
 * keiba-data-sharedから結果データを取得し、予想と照合して的中判定を行う
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
async function fetchSharedResults(date, venue = 'nankan') {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const [year, month] = date.split('-');
  const owner = 'apol0510';
  const repo = 'keiba-data-shared';
  const path = `${venue}/results/${year}/${month}/${date}.json`;

  console.log(`📡 keiba-data-sharedから取得中: ${path}`);

  // まず統合ファイルを試す
  try {
    // ローカル実行時（GITHUB_TOKENなし）: raw.githubusercontent.comを使用（公開リポジトリ）
    if (!GITHUB_TOKEN) {
      console.log(`   ローカル実行モード: raw.githubusercontent.comからダウンロード`);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
      const response = await fetch(rawUrl);

      if (response.ok) {
        const content = await response.text();
        const results = JSON.parse(content);
        console.log(`✅ 取得成功: ${path}`);
        return results;
      }
      // 404の場合は会場別ファイルにフォールバック
      if (response.status !== 404) {
        throw new Error(`結果データの取得に失敗: ${response.status} ${response.statusText}`);
      }
    } else {
      // GitHub Actions実行時: GitHub API経由（レート制限回避）
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        console.log(`✅ 取得成功: ${path}`);
        return JSON.parse(content);
      }
      // 404の場合は会場別ファイルにフォールバック
      if (response.status !== 404) {
        throw new Error(`結果データの取得に失敗: ${response.status} ${response.statusText}`);
      }
    }

    // 統合ファイルがない場合、会場別ファイルをマージ
    console.log(`   統合ファイルが見つかりません。会場別ファイルを検索します...`);
    return await fetchAndMergeVenueResults(date, year, month, GITHUB_TOKEN);

  } catch (error) {
    // ネットワークエラー等
    throw error;
  }
}

/**
 * 会場別結果ファイルを取得してマージ（南関版）
 */
async function fetchAndMergeVenueResults(date, year, month, GITHUB_TOKEN) {
  const owner = 'apol0510';
  const repo = 'keiba-data-shared';
  const venueCodes = ['OOI', 'FUN', 'KAW', 'URA']; // 大井・船橋・川崎・浦和

  const venues = [];
  let allRaces = [];

  for (const venueCode of venueCodes) {
    const venueFile = `${date}-${venueCode}.json`;
    const venuePath = `nankan/results/${year}/${month}/${venueFile}`;

    try {
      let venueData;

      if (!GITHUB_TOKEN) {
        // ローカル実行時
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${venuePath}`;
        const response = await fetch(rawUrl);
        if (!response.ok) continue; // 404ならスキップ
        venueData = JSON.parse(await response.text());
      } else {
        // GitHub Actions実行時
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${venuePath}`;
        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        if (!response.ok) continue; // 404ならスキップ
        const data = await response.json();
        venueData = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
      }

      console.log(`   ✅ ${venueCode}: ${venueData.races?.length || 0}レース取得`);

      // 会場データを追加
      if (venueData.races) {
        allRaces = allRaces.concat(venueData.races);
        venues.push(venueData.venue || venueCode);
      }

    } catch (err) {
      // エラーは無視して次の会場へ
      continue;
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
  // 買い目解析: "4-1.11.2.5.7.9(抑え10.8.6)"
  const match = bettingLine.match(/^(\d+)-(.+)$/);
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
  // 払戻金計算（回収率ベースの3段階可変点数方式）
  //   仮回収率 >=200% → 1レース 12点
  //   仮回収率 >=100% → 1レース 10点
  //   仮回収率 <100%  → 1レース 8点
  // 判定は「8点で仮計算した回収率」を基準に行う。
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const totalPayout = raceResults.reduce((sum, race) => {
    if (race.isHit && race.umatan.payout) {
      // 的中した場合、払戻金を加算
      // 的中するのは1点（100円）のみ、payoutは100円あたりの払戻金
      return sum + race.umatan.payout;
    }
    return sum;
  }, 0);

  // 仮計算（8点基準）で回収率を判定
  const provisionalBetAmount = totalRaces * 8 * 100;
  const provisionalRate = provisionalBetAmount > 0
    ? (totalPayout / provisionalBetAmount) * 100
    : 0;

  // 3段階: >=200% → 12, >=100% → 10, <100% → 8
  const betPointsPerRace = provisionalRate >= 200 ? 12 : (provisionalRate >= 100 ? 10 : 8);
  const betAmount = totalRaces * betPointsPerRace * 100;
  const returnRate = betAmount > 0 ? (totalPayout / betAmount) * 100 : 0;

  console.log(`\n📊 買い目点数判定: 仮回収率 ${provisionalRate.toFixed(1)}% → ${betPointsPerRace}点/レース (最終回収率 ${returnRate.toFixed(1)}%)`);

  // 最終的な回収率（小数点1桁）
  const finalReturnRate = returnRate.toFixed(1);

  // race 単位にも同じ betPoints / betType を埋め込む（archive UI が参照するため）
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
        const checkUrl = `https://raw.githubusercontent.com/apol0510/keiba-data-shared/main/${sharedPredictionPath}`;

        try {
          console.log(`\n🔍 keiba-data-sharedの予想データ存在確認中（${venueName}）...`);
          const checkResponse = await fetch(checkUrl);

          if (checkResponse.ok) {
            checkResults.push({ venue: venueName, exists: true });
            console.error(`   🚨 ${venueName}: 予想データが存在するのに読み込めませんでした！`);
          } else {
            checkResults.push({ venue: venueName, exists: false });
            console.log(`   ⏭️  ${venueName}: 予想データなし（SEO対策用の結果データのみ）`);
          }
        } catch (checkError) {
          checkResults.push({ venue: venueName, exists: null });
          console.warn(`   ⚠️  ${venueName}: 存在確認失敗（ネットワークエラー？）`);
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

main();
