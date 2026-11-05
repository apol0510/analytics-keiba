#!/usr/bin/env node
/**
 * 馬単の期待値フィルターを、購入可能時点のオッズで過去検証する（読み取り専用）。
 *   node scripts/verify-ev-filter.mjs --market nankan --out /tmp/ev-nankan.json
 *   node scripts/verify-ev-filter.mjs --prereg docs/prereg/ak-ev-filter-jra-v1.json --ledger /path/ledger.jsonl
 *     事前登録した規則を forwardFrom 以降のレースだけで判定する。閾値は変えない。
 *
 * 後付けを防ぐ固定の手順:
 *   - 判定は発走 DECISION_LEAD_MIN 分前。それより後に観測したオッズは読まない。
 *   - 確率は対象日より前のレースだけで学習する（日付ごとに学習し直す）。
 *   - 予想データは判定時刻より後に作られたものを使わない。
 *   - 閾値は開発期間（〜DEV_END）だけで選び、検証期間（それ以降）では選び直さない。
 *   - 精算は実際の払戻。オッズの値は出力しない（集計値だけ）。
 * 入力: keiba-data-shared（予想・結果）、market_tick.v1（--tick-root）、AK の買い目（archive）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import { umatanTickets } from '../src/lib/results/umatanHit.js';
import {
  asOfOdds, exactaProbs, fitConditionalLogit, fitLambda, forwardVerdict, selectTickets, settleTickets,
  seededRandom, summarize, ticketEvs, winProbs, zscore,
} from '../src/lib/results/evFilter.js';

export const DECISION_LEAD_MIN = 10;
export const MAX_ODDS_AGE_MIN = 30;
export const DEV_END = '2026-10-19';
export const THRESHOLDS = [1.0, 1.1, 1.2, 1.3, 1.5, 2.0];
export const P_MIN = 0.005;
export const ODDS_MAX = 100;
export const MIN_BLEND_RACES = 100;
export const MIN_DEV_RACES = 30;
export const MIN_DEV_HITS = 5;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'src', 'data');
const VAN = join(homedir(), 'keiba-van-export');

const MARKETS = {
  nankan: {
    archive: 'archiveResults.json',
    tickRoots: [join(VAN, 'market-ticks-web', 'keiba_go_jp_web', 'markets', 'nankan', 'hot')],
    venue: { FU: '船橋', OI: '大井', KA: '川崎', UR: '浦和' },
  },
  jra: {
    archive: 'archiveResultsJra.json',
    tickRoots: [join(VAN, 'market-ticks', 'warm'), join(VAN, 'market-ticks', 'hot')],
    venue: { '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京', '06': '中山', '07': '中京', '08': '京都', '09': '阪神', 10: '小倉' },
  },
};

const raceKey = (date, venue, number) => `${date}#${String(venue).replace(/競馬場?$/, '').trim()}#${Number(number)}`;
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : NaN;
};

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

/** レース前の指数・印。作成時刻を残し、判定時刻より後のものは後で捨てる */
function loadInputs(shared, market) {
  const races = new Map();
  const slot = (key) => {
    if (!races.has(key)) races.set(key, { horses: new Map(), createdAt: 0 });
    return races.get(key);
  };
  for (const f of jsonFiles(join(shared, market, 'predictions', 'computer'))) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    for (const r of d.races || []) {
      const s = slot(raceKey(d.date, d.venue, r.raceNumber));
      s.createdAt = Math.max(s.createdAt, Date.parse(d.createdAt) || Infinity);
      s.startTime = r.startTime;
      for (const h of r.horses || []) {
        s.horses.set(Number(h.number), { ...(s.horses.get(Number(h.number)) || {}), index: num(h.computerIndex) });
      }
    }
  }
  for (const f of jsonFiles(join(shared, market, 'racebook'))) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    for (const r of d.races || []) {
      const s = slot(raceKey(d.date, d.track, r.raceNumber));
      const created = Date.parse(d.createdAt);
      for (const h of r.horses || []) {
        const prev = s.horses.get(Number(h.number)) || {};
        s.horses.set(Number(h.number), {
          ...prev,
          index: Number.isFinite(prev.index) ? prev.index : num(h.computerIndex),
          score: created ? num(h.totalScore) : NaN,
        });
      }
      s.racebookCreatedAt = created;
    }
  }
  return races;
}

