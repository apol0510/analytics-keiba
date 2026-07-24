/**
 * Premium Plus 結果台帳 単一源（純粋・Node/SSR/ブラウザ安全）
 *
 * Premium Plus は「1 日 1 鞍・三連単フォーメーション」の単品商品。実際に配信した買い目と
 * その結果を、投票内容照会そっくりの見た目で毎日公開する。
 *
 * 設計原則:
 * - データは git コミットされた `src/data/premiumPlusResults.json`（1 日 1 件）を読む。
 *   **Netlify Blobs は使わない**（同一キー last-write-wins で lost-update が起きるため）。
 *   git は単一書き手なので競合が起きない。管理画面 → GitHub commit → Netlify 自動ビルド。
 * - 実績数値（的中率・回収率・最高払戻）は `premiumPlusShowcase.js` の computeStats() を
 *   再利用する（手書き禁止）。10 鞍未満は自動非表示。
 * - Airtable / Netlify Blobs / DOM に依存しない純粋モジュール。
 *
 * 会場サーキット:
 *   平日 = 南関（SPAT4）／土日 = 中央（JRA）。開催が重なる日も台帳の会場を優先。
 *   entry.circuit が明示されていればそれを使い、無ければ曜日から導出する。
 */

import { computeStats, formatYen, formatShortDate, STATS_WINDOW, MIN_RATE_SAMPLE } from './premiumPlusShowcase.js';

export { computeStats, formatYen, formatShortDate, STATS_WINDOW, MIN_RATE_SAMPLE };

/** 1 点あたりの投票額（円）。合計金額 = 点数 × これ。 */
export const UNIT_STAKE = 1000;

