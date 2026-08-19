/**
 * horseHistoryJoin.js — JRA 予想データ ↔ horseHistories の**結合キー**を決める単一源（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `predictions/jra` 側の馬名には `(地)` `(外)` の接頭辞が付くことがある
 * （地方所属馬 / 外国産馬）。`horseHistories` 側は素の馬名なので、
 * 単純な完全一致だけだと **これらの馬が丸ごと未照合**になる。
 *
 * 実測（2026-05〜08 / 11,431 頭）:
 *   完全一致のみ          … 10,628 頭 (92.98%)
 *   接頭辞除去を併用       … 11,396 頭 (99.69%)
 * 未照合だったのは `地` 467 頭 / `外` 301 頭。これらは「初コース」「乗り替わり」に
 * 該当しやすい馬なので、落ちたままだと**その手の集計が系統的に小さく出る**。
 *
 * ── 方針（fail closed）────────────────────────────────────────
 *   1. まず**完全一致**を試す（既存挙動と同じ。ここは絶対に変えない）
 *   2. 完全一致しなかった馬**だけ**、既知の接頭辞を結合キー上で外して再照合する
 *   3. 正規化後のキーが**レース内で一意**に対応するときだけ結合する
 *   4. 候補が複数ある / レース内で別の馬と衝突する場合は
 *      **first-match せず未照合**にする（誤結合より欠測を選ぶ）
 *   5. **表示用の馬名は変更しない**。正規化するのは結合キーだけ
 *   6. 空馬名・空白のみの馬名は常に未照合
 *
 * この module は「どの履歴とつなぐか」だけを決める。過去走の整形・注入は
 * `loadHorseHistoriesJra.js` の責務で、そちらは本 module の判定結果を使う。
 */

/**
 * 結合キー上で外してよい接頭辞。
 * 表示名からは外さない（表示は `(地)ホース` のまま）。
 */
export const KNOWN_NAME_PREFIXES = Object.freeze(['地', '外', '市', '父', '抽']);

const PREFIX_RE = new RegExp(`^[（(](?:${KNOWN_NAME_PREFIXES.join('|')})[）)]`);

/**
 * 馬名を結合キーへ正規化する。**既知の接頭辞のみ**を外し、前後の空白を落とす。
 * 未知の括弧書き（例 `(新)`）は外さない — 想定外の文字列で別馬へ寄せないため。
 *
 * @param {unknown} name
 * @returns {string} 正規化キー。判定不能なら空文字
 */
export function normalizeJoinKey(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.replace(PREFIX_RE, '').trim();
}

/**
 * 馬名に既知の接頭辞が付いているか。
 * @param {unknown} name
 * @returns {boolean}
 */
export function hasKnownPrefix(name) {
  return typeof name === 'string' && PREFIX_RE.test(name.trim());
}

/**
 * horseHistories の horses（horseId keyed）から、結合用の索引を作る。
 *
 * - `exact`      : 素の馬名 -> entry
 * - `normalized` : 正規化キー -> entry（**同キーに 2 件以上来たら null を入れて封じる**）
 *
 * @param {object|null|undefined} historiesJson
 * @returns {{exact: Map<string, object>, normalized: Map<string, object|null>}}
 */
export function buildJoinIndex(historiesJson) {
  const exact = new Map();
  const normalized = new Map();
  const horses = (historiesJson && typeof historiesJson === 'object' && historiesJson.horses) || {};
  for (const entry of Object.values(horses)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.horseName === 'string' ? entry.horseName.trim() : '';
    if (!name) continue;
    if (!exact.has(name)) exact.set(name, entry);

    const key = normalizeJoinKey(name);
    if (!key) continue;
    if (normalized.has(key)) {
      // 履歴側で同じキーが 2 件以上 = どちらへ寄せるか決められない → 封じる
      normalized.set(key, null);
    } else {
      normalized.set(key, entry);
    }
  }
  return { exact, normalized };
}

