/**
 * premiumPlusDelivery.js — Premium Plus の「当日の提供レース＋三連単18点」（純粋・I/O なし）
 *
 * ## 何をするか（2026-10-04 MK 決定）
 *
 * - 購入者のマイページに、対象日の提供レースと公開予定時刻（**発走予定の10分前**）を出す。
 * - 三連単は**既存の予想データから自動生成**（18点・高配当寄り）。MK の手入力は不要。
 * - 公開前の買い目は**サーバーが一切返さない**（`buildMemberView` が公開時刻で切る）。
 *   ページに埋め込んで隠す方式は、ソースを見れば読めるので採らない。
 *
 * ## 自動生成のルール（auto-v1）
 *
 * 1. **レース選定**: その日の対象開催（土日=中央 / 平日=南関。無ければもう一方）のうち、
 *    公開時刻が生成時点から 30 分以上先のレースで「**混戦度**」が最も高いもの。
 *    混戦度 = コンピ1位の指数が低い・1位と2位の差が小さい・頭数が多い。
 *    人気が割れるレースほど三連単の配当が上がる（過去 3,431 レースの検証で、
 *    コンピ1位 <80 / 1-2位差 <5 / 14頭以上のレース群が回収率で最上位だった）。
 * 2. **フォーメーション**: 1着 = 分析スコア(pt)1位 / 2着 = pt 2〜4位の3頭 /
 *    3着 = pt 2〜8位の7頭 → 1 × 3 × 6 = **18点**。
 *
 * ⚠️ 生成は 1 日 1 回で**上書きしない**（HSETNX）。公開後に買い目が変わる事故を構造的に防ぐ。
 */

export const PP_DELIVERY_RULE = 'auto-v1';
export const PP_RACES_PER_DAY = 1;
export const PP_REVEAL_LEAD_MIN = 10;
export const PP_FORMATION_POINTS = 18;
/** 生成時点から公開まで最低これだけ空いているレースだけを選ぶ */
export const PP_MIN_LEAD_BEFORE_REVEAL_MIN = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の日付 YYYY-MM-DD */
export function jstDate(nowMs, addDays = 0) {
  return new Date(nowMs + JST_OFFSET_MS + addDays * 86400000).toISOString().slice(0, 10);
}