/** ページの実績カードに出す最大件数（最新から） */
export const CARD_LIMIT = 8;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** "3,4,5" / "3 4 5" / [3,4,5] / [" 03 ", 4] → [3,4,5]（1〜28 の整数のみ・重複除去・昇順ではなく入力順維持） */
export function toHorseNumbers(v) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[,\s.・]+/);
  else if (v == null) arr = [];
  else arr = [v];
  const out = [];
  for (const x of arr) {
    const n = toInt(x);
    if (n >= 1 && n <= 28 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 曜日から導出（土日=中央 / 平日=南関）。date は YYYY-MM-DD。 */
export function circuitFromDate(date) {
  if (!DATE_RE.test(String(date))) return 'nankan';
  const [y, m, d] = String(date).split('-').map(Number);
  // JST の暦日で曜日判定（UTC 基準の Date でも曜日は日付だけで決まるので安全）
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日,6=土
  return day === 0 || day === 6 ? 'chuo' : 'nankan';
}

/** 三連単フォーメーションの点数 = 相異なる (1着,2着,3着) の組合せ数。 */
export function computePoints(first, second, third) {
  const F = toHorseNumbers(first), S = toHorseNumbers(second), T = toHorseNumbers(third);
  let n = 0;
  for (const a of F) for (const b of S) for (const c of T) {
    if (a !== b && a !== c && b !== c) n++;
  }
  return n;
}

/**
 * 入力 1 件を正規化する。date / 買い目が不正なら null（台帳に入れない）。
 */
export function normalizeResult(input) {
  if (!input || typeof input !== 'object') return null;
  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (!DATE_RE.test(date)) return null;

  const first = toHorseNumbers(input.first);
  const second = toHorseNumbers(input.second);
  const third = toHorseNumbers(input.third);
  if (first.length !== 1 || second.length < 1 || third.length < 1) return null; // 1着は1頭固定

  const circuit = input.circuit === 'chuo' || input.circuit === 'nankan' ? input.circuit : circuitFromDate(date);
  const points = computePoints(first, second, third);
  const payout = Math.max(0, toInt(input.payout));
  const isHit = toBool(input.isHit) || payout > 0;
  // 1 点あたりの購入金額（管理画面で選択）。未指定・不正は既定 UNIT_STAKE(1000)。
  const unitStakeRaw = toInt(input.unitStake);
  const unitStake = unitStakeRaw > 0 ? unitStakeRaw : UNIT_STAKE;

  return {
    date,
    circuit,
    venue: typeof input.venue === 'string' ? input.venue.trim() : '',
    raceNumber: toInt(input.raceNumber) || null,
    raceName: typeof input.raceName === 'string' ? input.raceName.trim() : '',
    first, second, third,
    points,
    unitStake,
    stake: points * unitStake,
    isHit,
    payout: isHit ? payout : 0,
    hitCombo: isHit && typeof input.hitCombo === 'string' ? input.hitCombo.trim() : '',
    unitPayout: isHit ? Math.max(0, toInt(input.unitPayout)) : 0,
    // 投票内容照会の受付ヘッダ（そっくりカードの再現度用・任意）。管理者が実スクショから
    // 受付番号 / 受付日時 をそのまま書き写す。未入力なら受付番号行は出さず、受付日時は
    // 開催日にフォールバック（推測値を作らない）。購入件数は常に 1件（1日1鞍）。
    receiptNo: typeof input.receiptNo === 'string' ? input.receiptNo.trim() : '',
    receiptAt: typeof input.receiptAt === 'string' ? input.receiptAt.trim() : '',
    imageFile: typeof input.imageFile === 'string' && input.imageFile.trim() ? input.imageFile.trim() : null,
    legacy: toBool(input.legacy),
    uploadedAt: typeof input.uploadedAt === 'string' ? input.uploadedAt : '',
  };
}

/** 日付降順（同日は uploadedAt 降順）。最新が index 0。 */
export function sortResults(entries) {
  return [...(entries || [])].filter(Boolean).sort((a, b) =>
    a.date === b.date ? String(b.uploadedAt).localeCompare(String(a.uploadedAt)) : b.date.localeCompare(a.date)
  );
}

/** 同じ日付は 1 件（後勝ち）。撮り直し・入力ミスの上書きが効く。 */
export function upsertResult(entries, entry) {
  const n = normalizeResult(entry);
  if (!n) return sortResults(entries);
  const rest = (entries || []).filter((e) => e && e.date !== n.date);
  return sortResults([...rest, n]);
}

export function removeResult(entries, date) {
  return sortResults((entries || []).filter((e) => e && e.date !== date));
}

/** 2桁ゼロ埋め表記（06 / 11）。投票内容照会の馬番表示に使う。 */
export function pad2(n) {
  const v = toInt(n);
  return v < 10 ? `0${v}` : `${v}`;
}

/**
 * 1 件を「投票内容照会カード + 左の買い目チップ」描画用データへ整形する。
 * service: 'spat4'（南関）/ 'jra'（中央）。
 */
export function deriveCard(entry) {
  const e = normalizeResult(entry);
  if (!e) return null;
  const service = e.circuit === 'chuo' ? 'jra' : 'spat4';
  const winner = e.hitCombo || '';
  return {
    ...e,
    service,
    firstPad: e.first.map(pad2),
    secondPad: e.second.map(pad2),
    thirdPad: e.third.map(pad2),
    // 表示用の会場+R（「大井11R」）
    raceLabel: `${e.venue}${e.raceNumber ? `${e.raceNumber}R` : ''}`.trim(),
    winnerCombo: winner,
  };
}

/** 実績カードに出す直近件数分（最新順）。 */
export function latestCards(entries, { limit = CARD_LIMIT } = {}) {
  return sortResults(entries).slice(0, Math.max(0, limit)).map(deriveCard).filter(Boolean);
}

/** ¥1,234,567 → 短縮（¥1.21M / ¥132k / ¥0）。レジャー帯の payout 表示用。 */
export function formatYenShort(value) {
  const v = toInt(value);
  if (v >= 1000000) return `¥${(v / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1000) return `¥${Math.round(v / 1000)}k`;
  return `¥${v}`;
}
