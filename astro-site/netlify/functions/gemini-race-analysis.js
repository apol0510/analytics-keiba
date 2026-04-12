/**
 * Netlify Function: Gemini AIレース分析
 *
 * 用途:
 * - 予想ページ: レースのAI解説コメント生成
 * - 結果ページ: レース結果の振り返りコメント生成
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const PREDICTION_PROMPT = `あなたは競馬AI予想の解説ライターです。

入力されたデータ（レース情報・各馬の近走成績・分析結果）を、読みやすい自然な解説文にまとめてください。

【絶対厳守ルール】
- 入力データに含まれる事実のみを使う。入力にない情報は絶対に追加しない
- 数値・馬名・会場名・距離・着順・タイムは一字一句変えない
- 的中を保証する表現は禁止（「確実」「間違いない」「鉄板」等）
- 「コース適性」「血統」「パドック」等、入力にないデータに基づく分析は書かない
- 各馬の解説は入力の[分析]セクションの内容に基づくこと

【文章スタイル】
- 各馬ごとに1〜2文で簡潔にまとめる
- レース概要→本命→対抗→その他の順で書く
- 近走の着順やタイムに触れながら、なぜその評価なのかが伝わる文章にする
- 語尾は「〜ですね」「〜でしょう」「〜でした」等の丁寧語で統一
- 読者に語りかけるような優しく親しみやすいトーンで

【出力形式】
- マークダウン記法は使わない。プレーンテキストのみ
- 箇条書きや番号リストは使わない
- 「KEIBA Intelligenceがお届けする」等の前置き・自己紹介は不要。いきなり本文から始める`;

const RESULT_PROMPT = `あなたは競馬AI予想の結果振り返りライターです。

入力されたレース結果データを、優しく丁寧な振り返り文にまとめてください。

【絶対厳守ルール】
- 入力データに含まれる事実のみを使う。入力にない情報は絶対に追加しない
- 馬番・馬名・着順・払戻金額・的中判定は一字一句変えない
- 「的中」と書かれていれば的中、「不的中」と書かれていれば不的中。判定を覆さない
- レース展開・脚質・能力評価など入力にない分析は書かない
- 買い目の内容（馬番の組み合わせ「○-○.○.○」等）は絶対に書かない
- 買い目の軸馬構造（「軸馬は○番」等）には触れない

【文章の方向性】
- AI予想の本命馬が好走した場合は「本命に推した○番が〜」のように触れてよい
- ただし対抗・単穴・連下などの役割名は文中に出さない。馬名だけで自然に触れる
- 上位に入った馬のポジティブな活躍を中心に書く
- 着外だった馬や予想が外れた馬にはわざわざ触れない（ネガティブな内容は不要）
- 的中時は素直に喜び、不的中時も次に期待できる前向きなトーンで

【文章スタイル】
- 語尾は「〜ですね」「〜でした」「〜ました」等の丁寧語で統一
- 読者に語りかけるような優しいトーンで
- 2〜3文程度で簡潔にまとめる
- 「見事」「お見事」を多用しない。レースごとに異なる表現を使い、単調にならないようにする
- 入力データにない馬の役割を捏造しない。役割が記載されていない馬について「AI予想の○○」等と書かない

【出力形式】
- マークダウン記法は使わない。プレーンテキストのみ
- 箇条書きや番号リストは使わない
- 「KEIBA Intelligenceがお届けする」等の前置き・自己紹介は不要。いきなり本文から始める`;

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { type, raceData } = JSON.parse(event.body);

    if (!type || !raceData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'type and raceData are required' })
      };
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const systemPrompt = type === 'prediction' ? PREDICTION_PROMPT : RESULT_PROMPT;
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: systemPrompt,
    });

    const userMessage = type === 'prediction'
      ? formatPredictionData(raceData)
      : formatResultData(raceData);

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.5,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const comment = result.response.text();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, comment })
    };

  } catch (error) {
    console.error('Race Analysis Error:', error.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: false, comment: null, error: error.message })
    };
  }
};

/**
 * recentRaceの1件を検証し、完全なデータのみ返す。不完全なら null
 * 必須: venue（会場名のみ）, distance（数値）, rank（着順数値）or finishStatus
 */
