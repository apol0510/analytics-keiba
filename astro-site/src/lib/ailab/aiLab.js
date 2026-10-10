/**
 * aiLab.js — AI ラボ（中央・南関・試験運用）の純粋ロジック。**サーバー（取込・画面データ）とブラウザ（画面）の単一源**
 *
 * 正本: docs/AI_LAB.md（2026-10-07 MK 確定・2026-10-05 版を置き換え）
 *   - KAP の Stage A dashboard（127.0.0.1:8766）の UI を基準に、中央・南関を**同じ UI**で見せる
 *   - **全出走馬**の AI 勝率・単勝オッズ・期待値（AI 勝率 × 単勝オッズ）と、発走までのカウントダウン・自動追従・自動更新
 *   - 🛑 出さない: 買い目・KAP が選んだ馬・推奨・金額・的中／不的中の競わせ方。特定の馬だけを強調しない（馬番順・色付けなし）
 *   - 各馬の期待値の横に AK の印（上位 5 頭 ◎○▲△△・2026-10-07 MK 追記）。印は取込時に aiLabAk.attachAk が添える
 *   - 🛑 欠損・不整合・更新停止は **数値を出さない（fail closed）**。推測で埋めない
 *
 * ⚠️ このファイルは Node 専用の import を持たない（ブラウザにも同梱する）。
 */

export const INGEST_SCHEMA = 'ak_ailab_ingest.v3';
export const MARKETS = Object.freeze(['jra', 'nankan']);
export const MARKET_LABEL = Object.freeze({ jra: '中央', nankan: '南関' });
// race_id の場コード → 場名（KAP の dashboard_common と同じ）
export const JRA_COURSE = Object.freeze({
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
});
export const NANKAN_COURSE = Object.freeze({ OI: '大井', KA: '川崎', FU: '船橋', UR: '浦和' });

/** 発走前に、データ（取込）またはオッズの観測がこれより古ければ値を出さない（更新停止・fail closed） */
export const STALE_MS = 10 * 60 * 1000;
/** 判断（AI の評価の確定）は発走の何分前か（KAP の lead_seconds=600） */
export const DECISION_LEAD_MIN = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RACES = 48;
const MAX_HORSES = 18;
const JST_MS = 9 * 3600 * 1000;

/** KAP の race_id → { market, date, venueCode, venueName, raceNumber }。読めなければ null */
export function parseRaceId(raceId) {
  const s = String(raceId || '');
  let m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const venueName = JRA_COURSE[m[2]];
    const raceNumber = Number(m[3]);
    if (!venueName || raceNumber < 1 || raceNumber > 12) return null;
    return { market: 'jra', date: m[1], venueCode: m[2], venueName, raceNumber };
  }
  m = /^(\d{4}-\d{2}-\d{2})-(OI|KA|FU|UR)-(\d{1,2})$/.exec(s);
  if (m) {
    const raceNumber = Number(m[3]);
    if (raceNumber < 1 || raceNumber > 12) return null;
    return { market: 'nankan', date: m[1], venueCode: m[2], venueName: NANKAN_COURSE[m[2]], raceNumber };
  }
  return null;
}

const isoMs = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const finite = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/**
 * 受け取ったデータを検査し、**保存してよい項目だけ**に絞る（未知の項目＝買い目・金額・判断は落とす）。
 * 値の欠損・範囲外・期待値と（AI 勝率 × オッズ）の食い違いは null にする（推測しない）。
 * @returns {{ ok: true, day: object } | { ok: false, reason: string }}
 */
