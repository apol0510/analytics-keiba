#!/usr/bin/env node

/**
 * importPredictionJra.js
 *
 * keiba-data-sharedから中央競馬の予想JSONを取得して、
 * normalizeAndAdjustして、keiba-intelligenceに保存する
 *
 * 使い方:
 *   node scripts/importPredictionJra.js --date 2026-02-08
 *   node scripts/importPredictionJra.js  # 今日の日付を使用
 *
 * 環境変数:
 *   KEIBA_DATA_SHARED_TOKEN: keiba-data-shared 読取用トークン（必須・匿名 fallback 禁止）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';

import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw 廃止）。
// token 未設定は取得前に fatal（匿名 fallback 禁止）。private 化後も KEIBA_DATA_SHARED_TOKEN で読取可。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

// ESモジュールで __dirname を取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// プロジェクトルート
const projectRoot = join(__dirname, '..');

// src/utils から正規化関数をインポート
import { normalizeAndAdjust, isHorseNameBroken } from '../src/utils/normalizePrediction.js';
// 2026-06-19: computer→racebook の真コンピ指数注入を race-scoped 馬番主キーで行う共通 helper
import { buildRaceScopedComputerMap, injectSourceComputerIndexRaceScoped, assertInjectionSafe } from './lib/computerIndexMatch.mjs';

// メインレース10点ロジック + 通常レース本命軸双方向1行ロジック（共通モジュール）
// 🔧 2026-05-18: 通常レース買い目を CLAUDE.md 仕様の generateRaceUmatanLines（双方向 ↔ 1行）に統一。
//   5/12 commit で wide-partner 方式（KI と同等の "-" 形式）に直接書き換えていたが、KI と
//   完全一致してしまい AK 独自サービスとしての差別化が失われていたため、共通モジュール経由に戻した。
import { isMainRace, generateRaceUmatanLines } from '../src/utils/mainRaceBetting.js';

// データ検証関数をインポート
import { validateJRAPrediction } from './utils/validatePrediction.js';

/**
 * JST（日本時間）の今日の日付を取得
 *
 * @returns {string} YYYY-MM-DD形式の日付
 */