/** 着順と馬単の払戻 */
function loadResults(shared, market) {
  const out = new Map();
  for (const f of jsonFiles(join(shared, market, 'results'))) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    for (const r of d.races || []) {
      const rows = (r.results || [])
        .map((x) => ({ number: Number(x.number), rank: Number(x.rank ?? x.position) }))
        .filter((x) => x.rank >= 1)
        .sort((a, b) => a.rank - b.rank);
      if (rows.length < 2) continue;
      const payouts = new Map();
      for (const p of r.payouts?.umatan || []) {
        const m = String(p.combination).match(/(\d+)\D+(\d+)/);
        if (m && p.payout > 0) payouts.set(`${Number(m[1])}>${Number(m[2])}`, Number(p.payout));
      }
      out.set(raceKey(d.date, r.venue || d.venue, r.raceNumber), {
        date: d.date, first: rows[0].number, second: rows[1].number, payouts,
      });
    }
  }
  return out;
}

function loadAkTickets(market) {
  const out = new Map();
  const entries = JSON.parse(readFileSync(join(DATA, MARKETS[market].archive), 'utf8'));
  for (const e of entries) {
    for (const r of e.races || []) {
      const lines = Array.isArray(r.bettingLines) ? r.bettingLines : r.bettingLines?.umatan;
      const tickets = umatanTickets(lines, { includeOsae: true });
      if (!tickets.size) continue;
      out.set(raceKey(e.date, r.venue || e.venue, parseInt(r.raceNumber, 10)), [...tickets]);
    }
  }
  return out;
}