export function sanitizeIngest(payload) {
  const p = payload || {};
  if (p.schema !== INGEST_SCHEMA) return { ok: false, reason: 'schema' };
  if (!MARKETS.includes(p.market)) return { ok: false, reason: 'market' };
  if (!DATE_RE.test(String(p.date))) return { ok: false, reason: 'date' };
  const generatedMs = isoMs(p.generated_at);
  if (generatedMs == null) return { ok: false, reason: 'generated_at' };
  if (!Array.isArray(p.races) || p.races.length === 0 || p.races.length > MAX_RACES) return { ok: false, reason: 'races' };
  const races = [];
  const seenRace = new Set();
  for (const r of p.races) {
    const id = parseRaceId(r?.race_id);
    if (!id || id.market !== p.market || id.date !== p.date) return { ok: false, reason: 'race_id' };
    if (seenRace.has(r.race_id)) return { ok: false, reason: 'race_dup' };
    seenRace.add(r.race_id);
    const startMs = isoMs(r.race_start_at);
    if (startMs == null) return { ok: false, reason: 'race_start_at' };
    const model = typeof r.model_version === 'string' ? r.model_version.slice(0, 80) : '';
    if (!Array.isArray(r.field) || r.field.length > MAX_HORSES) return { ok: false, reason: 'field' };
    const field = [];
    const seen = new Set();
    for (const h of r.field) {
      const n = h?.horse_number;
      if (!Number.isInteger(n) || n < 1 || n > MAX_HORSES || seen.has(n)) return { ok: false, reason: 'horse_number' };
      seen.add(n);
      const pc = finite(h.p_calibrated, 0, 1);
      const odds = finite(h.odds, 1.0000001, 9999.9);
      let ev = odds == null ? null : finite(h.ev, 0, 1000);
      // 期待値は AI 勝率 × 単勝オッズ。食い違う値は出さない
      if (ev != null && pc != null && Math.abs(pc * odds - ev) > 0.005) ev = null;
      field.push({ n, p: pc, odds, ev });
    }
    field.sort((a, b) => a.n - b.n);
    // 市場由来（オッズから作った）勝率・値の無いレースは「評価待ち」（レースは一覧に出す）
    const ok = r.status === 'ok' && field.length > 0 && !!model && !/market/i.test(model);
    const obs = isoMs(r.odds_observed_at);
    races.push({
      raceId: r.race_id, venueCode: id.venueCode, venueName: id.venueName, raceNumber: id.raceNumber,
      startAt: new Date(startMs).toISOString(),
      status: ok ? 'ok' : 'pending',
      model: ok ? model : null,
      oddsBasis: ok && ['decision', 'latest'].includes(r.odds_basis) ? r.odds_basis : null,
      oddsObservedAt: ok && obs != null ? new Date(obs).toISOString() : null,
      field: ok ? field : [],
    });
  }
  races.sort((a, b) => (a.venueCode < b.venueCode ? -1 : a.venueCode > b.venueCode ? 1 : a.raceNumber - b.raceNumber));
  return { ok: true, day: { market: p.market, date: p.date, generatedAt: new Date(generatedMs).toISOString(), races } };
}

// ── 表示（ブラウザと共通）────────────────────────────────────────────

