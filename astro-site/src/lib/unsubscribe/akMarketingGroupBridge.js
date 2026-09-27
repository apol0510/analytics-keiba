/**
 * akMarketingGroupBridge.js — AK の配信停止と SendGrid の unsubscribe group `AK Marketing` をつなぐ。
 *
 * 正本: `docs/UNSUBSCRIBE.md` §8（2026-09-27 MK 確定）
 *
 * ## なぜ要るか
 *
 * AK には配信停止の経路が 2 本ある。
 *   - 旧 AK 経路: AK の HTTPS ワンクリック（`unsubscribe.js`）→ Customers `UnsubscribedAnalyticsKeiba`
 *   - SendGrid Marketing Campaigns: unsubscribe group `AK Marketing` → SendGrid の group suppression
 * どちらも**もう片方へ伝わっていなかった**。SendGrid 側で止めた会員に旧経路のメールが届き、
 * AK 側で止めた会員に SendGrid のメールが届き得る。
 *
 * ## 方向ごとの規則
 *
 * SendGrid → AK（`sendgrid-webhook.js`）
 *   - `group_unsubscribe` / `group_resubscribe` で、**`asm_group_id` が AK Marketing のものだけ**を扱う。
 *     KI の group・テスト group・group が分からないイベントは **Customers を 1 ビットも変えない**。
 *   - 通常の `unsubscribe`（global）・bounce・spam 等の既存処理には関与しない。
 *   - 再開（resubscribe）は **AK 側の停止より新しいときだけ**解除する（古い再開で新しい停止を消さない）。
 *
 * AK → SendGrid（`unsubscribe.js`）
 *   - Customers の停止が記録できたら、**global unsubscribe ではなく** AK Marketing の
 *     group suppression へメールアドレスを直接追加する（contact 検索は不要）。
 *   - 追加の前に group を GET で読み、**id と名前が両方一致したときだけ**書く（fail closed）。
 *   - KI の group には触らない（このモジュールは AK Marketing の id しか持たない）。
 *
 * ## gate
 *
 * `AK_MARKETING_UNSUBSCRIBE_BRIDGE_ENABLED === 'true'` のときだけ書く。それ以外は**判定と件数だけ**
 * （Customers にも SendGrid にも書かない）。本番の有効化は env 変更＋redeploy（要承認）。
 */

import { formulaString } from '../webhooks/airtableFormula.js';
import { AK_MARKETING_GROUP, parseAsmGroupId } from './akMarketingGroup.js';

/**
 * AK 用の unsubscribe group（単一源は `akMarketingGroup.js`）。
 * ⚠️ id だけで信用しない。SendGrid へ書く前に GET で名前も照合する。
 */
export { AK_MARKETING_GROUP };

export const BRIDGE_GATE_ENV = 'AK_MARKETING_UNSUBSCRIBE_BRIDGE_ENABLED';

/** Customers の配信停止列（`unsubscribe.js` の analytics-keiba 設定と同じ。guard テストで照合） */
export const CUSTOMER_UNSUBSCRIBE_FIELDS = Object.freeze({
  flag: 'UnsubscribedAnalyticsKeiba',
  at: 'UnsubscribedAtAnalyticsKeiba',
  baseEnv: 'AIRTABLE_BASE_ID_ANALYTICS_KEIBA',
  table: 'Customers',
});

export const GROUP_EVENT = Object.freeze({
  UNSUBSCRIBE: 'group_unsubscribe',
  RESUBSCRIBE: 'group_resubscribe',
});

export const BRIDGE_ACTION = Object.freeze({
  UNSUBSCRIBE: 'unsubscribe',
  RESUBSCRIBE: 'resubscribe',
});

/** イベントを扱わなかった理由（固定コード。アドレスを混ぜない） */
export const BRIDGE_IGNORE = Object.freeze({
  NOT_GROUP_EVENT: 'not_group_event',
  UNKNOWN_GROUP: 'unknown_group',
  FOREIGN_GROUP: 'foreign_group',
  INVALID_EMAIL: 'invalid_email',
});

/** Customers を変えなかった理由 */
export const BRIDGE_NOOP = Object.freeze({
  ALREADY_UNSUBSCRIBED: 'already_unsubscribed',
  ALREADY_SUBSCRIBED: 'already_subscribed',
  STALE_RESUBSCRIBE: 'stale_resubscribe',
  NOT_FOUND: 'customer_not_found',
  AMBIGUOUS: 'customer_ambiguous',
});

export function isBridgeEnabled(env) {
  return String((env || {})[BRIDGE_GATE_ENV] || '').trim() === 'true';
}

const str = (v) => String(v ?? '').trim();
const normEmail = (v) => str(v).toLowerCase();
const EMAIL_RE = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;

/**
 * 1 件のイベントを分類する（純粋）。
 * @returns {{kind:'unsubscribe'|'resubscribe', email:string, atMs:number|null}
 *          | {kind:'ignore', reason:string}}
 */
