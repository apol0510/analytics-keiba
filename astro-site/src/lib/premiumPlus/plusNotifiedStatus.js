/**
 * plusNotifiedStatus.js — 「販売可なのに一度も案内していない会員」を見つける判定（純粋・I/O なし）
 *
 * ── なぜ必要か（2026-08-13 実測）────────────────────────────────────
 * 管理画面は「この人に Plus の CTA を出す設定になっているか」（`upsellDisplay`）と
 * 「実際に画面で見たか」（`realView` / PR #323）は出せるようになった。
 * だが **こちらから案内を送ったかどうか**はどこにも出ていなかった。
 *
 * 本番 `CampaignDeliveries` を実測すると、`premium-plus-offer` の配信は
 * **全体で 0 件**だった。つまり販売可にした会員に対して、こちらからは
 * 一度も声をかけていない。CTA は「ログインして該当ページを開けば見える」ものなので、
 * 案内が 0 通なら、その人が Plus の存在に気づく経路は事実上ない。
 *
 * 管理画面には「販売可」「CTA 表示中」と出ているため、運用者からは
 * **売れる状態に見えて、実際には誰にも届いていない**。この差を 1 列で見せる。
 *
 * ── 3 つを混同しない ────────────────────────────────────────────
 *   1. 表示判定（`upsellDisplay`）  … 出す設定か。送った証拠でも見た証拠でもない
 *   2. 実閲覧（`realView`）         … 本人が画面で見た実測（計測開始以降のみ）
 *   3. **案内済み（このモジュール）** … こちらから送った実績（CampaignDeliveries）
 *
 * ── fail closed ────────────────────────────────────────────────
 * 配信履歴が読めないときは **`unknown`（未確認）** にする。
 * 0 通として返してはいけない。「読めなかった」を「送っていない」と表示すると、
 * 運用者が既に送った相手へ二重に送る。逆に、送っていないのに「案内済み」と
 * 表示するのは最悪で、その人は永久に案内されない。**迷ったら未確認**。
 */

import { isSafeIdentifier } from '../marketing/marketingTargetedLoad.js';

/**
 * Premium Plus の案内に該当する campaignId。
 * `campaignCatalog.js` の `campaignId: 'premium-plus-offer'` が正本で、
 * ここはその**参照**。新しい Plus 案内キャンペーンを足したらここへ追加する。
 */
export const PLUS_CAMPAIGN_IDS = Object.freeze(['premium-plus-offer']);

/** 案内状態。**表示判定・実閲覧とは別の軸**。 */
export const PLUS_NOTIFIED = Object.freeze({
  /** 配信履歴を読めなかった（0 通ではない） */
  UNKNOWN: 'unknown',
  /** 送信済み（sent）が 1 通以上ある */
  NOTIFIED: 'notified',
  /** 送信を試みたが失敗のみ（本人には届いていない） */
  UNDELIVERED: 'undelivered',
  /** 履歴を読めたうえで 1 通も無い */
  NEVER: 'never',
});

export const PLUS_NOTIFIED_LABEL = Object.freeze({
  unknown: '未確認',
  notified: '案内済み',
  undelivered: '未着（送信失敗）',
  never: '未案内',
});

/**
 * 状態ごとの説明。**そのまま画面に出す**（運用者が意味を推測しなくて済むように）。
 */
export const PLUS_NOTIFIED_NOTE = Object.freeze({
  unknown: '配信履歴を読み取れませんでした。0 通という意味ではありません。',
  notified: 'Premium Plus の案内メールを送信済みです。',
  undelivered: '送信を試みましたが失敗しており、本人には届いていません。',
  never: 'Premium Plus の案内メールを一度も送っていません。',
});

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();

/** Airtable の文字列リテラルとして安全なアドレスか（`'` を含むものは使わない）。 */
export function isSafeEmailLiteral(value) {
  const s = lower(value);
  if (!s || s.length > 254) return false;
  if (s.includes("'")) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s);
}

/** campaignId が識別子として安全か（formula へ埋める前の検査）。 */
function isSafeCampaignId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/**
 * 名指しの会員について、Plus 案内の配信行だけを引く formula を組み立てる。
 *
 * **全件走査を作らない**（`check:no-unbounded-scan` の対象）。対象は必ず
 * recordId / アドレスで名指しし、コストは対象人数に比例させる。
 *
 * 会員の特定は `CustomerRecordId` と `RecipientEmail` の **OR** にする。
 * `CustomerRecordId` は後から入った列で、古い配信行には入っていないことがある。
 * 片方だけで引くと **送ったのに「未案内」** と出てしまい、二重送信を誘発する。
 *
 * @param {{ recordIds?: string[], emails?: string[], campaignIds?: readonly string[] }} input
 * @returns {string|null} 引く対象が無ければ null（呼び出し側は fetch しない）
 */
export function buildPlusDeliveryFormula({ recordIds = [], emails = [], campaignIds = PLUS_CAMPAIGN_IDS } = {}) {
  const ids = (Array.isArray(recordIds) ? recordIds : []).filter(isSafeIdentifier);
  const mails = [...new Set((Array.isArray(emails) ? emails : []).map(lower).filter(isSafeEmailLiteral))];
  const who = [
    ...ids.map((id) => `{CustomerRecordId}='${id}'`),
    ...mails.map((e) => `LOWER({RecipientEmail})='${e}'`),
  ];
  if (who.length === 0) return null;

  const camps = (Array.isArray(campaignIds) ? campaignIds : []).filter(isSafeCampaignId);
  if (camps.length === 0) return null;
  // CampaignType は `<campaignId>:v<n>`。**前方一致**で版に依存せず拾う
  // （v1 で送った相手が v2 の追加で「未案内」に戻らないようにする）。
  const which = camps.map((c) => `FIND('${c}:', {CampaignType}) = 1`);

  const or = (parts) => (parts.length === 1 ? parts[0] : `OR(${parts.join(',')})`);
  return `AND(${or(which)},${or(who)})`;
}