function validateRecentRace(race) {
  if (!race) return null;

  // rank も finishStatus もなければ不完全 → 削除
  const hasRank = race.rank && typeof race.rank === 'number' && race.rank > 0;
  const hasFinishStatus = race.finishStatus && typeof race.finishStatus === 'string';
  if (!hasRank && !hasFinishStatus) return null;

  // venue: 会場名のみ抽出（"盛岡 11.17" → "盛岡"、null → 不完全）
  if (!race.venue) return null;
  const venueName = race.venue.replace(/\s+[\d.\/]+$/, '').trim();
  if (!venueName) return null;

  // distance: 数値のみ抽出（"ダ1400" → 1400、null → 不完全）
  let distanceNum = null;
  if (race.distance) {
    const distStr = race.distance.toString().replace(/^[ダ芝障]+/, '').trim();
    const parsed = parseInt(distStr, 10);
    if (!isNaN(parsed) && parsed > 0) {
      distanceNum = parsed;
    }
  }
  // distanceがなければ不完全 → 削除
  if (!distanceNum) return null;

  const rankText = hasFinishStatus ? race.finishStatus : `${race.rank}着`;

  return { venue: venueName, distance: distanceNum, rankText };
}

/**
 * 近走データから分析ファクトを生成する（LLMに渡す前の事前計算）
 */
function analyzeRecentRaces(recentRaces, currentDistance, currentVenue) {
  if (!recentRaces || recentRaces.length === 0) return null;

  const analysis = {};
  const validRaces = [];

  for (const r of recentRaces.slice(0, 5)) {
    const validated = validateRecentRace(r);
    if (!validated) continue;
    validRaces.push({ ...validated, raw: r });
  }
  if (validRaces.length === 0) return null;

  // 直近走の成績サマリ（最大3走）
  const runLines = [];
  for (let i = 0; i < Math.min(3, validRaces.length); i++) {
    const v = validRaces[i];
    const label = i === 0 ? '前走' : i === 1 ? '2走前' : '3走前';
    let line = `${label}${v.venue}${v.distance}m${v.rankText}`;
    // 上がり3Fを追加
    const f3 = parseFloat(v.raw.last3f || '0');
    if (f3 > 0) {
      line += `(上がり${f3}秒)`;
    }
    runLines.push(line);
  }
  analysis.runLines = runLines;

  // 着順傾向（直近の好走率）
  const top3count = validRaces.filter(r => {
    const rank = r.raw.rank;
    return rank && rank <= 3;
  }).length;
  if (validRaces.length >= 2) {
    analysis.top3rate = `直近${validRaces.length}走中${top3count}回3着以内`;
  }

  // 上がり3F分析
  const f3values = validRaces.map(r => parseFloat(r.raw.last3f || '0')).filter(v => v > 0);
  if (f3values.length >= 2) {
    const avg = f3values.reduce((a, b) => a + b, 0) / f3values.length;
    const best = Math.min(...f3values);
    analysis.last3f = `上がり3F平均${avg.toFixed(1)}秒、最速${best.toFixed(1)}秒`;
  } else if (f3values.length === 1) {
    analysis.last3f = `前走の上がり3Fは${f3values[0].toFixed(1)}秒`;
  }

  // 距離適性
  const targetDist = parseInt(String(currentDistance || '').match(/(\d{3,4})/)?.[1] || '0');
  if (targetDist > 0) {
    const sameDistRaces = validRaces.filter(r => {
      const rDist = r.distance;
      return rDist && Math.abs(rDist - targetDist) <= 200;
    });
    if (sameDistRaces.length > 0) {
      const goodCount = sameDistRaces.filter(r => r.raw.rank && r.raw.rank <= 3).length;
      analysis.distFit = `同距離帯${sameDistRaces.length}走中${goodCount}回3着以内`;
    }
  }

  // コース適性
  if (currentVenue) {
    const venueShort = currentVenue.replace(/競馬/g, '');
    const sameVenue = validRaces.filter(r => r.venue.includes(venueShort));
    if (sameVenue.length > 0) {
      const goodCount = sameVenue.filter(r => r.raw.rank && r.raw.rank <= 3).length;
      analysis.trackFit = `${venueShort}では${sameVenue.length}走中${goodCount}回3着以内`;
    }
  }

  // ペース傾向
  const paceTypes = validRaces.map(r => r.raw.paceType).filter(Boolean);
  if (paceTypes.length >= 2) {
    const paceCount = {};
    paceTypes.forEach(p => { paceCount[p] = (paceCount[p] || 0) + 1; });
    const dominant = Object.entries(paceCount).sort((a, b) => b[1] - a[1])[0];
    const paceLabels = { 'H': 'ハイペース', 'M': 'ミドルペース', 'S': 'スローペース', 'Ｈ': 'ハイペース', 'Ｍ': 'ミドルペース', 'Ｓ': 'スローペース' };
    if (dominant && paceLabels[dominant[0]]) {
      analysis.pace = `近走は${paceLabels[dominant[0]]}のレースが多い`;
    }
  }

  return analysis;
}

