/**
 * touchMeasurement.js — 配信台帳 × イベント索引を **DeliveryKey 完全一致**で結ぶ（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 「この人はこの touch を開いたか」を、**その 1 通の記録**だけで決める。
 * 受信者単位の「最新 open 時刻」から推測すると、**古いメールを後から開いた**ときに
 * 別の touch を開封済みにしてしまう（誤帰属）。
 *
 * ── 入力 ──────────────────────────────────────────────────────
 *   deliveries … `CampaignDeliveries` の行（DeliveryKey / CampaignType / Status / SentAt）
 *   index      … `deliveryEventIndex.read()` の結果（`{ok, byKey}`）
 *
 * ── 出力 ──────────────────────────────────────────────────────
 *   受信者ごとの履歴（`sequencePolicy` がそのまま食える形）と、touch 別の集計。
 *
 * ── 束ね方は 2 つ（campaign で選ぶ）──────────────────────────
 *   `summarizeByTouch()`       … **Light 無料体験の 24 接点専用**（`journeyModel.js` の通し番号）
 *   `summarizeByCampaignStep()` … `campaignId` × `step`（**接点番号を使わない**。DRM など一般 sequence）
 *
 *   `journeyModel.js` は Light 24 接点の専用 SSOT。**他の campaign をそこへ登録しない。**
 *   登録されていない campaign を接点番号で数えると、行があるのに 0 件になる
 *   （2026-09-14 実測: `free-signup-onboarding` の 13 行が読めているのに `touches: []`）。
 *
 * ⚠️ **click は扱わない**（provider 側 OFF。false と捏造しない）。
 * ⚠️ 索引が読めない（`ok: false`）ときは**全行 未計測**（0 件にしない）。
 */

import { toHistoryRow } from '../webhooks/deliveryEventIndex.js';
import { toTouch } from './journeyModel.js';

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `CampaignType`（`campaignId:v1`）から campaignId を取り出す */
export function campaignIdFromType(raw) {
  const m = /^([a-z0-9][a-z0-9-]{0,63}):v[0-9]{1,4}$/.exec(str(raw));
  return m ? m[1] : '';
}

/**
 * 配信行 1 件を「どの touch か」まで解く。
 *
 * ⚠️ step は配信行に載っていないので、**DeliveryKey → step の対応表**を渡す
 *    （呼び出し側が「その step の DeliveryKey を計算する」形で作る）。
 *    推測はしない。対応が無ければ `touch: null` として集計から外す。
 */
export function resolveDeliveryTouch({ delivery, stepByDeliveryKey }) {
  const f = (delivery && delivery.fields) || delivery || {};
  const deliveryKey = str(f.DeliveryKey);
  const campaignId = campaignIdFromType(f.CampaignType);
  const step = stepByDeliveryKey instanceof Map ? num(stepByDeliveryKey.get(deliveryKey)) : null;
  const touch = campaignId && step !== null ? toTouch(campaignId, step) : null;
  return {
    deliveryKey,
    campaignId,
    step,
    touch,
    status: str(f.Status),
    sentAtMs: f.SentAt ? Date.parse(f.SentAt) : (f.QueuedAt ? Date.parse(f.QueuedAt) : null),
    email: str(f.RecipientEmail).toLowerCase(),
  };
}

/**
 * 受信者ごとの履歴を作る（`sequencePolicy` の `countConsecutiveNoEngagement` に渡す形）。
 *
 * @returns {Map<string, Array<object>>} email（小文字）→ 古い順の履歴
 */
