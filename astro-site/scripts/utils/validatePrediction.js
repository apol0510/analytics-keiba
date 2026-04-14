/**
 * validatePrediction.js
 *
 * 予想データの整合性を検証
 * 再発防止：role/assignment の誤変換を検出
 */

/**
 * JRA予想データの検証
 *
 * @param {Object} data - 変換後の予想データ
 * @throws {Error} 検証エラー
 */
export function validateJRAPrediction(data, checkVenueMix = false) {
  const errors = [];

  // venues配列がある場合
  if (data.venues && Array.isArray(data.venues)) {
    for (const venue of data.venues) {
      const predictions = venue.predictions || [];
      const expectedVenue = checkVenueMix ? venue.venue : null;

      for (let i = 0; i < predictions.length; i++) {
        const race = predictions[i];
        const raceId = `${venue.venue}${race.raceInfo.raceNumber}R`;

        validateRace(race, raceId, errors, expectedVenue);
      }
    }
  } else {
    // 単一会場の場合
    const predictions = data.predictions || [];
    const expectedVenue = checkVenueMix ? data.eventInfo?.venue : null;

    for (let i = 0; i < predictions.length; i++) {
      const race = predictions[i];
      const raceId = `${data.eventInfo?.venue || '不明'}${race.raceInfo.raceNumber}R`;

      validateRace(race, raceId, errors, expectedVenue);
    }
  }

  if (errors.length > 0) {
    throw new Error(`データ検証エラー（${errors.length}件）:\n${errors.join('\n')}`);
  }
}

/**
 * レースデータの検証
 *
 * @param {Object} race - レースデータ
 * @param {string} raceId - レース識別子
 * @param {Array} errors - エラー配列
 * @param {string} expectedVenue - 期待される会場名（オプション）
 */
function validateRace(race, raceId, errors, expectedVenue = null) {
  if (!race.horses || race.horses.length === 0) {
    return; // 馬データなしは許可
  }

  // 本命・対抗・単穴のカウント
  const honmeiList = race.horses.filter(h => h.role === '本命');
  const taikouList = race.horses.filter(h => h.role === '対抗');
  const tananaList = race.horses.filter(h => h.role === '単穴');
  const renkaTopList = race.horses.filter(h => h.role === '連下最上位');

  // 【検証1】本命は1頭のみ
  if (honmeiList.length === 0) {
    errors.push(`❌ ${raceId}: 本命が0頭（1頭必須）`);
  } else if (honmeiList.length > 1) {
    errors.push(`❌ ${raceId}: 本命が${honmeiList.length}頭（1頭のみ許可）`);
  }

  // 【検証2】対抗は1頭のみ
  if (taikouList.length === 0) {
    errors.push(`❌ ${raceId}: 対抗が0頭（1頭必須）`);
  } else if (taikouList.length > 1) {
    errors.push(`❌ ${raceId}: 対抗が${taikouList.length}頭（1頭のみ許可）`);
  }

  // 【検証3】単穴は1頭のみ
  if (tananaList.length > 1) {
    errors.push(`❌ ${raceId}: 単穴が${tananaList.length}頭（1頭のみ許可）- ${tananaList.map(h => `${h.horseNumber}番${h.horseName}`).join(', ')}`);
  }

  // 【検証4】連下最上位は1頭のみ
  if (renkaTopList.length > 1) {
    errors.push(`❌ ${raceId}: 連下最上位が${renkaTopList.length}頭（1頭のみ許可）- ${renkaTopList.map(h => `${h.horseNumber}番${h.horseName}`).join(', ')}`);
  }

  // 【検証5】PT値の整合性（本命 >= 対抗 >= 単穴の期待）
  if (honmeiList.length === 1 && taikouList.length === 1) {
    const honmei = honmeiList[0];
    const taikou = taikouList[0];

    // 本命と対抗が同じPTの場合は警告（エラーではない）
    if (honmei.pt < taikou.pt - 5) {
      errors.push(`⚠️  ${raceId}: 本命（${honmei.horseNumber}番 PT${honmei.pt}）が対抗（${taikou.horseNumber}番 PT${taikou.pt}）より5点以上低い`);
    }
  }

  // 【検証6】役割の値チェック（許可された値のみ）
  const allowedRoles = ['本命', '対抗', '単穴', '連下最上位', '連下', '補欠', '無', '抑え'];
  for (const horse of race.horses) {
    if (!allowedRoles.includes(horse.role)) {
      errors.push(`❌ ${raceId}: ${horse.horseNumber}番 - 不正な役割 "${horse.role}"`);
    }
  }

  // 【検証7】会場混入検出（南関のみ）
  if (expectedVenue) {
    validateVenueCrossMix(race, raceId, expectedVenue, errors);
  }
}

/**
 * 会場混入検出（南関競馬の2場開催日対応）
 *
 * trainer/jockey に他会場の記号が含まれていないかチェック
 *
 * 【重要】2026-03-12修正: 他場所属の調教師・騎手は警告のみで許容
 * 南関競馬では他場所属の調教師が出走することは正常な動作
 * （例: 船橋レースに浦和所属の調教師、川崎所属の調教師など）
 *
 * @param {Object} race - レースデータ
 * @param {string} raceId - レース識別子
 * @param {string} expectedVenue - 期待される会場名
 * @param {Array} errors - エラー配列
 */
function validateVenueCrossMix(race, raceId, expectedVenue, errors) {
  // 南関4場の会場記号マップ
  const venueMarkers = {
    '大井': '(大)',
    '船橋': '(船)',
    '川崎': '(川)',
    '浦和': '(浦)'
  };

  // 期待される会場記号
  const expectedMarker = venueMarkers[expectedVenue];

  if (!expectedMarker) {
    return; // 南関4場以外はスキップ
  }

  // 他会場の記号リスト
  const otherMarkers = Object.entries(venueMarkers)
    .filter(([venue, marker]) => venue !== expectedVenue)
    .map(([venue, marker]) => ({ venue, marker }));

  // 全馬のtrainer/jockeyをチェック（警告のみ、エラーではない）
  for (const horse of race.horses) {
    const trainer = horse.trainer || '';
    const jockey = horse.jockey || '';

    // 他会場の記号が含まれている場合は警告ログ出力（エラーには追加しない）
    for (const { venue, marker } of otherMarkers) {
      if (trainer.includes(marker)) {
        console.warn(
          `⚠️  [Venue Mix WARNING] ${raceId}: ${horse.horseNumber}番 - trainer "${trainer}" に ${venue} の記号 "${marker}" 検出（期待: ${expectedVenue}）`
        );
        // errors.push は削除（fail fastを無効化）
      }
      if (jockey.includes(marker)) {
        console.warn(
          `⚠️  [Venue Mix WARNING] ${raceId}: ${horse.horseNumber}番 - jockey "${jockey}" に ${venue} の記号 "${marker}" 検出（期待: ${expectedVenue}）`
        );
        // errors.push は削除（fail fastを無効化）
      }
    }
  }
}

/**
 * 南関予想データの検証
 *
 * @param {Object} data - 変換後の予想データ
 * @throws {Error} 検証エラー
 */
export function validateNankanPrediction(data) {
  // 南関は会場混入チェックを有効化（2場開催日対応）
  validateJRAPrediction(data, true);
}
