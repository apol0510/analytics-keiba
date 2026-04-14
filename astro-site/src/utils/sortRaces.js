/**
 * JRA結果一覧のレースを「会場ごと → 同一会場内はレース番号順」に並び替える共通関数。
 *
 * @param {Array} races - レース配列
 * @param {Array<string>} [venueOrder=[]] - 優先する会場順序 (例: dayData.venues)
 * @returns {Array} 並び替え後の新しい配列
 */
export function sortRacesByVenueAndNumber(races = [], venueOrder = []) {
  const safeVenueOrder = Array.isArray(venueOrder) ? venueOrder : [];

  const getVenue = (race) => race?.venue || race?.course || '';
  const getRaceNumber = (race) => Number(race?.raceNumber ?? race?.r ?? 0);

  return [...races].sort((a, b) => {
    const venueA = getVenue(a);
    const venueB = getVenue(b);

    const indexA = safeVenueOrder.indexOf(venueA);
    const indexB = safeVenueOrder.indexOf(venueB);

    const safeIndexA = indexA === -1 ? 999 : indexA;
    const safeIndexB = indexB === -1 ? 999 : indexB;

    if (safeVenueOrder.length > 0 && safeIndexA !== safeIndexB) {
      return safeIndexA - safeIndexB;
    }

    if (venueA !== venueB) {
      return venueA.localeCompare(venueB, 'ja');
    }

    return getRaceNumber(a) - getRaceNumber(b);
  });
}
