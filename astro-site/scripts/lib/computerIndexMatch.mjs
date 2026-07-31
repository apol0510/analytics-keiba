/**
 * computerIndexMatch.mjs — computer JSON の真コンピ指数(45-99)を racebook 本体へ
 *   race-scoped horseNumber 主キーで突合・注入する純関数群（依存ゼロ・テスト可能）。
 *
 * 背景（2026-06-19 不要馬誤判定バグ）:
 *   旧 injectSourceComputerIndex は `${馬番}|${馬名}` の完全一致をキーにしていたため、
 *   computer 側 "(外)ポールセン" と racebook 側 "ポールセン" の接頭辞差、または racebook
 *   側 PUA/空名で突合失敗し、真コンピ指数 60 が不要馬判定ゲート(getOsaeCi>=45)に届かず
 *   不要馬に分類された（36R で 28頭）。
 *
 * 設計:
 *   正本キー = (venue, raceNumber, horseNumber)。horseNumber はレース内で一意。
 *   照合順:
 *     1. 同一会場・同一レース・同一馬番（主キー）
 *     2. 馬番が欠損する場合のみ正規化馬名フォールバック
 *     3. 馬番一致だが正規化馬名が乖離 → 指数は注入しつつ nameMismatch を記録（黙殺禁止）
 *     4. computer 側で同一レース内に重複馬番 → ambiguous として注入せず記録（FAIL）
 *   racebook 名が破損（空 / PUA）かつ馬番一致時は、computer 側の正規馬名で名前を復元する
 *   （shared に存在する正本値の補完であり、画面側の推測補正ではない）。
 *
 * 閾値・仕様は変更しない。45以上を強制補充しない。特定馬専用分岐を持たない。
 */

/** (地)/(外) 接頭辞を除去して比較する。KI importPredictionJra と同一仕様。 */
export function normalizeHorseName(n) {
  return String(n || '').replace(/^[（(](地|外)[）)]\s*/, '').trim();
}