/**
 * 1 レースぶんの馬配列を履歴へ結合する。
 *
 * 返り値は入力と同じ長さの配列で、各要素は
 *   `{ entry, matched, via, reason }`
 *     - `entry`   : 結合できた履歴 entry（できなければ null）
 *     - `matched` : boolean
 *     - `via`     : 'exact' | 'normalized' | null
 *     - `reason`  : 未照合の理由（'empty-name' | 'no-candidate' | 'ambiguous-in-race' |
 *                   'ambiguous-in-history' | 'already-taken'）。照合できたときは null
 *
 * @param {Array<object>} horses 1 レースの出走馬（predictions 側）
 * @param {{exact: Map, normalized: Map}} index `buildJoinIndex()` の戻り値
 * @param {{nameOf?: (h: object) => unknown}} [opts] 馬名の取り出し方（既定 `h.horseName`）。
 *   ページによって `horse.name` を使う経路があるため差し替え可能にしてある。
 * @returns {Array<{entry: object|null, matched: boolean, via: string|null, reason: string|null}>}
 */
export function joinRaceHorses(horses, index, opts = {}) {
  const list = Array.isArray(horses) ? horses : [];
  const exact = (index && index.exact) || new Map();
  const normalized = (index && index.normalized) || new Map();
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : (h) => h?.horseName;

  const results = list.map(() => ({ entry: null, matched: false, via: null, reason: null }));

  // 同じ履歴 entry を 2 頭が奪い合わないよう、使用済みを記録する
  const taken = new Set();

  // ── 1st pass: 完全一致（既存挙動）──────────────────────────
  list.forEach((horse, i) => {
    const rawName = nameOf(horse);
    const raw = typeof rawName === 'string' ? rawName.trim() : '';
    if (!raw) {
      results[i].reason = 'empty-name';
      return;
    }
    const hit = exact.get(raw);
    if (hit && !taken.has(hit)) {
      results[i] = { entry: hit, matched: true, via: 'exact', reason: null };
      taken.add(hit);
    }
  });

  // ── 2nd pass: 未照合の馬だけ、正規化キーで再照合 ──────────────
  // レース内で正規化キーが重複する馬は、どちらがどれか決められないので全員 fail closed。
  const pendingByKey = new Map();
  list.forEach((horse, i) => {
    if (results[i].matched || results[i].reason === 'empty-name') return;
    const key = normalizeJoinKey(nameOf(horse));
    if (!key) {
      results[i].reason = 'empty-name';
      return;
    }
    if (!pendingByKey.has(key)) pendingByKey.set(key, []);
    pendingByKey.get(key).push(i);
  });

  for (const [key, idxs] of pendingByKey) {
    if (idxs.length > 1) {
      // レース内で同じキーの馬が複数 → 誤結合を避けて全員未照合
      for (const i of idxs) results[i].reason = 'ambiguous-in-race';
      continue;
    }
    const i = idxs[0];
    if (!normalized.has(key)) {
      results[i].reason = 'no-candidate';
      continue;
    }
    const cand = normalized.get(key);
    if (cand === null) {
      // 履歴側で同キーが複数 → 決められない
      results[i].reason = 'ambiguous-in-history';
      continue;
    }
    if (taken.has(cand)) {
      // すでに完全一致で別の馬が取っている → 奪わない
      results[i].reason = 'already-taken';
      continue;
    }
    results[i] = { entry: cand, matched: true, via: 'normalized', reason: null };
    taken.add(cand);
  }

  return results;
}

/**
 * 結合結果の要約（計測・表示状態の判定に使う）。
 *
 * @param {Array<{matched: boolean, reason: string|null}>} results
 * @returns {{total: number, matched: number, coverage: number, failClosed: number, byReason: Record<string, number>}}
 */
export function summarizeJoin(results) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const matched = list.filter((r) => r && r.matched).length;
  const byReason = {};
  let failClosed = 0;
  for (const r of list) {
    if (!r || r.matched) continue;
    const key = r.reason || 'unknown';
    byReason[key] = (byReason[key] || 0) + 1;
    if (key === 'ambiguous-in-race' || key === 'ambiguous-in-history' || key === 'already-taken') {
      failClosed += 1;
    }
  }
  return {
    total,
    matched,
    coverage: total > 0 ? matched / total : 0,
    failClosed,
    byReason,
  };
}

export default { normalizeJoinKey, hasKnownPrefix, buildJoinIndex, joinRaceHorses, summarizeJoin, KNOWN_NAME_PREFIXES };