export function buildHistoryByRecipient({ deliveries, stepByDeliveryKey, index }) {
  const ok = !!(index && index.ok);
  const byKey = ok && index.byKey instanceof Map ? index.byKey : new Map();
  const out = new Map();
  for (const d of Array.isArray(deliveries) ? deliveries : []) {
    const r = resolveDeliveryTouch({ delivery: d, stepByDeliveryKey });
    if (!r.deliveryKey || !r.email) continue;
    // 送っていない行（queued / skipped）は履歴に入れない（届いた通だけを数える）
    if (r.status !== 'sent') continue;
    // ⚠️ 索引が読めないときは **entry を渡さない** = 未計測
    const entry = ok ? byKey.get(r.deliveryKey) || null : null;
    const row = toHistoryRow({
      deliveryKey: r.deliveryKey, entry, sentAtMs: r.sentAtMs, step: r.step,
    });
    row.touch = r.touch;
    row.campaignId = r.campaignId;
    const list = out.get(r.email) || [];
    list.push(row);
    out.set(r.email, list);
  }
  // 古い順（送信時刻）に並べる。時刻が無い行は後ろへ
  for (const [k, list] of out) {
    list.sort((a, b) => {
      const x = num(a.sentAtMs); const y = num(b.sentAtMs);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    });
    out.set(k, list);
  }
  return out;
}

/**
 * 1 行ぶんを箱へ足す。**数えかたの正本はここ 1 か所**。
 *
 * 接点別（Light の 24 接点）でも campaign × step 別（その他の sequence）でも
 * **同じ判断**を使う。片方だけ意味がずれる余地を作らない。
 *
 * ⚠️ `sent` / `delivered` / `opened` を混ぜない:
 *   - 送った（`Status === 'sent'`）だけでは **届いた**ことにしない
 *   - 届いた証拠（`deliveredAtMs`）が無い行は `unknown`。**未開封と決めつけない**
 *   - `opened` は「**届いた**と分かっている行」の中だけで数える
 */
function countInto(cur, r, ok, byKey) {
  if (r.status !== 'sent') return cur;
  cur.sent += 1;
  // ⚠️ 索引が読めないときは entry を渡さない = 未計測（0 件にしない）
  const entry = ok ? byKey.get(r.deliveryKey) || null : null;
  const deliveredAtMs = entry ? num(entry.deliveredAtMs) : null;
  if (deliveredAtMs !== null) {
    cur.delivered += 1;
    cur.measured += 1;
    if (num(entry.firstOpenAtMs) !== null) cur.opened += 1;
  } else {
    cur.unknown += 1;
  }
  return cur;
}

/** 率を足す。分母が 0 のときは `null`（0% と書かない） */
function withRates(x) {
  return {
    ...x,
    deliveryRate: x.sent > 0 ? x.delivered / x.sent : null,
    openRate: x.delivered > 0 ? x.opened / x.delivered : null,
    /** 率の分母を画面へ明示する（誤読を防ぐ） */
    rateBasis: { deliveryRate: 'sent', openRate: 'delivered' },
  };
}

/** 合計は**足してから 1 回だけ**率を出す（行ごとの率を平均しない） */
function sumTotals(list) {
  const totals = list.reduce((a, x) => ({
    sent: a.sent + x.sent,
    delivered: a.delivered + x.delivered,
    opened: a.opened + x.opened,
    measured: a.measured + x.measured,
    unknown: a.unknown + x.unknown,
  }), { sent: 0, delivered: 0, opened: 0, measured: 0, unknown: 0 });
  return {
    ...totals,
    deliveryRate: totals.sent > 0 ? totals.delivered / totals.sent : null,
    openRate: totals.delivered > 0 ? totals.opened / totals.delivered : null,
    rateBasis: { deliveryRate: 'sent', openRate: 'delivered' },
  };
}

/**
 * touch 別の集計（**PII なし・件数と率だけ**）。
 *
 * ⚠️ **Light 無料体験の 24 接点専用**。`journeyModel.js` に載っている campaign だけが
 *    通し接点番号を持つ。載っていない campaign（DRM の 3 本など）は `touch: null` になり
 *    ここでは数えられない → `summarizeByCampaignStep()` を使う。
 *
 * 率の分母を明示する:
 *   deliveryRate = delivered / sent
 *   openRate     = opened / **delivered**（measured を分母にしない。届いた通のうち何通開かれたか）
 * 分母が 0 のときは `null`（0% と書かない）。
 */