/** "11R" / 11 / "11" → 11（整数）。解析不能なら null。 */
export function parseRaceNumber(x) {
  if (x == null) return null;
  const m = String(x).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/**
 * 馬番として有効か。正の整数のみ受理（0 / 負数 / 小数 / NaN / 文字列混じりは不可）。
 * "8" のような数値文字列は整数値へ正規化して受理する。
 * @returns {number|null} 正規化済み馬番（無効なら null）
 */
export function toHorseNumber(x) {
  if (typeof x === 'number') return Number.isInteger(x) && x > 0 ? x : null;
  if (typeof x === 'string' && /^\d+$/.test(x.trim())) {
    const n = parseInt(x.trim(), 10);
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * computer 各会場データから race-scoped lookup を構築する。
 * @param {Array<{venue:string, races:Array<{raceNumber:any, horses:Array<{number:any,name:any,computerIndex:any,recentRaces?:any[]}>}>}>} venues
 * @returns {Map<string, Map<number, {byNumber:Map<number,object>, byName:Map<string,object>, dupNumbers:Set<number>}>>}
 */
export function buildRaceScopedComputerMap(venues) {
  const venueMap = new Map();
  for (const v of (venues || [])) {
    const venueName = v.venue || v.name || v.track || null;
    if (!venueName) continue;
    const raceMap = venueMap.get(venueName) || new Map();
    for (const r of (v.races || [])) {
      const rn = parseRaceNumber(r.raceNumber ?? r.raceInfo?.raceNumber);
      if (rn == null) continue;
      const per = raceMap.get(rn) || { byNumber: new Map(), byName: new Map(), dupNumbers: new Set() };
      for (const h of (r.horses || [])) {
        const num = toHorseNumber(h.number ?? h.horseNumber); // 正の整数のみ。0/負/小数/NaN は null
        const name = h.name ?? h.horseName ?? '';
        const ciRaw = Number(h.computerIndex);
        const entry = {
          ci: Number.isFinite(ciRaw) ? ciRaw : null,
          name: String(name),
          recentRaces: Array.isArray(h.recentRaces) ? h.recentRaces : [],
        };
        if (num != null) {
          if (per.byNumber.has(num)) per.dupNumbers.add(num); // 同一レース内 重複馬番 = 曖昧
          else per.byNumber.set(num, entry);
        }
        const norm = normalizeHorseName(name);
        if (norm && !per.byName.has(norm)) per.byName.set(norm, entry);
      }
      raceMap.set(rn, per);
    }
    venueMap.set(venueName, raceMap);
  }
  return venueMap;
}

/**
 * sharedJSON(racebook 本体)へ sourceComputerIndex / recentRaces / 破損名復元を注入する。
 * sharedJSON は破壊的に更新される（既存挙動踏襲）。
 *
 * @param {object} sharedJSON  - {venues:[{venue,races:[{raceInfo|raceNumber,horses:[...]}]}]} または単一会場
 * @param {Map} venueMap       - buildRaceScopedComputerMap の戻り値
 * @param {{isNameBroken?:(name:string)=>boolean, onWarn?:(msg:string,ctx?:object)=>void}} [opts]
 * @returns {{injected:number, recentInjected:number, nameRecovered:number, unmatched:number,
 *           ambiguous:number, nameMismatch:number, uncoveredHighCi:Array, matchedByName:number}}
 */
export function injectSourceComputerIndexRaceScoped(sharedJSON, venueMap, opts = {}) {
  const isNameBroken = opts.isNameBroken || (() => false);
  const onWarn = opts.onWarn || (() => {});
  const stats = {
    injected: 0, recentInjected: 0, nameRecovered: 0, unmatched: 0,
    ambiguous: 0, nameMismatch: 0, matchedByName: 0, uncoveredHighCi: [],
  };
  if (!sharedJSON || !venueMap) return stats;

  const consumed = new Set(); // `${venue}|${rn}|${num}` 消費済み
  const venues = Array.isArray(sharedJSON.venues) ? sharedJSON.venues : [sharedJSON];

  for (const venueData of venues) {
    const venueName = venueData.venue || venueData.name || venueData.track || null;
    if (!venueName) continue;
    const raceMap = venueMap.get(venueName);
    if (!raceMap) continue;
    for (const race of (venueData.races || [])) {
      const rn = parseRaceNumber(race.raceNumber ?? race.raceInfo?.raceNumber);
      if (rn == null) continue;
      const per = raceMap.get(rn);
      if (!per) continue;
      for (const h of (race.horses || [])) {
        const num = toHorseNumber(h.horseNumber ?? h.number); // 正の整数のみ
        const rawName = h.horseName ?? h.name ?? '';
        let entry = null;
        let matchedNum = null;

        // 照合順 1: 同会場・同R・同馬番（主キー）
        if (num != null) {
          if (per.dupNumbers.has(num)) {
            stats.ambiguous++;
            onWarn(`[JOIN-FAIL] ${venueName} R${rn} 馬番${num}: computer 側で馬番重複（曖昧）。注入スキップ`, { venueName, rn, num });
            continue; // 黙って 0 にせず、注入しないことを記録
          }
          entry = per.byNumber.get(num) || null;
          if (entry) matchedNum = num;
        }
        // 照合順 2: 馬番欠損時のみ正規化名フォールバック
        if (!entry && num == null) {
          const norm = normalizeHorseName(rawName);
          if (norm) { entry = per.byName.get(norm) || null; if (entry) stats.matchedByName++; }
        }

        if (!entry) {
          stats.unmatched++;
          continue;
        }
        if (matchedNum != null) consumed.add(`${venueName}|${rn}|${matchedNum}`);

        // 照合順 3: 馬番一致だが正規化名が乖離 → 注入しつつ警告（黙殺禁止）
        if (matchedNum != null && rawName && !isNameBroken(rawName)) {
          if (normalizeHorseName(entry.name) !== normalizeHorseName(rawName)) {
            stats.nameMismatch++;
            onWarn(`[JOIN-WARN] ${venueName} R${rn} 馬番${num}: 馬番一致だが名前乖離 computer="${entry.name}" racebook="${rawName}"（指数は注入）`, { venueName, rn, num });
          }
        }

        // 真コンピ指数の注入。null/undefined/NaN/0-9 は真コンピ指数として扱わない
        // （admin 0-9 編集系スケールを真指数と誤認しない）。45以上の強制補充もしない。
        if (Number.isFinite(entry.ci) && entry.ci >= 10) {
          h.sourceComputerIndex = entry.ci;
          stats.injected++;
        } else if (matchedNum != null) {
          // 馬番一致したのに computer 側 ci が無効 → 黙殺せず記録（0 へ落とすだけにしない）
          onWarn(`[JOIN-WARN] ${venueName} R${rn} 馬番${num}: computer 側 computerIndex 無効 (=${entry.ci})`, { venueName, rn, num });
        }

        // recentRaces 注入（既存挙動）
        if (Array.isArray(entry.recentRaces) && entry.recentRaces.length > 0) {
          h.recentRaces = entry.recentRaces;
          stats.recentInjected++;
        }

        // 破損名の復元（馬番一致時のみ／computer の正本名を採用）
        const targetNameKey = (h.horseName !== undefined) ? 'horseName' : 'name';
        if (matchedNum != null && isNameBroken(rawName) && entry.name && !isNameBroken(entry.name)) {
          h[targetNameKey] = entry.name;
          stats.nameRecovered++;
          onWarn(`[JOIN-RECOVER] ${venueName} R${rn} 馬番${num}: racebook 破損名 → computer 名 "${entry.name}" で復元`, { venueName, rn, num });
        }
      }
    }
  }

  // 被覆検査: computer 側 ci>=45 で racebook に取り込まれなかった馬を記録（黙殺禁止）
  for (const [venueName, raceMap] of venueMap.entries()) {
    for (const [rn, per] of raceMap.entries()) {
      for (const [num, entry] of per.byNumber.entries()) {
        if (Number.isFinite(entry.ci) && entry.ci >= 45 && !consumed.has(`${venueName}|${rn}|${num}`)) {
          stats.uncoveredHighCi.push({ venue: venueName, raceNumber: rn, number: num, name: entry.name, ci: entry.ci });
          onWarn(`[JOIN-UNCOVERED] ${venueName} R${rn} 馬番${num} "${entry.name}" ci=${entry.ci} が racebook 本体に未対応`, { venueName, rn, num });
        }
      }
    }
  }
  return stats;
}

/**
 * 注入結果が安全か検証し、危険なら例外を投げる（import を成功扱いさせない）。
 * 恒久ルール: 真コンピ指数>=45 の馬を黙って 0 へ落とす（不要馬化）くらいなら import を FAIL させる。
 *
 *   - uncoveredHighCi（computer ci>=45 で racebook 本体に馬番対応なし）が 1 件でもあれば throw
 *   - ambiguous（computer 同一レース内 馬番重複）が 1 件でもあれば throw
 *
 * @param {object} stats injectSourceComputerIndexRaceScoped の戻り値
 * @param {{label?:string}} [opts]
 */
export function assertInjectionSafe(stats, opts = {}) {
  const label = opts.label ? `[${opts.label}] ` : '';
  const problems = [];
  if (stats.ambiguous > 0) problems.push(`computer 馬番重複 ${stats.ambiguous} 件`);
  if (Array.isArray(stats.uncoveredHighCi) && stats.uncoveredHighCi.length > 0) {
    const list = stats.uncoveredHighCi.map(u => `${u.venue} R${u.raceNumber} #${u.number} "${u.name}" ci=${u.ci}`).join(', ');
    problems.push(`真コンピ指数>=45 の racebook 未対応 ${stats.uncoveredHighCi.length} 件 [${list}]`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}sourceComputerIndex 注入が安全条件を満たしません: ${problems.join(' / ')}。` +
      `黙って不要馬化させないため import を中止します（shared の馬番整合 or 馬名を確認してください）。`
    );
  }
}

/**
 * 注入 stats の問題を「再取得で解消しうるか」で分類する純関数（throw しない）。
 *
 * 背景（2026-07-31 一過性 FAIL）:
 *   会場ごとの dispatch が短時間に連続すると、GitHub Contents API の結果整合性により
 *   racebook 側だけが computer 側より遅れて見えることがある（2026-07-31 08:43 の run では
 *   racebook 一覧に札幌1件しか現れず、直後に読んだ computer には中京/新潟が既に存在した）。
 *   この状態では中京/新潟の全高 ci 馬が uncoveredHighCi となり、実データは正常なのに FAIL する。
 *
 * 分類基準:
 *   - uncoveredHighCi のみ → racebook 側の可視性・内容が遅れている可能性がある（staleSuspect）。
 *     一定回数だけ再取得して再判定してよい。解消しなければ従来どおり FAIL（fail-closed）。
 *   - ambiguous（同一 computer ファイル内の馬番重複）→ ファイルは commit 単位で原子的であり、
 *     再取得しても内容は変わらない。stale read では説明できない実データ欠陥なので即 FAIL。
 *
 * ここでは推測補完・閾値変更・強制注入を一切行わない（判定のみ）。
 *
 * @param {object} stats injectSourceComputerIndexRaceScoped の戻り値
 * @returns {{ok:boolean, staleSuspect:boolean, uncovered:number, ambiguous:number}}
 */
export function classifyInjectionProblems(stats) {
  const uncovered = Array.isArray(stats?.uncoveredHighCi) ? stats.uncoveredHighCi.length : 0;
  const ambiguous = Number(stats?.ambiguous) > 0 ? Number(stats.ambiguous) : 0;
  const ok = uncovered === 0 && ambiguous === 0;
  return { ok, staleSuspect: !ok && ambiguous === 0 && uncovered > 0, uncovered, ambiguous };
}