/**
 * 取得した配信行を「会員ごと」に束ねる。
 * recordId とアドレスの両方を鍵にする（どちらで引けたかに依存させない）。
 *
 * @param {Array<{id?: string, fields?: object}>} records
 * @returns {{ byRecordId: Map<string, object[]>, byEmail: Map<string, object[]> }}
 */
export function indexPlusDeliveries(records = []) {
  const byRecordId = new Map();
  const byEmail = new Map();
  const push = (map, key, entry) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };

  for (const rec of Array.isArray(records) ? records : []) {
    const f = (rec && rec.fields) || {};
    const entry = {
      campaignType: str(f.CampaignType),
      status: lower(f.Status),
      // 送信時刻は SentAt が正。無ければ queue 時刻で代替し、どちらも無ければ null
      atMs: parseAt(f.SentAt) ?? parseAt(f.QueuedAt) ?? null,
    };
    push(byRecordId, str(f.CustomerRecordId), entry);
    push(byEmail, lower(f.RecipientEmail), entry);
  }
  return { byRecordId, byEmail };
}

function parseAt(v) {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 1 会員ぶんの案内状態を組み立てる。
 *
 * @param {{
 *   entries?: object[]|null,   その会員の配信行（null = 引けなかった）
 *   available?: boolean,       配信履歴を読み取れたか。false なら必ず unknown
 *   upsellChannel?: string,    実表示の販売導線（'plus' のときだけ「要対応」になり得る）
 * }} input
 * @returns {{
 *   available: boolean, state: string, label: string, note: string,
 *   sentCount: number, failedCount: number, lastSentAt: string|null,
 *   needsAction: boolean, actionNote: string,
 * }}
 */
export function describePlusNotified({ entries, available = false, upsellChannel = '' } = {}) {
  const base = (state, over = {}) => ({
    available: available === true,
    state,
    label: PLUS_NOTIFIED_LABEL[state] || state,
    note: PLUS_NOTIFIED_NOTE[state] || '',
    sentCount: 0,
    failedCount: 0,
    lastSentAt: null,
    needsAction: false,
    actionNote: '',
    ...over,
  });

  // 読めなかった → 未確認（0 通ではない）。要対応の判定もしない（誤検知を作らない）。
  if (available !== true) return base(PLUS_NOTIFIED.UNKNOWN);

  const list = Array.isArray(entries) ? entries : [];
  const sent = list.filter((e) => e && e.status === 'sent');
  const failed = list.filter((e) => e && e.status === 'failed');
  const lastSentMs = sent.reduce((m, e) => (Number.isFinite(e.atMs) && e.atMs > m ? e.atMs : m), 0);

  if (sent.length > 0) {
    return base(PLUS_NOTIFIED.NOTIFIED, {
      sentCount: sent.length,
      failedCount: failed.length,
      lastSentAt: lastSentMs > 0 ? new Date(lastSentMs).toISOString() : null,
    });
  }

  // 送信を試みたが失敗しかない = 本人には届いていない。案内済み扱いにしない。
  const state = failed.length > 0 ? PLUS_NOTIFIED.UNDELIVERED : PLUS_NOTIFIED.NEVER;
  // 「CTA を出す設定になっている（channel=plus）のに、届いていない」= 運用者が動くべき相手。
  const needsAction = lower(upsellChannel) === 'plus';
  return base(state, {
    failedCount: failed.length,
    needsAction,
    actionNote: needsAction
      ? (state === PLUS_NOTIFIED.UNDELIVERED
        ? '販売導線は plus ですが、案内が届いていません。アドレスを確認して再送してください。'
        : '販売導線は plus ですが、案内を一度も送っていません。この会員が Plus に気づく経路がありません。')
      : '',
  });
}

/**
 * 一覧全体の集計。管理画面のヘッダに出して、**運用者が最初に見る 1 行**にする。
 *
 * @param {Array<{ plusNotified?: object }>} rows
 */
export function summarizePlusNotified(rows = []) {
  const out = {
    available: true, total: 0, notified: 0, undelivered: 0, never: 0, unknown: 0, needsAction: 0,
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = r && r.plusNotified;
    if (!n) continue;
    out.total += 1;
    if (!n.available) { out.unknown += 1; out.available = false; continue; }
    if (n.state === PLUS_NOTIFIED.NOTIFIED) out.notified += 1;
    else if (n.state === PLUS_NOTIFIED.UNDELIVERED) out.undelivered += 1;
    else if (n.state === PLUS_NOTIFIED.NEVER) out.never += 1;
    else out.unknown += 1;
    if (n.needsAction) out.needsAction += 1;
  }
  out.note = !out.available
    ? '配信履歴を読み取れなかった会員がいます。「未確認」は 0 通という意味ではありません。'
    : out.needsAction > 0
      ? `${out.needsAction} 名が「販売可なのに案内が届いていない」状態です。`
      : '販売導線が plus の会員には、案内が届いています。';
  return out;
}

export default describePlusNotified;