function getTodayJST() {
  const now = new Date();
  const jstOffset = 9 * 60; // JST = UTC+9
  const jstTime = new Date(now.getTime() + jstOffset * 60 * 1000);

  const year = jstTime.getUTCFullYear();
  const month = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstTime.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * keiba-data-sharedから予想JSONを取得
 *
 * GitHub Contents APIを使用（private対応）
 *
 * @param {string} date - 日付（YYYY-MM-DD）
 * @param {string} venue - 競馬場カテゴリ（デフォルト: 'jra'）
 * @returns {Promise<Object>} 予想JSON
 */
export async function fetchSharedPrediction(date, venue = 'jra', client = sharedClient) {
  // 日付をパースしてパスを構築
  const [year, month, day] = date.split('-');
  const path = `${venue}/predictions/${year}/${month}/${date}.json`;

  console.log(`📡 keiba-data-sharedから取得中: ${path}`);

  // 統合ファイル（任意）: 404 は未投入として null（正常終了）。
  // 認証/権限/レート/サーバ/タイムアウトは SharedFetchError として throw（fatal・匿名 fallback なし）。
  const prediction = await client.fetchJson(path, { ref: SHARED_REF, required: false });
  if (prediction === null) {
    // 予想データがない場合は正常終了（エラーではない）
    console.log(`⏭️  予想データが見つかりません: ${path}`);
    console.log(`   まだ予想が作成されていない可能性があります`);
    return null; // nullを返す
  }

  console.log(`✅ 取得成功: ${path}`);
  return prediction;
}

/**
 * 同日の computer JSON 群から sourceComputerIndex の lookup map を構築する（JRA 用）。
 *
 * 返り値: Map<会場名, Map<"馬番|馬名", computerIndex>>
 * 突合キーは「会場名 → (馬番, 馬名) 完全一致」。
 */
export async function buildSourceComputerIndexMap(date, category = 'jra', client = sharedClient) {
  const [year, month] = date.split('-');
  const dirPath = `${category}/predictions/computer/${year}/${month}`;

  console.log(`📡 [IMPORT-JRA] computer JSON 併読み: ${dirPath}`);

  // ディレクトリ未投入の 404 のみ skip。認証/権限/レート/5xx/timeout は throw（fatal）。
  const files = await client.listDirectory(dirPath, { ref: SHARED_REF, required: false });
  if (files === null) {
    console.log(`⏭️  [IMPORT-JRA] computer ディレクトリなし: ${dirPath}`);
    return null;
  }

  const dateFiles = files.filter(f => f.name.startsWith(`${date}-`) && f.name.endsWith('.json'));
  if (dateFiles.length === 0) {
    console.log(`⏭️  [IMPORT-JRA] ${date} の computer ファイルなし`);
    return null;
  }

  // computer 各会場データを race-scoped 形へ整形して収集（過去走はフィールド名統一）。
  const venuesForMap = [];
  for (const file of dateFiles) {
    // 一覧済みファイルは required:true＝取得失敗は fatal
    const venueData = await client.fetchJson(file.path, { ref: SHARED_REF });
    const venueName = venueData.venue || venueData.name || null;
    if (!venueName) continue;
    let horseCount = 0;
    let pastRacesCount = 0;
    const races = (venueData.races || []).map(race => ({
      raceNumber: race.raceNumber ?? race.raceInfo?.raceNumber,
      horses: (race.horses || []).map(h => {
        horseCount++;
        // 過去走（pastRaces）も同時保持。computer JSON のフィールド名で正規化して保存。
        // free/premium 表示側は recentRaces として参照するため、ここでフィールド名統一する。
        const recentRaces = Array.isArray(h.pastRaces)
          ? h.pastRaces.slice(0, 5).map(pr => ({
              venue: pr.venue || '',
              distance: pr.distance || pr.distanceMeters || '',
              rank: (pr.finish != null && Number.isFinite(Number(pr.finish))) ? Number(pr.finish) : null,
              time: pr.time || '',
              last3f: pr.final3F || pr.last3f || '',
              bodyWeight: pr.bodyWeight || null,
              jockey: pr.jockey || '',
              passingOrder: pr.passingOrder || ''
            }))
          : [];
        if (recentRaces.length > 0) pastRacesCount++;
        return { number: h.number ?? h.horseNumber, name: h.name ?? h.horseName, computerIndex: h.computerIndex, recentRaces };
      })
    }));
    if (horseCount > 0) {
      venuesForMap.push({ venue: venueName, races });
      console.log(`   📋 [IMPORT-JRA] ${venueName}: ${horseCount} 頭の computer データを取得 (うち過去走あり: ${pastRacesCount})`);
    }
  }
  if (venuesForMap.length === 0) return null;
  // race-scoped (venue, raceNumber, horseNumber) 主キーの lookup を構築
  return buildRaceScopedComputerMap(venuesForMap);
}

/**
 * sharedJSON (racebook 本体) に sourceComputerIndex / recentRaces / 破損名復元を注入する。
 * 突合は (会場, レース番号, 馬番) を主キー、馬番欠損時のみ正規化馬名フォールバック。
 * 馬名完全一致には依存しない（2026-06-19 不要馬誤判定バグ対策）。詳細は computerIndexMatch.mjs。
 */
function injectSourceComputerIndex(sharedJSON, venueMap) {
  const stats = injectSourceComputerIndexRaceScoped(sharedJSON, venueMap, {
    isNameBroken: isHorseNameBroken,
    onWarn: (msg) => console.warn(`⚠️ ${msg}`),
  });
  console.log(
    `✅ [IMPORT-JRA] computer データ注入: sourceComputerIndex ${stats.injected} 頭 / recentRaces ${stats.recentInjected} 頭 ` +
    `/ 破損名復元 ${stats.nameRecovered} 頭 / 名前フォールバック ${stats.matchedByName} 頭 ` +
    `(突合失敗 ${stats.unmatched} / 馬番重複 ${stats.ambiguous} / 名前乖離 ${stats.nameMismatch} / 未対応ci≥45 ${stats.uncoveredHighCi.length})`
  );
  return stats;
}

/**
 * keiba-data-sharedからracebook JSONを取得（JRA用）
 */
export async function fetchRacebookData(date, category = 'jra', client = sharedClient) {
  const [year, month] = date.split('-');
  const dirPath = `${category}/racebook/${year}/${month}`;

  console.log(`📡 [RACEBOOK] racebookデータ取得中: ${dirPath}`);

  // ディレクトリ未投入の 404 のみ skip。認証/権限/レート/5xx/timeout は throw（fatal）。
  const files = await client.listDirectory(dirPath, { ref: SHARED_REF, required: false });
  if (files === null) {
    console.log(`⏭️  [RACEBOOK] ディレクトリなし: ${dirPath}`);
    return null;
  }

  // 2026-05-15 追加: JRA の同一開催（5/16 土）に対し、TOK/NII の racebook ファイル名は
  // 2026-05-15-*.json として保存される運用がある（データ供給側仕様）。
  // 指定日 ±1 日のファイルを全件取得し、ファイル中身の `date` または venue 重複で正しくマージする。
  const toMs = (d) => new Date(d + 'T00:00:00Z').getTime();
  const targetMs = toMs(date);
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const dateFiles = files.filter(f => {
    if (!f.name.endsWith('.json')) return false;
    const m = f.name.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (!m) return false;
    const fileMs = toMs(m[1]);
    const diff = Math.abs(targetMs - fileMs);
    return diff <= ONE_DAY; // 指定日 or 前後1日まで
  });

  if (dateFiles.length === 0) {
    console.log(`⏭️  [RACEBOOK] ${date}±1日のracebookファイルなし`);
    return null;
  }

  const venues = [];
  const seenVenues = new Set();
  // 指定日と完全一致するファイルを優先するためソート（差0 → 差1日の順）
  dateFiles.sort((a, b) => {
    const da = Math.abs(targetMs - toMs(a.name.match(/^(\d{4}-\d{2}-\d{2})-/)[1]));
    const db = Math.abs(targetMs - toMs(b.name.match(/^(\d{4}-\d{2}-\d{2})-/)[1]));
    return da - db;
  });
  for (const file of dateFiles) {
    // 一覧済みファイルは required:true＝取得失敗は fatal（握りつぶさない）
    const rbData = await client.fetchJson(file.path, { ref: SHARED_REF });
    // 【中身 date 検証ガード】(2026-05-23 追加)
    // admin 側のペア揃いガード（keiba-data-shared-admin#1）を補完する追加防御。
    // ±1日マージで拾ったファイルでも、ファイル中身の date が指定日と一致するものだけ採用する。
    // 2026-05-24 案件: 24-NII / 24-TOK が未投入の状態で 23-NII / 23-TOK が ±1日マージで
    // 拾われ、中身 date=2026-05-23 のまま24日 prediction に混入していた。
    // 中身に date フィールドが無い古いファイルは後方互換のため通す。
    if (rbData.date && rbData.date !== date) {
      console.log(`   ⏭️  [RACEBOOK-GUARD] ${file.name} スキップ（中身 date=${rbData.date} ≠ 指定日 ${date}）`);
      continue;
    }
    const venueName = rbData.track || rbData.venue || null;
    if (!venueName) continue;
    if (seenVenues.has(venueName)) {
      console.log(`   ⏭️  [RACEBOOK] ${file.name} スキップ（${venueName} は既に取込済）`);
      continue;
    }
    seenVenues.add(venueName);
    console.log(`   ✅ [RACEBOOK] ${file.name} 取得完了 (${venueName} / ${rbData.races?.length || 0}R)`);

    venues.push({
      date, venue: venueName, totalRaces: rbData.races?.length || 0,
      races: (rbData.races || []).map(r => ({
        raceInfo: {
          raceNumber: `${r.raceNumber}R`, raceName: r.raceClass || '',
          startTime: r.startTime || '', distance: r.distance || '', raceType: r.conditions || ''
        },
        horses: (r.horses || []).map(h => ({
          number: h.number, name: h.name, totalScore: h.totalScore || 0, assignment: h.assignment || '無',
          jockey: h.jockey || '', trainer: h.trainer || '', seirei: h.sexAge || '',
          kinryo: h.weight != null ? String(h.weight) : '', computerIndex: h.computerIndex || null,
          marks: h.marks || [], ranking: h.ranking || null,
          // 過去走（5走分まで保持。convertToLegacyFormat で recentRaces に変換）
          _pastRaces: Array.isArray(h.pastRaces) ? h.pastRaces.slice(0, 5) : []
        }))
      }))
    });
  }

  if (venues.length === 0) return null;
  return { date, venues };
}

/**
 * 予想データを取り込み（正規化 + 調整ルール適用）
 *
 * @param {string} date - 日付（YYYY-MM-DD）
 * @param {string} venue - 競馬場カテゴリ（デフォルト: 'jra'）
 * @returns {Promise<Object>} 調整済みNormalizedPrediction
 */
export async function importPrediction(date, venue = 'jra', client = sharedClient) {
  console.log(`\n━━━ ${date} 中央競馬予想データ取り込み開始 ━━━`);

  // 優先順位1: predictions（従来）
  let sharedJSON = await fetchSharedPrediction(date, venue, client);

  // 優先順位2: racebook（race-data-importer保存データ）
  if (!sharedJSON) {
    console.log(`📡 [IMPORT] racebook配下をチェック`);
    sharedJSON = await fetchRacebookData(date, venue, client);
  }

  // 予想データがない場合はスキップ
  if (!sharedJSON) {
    console.log(`⏭️  予想データがないため、スキップします`);
    return null;
  }

  // 【2026-05-14 追加】computer JSON を併読みして sourceComputerIndex を注入
  // 【2026-06-19】race-scoped 馬番主キー注入 + 安全アサート（真ci>=45の未対応/馬番重複なら import を FAIL）
  const computerSourceMap = await buildSourceComputerIndexMap(date, venue, client);
  if (computerSourceMap && computerSourceMap.size > 0) {
    const stats = injectSourceComputerIndex(sharedJSON, computerSourceMap);
    assertInjectionSafe(stats, { label: `IMPORT-JRA ${date}` });
  }

  // 複数会場対応：venues配列がある場合
  if (sharedJSON.venues && Array.isArray(sharedJSON.venues)) {
    console.log(`⚙️  複数会場データを正規化中...`);
    const normalizedVenues = [];

    for (const venueData of sharedJSON.venues) {
      // 各会場のデータを正規化
      const singleVenueData = {
        date: sharedJSON.date,
        venue: venueData.venue,
        totalRaces: venueData.totalRaces,
        races: venueData.races
      };

      const normalized = normalizeAndAdjust(singleVenueData);
      normalizedVenues.push(normalized);

      console.log(`   ✅ ${normalized.venue}: ${normalized.totalRaces}レース`);
    }

    // 複数会場統合データ
    const result = {
      date: sharedJSON.date,
      totalVenues: normalizedVenues.length,
      totalRaces: normalizedVenues.reduce((sum, v) => sum + v.totalRaces, 0),
      venues: normalizedVenues
    };

    console.log(`✅ 正規化完了`);
    console.log(`   - 開催日: ${result.date}`);
    console.log(`   - 会場数: ${result.totalVenues}`);
    console.log(`   - 総レース数: ${result.totalRaces}`);

    return result;
  }

  // 単一会場の場合（従来フォーマット）
  console.log(`⚙️  正規化 + 調整ルール適用中...`);
  const normalizedAndAdjusted = normalizeAndAdjust(sharedJSON);

  console.log(`✅ 正規化完了`);
  console.log(`   - 開催日: ${normalizedAndAdjusted.date}`);
  console.log(`   - 競馬場: ${normalizedAndAdjusted.venue}`);
  console.log(`   - レース数: ${normalizedAndAdjusted.totalRaces}`);

  return normalizedAndAdjusted;
}

/**
 * keiba-data-shared標準フォーマットを既存の予想ページフォーマットに変換
 *
 * @param {Object} data - 正規化・調整済みデータ
 * @param {string} date - 日付
 * @returns {Object} 既存フォーマット
 */
function convertToLegacyFormat(data, date) {
  // メインレース判定は会場別レース数で行う（防御）。
  // JRAは1日3場×12R=36Rが渡るパターンに備えて、race.venue ごとに数える。
  const dataVenue = data.venue || '';
  const racesByVenue = new Map();
  for (const r of (Array.isArray(data.races) ? data.races : [])) {
    const v = r.venue || r.raceInfo?.venue || dataVenue;
    racesByVenue.set(v, (racesByVenue.get(v) || 0) + 1);
  }
  const predictions = data.races.map((race) => {
    // 買い目生成（馬単）- CLAUDE.md 仕様の共通モジュールに統一
    // - メインレース: 10点ロジック（本命↔上位5頭、双方向）
    // - 通常レース: 本命↔上位5頭(抑え...)（双方向 1行、AK 独自フォーマット）
    const venueKey = race.venue || race.raceInfo?.venue || dataVenue;
    const venueRaces = racesByVenue.get(venueKey) || (Array.isArray(data.races) ? data.races.length : 0);
    const isMain = isMainRace(race.raceNumber, venueRaces);
    const umatanLines = generateRaceUmatanLines(race.horses, isMain);

    return {
      raceInfo: {
        date: date,
        venue: data.venue,
        raceNumber: race.raceNumber,
        raceName: race.raceInfo?.raceName || race.raceName || `第${race.raceNumber}レース`,
        startTime: race.raceInfo?.startTime || '', // 発走時刻
        distance: race.raceInfo?.distance || '', // 距離
        horseCount: race.horses?.length || 0 // 頭数
      },
      horses: race.horses
        .map(h => {
          // 過去走の優先順位: racebook由来 _pastRaces（豊富なフィールド） > computer由来 recentRaces（注入済み）
          const fromPast = Array.isArray(h._pastRaces) && h._pastRaces.length > 0
            ? h._pastRaces.slice(0, 5).map(pr => ({
                venue: pr.venue || '',
                distance: pr.distance || pr.distanceMeters || '',
                rank: (pr.finish != null && Number.isFinite(Number(pr.finish))) ? Number(pr.finish) : null,
                time: pr.time || '',
                last3f: pr.final3F || pr.last3f || '',
                bodyWeight: pr.bodyWeight || null,
                jockey: pr.jockey || '',
                passingOrder: pr.passingOrder || ''
              }))
            : null;
          const recentRaces = fromPast || (Array.isArray(h.recentRaces) && h.recentRaces.length > 0 ? h.recentRaces : null);
          return {
            horseNumber: h.number,
            horseName: h.name,
            pt: h.displayScore || h.rawScore || 70, // ptフィールド
            role: h.role, // roleをそのまま保持（JRAのassignmentをそのまま使用）
            jockey: h.jockey || h.kisyu || '', // 騎手
            trainer: h.trainer || h.kyusya || '', // 厩舎
            age: h.age || h.seirei || '', // 馬齢
            weight: h.weight || h.kinryo || '', // 斤量
            // 役割再計算（adjustPrediction フォールバック）に必要なフィールド
            computerIndex: h.computerIndex != null ? h.computerIndex : null,
            // 2026-05-14: 元 racebook 指数（pt 生成の正規ソース）
            ...(h.sourceComputerIndex != null ? { sourceComputerIndex: h.sourceComputerIndex } : {}),
            // 過去走（racebook由来 _pastRaces 優先 / computer由来 recentRaces をフォールバック）
            ...(recentRaces ? { recentRaces } : {}),
            marks: h.marks || {}
          };
        })
        .sort((a, b) => {
          // 役割の優先順位
          const roleOrder = { '本命': 1, '対抗': 2, '単穴': 3, '連下': 4, '補欠': 5, '抑え': 6, '無': 7 };
          const orderA = roleOrder[a.role] || 99;
          const orderB = roleOrder[b.role] || 99;

          if (orderA !== orderB) {
            return orderA - orderB; // 役割順
          }
          return b.pt - a.pt; // 同じ役割内ではpt降順
        }),
      bettingLines: {
        umatan: umatanLines
      },
      generatedAt: new Date().toISOString()
    };
  });

  return {
    eventInfo: {
      date: date,
      venue: data.venue,
      totalRaces: data.totalRaces
    },
    predictions: predictions
  };
}

/**
 * 予想データをkeiba-intelligence側に保存
 *
 * @param {string} date - 日付（YYYY-MM-DD）
 * @param {Object} normalizedAndAdjusted - 調整済みNormalizedPrediction
 * @returns {boolean} 保存したかどうか（true: 保存, false: no-op）
 */
function savePrediction(date, normalizedAndAdjusted) {
  console.log(`\n💾 保存処理開始...`);

  // 保存先パス構築（階層構造：jra/YYYY/MM/YYYY-MM-DD.json）
  const [year, month] = date.split('-');
  const dirPath = join(projectRoot, 'src', 'data', 'predictions', 'jra', year, month);
  const filePath = join(dirPath, `${date}.json`);

  // ディレクトリ作成（存在しない場合）
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
    console.log(`📁 ディレクトリ作成: ${dirPath}`);
  }

  // 複数会場対応
  let convertedData;
  if (normalizedAndAdjusted.venues && Array.isArray(normalizedAndAdjusted.venues)) {
    // 複数会場の場合：各会場を個別に変換
    console.log(`⚙️  複数会場フォーマット変換中...`);
    const venuesConverted = normalizedAndAdjusted.venues.map(venueData => {
      const converted = convertToLegacyFormat(venueData, date);
      return {
        venue: venueData.venue,
        ...converted
      };
    });

    convertedData = {
      date: date,
      totalVenues: normalizedAndAdjusted.totalVenues,
      totalRaces: normalizedAndAdjusted.totalRaces,
      venues: venuesConverted
    };
    console.log(`   ✅ ${venuesConverted.length}会場の変換完了`);
  } else {
    // 単一会場の場合（従来フォーマット）
    convertedData = convertToLegacyFormat(normalizedAndAdjusted, date);
  }

  // 【再発防止】データ検証を実行（印1ロジック適用後は警告のみ）
  console.log(`🔍 データ検証中...`);
  try {
    validateJRAPrediction(convertedData);
    console.log(`   ✅ データ検証成功（本命・対抗・単穴の整合性確認済み）`);
  } catch (err) {
    // 印1ロジック適用後は本命<対抗が正常なケースがあるため警告のみ
    console.warn(`\n⚠️  データ検証警告:\n${err.message}`);
    console.warn(`\n⚠️  印1◎○▲ロジック適用により本命PT<対抗PTは正常です`);
  }

  // JSON文字列化（整形）
  const newContent = JSON.stringify(convertedData, null, 2);

  // 既存ファイルとの比較（ハッシュ比較）
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf-8');

    // ハッシュ計算
    const existingHash = crypto.createHash('sha256').update(existingContent).digest('hex');
    const newHash = crypto.createHash('sha256').update(newContent).digest('hex');

    if (existingHash === newHash) {
      console.log(`⏭️  スキップ: 既存データと同一です`);
      console.log(`   ファイル: ${filePath}`);
      return false; // no-op
    } else {
      console.log(`🔄 更新: 既存データと差分があります`);
    }
  } else {
    console.log(`🆕 新規作成`);
  }

  // ファイル書き込み
  writeFileSync(filePath, newContent, 'utf-8');
  console.log(`✅ 保存完了: ${filePath}`);

  return true; // 保存した
}