export function summarizeByTouch({ deliveries, stepByDeliveryKey, index }) {
  const ok = !!(index && index.ok);
  const byKey = ok && index.byKey instanceof Map ? index.byKey : new Map();
  const rows = new Map();

  for (const d of Array.isArray(deliveries) ? deliveries : []) {
    const r = resolveDeliveryTouch({ delivery: d, stepByDeliveryKey });
    if (r.touch === null) continue;
    const cur = rows.get(r.touch) || {
      touch: r.touch, campaignId: r.campaignId, step: r.step,
      sent: 0, delivered: 0, opened: 0, measured: 0, unknown: 0,
    };
    rows.set(r.touch, countInto(cur, r, ok, byKey));
  }

  const list = [...rows.values()].sort((a, b) => a.touch - b.touch).map(withRates);

  return {
    /** 索引が読めなかった = 全部 unknown（0 件と区別する） */
    measurementAvailable: ok,
    touches: list,
    totals: sumTotals(list),
    /** click は provider 側 OFF。**計測していない**（0 ではない） */
    clickMeasured: false,
  };
}

/**
 * campaign × step 別の集計（**PII なし・件数と率だけ**）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `summarizeByTouch()` は `journeyModel.js` の通し接点番号に依存する。
 * `journeyModel.js` は **Light 無料体験（6 通 ＋ 終了後 18 通 = 24 接点）の専用 SSOT**で、
 * 他の campaign をここへ登録してはいけない。
 * その結果、DRM の 3 本は `toTouch()` が `null` を返し、**行があるのに 0 件**に見えていた
 * （2026-09-14 実測: `free-signup-onboarding` の 13 行が読めているのに `touches: []`）。
 *
 * そこで「接点の通し番号」を**使わない**数えかたを用意する。
 * campaign と step は配信行と `DeliveryKey` から**確定できる**ので、推測は要らない。
 *
 * ⚠️ `stepByDeliveryKey` に**完全一致**する行だけを数える（`summarizeByTouch` と同じ）。
 *    鍵が一致しない行は「どの step か分からない」ので**数えない**（推測しない）。
 * ⚠️ 数えかた（sent / delivered / opened / unknown）は `countInto()` の 1 か所。
 */
export function summarizeByCampaignStep({ deliveries, stepByDeliveryKey, index }) {
  const ok = !!(index && index.ok);
  const byKey = ok && index.byKey instanceof Map ? index.byKey : new Map();
  const rows = new Map();

  for (const d of Array.isArray(deliveries) ? deliveries : []) {
    const r = resolveDeliveryTouch({ delivery: d, stepByDeliveryKey });
    // campaign と step の**両方**が確定した行だけ数える（片方でも欠けたら推測しない）
    if (!r.campaignId || r.step === null) continue;
    const key = groupKeyOf(r.campaignId, r.step);
    const cur = rows.get(key) || {
      campaignId: r.campaignId, step: r.step,
      sent: 0, delivered: 0, opened: 0, measured: 0, unknown: 0,
    };
    rows.set(key, countInto(cur, r, ok, byKey));
  }

  const list = [...rows.values()]
    .sort((a, b) => (a.campaignId === b.campaignId
      ? a.step - b.step
      : (a.campaignId < b.campaignId ? -1 : 1)))
    .map(withRates);

  return {
    measurementAvailable: ok,
    steps: list,
    totals: sumTotals(list),
    clickMeasured: false,
  };
}

/** `campaignId` × `step` の並び順つきキー（集計の箱を一意にする） */
export function groupKeyOf(campaignId, step) {
  return `${str(campaignId)}#${str(step)}`;
}

export default summarizeByTouch;