export function classifyGroupEvent(event) {
  const e = event && typeof event === 'object' ? event : {};
  const type = str(e.event);
  if (type !== GROUP_EVENT.UNSUBSCRIBE && type !== GROUP_EVENT.RESUBSCRIBE) {
    return { kind: 'ignore', reason: BRIDGE_IGNORE.NOT_GROUP_EVENT };
  }
  // group が分からないものは**AK のものとみなさない**（fail closed）
  const groupId = parseAsmGroupId(e.asm_group_id);
  if (groupId === null) return { kind: 'ignore', reason: BRIDGE_IGNORE.UNKNOWN_GROUP };
  if (groupId !== AK_MARKETING_GROUP.id) return { kind: 'ignore', reason: BRIDGE_IGNORE.FOREIGN_GROUP };
  const email = normEmail(e.email);
  if (!EMAIL_RE.test(email)) return { kind: 'ignore', reason: BRIDGE_IGNORE.INVALID_EMAIL };
  const ts = Number(e.timestamp);
  return {
    kind: type === GROUP_EVENT.UNSUBSCRIBE ? BRIDGE_ACTION.UNSUBSCRIBE : BRIDGE_ACTION.RESUBSCRIBE,
    email,
    atMs: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null,
  };
}

/**
 * バッチを 1 人 1 操作にまとめる（純粋）。
 * 同じ人に複数届いたら**時刻が新しいほう**。同時刻なら**停止を優先**（安全側）。
 *
 * @returns {{ops: Array<{email, action, atMs}>, ignored: Record<string, number>}}
 *          ops はアドレスを含むので**ログ・応答へ出さない**。
 */
export function planGroupEvents(events) {
  /** @type {Record<string, number>} */
  const ignored = {};
  const byEmail = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const c = classifyGroupEvent(ev);
    if (c.kind === 'ignore') {
      if (c.reason !== BRIDGE_IGNORE.NOT_GROUP_EVENT) ignored[c.reason] = (ignored[c.reason] || 0) + 1;
      continue;
    }
    const cur = byEmail.get(c.email);
    const newer = !cur
      || (c.atMs ?? -1) > (cur.atMs ?? -1)
      || ((c.atMs ?? -1) === (cur.atMs ?? -1) && c.kind === BRIDGE_ACTION.UNSUBSCRIBE);
    if (newer) byEmail.set(c.email, { email: c.email, action: c.kind, atMs: c.atMs });
  }
  return { ops: [...byEmail.values()], ignored };
}

/**
 * Customers をどう変えるか（純粋）。
 *
 * **時系列は AK 側の停止時刻（`UnsubscribedAtAnalyticsKeiba`）を基準にする。**
 * webhook のバッチは到着順が入れ替わり得る（停止 9/1 → 停止 9/10 → 遅れて再開 9/5）ので、
 *   - 停止: 未停止なら立てる。**既に停止中でも、より新しい停止なら停止時刻を進める**
 *     （後から古い再開が届いても解除されないようにする）
 *   - 再開: **再開の時刻と AK の停止時刻が両方読めて、再開のほうが厳密に新しいときだけ**解除する。
 *     時刻が無い・読めない・同時刻以前は解除しない（止め続ける側に倒す）
 *
 * @param {{fields: object, action: string, atMs: number|null, nowMs: number}} input
 * @returns {{write: object|null, noop: string|null}}
 */
export function decideCustomerChange({ fields, action, atMs, nowMs }) {
  const f = fields || {};
  const flagged = f[CUSTOMER_UNSUBSCRIBE_FIELDS.flag] === true;
  const stoppedAt = Date.parse(str(f[CUSTOMER_UNSUBSCRIBE_FIELDS.at]));
  const hasStoppedAt = Number.isFinite(stoppedAt);
  const hasEventAt = Number.isFinite(atMs);

  if (action === BRIDGE_ACTION.UNSUBSCRIBE) {
    if (!flagged) {
      const at = hasEventAt ? atMs : nowMs;
      return {
        write: {
          [CUSTOMER_UNSUBSCRIBE_FIELDS.flag]: true,
          [CUSTOMER_UNSUBSCRIBE_FIELDS.at]: new Date(at).toISOString(),
        },
        noop: null,
      };
    }
    // 既に停止中: より新しい停止なら時刻だけ進める（停止時刻が読めない場合も、時刻のある停止で埋める）
    if (hasEventAt && (!hasStoppedAt || atMs > stoppedAt)) {
      return { write: { [CUSTOMER_UNSUBSCRIBE_FIELDS.at]: new Date(atMs).toISOString() }, noop: null };
    }
    return { write: null, noop: BRIDGE_NOOP.ALREADY_UNSUBSCRIBED };
  }

  if (action === BRIDGE_ACTION.RESUBSCRIBE) {
    if (!flagged) return { write: null, noop: BRIDGE_NOOP.ALREADY_SUBSCRIBED };
    if (!hasEventAt || !hasStoppedAt || atMs <= stoppedAt) {
      return { write: null, noop: BRIDGE_NOOP.STALE_RESUBSCRIBE };
    }
    return {
      write: { [CUSTOMER_UNSUBSCRIBE_FIELDS.flag]: false, [CUSTOMER_UNSUBSCRIBE_FIELDS.at]: null },
      noop: null,
    };
  }
  return { write: null, noop: 'unknown_action' };
}

