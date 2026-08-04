/**
 * deliveryMeasurement.js — 計測できているのか、していないのかを**必ず区別する**（純粋・I/O なし）
 *
 * ── 直した問題 ────────────────────────────────────────────────
 * 2026-08-04 の 28 名配信で、AK の管理画面は「開封 0」と出せる状態だった。
 * だが実際には SendGrid 側で **9 名が開封**しており、0 だったのは
 * **Event Webhook が open を AK へ送っていない**からだった
 * （`open: false` / `click: false`）。さらに click は tracking 自体が無効。
 *
 * 「0 件」と「測っていない」を同じ 0 として見せると、施策の評価を丸ごと誤る。
 * このモジュールは**必ず 3 状態**（有効 / 無効 / 不明）で答え、
 * 無効・不明のときは**数値を出させない**。
 *
 * ── 区別するもの ──────────────────────────────────────────────
 *   provider 受理（accepted） … 送信 API が 202 を返した
 *   delivered                 … 受信サーバーが受け取った
 *   opened / clicked          … 受信者の行動（計測が有効なときだけ意味を持つ）
 *   unique 人数 / event 件数  … 同一人物の複数回を人数に数えない
 */

/** 計測の状態 */
export const MEASURE = Object.freeze({
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  UNKNOWN: 'unknown',
});

export const MEASURE_LABEL = Object.freeze({
  [MEASURE.ENABLED]: '計測中',
  [MEASURE.DISABLED]: '計測していません',
  [MEASURE.UNKNOWN]: '計測状態が不明',
});

/** 数値を出してよいか（無効・不明では 0 を見せない） */
export const canShowCount = (state) => state === MEASURE.ENABLED;

/** 数値の代わりに出す文言 */
export const NOT_MEASURED_TEXT = '—（計測していません）';
export const UNKNOWN_TEXT = '—（計測状態を確認できません）';