function readTicks(path) {
  const text = path.endsWith('.gz') ? gunzipSync(readFileSync(path)).toString('utf8') : readFileSync(path, 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function tickFile(dir, spec) {
  for (const name of [`${spec}.ticks.jsonl`, `${spec}.ticks.jsonl.gz`]) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** 判定時刻のオッズを読む。判定時刻より前の観測が無い／古いレースは対象外にする */
function loadMarket(market) {
  const out = new Map();
  const stats = { tickRaces: 0, noDecisionSnapshot: 0, staleSnapshot: 0 };
  for (const root of MARKETS[market].tickRoots) {
    if (!existsSync(root)) continue;
    for (const date of readdirSync(root).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      for (const raceId of readdirSync(join(root, date))) {
        const dir = join(root, date, raceId);
        const exactaFile = tickFile(dir, '0B34');
        const winFile = tickFile(dir, '0B31');
        if (!exactaFile || !winFile) continue;
        stats.tickRaces += 1;
        const raw = readTicks(exactaFile);
        const start = Date.parse(raw.find((t) => t.race_start_at)?.race_start_at);
        if (!Number.isFinite(start)) { stats.noDecisionSnapshot += 1; continue; }
        const decisionMs = start - DECISION_LEAD_MIN * 60000;
        const shape = (rows, betType, norm) => rows.filter((t) => t.bet_type === betType).map((t) => ({
          selection: norm(t.selection),
          odds: Number(t.odds),
          ok: t.odds_status === 'ok',
          observedAt: Date.parse(t.observed_at),
        }));
        const exactaRows = shape(raw, 'exacta', (s) => s.split('>').map(Number).join('>'));
        const before = exactaRows.filter((t) => t.observedAt <= decisionMs);
        if (!before.length) { stats.noDecisionSnapshot += 1; continue; }
        if (decisionMs - Math.max(...before.map((t) => t.observedAt)) > MAX_ODDS_AGE_MIN * 60000) { stats.staleSnapshot += 1; continue; }
        const exacta = asOfOdds(exactaRows, decisionMs);
        const win = asOfOdds(shape(readTicks(winFile), 'win', (s) => String(Number(s))), decisionMs);
        const venue = MARKETS[market].venue[raceId.split('-')[3]];
        const number = Number(raceId.split('-')[4]);
        if (venue) out.set(raceKey(date, venue, number), { decisionMs, exacta, win });
      }
    }
  }
  return { byRace: out, stats };
}

/** 指数・総合点をレース内で標準化した特徴量。判定時刻の前に無い入力は使わない */
function featuresOf(input, numbers) {
  const rows = numbers.map((n) => input.horses.get(n) || {});
  const index = zscore(rows.map((h) => h.index));
  const score = zscore(rows.map((h) => h.score));
  return numbers.map((_, i) => [index[i], score[i]]);
}

function buildDataset(market, shared) {
  const inputs = loadInputs(shared, market);
  const results = loadResults(shared, market);
  const races = [];
  let dropped = 0;
  for (const [key, res] of results) {
    const input = inputs.get(key);
    if (!input || input.horses.size < 3) { dropped += 1; continue; }
    const numbers = [...input.horses.keys()].sort((a, b) => a - b);
    const winner = numbers.indexOf(res.first);
    if (winner < 0 || !numbers.includes(res.second)) { dropped += 1; continue; }
    races.push({ key, date: res.date, numbers, input, features: featuresOf(input, numbers), winner, ...res });
  }
  races.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return { races, dropped };
}

/** 市場の勝率（単勝オッズの逆数を合計 1 に直したもの） */
function marketWin(numbers, win) {
  const raw = numbers.map((n) => (win.get(String(n)) ? 1 / win.get(String(n)) : 0));
  const total = raw.reduce((s, v) => s + v, 0);
  if (!total || raw.some((v) => v === 0)) return null;
  return raw.map((v) => v / total);
}

const logp = (p) => Math.log(Math.max(p, 1e-6));

/** 対象日より前だけで学習し、その日のレースの確率を返す */
function walkForward(dataset, oddsByRace) {
  const scored = [];
  const dates = [...new Set(dataset.races.filter((r) => oddsByRace.has(r.key)).map((r) => r.date))].sort();
  let beta;
  for (const date of dates) {
    const past = dataset.races.filter((r) => r.date < date);
    beta = fitConditionalLogit(past, { initial: beta, iterations: beta ? 60 : 300 });
    const pastProbs = past.map((r) => ({ ...r, pWin: winProbs(r.features, beta) }));
    const lambda = fitLambda(pastProbs);

    // 混合: 勝率と市場の勝率の対数を、過去のオッズ付きレースだけで重み付けする
    const pastBlend = pastProbs.flatMap((r) => {
      const o = oddsByRace.get(r.key);
      const m = o && marketWin(r.numbers, o.win);
      return m ? [{ winner: r.winner, numbers: r.numbers, first: r.first, second: r.second, features: r.pWin.map((p, i) => [logp(p), logp(m[i])]) }] : [];
    });
    const blend = pastBlend.length >= MIN_BLEND_RACES ? fitConditionalLogit(pastBlend, { initial: [0.2, 0.8], iterations: 200, rate: 0.2 }) : null;
    const blendLambda = blend ? fitLambda(pastBlend.map((r) => ({ ...r, pWin: winProbs(r.features, blend) }))) : null;

    for (const r of dataset.races.filter((x) => x.date === date && oddsByRace.has(x.key))) {
      const odds = oddsByRace.get(r.key);
      const usable = !(r.input.createdAt > odds.decisionMs);
      if (!usable) continue;
      const pAk = winProbs(r.features, beta);
      const models = { ak: exactaProbs(r.numbers, pAk, lambda) };
      const m = marketWin(r.numbers, odds.win);
      if (blend && m) models.blend = exactaProbs(r.numbers, winProbs(pAk.map((p, i) => [logp(p), logp(m[i])]), blend), blendLambda);
      scored.push({ ...r, odds, models });
    }
  }
  return scored;
}

/**
 * 検証の検査。組の向きや結合を間違えると EV が無意味になるので、数字を読む前に確かめる。
 *   oddsToPayoutMedian: 的中組の 判定時点オッズ×100 ÷ 実払戻 の中央値（1 付近でなければ結合が壊れている）
 *   logLoss: 実際の 1・2 着の組の対数損失。market は馬単オッズの逆数を合計 1 に直したもの
 *   calibration: EV の帯ごとの 予測的中数 と 実的中数（全組の範囲）
 */
export function diagnostics(scored) {
  const ratios = [];
  const blendGain = [];
  const loss = { market: [], ak: [], blend: [], marketOnBlendRaces: [] };
  const bands = [[0, 0.8], [0.8, 1], [1, 1.2], [1.2, 1.5], [1.5, 2], [2, Infinity]];
  const calibration = { ak: bands.map(() => ({ tickets: 0, expected: 0, hits: 0 })), blend: bands.map(() => ({ tickets: 0, expected: 0, hits: 0 })) };
  for (const r of scored) {
    const winning = `${r.first}>${r.second}`;
    const o = r.odds.exacta.get(winning);
    const paid = r.payouts.get(winning);
    if (o && paid) ratios.push((o * 100) / paid);
    const implied = [...r.odds.exacta.values()].reduce((s, v) => s + 1 / v, 0);
    if (o) loss.market.push(-Math.log(1 / o / implied));
    if (o && r.models.blend) {
      loss.marketOnBlendRaces.push(-Math.log(1 / o / implied));
      blendGain.push(-Math.log(1 / o / implied) + Math.log(Math.max(r.models.blend.get(winning) ?? 0, 1e-9)));
    }
    for (const name of ['ak', 'blend']) {
      const probs = r.models[name];
      if (!probs) continue;
      loss[name].push(-Math.log(Math.max(probs.get(winning) ?? 0, 1e-9)));
      for (const [ticket, odds] of r.odds.exacta) {
        const p = probs.get(ticket);
        if (p == null) continue;
        const ev = p * odds;
        const b = calibration[name][bands.findIndex(([lo, hi]) => ev >= lo && ev < hi)];
        b.tickets += 1;
        b.expected += p;
        if (ticket === winning) b.hits += 1;
      }
    }
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const sorted = [...ratios].sort((a, b) => a - b);
  const random = seededRandom(20261106);
  const gains = Array.from({ length: 2000 }, () => mean(blendGain.map(() => blendGain[Math.floor(random() * blendGain.length)]))).sort((a, b) => a - b);
  return {
    blendGainOverMarket: { mean: mean(blendGain), ci95: [gains[50], gains[1949]], races: blendGain.length },
    oddsToPayoutMedian: sorted[Math.floor(sorted.length / 2)] ?? null,
    oddsToPayoutRaces: sorted.length,
    logLoss: { market: mean(loss.market), ak: mean(loss.ak), blend: mean(loss.blend), marketOnBlendRaces: mean(loss.marketOnBlendRaces) },
    calibration: Object.fromEntries(Object.entries(calibration).map(([name, rows]) => [name, rows.map((b, i) => ({ evBand: bands[i].map(String).join('-'), ...b }))])),
  };
}

function evaluate(scored, akTickets, spec) {
  const rows = [];
  const oddsLimits = { pMin: spec.pMin ?? P_MIN, oddsMax: spec.oddsMax ?? ODDS_MAX };
  for (const r of scored) {
    const probs = r.models[spec.model];
    if (!probs) continue;
    const universe = spec.universe === 'all' ? [...r.odds.exacta.keys()] : akTickets.get(r.key);
    if (!universe) continue;
    const evs = ticketEvs(universe, probs, r.odds.exacta);
    const tickets = selectTickets(evs, { rule: spec.rule, threshold: spec.threshold, ...oddsLimits });
    rows.push({ date: r.date, key: r.key, tickets, ...settleTickets(tickets, r.payouts) });
  }
  return rows;
}

export function buildSpecs() {
  const specs = [];
  for (const model of ['ak', 'blend']) {
    for (const threshold of THRESHOLDS) {
      specs.push({ model, universe: 'ak', rule: 'ticket', threshold });
      specs.push({ model, universe: 'ak', rule: 'race', threshold });
      specs.push({ model, universe: 'all', rule: 'ticket', threshold });
    }
  }
  return specs;
}

/** 開発期間の成績だけで選ぶ。検証期間の値は見ない */
export function chooseOnDev(results) {
  const eligible = results.filter((r) => r.dev.races >= MIN_DEV_RACES && r.dev.hits >= MIN_DEV_HITS);
  return [...eligible].sort((a, b) => b.dev.roi - a.dev.roi)[0] ?? null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 事前登録した規則を forwardFrom 以降だけで判定する。買い目の判定は ledger に残す（オッズの値は残さない） */
function runForward(prereg, shared, ledger, out) {
  const dataset = buildDataset(prereg.market, shared);
  const { byRace } = loadMarket(prereg.market);
  const rows = evaluate(walkForward(dataset, byRace), loadAkTickets(prereg.market), prereg.rule)
    .filter((r) => r.date >= prereg.forwardFrom);
  const summary = summarize(rows);
  const report = {
    id: prereg.id,
    forwardFrom: prereg.forwardFrom,
    judgedRaces: rows.length,
    summary,
    verdict: forwardVerdict(summary, prereg.checkpoint),
    checkpoint: prereg.checkpoint,
  };
  if (ledger) writeFileSync(ledger, rows.map((r) => JSON.stringify({ id: prereg.id, ...r })).join('\n') + (rows.length ? '\n' : ''));
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

function main() {
  const prereg = arg('prereg');
  if (prereg) {
    runForward(JSON.parse(readFileSync(prereg, 'utf8')), arg('shared', join(HERE, '..', '..', '..', '..', 'keiba-data-shared')), arg('ledger'), arg('out'));
    return;
  }
  const market = arg('market', 'nankan');
  if (!MARKETS[market]) throw new Error(`unknown market: ${market}`);
  const shared = arg('shared', join(HERE, '..', '..', '..', '..', 'keiba-data-shared'));
  const out = arg('out');
  const forwardFrom = arg('forward-from');

  const dataset = buildDataset(market, shared);
  const { byRace, stats } = loadMarket(market);
  const akTickets = loadAkTickets(market);
  const scored = walkForward(dataset, byRace);

  const results = buildSpecs().map((spec) => {
    const rows = evaluate(scored, akTickets, spec);
    return {
      spec,
      dev: summarize(rows.filter((r) => r.date <= DEV_END)),
      holdout: summarize(rows.filter((r) => r.date > DEV_END)),
      ...(forwardFrom ? { forward: summarize(rows.filter((r) => r.date >= forwardFrom)) } : {}),
    };
  });

  const baselineRows = scored.flatMap((r) => {
    const t = akTickets.get(r.key);
    return t ? [{ date: r.date, ...settleTickets(t, r.payouts) }] : [];
  });

  // AI 事前選定の予測期待回収率（判定時点のオッズ）と実現回収率。別の指標なので別々に出す
  const selected = new Map();
  for (const e of JSON.parse(readFileSync(join(DATA, MARKETS[market].archive), 'utf8'))) {
    for (const r of e.races || []) if (r.aiSelect?.tickets) selected.set(raceKey(e.date, r.venue || e.venue, parseInt(r.raceNumber, 10)), r.aiSelect.tickets.map((t) => t.replace('-', '>')));
  }
  const aiSelect = {};
  for (const model of ['ak', 'blend']) {
    let points = 0; let expected = 0; let payout = 0; let races = 0;
    for (const r of scored) {
      const tickets = selected.get(r.key);
      const probs = r.models[model];
      if (!tickets || !probs) continue;
      const evs = ticketEvs(tickets, probs, r.odds.exacta);
      if (!evs.length) continue;
      races += 1;
      points += evs.length;
      expected += evs.reduce((s, e) => s + e.ev, 0);
      payout += settleTickets(evs.map((e) => e.ticket), r.payouts).payout;
    }
    aiSelect[model] = { races, points, expectedRecovery: points ? expected / points : null, realizedRecovery: points ? payout / (points * 100) : null };
  }

  const report = {
    market,
    aiSelect,
    decisionLeadMinutes: DECISION_LEAD_MIN,
    devEnd: DEV_END,
    coverage: {
      trainingRaces: dataset.races.length,
      droppedWithoutInputs: dataset.dropped,
      ...stats,
      racesWithDecisionOdds: byRace.size,
      scoredRaces: scored.length,
      scoredWithAkTickets: scored.filter((r) => akTickets.has(r.key)).length,
      dates: [scored[0]?.date, scored.at(-1)?.date],
    },
    baselineAllAkTickets: {
      dev: summarize(baselineRows.filter((r) => r.date <= DEV_END)),
      holdout: summarize(baselineRows.filter((r) => r.date > DEV_END)),
    },
    diagnostics: diagnostics(scored),
    chosenOnDev: chooseOnDev(results),
    results,
  };
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
  console.log(`[${market}]`, JSON.stringify(report.coverage));
  console.log(JSON.stringify(report.diagnostics));
  console.log('AI 事前選定', JSON.stringify(report.aiSelect));
  console.log('全買い目（基準）: 開発', pct(report.baselineAllAkTickets.dev.roi), '検証', pct(report.baselineAllAkTickets.holdout.roi));
  for (const r of results) {
    console.log([r.spec.model, r.spec.universe, r.spec.rule, r.spec.threshold,
      `開発 ${r.dev.races}R ${r.dev.hits}的中 ${pct(r.dev.roi)}`,
      `検証 ${r.holdout.races}R ${r.holdout.hits}的中 ${pct(r.holdout.roi)}`].join(' | '));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