/** 発走予定（JST の日付＋HH:MM）の epoch ms。読めなければ null */
export function startAtMs(date, startTime) {
  const m = TIME_RE.exec(String(startTime || '').trim());
  if (!DATE_RE.test(String(date || '')) || !m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const ms = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${m[2]}:00+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function revealAtMs(date, startTime) {
  const s = startAtMs(date, startTime);
  return s === null ? null : s - PP_REVEAL_LEAD_MIN * 60 * 1000;
}

/** 土日 = 中央を優先、平日 = 南関を優先 */
export function preferredCircuit(date) {
  const dow = new Date(`${date}T12:00:00+09:00`).getUTCDay();
  return dow === 0 || dow === 6 ? 'jra' : 'nankan';
}

function ci(h) {
  const v = Number(h.sourceComputerIndex ?? h.computerIndex);
  return Number.isFinite(v) ? v : 0;
}

function toRace(p, { date, circuit, venue }) {
  const ri = p?.raceInfo || {};
  const all = Array.isArray(p?.horses) ? p.horses : [];
  const horses = all
    .filter((h) => Number.isInteger(Number(h.horseNumber)) && Number(h.horseNumber) > 0
      && String(h.horseName || '').trim() !== '' && h.role !== '無')
    .map((h) => ({ n: Number(h.horseNumber), pt: Number(h.pt) || 0, ci: ci(h) }));
  return {
    date,
    circuit,
    venue: String(ri.venue || venue || ''),
    raceNumber: Number(ri.raceNumber),
    raceName: String(ri.raceName || ''),
    startTime: String(ri.startTime || ''),
    fieldSize: all.length,
    horses,
  };
}

/**
 * 予想 JSON を共通形へ。
 * - 南関: `{ predictions: [...] }`（1 会場 1 ファイル）
 * - 中央: `{ venues: [{ venue, predictions: [...] }] }`（1 日 1 ファイル）
 */
export function normalizePredictionFile(json, { date, circuit }) {
  if (!json || typeof json !== 'object') return [];
  const out = [];
  if (Array.isArray(json.venues)) {
    for (const v of json.venues) {
      for (const p of v?.predictions || []) out.push(toRace(p, { date, circuit, venue: v?.venue }));
    }
  } else if (Array.isArray(json.predictions)) {
    for (const p of json.predictions) out.push(toRace(p, { date, circuit }));
  }
  return out.filter((r) => Number.isInteger(r.raceNumber) && r.raceNumber > 0);
}

/** 混戦度（小さいほど混戦＝高配当寄り） */
export function chaosScore(race) {
  const cis = race.horses.map((h) => h.ci).sort((a, b) => b - a);
  const top = cis[0] || 0;
  const gap = top - (cis[1] || 0);
  return top + gap * 2 - race.fieldSize;
}

/** 18点フォーメーション。作れない（8頭未満・pt 欠落）なら null */
export function buildFormation(race) {
  const hs = [...race.horses].sort((a, b) => (b.pt - a.pt) || (b.ci - a.ci) || (a.n - b.n));
  if (hs.length < 8 || hs[0].pt <= 0) return null;
  const first = [hs[0].n];
  const second = hs.slice(1, 4).map((h) => h.n);
  const third = hs.slice(1, 8).map((h) => h.n);
  const points = first.length * second.length * (third.length - 1);
  if (points !== PP_FORMATION_POINTS) return null;
  return { first, second, third, points };
}

/**
 * その日の提供レースを決める（副作用なし）。
 * @param {{ saleDate:string, racesByCircuit:{jra?:object[], nankan?:object[]}, nowMs:number, count?:number }} input
 * @returns {{ ok:true, delivery:object } | { ok:false, reason:string }}
 */
export function planDelivery({ saleDate, racesByCircuit, nowMs, count = PP_RACES_PER_DAY }) {
  if (!DATE_RE.test(String(saleDate || ''))) return { ok: false, reason: 'invalid_date' };
  const pref = preferredCircuit(saleDate);
  const order = pref === 'jra' ? ['jra', 'nankan'] : ['nankan', 'jra'];
  const minReveal = nowMs + PP_MIN_LEAD_BEFORE_REVEAL_MIN * 60 * 1000;
  for (const circuit of order) {
    const candidates = (racesByCircuit?.[circuit] || [])
      .filter((r) => r.date === saleDate)
      .map((r) => ({ r, reveal: revealAtMs(r.date, r.startTime), formation: buildFormation(r) }))
      .filter((x) => x.reveal !== null && x.reveal >= minReveal && x.formation);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => (chaosScore(a.r) - chaosScore(b.r))
      || (b.r.fieldSize - a.r.fieldSize) || (a.reveal - b.reveal));
    const picked = candidates.slice(0, Math.max(1, count))
      .sort((a, b) => a.reveal - b.reveal)
      .map(({ r, reveal, formation }) => ({
        circuit,
        venue: r.venue,
        raceNumber: r.raceNumber,
        raceName: r.raceName,
        startTime: r.startTime,
        revealAtMs: reveal,
        betType: '三連単フォーメーション',
        ...formation,
      }));
    return { ok: true, delivery: { v: 1, saleDate, rule: PP_DELIVERY_RULE, circuit, generatedAt: nowMs, races: picked } };
  }
  return { ok: false, reason: 'no_eligible_race' };
}

/**
 * マイページ用の表示データ。**公開時刻前のレースには買い目を入れない**（ここが唯一の関門）。
 * @param {{ orders:object[], deliveries:Record<string, object|null>, nowMs:number }} input
 */
export function buildMemberView({ orders, deliveries, nowMs }) {
  const days = [];
  for (const o of orders || []) {
    const d = deliveries?.[o.saleDate] || null;
    const races = (d?.races || []).map((r) => {
      const revealed = Number.isFinite(r.revealAtMs) && nowMs >= r.revealAtMs;
      return {
        venue: r.venue,
        raceNumber: r.raceNumber,
        raceName: r.raceName,
        startTime: r.startTime,
        revealAtMs: r.revealAtMs,
        revealed,
        ...(revealed ? { betType: r.betType, first: r.first, second: r.second, third: r.third, points: r.points } : {}),
      };
    });
    days.push({
      saleDate: o.saleDate,
      raceCount: d ? races.length : PP_RACES_PER_DAY,
      leadMinutes: PP_REVEAL_LEAD_MIN,
      status: !d ? 'preparing' : (races.every((r) => r.revealed) ? 'revealed' : 'scheduled'),
      races,
    });
  }
  days.sort((a, b) => a.saleDate.localeCompare(b.saleDate));
  return { days, serverNowMs: nowMs };
}

/** マイページに出す注文（確認済み・本番注文・対象日が今日以降） */
export function selectMemberOrders(orders, { recordId, nowMs }) {
  const today = jstDate(nowMs);
  return (orders || []).filter((o) => o && o.recordId === recordId && o.status === 'confirmed'
    && o.canary !== true && DATE_RE.test(String(o.saleDate || '')) && o.saleDate >= today);
}

/** サンクスメールを送る対象（確認済み・本番注文・対象日が今日以降） */
export function selectThanksTargets(orders, { nowMs }) {
  const today = jstDate(nowMs);
  return (orders || []).filter((o) => o && o.status === 'confirmed' && o.canary !== true
    && DATE_RE.test(String(o.saleDate || '')) && o.saleDate >= today);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatSaleDateJa(saleDate) {
  const [y, m, d] = String(saleDate).split('-').map(Number);
  const dow = '日月火水木金土'[new Date(`${saleDate}T12:00:00+09:00`).getUTCDay()];
  return `${y}年${m}月${d}日（${dow}）`;
}

/**
 * 入金確認後のサンクスメール。**買い目の点数・中身は書かない**（MK 指示）。
 * 何レースを・発走何分前に・どこで公開するかだけを伝える。
 */
export function buildThanksEmail({ fullName, saleDate, raceCount = PP_RACES_PER_DAY, siteBase }) {
  const base = String(siteBase || 'https://analytics.keiba.link').replace(/\/$/, '');
  const dashboardUrl = `${base}/dashboard/`;
  const name = String(fullName || '').trim();
  const greeting = name ? `${name} 様` : 'お客様';
  const dateJa = formatSaleDateJa(saleDate);
  const subject = '【KEIBA Analytics】Premium Plus ご購入ありがとうございます';
  const text = [
    greeting,
    '',
    'このたびは Premium Plus をご購入いただき、誠にありがとうございます。',
    'ご入金を確認いたしました。',
    '',
    `■ 提供日: ${dateJa}`,
    `■ 提供レース数: ${raceCount}レース`,
    `■ 公開時刻: 各レースの発走予定時刻の${PP_REVEAL_LEAD_MIN}分前`,
    '■ 公開場所: マイページ',
    '',
    'マイページでは、提供レースと公開予定時刻を事前にご確認いただけます。',
    '公開時刻になると、同じ画面に買い目が表示されます（再読み込みは不要です）。',
    '',
    `マイページ: ${dashboardUrl}`,
    '※ ご購入時と同じメールアドレスでログインしてください。',
    '',
    'ご不明な点は、このメールにご返信ください。',
    '',
    'KEIBA Analytics',
  ].join('\n');
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#94a3b8;font-size:14px;">${k}</td>`
    + `<td style="padding:6px 0;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600;">${v}</td></tr>`;
  const html = `<!DOCTYPE html>
<html lang="ja">
<body style="margin:0;padding:24px 12px;background:#0f172a;font-family:'Hiragino Sans','Yu Gothic',sans-serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="text-align:center;padding:8px 0 20px;">
      <div style="font-size:13px;letter-spacing:.18em;color:#38bdf8;font-weight:700;">KEIBA ANALYTICS</div>
    </div>
    <div style="background:linear-gradient(135deg,#1e293b,#3b0764);border-radius:16px 16px 0 0;padding:32px 28px 24px;text-align:center;">
      <h1 style="margin:0 0 8px;font-size:22px;color:#f8fafc;font-weight:700;">Premium Plus ご購入ありがとうございます</h1>
      <p style="margin:0;color:#e9d5ff;font-size:14px;font-weight:600;">ご入金を確認いたしました</p>
    </div>
    <div style="background:#1e293b;padding:24px 28px;border-radius:0 0 16px 16px;">
      <p style="margin:0 0 16px;color:#e2e8f0;font-size:15px;">${escapeHtml(greeting)}</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">
        ${row('提供日', escapeHtml(dateJa))}
        ${row('提供レース数', `${raceCount}レース`)}
        ${row('公開時刻', `各レースの発走予定時刻の${PP_REVEAL_LEAD_MIN}分前`)}
        ${row('公開場所', 'マイページ')}
      </table>
      <p style="margin:0 0 20px;color:#cbd5e1;font-size:14px;line-height:1.8;">
        マイページでは、提供レースと公開予定時刻を事前にご確認いただけます。<br>
        公開時刻になると、同じ画面に買い目が表示されます（再読み込みは不要です）。
      </p>
      <div style="text-align:center;margin:0 0 16px;">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:14px 28px;background:#a855f7;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">マイページを開く</a>
      </div>
      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;">
        ※ ご購入時と同じメールアドレスでログインしてください。<br>
        ご不明な点は、このメールにご返信ください。
      </p>
    </div>
  </div>
</body>
</html>`;
  return { subject, text, html };
}