/**
 * 予想データを分析付きファクト文に変換する
 * LLMは「このデータを自然な解説文にまとめる」
 */
function formatPredictionData(data) {
  const { venue, date, raceNumber, raceName, distance, horseCount, topHorses } = data;

  const sections = [];
  sections.push(`[レース情報]`);
  sections.push(`${date} ${venue} ${raceNumber}R${raceName ? ' ' + raceName : ''}${distance ? ' ' + distance + 'm' : ''}${horseCount ? ' ' + horseCount + '頭立て' : ''}`);

  topHorses.forEach(h => {
    sections.push('');
    // 基本情報行: 騎手・調教師・年齢・斤量があれば追加
    const basicInfo = [];
    if (h.jockey) basicInfo.push(`騎手:${h.jockey}`);
    if (h.trainer) basicInfo.push(`調教師:${h.trainer}`);
    if (h.age) basicInfo.push(h.age);
    if (h.weight) basicInfo.push(`${h.weight}kg`);
    const infoStr = basicInfo.length > 0 ? ` (${basicInfo.join(' ')})` : '';
    sections.push(`[${h.role}] ${h.horseNumber}番${h.horseName} PT${h.pt}${infoStr}`);

    const analysis = analyzeRecentRaces(h.recentRaces, distance, venue);
    if (analysis) {
      sections.push('[近走]');
      if (analysis.runLines) {
        analysis.runLines.forEach(line => sections.push(line));
      }

      const insights = [];
      if (analysis.top3rate) insights.push(analysis.top3rate);
      if (analysis.last3f) insights.push(analysis.last3f);
      if (analysis.distFit) insights.push(analysis.distFit);
      if (analysis.trackFit) insights.push(analysis.trackFit);
      if (analysis.pace) insights.push(analysis.pace);

      if (insights.length > 0) {
        sections.push('[分析]');
        insights.forEach(i => sections.push(i));
      }
    }
  });

  return `以下のレースデータを元に、自然な解説文を作成してください。データに含まれる事実のみを使い、情報の追加は禁止です。\n\n${sections.join('\n')}`;
}

/**
 * 結果データを事前確定された事実文に変換する
 * LLMは「この文章を自然な日本語に整形するだけ」
 */
function formatResultData(data) {
  const { venue, date, raceNumber, raceName, isHit, result, payout, umatanCombination, roles } = data;

  const facts = [];

  // ① 結果事実
  facts.push(`${date} ${venue} ${raceNumber}R${raceName ? ' ' + raceName : ''}`);
  facts.push(`1着: ${result.first.number}番${result.first.name ? ' ' + result.first.name : ''}`);
  facts.push(`2着: ${result.second.number}番${result.second.name ? ' ' + result.second.name : ''}`);
  facts.push(`3着: ${result.third.number}番${result.third.name ? ' ' + result.third.name : ''}`);
  if (umatanCombination) {
    facts.push(`馬単決着: ${umatanCombination}`);
  }

  // ② AI予想の役割（買い目の内容は絶対に含めない）
  if (roles && roles.length > 0) {
    facts.push(`AI予想の評価:`);
    roles.forEach(r => {
      facts.push(`  ${r.horseNumber}番${r.horseName || ''} → ${r.role}`);
    });
  }

  // ③ 的中状況
  facts.push(`判定: ${isHit ? '的中' : '不的中'}`);

  // ④ 金額結果
  if (isHit && payout) {
    facts.push(`払戻: ¥${payout.toLocaleString()}`);
  }

  return `以下のレース結果データを元に、優しく丁寧な振り返り文を作成してください。データに含まれる事実のみを使い、情報の追加は禁止です。買い目（馬番の組み合わせ）は絶対に書かないでください。\n\n${facts.join('\n')}`;
}