/** ISO → JST の 'HH:MM'（ブラウザのタイムゾーンに依らない） */
export function jstHm(iso) {
  const t = isoMs(iso);
  if (t == null) return '-';
  const d = new Date(t + JST_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
/** ISO → JST の 'HH:MM:SS' */
export function jstHms(iso) {
  const t = isoMs(iso);
  if (t == null) return '-';
  const d = new Date(t + JST_MS);
  return `${jstHm(iso)}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}
/** 現在の JST の日付 'YYYY-MM-DD' */
export function jstDate(nowMs) {
  return new Date(nowMs + JST_MS).toISOString().slice(0, 10);
}

/** 発走までの表示（dashboard と同じ書き方）。発走時刻ちょうど以降は「発走済み」 */
export function countdown(startAt, nowMs) {
  const t = isoMs(startAt);
  if (t == null) return { started: false, seconds: null, text: '-' };
  if (t - nowMs <= 0) return { started: true, seconds: 0, text: '発走済み' };
  const sec = Math.ceil((t - nowMs) / 1000);
  const hr = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return { started: false, seconds: sec, text: `${hr > 0 ? `${hr}時間` : ''}${m}分${String(s).padStart(2, '0')}秒` };
}

/**
 * 発走の行（発走前はカウントダウン・発走後は「発走済み（HH:MM 発走）」）。
 * 発走後に「発走まで 発走済み」と並べない。
 */
export function startLine(startAt, nowMs) {
  const c = countdown(startAt, nowMs);
  const at = jstHm(startAt);
  if (c.started) return { started: true, lead: '', value: '発走済み', tail: `（${at} 発走）` };
  return { started: false, lead: '発走まで ', value: c.text, tail: `（発走 ${at}）` };
}

/**
 * 発走済みのレースを見ているときの「次に発走するレース」（全開催場で一番早い・自分以外）。無ければ null。
 * @returns {null | { raceId, label, startAt }}
 */
export function nextUpcoming(races, currentId, nowMs) {
  const cur = (races || []).find((r) => r.raceId === currentId);
  if (!cur || isoMs(cur.startAt) == null || isoMs(cur.startAt) > nowMs) return null;
  const id = (races || []).some((r) => isoMs(r.startAt) > nowMs) ? followTarget(races, nowMs) : null;
  const r = id && races.find((x) => x.raceId === id);
  return r ? { raceId: r.raceId, label: `${r.venueName} ${r.raceNumber}R`, startAt: r.startAt } : null;
}

/** 自動追従の対象: これから発走するうち一番早いレース。全部発走済みなら最後のレース。無ければ null */
export function followTarget(races, nowMs) {
  const list = (races || []).filter((r) => isoMs(r.startAt) != null);
  if (list.length === 0) return null;
  const upcoming = list.filter((r) => isoMs(r.startAt) > nowMs)
    .sort((a, b) => isoMs(a.startAt) - isoMs(b.startAt) || a.raceId.localeCompare(b.raceId));
  if (upcoming.length) return upcoming[0].raceId;
  return list.slice().sort((a, b) => isoMs(b.startAt) - isoMs(a.startAt) || b.raceId.localeCompare(a.raceId))[0].raceId;
}

/** 開催場 → レースの一覧と、**同じ開催場の**前レース / 次レース（R 番号順・dashboard と同じ） */
export function buildNav(races, raceId) {
  const venues = [];
  const byCode = new Map();
  const sorted = (races || []).slice()
    .sort((a, b) => (a.venueCode < b.venueCode ? -1 : a.venueCode > b.venueCode ? 1 : a.raceNumber - b.raceNumber));
  for (const r of sorted) {
    if (!byCode.has(r.venueCode)) { const v = { code: r.venueCode, name: r.venueName, races: [] }; byCode.set(r.venueCode, v); venues.push(v); }
    byCode.get(r.venueCode).races.push(r.raceId);
  }
  const cur = (races || []).find((r) => r.raceId === raceId);
  let prev = null;
  let next = null;
  if (cur) {
    const same = byCode.get(cur.venueCode).races;
    const i = same.indexOf(raceId);
    prev = i > 0 ? same[i - 1] : null;
    next = i + 1 < same.length ? same[i + 1] : null;
  }
  return { venues, prev, next };
}

const fixed = (v, d) => (v == null ? '-' : v.toFixed(d));

/** 着順（1〜3 着だけ・結果アーカイブ由来）。無ければ null */
function rankOf(result, n) {
  if (!result) return null;
  if (result.first === n) return 1;
  if (result.second === n) return 2;
  if (result.third === n) return 3;
  return null;
}

/** 結果（着順）がまとめて入る時刻の目安（docs/AI_LAB.md・結果アーカイブの取込時刻） */
export const RESULT_ETA = Object.freeze({ jra: '17 時台', nankan: '21 時台' });

/**
 * レースの結果（1〜3 着の馬番）の表示。結果は当日の全レース終了後にまとめて入る（中央 17 時台・南関 21 時台）。
 * 的中・不的中の判定はしない（着順の事実だけ）。
 */
export function resultLine(race, { nowMs, market = null }) {
  const started = isoMs(race?.startAt) != null && isoMs(race.startAt) <= nowMs;
  const r = race?.result;
  if (r && Number.isInteger(r.first) && Number.isInteger(r.second)) {
    return { state: 'result', order: [r.first, r.second, r.third].filter((x) => Number.isInteger(x)) };
  }
  const eta = RESULT_ETA[market];
  return started ? { state: 'waiting', text: `着順は当日の全レース終了後${eta ? `（${eta}）` : ''}に表示されます` } : { state: 'none' };
}

/**
 * 1 レースの全頭の表示行（馬番順・強調なし）と、値を出せない理由。
 * fail closed:
 *   - 評価待ち（KAP の判断前・予測なし）→ 行を出さない
 *   - 発走前で、データの受信 or オッズの観測が STALE_MS より古い → オッズ・期待値を出さない（AI 勝率だけ）
 *   - オッズの観測時刻が無い → オッズ・期待値を出さない
 * @param {object} race   保存済みのレース
 * @param {{ nowMs: number, receivedAt?: string|null }} opts
 */
export function raceDisplay(race, { nowMs, receivedAt = null } = {}) {
  const started = isoMs(race?.startAt) != null && isoMs(race.startAt) <= nowMs;
  if (!race || race.status !== 'ok' || !Array.isArray(race.field) || race.field.length === 0) {
    // 判断時刻（発走 10 分前）を過ぎたのに未着 = 取込待ち（送信は 2 分ごと）。それより前は「10 分前に出ます」
    const pastDecision = isoMs(race?.startAt) != null && nowMs >= isoMs(race.startAt) - DECISION_LEAD_MIN * 60 * 1000;
    return { state: 'pending', rows: [], started, valuesShown: false, oddsNote: null,
      message: started ? 'このレースの AI の評価はありません'
        : pastDecision ? 'AI の評価を取り込んでいます（まもなく表示されます）'
          : `AI の評価は発走の約 ${DECISION_LEAD_MIN} 分前に出ます` };
  }
  const recvMs = isoMs(receivedAt);
  const obsMs = isoMs(race.oddsObservedAt);
  let valuesShown = obsMs != null;
  let message = obsMs == null ? 'オッズを取得できていません' : null;
  if (!started && obsMs != null) {
    if (recvMs == null || nowMs - recvMs > STALE_MS) { valuesShown = false; message = 'データの更新が止まっているため、オッズ・期待値の表示を止めています'; }
    else if (nowMs - obsMs > STALE_MS) { valuesShown = false; message = 'オッズの更新を待っています'; }
  }
  const rows = race.field.map((h) => ({
    n: h.n,
    name: h.name || '',
    p: h.p == null ? '-' : `${(h.p * 100).toFixed(1)}%`,
    odds: valuesShown ? fixed(h.odds, 1) : '-',
    ev: valuesShown && h.odds != null ? fixed(h.ev, 2) : '-',
    mark: typeof h.mark === 'string' ? h.mark : '',
    rank: rankOf(race.result, h.n),
  }));
  const basis = race.oddsBasis === 'decision' ? `判断時刻（発走${DECISION_LEAD_MIN}分前）時点のオッズ`
    : race.oddsBasis === 'latest' ? '最新のオッズ' : 'オッズ';
  return {
    state: 'ok', rows, started, valuesShown, message,
    oddsNote: !valuesShown ? null
      : started && race.oddsBasis === 'decision'
        ? `オッズ・期待値は発走${DECISION_LEAD_MIN}分前（${jstHm(race.oddsObservedAt)} 観測）の値です。発走後は更新しません`
        : `${basis}（${jstHm(race.oddsObservedAt)} 観測）`,
  };
}