/**
 * メイン処理
 */
async function main() {
  try {
    // private 化後に備え、開始直後に token を必須化（未設定なら匿名 fallback せず即 fatal）。
    resolveSharedToken();

    // コマンドライン引数をパース
    const args = process.argv.slice(2);
    let date = null;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--date' && i + 1 < args.length) {
        date = args[i + 1];
        i++;
      }
    }

    // 日付が指定されていない場合は今日の日付を使用
    if (!date) {
      date = getTodayJST();
      console.log(`📅 日付未指定のため、今日の日付を使用: ${date}`);
    } else {
      console.log(`📅 指定された日付: ${date}`);
    }

    // 会場コード付き日付を自動除去（例: 2026-02-20-TKY → 2026-02-20）
    const dateMatch = date.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const cleanDate = dateMatch[1];
      if (cleanDate !== date) {
        console.log(`📅 会場コードを除去: ${date} → ${cleanDate}`);
        date = cleanDate;
      }
    }

    // 日付フォーマット検証
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('日付はYYYY-MM-DD形式で指定してください');
    }

    // 取り込み実行
    const normalizedAndAdjusted = await importPrediction(date);

    // 予想データがない場合は正常終了
    if (!normalizedAndAdjusted) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('⏭️  予想データがないため、処理を終了します');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      return; // 正常終了
    }

    // 保存
    const saved = savePrediction(date, normalizedAndAdjusted);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (saved) {
      console.log('✅ 取り込み完了！');
    } else {
      console.log('⏭️  変更なし（既存データと同一）');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