/**
 * webhook のバッチを Customers へ反映する。**gate が閉じていれば書かない**（件数だけ）。
 *
 * @param {{events: object[], env: object, fetchImpl: Function, nowMs?: number}} input
 * @returns {Promise<object>} 件数だけ（アドレス・recordId を含まない）
 */
export async function applyGroupEventsToCustomers({ events, env, fetchImpl, nowMs = Date.now() }) {
  const { ops, ignored } = planGroupEvents(events);
  const summary = {
    enabled: isBridgeEnabled(env),
    targeted: ops.length,
    ignored,
    written: { unsubscribe: 0, resubscribe: 0, stopTimeAdvanced: 0 },
    noop: {},
    errors: 0,
  };
  if (ops.length === 0 || !summary.enabled) return summary;

  const apiKey = str(env.AIRTABLE_API_KEY);
  const baseId = str(env[CUSTOMER_UNSUBSCRIBE_FIELDS.baseEnv]);
  if (!apiKey || !baseId || typeof fetchImpl !== 'function') {
    return { ...summary, errors: ops.length, reason: 'config_missing' };
  }
  const table = encodeURIComponent(CUSTOMER_UNSUBSCRIBE_FIELDS.table);
  const auth = { Authorization: `Bearer ${apiKey}` };

  for (const op of ops) {
    try {
      const formula = `LOWER({Email}) = ${formulaString(op.email)}`;
      const url = `https://api.airtable.com/v0/${baseId}/${table}`
        + `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=2`
        + `&fields%5B%5D=${encodeURIComponent(CUSTOMER_UNSUBSCRIBE_FIELDS.flag)}`
        + `&fields%5B%5D=${encodeURIComponent(CUSTOMER_UNSUBSCRIBE_FIELDS.at)}`;
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(url, { method: 'GET', headers: auth });
      if (!res.ok) { summary.errors += 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json();
      const recs = Array.isArray(data.records) ? data.records : [];
      if (recs.length === 0) { summary.noop[BRIDGE_NOOP.NOT_FOUND] = (summary.noop[BRIDGE_NOOP.NOT_FOUND] || 0) + 1; continue; }
      // 同じアドレスが 2 件あるならどちらを直すか決められない → 書かない
      if (recs.length > 1) { summary.noop[BRIDGE_NOOP.AMBIGUOUS] = (summary.noop[BRIDGE_NOOP.AMBIGUOUS] || 0) + 1; continue; }
      const d = decideCustomerChange({ fields: recs[0].fields, action: op.action, atMs: op.atMs, nowMs });
      if (!d.write) { summary.noop[d.noop] = (summary.noop[d.noop] || 0) + 1; continue; }
      // eslint-disable-next-line no-await-in-loop
      const p = await fetchImpl(`https://api.airtable.com/v0/${baseId}/${table}/${recs[0].id}`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: d.write }),
      });
      if (!p.ok) { summary.errors += 1; continue; }
      const advancedOnly = op.action === BRIDGE_ACTION.UNSUBSCRIBE
        && !(CUSTOMER_UNSUBSCRIBE_FIELDS.flag in d.write);
      if (advancedOnly) summary.written.stopTimeAdvanced += 1;
      else summary.written[op.action] += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
}

/**
 * AK 側で止めた人を SendGrid の AK Marketing group suppression へ加える。
 *
 * - global unsubscribe は使わない（KI 等の別ブランドの配信まで止めてしまう）
 * - 書く前に group を GET し、**id と名前が両方一致**しなければ書かない
 * - SendGrid 側は同じアドレスを何度加えても 1 件（冪等）
 *
 * @returns {Promise<{status:string}>} 'skipped_gate' | 'synced' | 'group_mismatch' | 'failed' | 'config_missing'
 */
export async function addToAkMarketingGroupSuppression({ email, env, fetchImpl }) {
  if (!isBridgeEnabled(env)) return { status: 'skipped_gate' };
  const apiKey = str((env || {}).SENDGRID_API_KEY);
  const e = normEmail(email);
  if (!apiKey || typeof fetchImpl !== 'function') return { status: 'config_missing' };
  if (!EMAIL_RE.test(e)) return { status: 'failed' };
  const base = `https://api.sendgrid.com/v3/asm/groups/${AK_MARKETING_GROUP.id}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  try {
    const g = await fetchImpl(base, { method: 'GET', headers: auth });
    if (!g.ok) return { status: 'failed' };
    const group = await g.json();
    if (!group || Number(group.id) !== AK_MARKETING_GROUP.id || str(group.name) !== AK_MARKETING_GROUP.name) {
      return { status: 'group_mismatch' };
    }
    const r = await fetchImpl(`${base}/suppressions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_emails: [e] }),
    });
    return { status: r.ok ? 'synced' : 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

export default classifyGroupEvent;
