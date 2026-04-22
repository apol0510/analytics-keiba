/**
 * JRA結果一覧のレースをラウンドロビン順で並び替える共通関数。
 * 並び順: raceNumber 昇順 → 同一R内では venueOrder で指定した会場順（固定）。
 * 例: 中山1R → 阪神1R → 福島1R → 中山2R → 阪神2R → 福島2R ...
 *
 * @param {Array} races - レース配列
 * @param {Array<string>} [venueOrder=[]] - 同一R内の会場優先順序 (例: dayData.venues)
 * @returns {Array} 並び替え後の新しい配列
 */
export function sortRacesByVenueAndNumber(races = [], venueOrder = []) {
  const safeVenueOrder = Array.isArray(venueOrder) ? venueOrder : [];

  const getVenue = (race) => race?.venue || race?.course || '';
  const getRaceNumber = (race) => Number(race?.raceNumber ?? race?.r ?? 0);

  return [...races].sort((a, b) => {
    const numA = getRaceNumber(a);
    const numB = getRaceNumber(b);
    if (numA !== numB) return numA - numB;

    const venueA = getVenue(a);
    const venueB = getVenue(b);
    if (venueA === venueB) return 0;

    const indexA = safeVenueOrder.indexOf(venueA);
    const indexB = safeVenueOrder.indexOf(venueB);
    const safeIndexA = indexA === -1 ? 999 : indexA;
    const safeIndexB = indexB === -1 ? 999 : indexB;

    if (safeVenueOrder.length > 0 && safeIndexA !== safeIndexB) {
      return safeIndexA - safeIndexB;
    }

    return venueA.localeCompare(venueB, 'ja');
  });
}