const bool = (v) => (v === true ? true : v === false ? false : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * provider の設定から「開封・クリックを AK が受け取れているか」を決める。
 *
 * **2 つの条件が両方そろって初めて `enabled`**:
 *   1. tracking が有効（そもそも計測している）
 *   2. Event Webhook がその種別を送る（AK の台帳に入る）
 *
 * どちらかが false なら `disabled`、読めなければ `unknown`（推測しない）。
 *
 * @param {{ openTracking?: {enabled?: boolean}|null,
 *           clickTracking?: {enabled?: boolean}|null,
 *           eventWebhook?: {enabled?: boolean, open?: boolean, click?: boolean}|null }} settings
 */
export function resolveMeasurementState(settings = {}) {
  const ot = settings.openTracking ? bool(settings.openTracking.enabled) : null;
  const ct = settings.clickTracking ? bool(settings.clickTracking.enabled) : null;
  const wh = settings.eventWebhook || null;
  const whOn = wh ? bool(wh.enabled) : null;
  const whOpen = wh ? bool(wh.open) : null;
  const whClick = wh ? bool(wh.click) : null;

  const decide = (tracking, webhookKind) => {
    if (tracking === null || whOn === null || webhookKind === null) return MEASURE.UNKNOWN;
    if (tracking !== true) return MEASURE.DISABLED;          // そもそも測っていない
    if (whOn !== true || webhookKind !== true) return MEASURE.DISABLED; // 測っても届かない
    return MEASURE.ENABLED;
  };

  const open = decide(ot, whOpen);
  const click = decide(ct, whClick);

  const why = [];
  if (ot === false) why.push('開封トラッキングが無効');
  if (ct === false) why.push('クリックトラッキングが無効');
  if (whOn === false) why.push('Event Webhook が無効');
  if (whOn === true && whOpen === false) why.push('Event Webhook が open を送らない設定');
  if (whOn === true && whClick === false) why.push('Event Webhook が click を送らない設定');

  return {
    open,
    click,
    openLabel: MEASURE_LABEL[open],
    clickLabel: MEASURE_LABEL[click],
    reasons: why,
    /** provider 側だけで確認した値を「参考値」と断る必要があるか */
    providerOnly: open === MEASURE.DISABLED || open === MEASURE.UNKNOWN,
  };
}

/**
 * 台帳の件数 1 つを、計測状態に応じて**出してよい数値かどうか**まで含めて返す。
 *
 * `summarizeDelivery()` はキャンペーン単位の集計用だが、顧客カルテのように
 * **1 件ずつの内訳を出す画面**でも同じ判断が要る。両方で同じ規則を使うため、
 * ここを単一源にする（画面側で `?? 0` と書くと未計測が 0 に化ける）。
 *
 * @param {string} state MEASURE のいずれか
 * @param {number|null|undefined} value 台帳側の件数
 * @param {string} [unit] '回' / '件' など。付けると text に添える
 * @returns {{ state: string, value: number|null, text: string, measured: boolean }}
 */
export function measuredCount(state, value, unit = '') {
  const ok = canShowCount(state);
  const n = num(value);
  return {
    state,
    value: ok ? n : null,
    text: ok ? `${n}${unit ? ` ${unit}` : ''}`
      : (state === MEASURE.DISABLED ? NOT_MEASURED_TEXT : UNKNOWN_TEXT),
    measured: ok,
  };
}

/**
 * 計測状態に依存しない指標（delivered / bounce / 配信停止 / 迷惑報告）かどうか。
 *
 * Event Webhook が届けている種別は**開封・クリックと無関係に数えてよい**。
 * これを区別しないと「計測していないので全部 —」となり、確定している事実まで隠れる。
 */
export const ALWAYS_MEASURED_METRICS = Object.freeze([
  'delivered', 'bounced', 'unsubscribed', 'spamReported',
]);

/**
 * 1 キャンペーン分の配信結果をまとめる。
 * **計測が有効でない指標は数値を返さない**（null）。0 を返さないのが肝。
 *
 * @param {{
 *   targeted?: number, queued?: number, sent?: number, delivered?: number,
 *   openUnique?: number, openEvents?: number, clickUnique?: number, clickEvents?: number,
 *   bounce?: number, blocked?: number, deferred?: number, dropped?: number,
 *   spamReport?: number, unsubscribe?: number, unresolved?: number,
 *   lastEventAtMs?: number|null,
 *   measurement: ReturnType<typeof resolveMeasurementState>,
 *   providerObserved?: { openUnique?: number, openEvents?: number,
 *                        clickUnique?: number, clickEvents?: number }|null,
 * }} input
 */
export function summarizeDelivery(input = {}) {
  const m = input.measurement || resolveMeasurementState({});
  const ledgerOpen = canShowCount(m.open);
  const ledgerClick = canShowCount(m.click);
  const po = input.providerObserved || null;

  const metric = (state, value, providerValue) => ({
    state,
    /** AK 台帳の値。計測が有効なときだけ数値。無効・不明では null（0 と混同させない） */
    value: canShowCount(state) ? num(value) : null,
    text: canShowCount(state) ? String(num(value))
      : (state === MEASURE.DISABLED ? NOT_MEASURED_TEXT : UNKNOWN_TEXT),
    /** provider 側だけで確認できた値。**参考値**であることを必ず添える */
    providerValue: Number.isFinite(Number(providerValue)) ? Number(providerValue) : null,
    providerNote: Number.isFinite(Number(providerValue))
      ? '配信基盤側の参考値（AK の台帳には入っていません）' : null,
  });

  return {
    measurement: m,
    // ── 事実として確定しているもの ──
    targeted: num(input.targeted),
    queued: num(input.queued),
    /** 送信 API が受理した数。**届いた数ではない** */
    sentAccepted: num(input.sent),
    delivered: num(input.delivered),
    bounce: num(input.bounce),
    blocked: num(input.blocked),
    deferred: num(input.deferred),
    dropped: num(input.dropped),
    spamReport: num(input.spamReport),
    unsubscribe: num(input.unsubscribe),
    unresolved: num(input.unresolved),
    lastEventAtMs: Number.isFinite(input.lastEventAtMs) ? input.lastEventAtMs : null,
    // ── 計測状態しだいのもの（人数と件数を分ける）──
    openedUnique: metric(m.open, input.openUnique, po && po.openUnique),
    openEvents: metric(m.open, input.openEvents, po && po.openEvents),
    clickedUnique: metric(m.click, input.clickUnique, po && po.clickUnique),
    clickEvents: metric(m.click, input.clickEvents, po && po.clickEvents),
    /** 画面に必ず出す注意書き（無ければ null） */
    warning: warningFor(m, input),
  };
}

function warningFor(m, input) {
  const parts = [];
  if (m.open !== MEASURE.ENABLED) {
    parts.push('開封数は AK の台帳に入っていません。「0」は未開封ではなく**計測していない**という意味です。');
  }
  if (m.click !== MEASURE.ENABLED) {
    parts.push('クリック数も同様に計測していません。');
  }
  if (num(input.delivered) > 0 && !Number.isFinite(input.lastEventAtMs)) {
    parts.push('イベントの受信時刻が読めません。Webhook が届いていない可能性があります。');
  }
  if (num(input.unresolved) > 0) {
    parts.push(`どの配信か特定できなかったイベントが ${num(input.unresolved)} 件あります。`);
  }
  if (!parts.length) return null;
  return { text: parts.join(' '), reasons: m.reasons };
}

/**
 * AK 台帳と provider の件数が食い違っていないか。
 * **食い違いは異常停止の判断材料**なので、黙って片方を採用しない。
 */
export function compareLedgerWithProvider({ ledger, provider } = {}) {
  const l = ledger || {}; const p = provider || {};
  const keys = ['delivered', 'bounce', 'dropped', 'spamReport'];
  const diffs = {};
  for (const k of keys) {
    const a = Number.isFinite(Number(l[k])) ? Number(l[k]) : null;
    const b = Number.isFinite(Number(p[k])) ? Number(p[k]) : null;
    if (a === null || b === null) continue;
    if (a !== b) diffs[k] = { ledger: a, provider: b, diff: b - a };
  }
  const n = Object.keys(diffs).length;
  return {
    consistent: n === 0,
    diffs,
    note: n === 0 ? '台帳と配信基盤の件数は一致しています。'
      : '台帳と配信基盤の件数が食い違っています。どちらかの取りこぼしなので、送信を止めて原因を確認してください。',
  };
}

export default resolveMeasurementState;
