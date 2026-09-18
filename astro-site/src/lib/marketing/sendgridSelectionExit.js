/**
 * sendgridSelectionExit.js — 選別を終えた人を **SendGrid の選別 list から即時に外す**
 * （判定は純粋 / HTTP は注入）
 *
 * ## なぜ webhook の中でやるのか（2026-09-18 MK 確定）
 *
 * Single Send は**送信時点の list の中身**へ送るので、送信前に外せていれば未来の号には入らない。
 * SendGrid の Segment では open を条件にできないことが実測で分かったため
 * （`sendgridExitReadiness.SEGMENT_CAPABILITY`）、外すのは AK 側の役目になる。
 *
 * **新しい cron も配送エンジンも作らない。** 既に open / bounce / 苦情 / 配信停止を
 * 受け取っている `sendgrid-webhook.js` の処理の中で、そのまま list から外す。
 *
 * ⚠️ **「必ず最終的に外れる」とは書かない。** 実際に行うのは
 *    **即時 2 回再試行 ＋ SendGrid Event Webhook の非 2xx 再送（最大 24 時間）による再試行**で、
 *    その窓の中で除去を繰り返し試みる。窓を過ぎても外せなければ**外れないまま残る**
 *    （そのときは移行スクリプトの再実行など人手の回収が要る）。
 *
 * ## 外す相手（これ以外は外さない）
 *
 * | 状態 | 意味 |
 * |---|---|
 * | `ENGAGED` | 反応した（open / click）＝ 選別完了 → DRM へ |
 * | `PROMOTED` | Customers へ昇格した（購入・登録）|
 * | `SUPPRESSED` | 配信停止 / bounce / 苦情 |
 * | `EXHAUSTED` | delivered 10 通・無反応で打ち切り |
 *
 * ## 守ること
 *
 * - **触る list は `ak-prospect-select-start-N` だけ**（名前で確かめる。KI / KMA の資産は対象外）
 * - **べき等**: 同じ人を何度外しても害が無い（SendGrid は既に居なくても 202）。
 *   状態が変わった人だけを対象にし、同じ webhook 内では重複を除く
 * - **失敗しても webhook は 200 を返す**（SendGrid に再送させない。次のイベントか
 *   移行スクリプトの再実行で回収できる）
 * - **1 回の webhook で扱う上限**を決める（大量イベントで実行時間を食い潰さない）
 * - **ログ・戻り値にアドレスを出さない**（件数だけ）
 * - **止めたいときは env 1 つ**（`SENDGRID_SELECTION_EXIT_DISABLED=true`）。
 *   **既定は有効**（env を足さなくても動く）
 */

import { PROSPECT_STATE } from './prospectPolicy.js';
import { listNameFor } from './sendgridAutomationPlan.js';

/** 選別から外す状態 */
export const EXIT_STATES = Object.freeze([
  PROSPECT_STATE.ENGAGED, PROSPECT_STATE.PROMOTED,
  PROSPECT_STATE.SUPPRESSED, PROSPECT_STATE.EXHAUSTED,
]);

/**
 * **失敗を握り潰してはいけない**状態。
 *
 * `SUPPRESSED`（配信停止 / bounce / 苦情）と `EXHAUSTED` は
 * **SendGrid の suppression が list とは独立に効く**ので、list から外し損ねても届かない。
 * 一方 **`ENGAGED` / `PROMOTED` は list から外れない限り翌日の号が届く**。
 * したがってこの 2 つの除去に失敗したら、**webhook を失敗として返して再送させる**。
 */
export const CRITICAL_EXIT_STATES = Object.freeze([PROSPECT_STATE.ENGAGED, PROSPECT_STATE.PROMOTED]);

/** 1 回の webhook 内で除去を試す回数（**新しい queue を作らずに一時障害を吸収する**）*/
export const REMOVE_ATTEMPTS = 2;

/** 対象 list の名前（**この名前以外は絶対に触らない**） */
export const SELECTION_LIST_NAMES = Object.freeze([listNameFor(1), listNameFor(2), listNameFor(3)]);

/** 1 回の webhook で外す上限（実行時間を食い潰さない） */
export const MAX_EXIT_PER_CALL = 100;

/** 緊急停止（**既定は有効**。env を足さなくても動く） */
export const EXIT_DISABLE_ENV = 'SENDGRID_SELECTION_EXIT_DISABLED';
export function isSelectionExitDisabled(env = process.env) {
  return String((env && env[EXIT_DISABLE_ENV]) || '').trim().toLowerCase() === 'true';
}

const normalize = (v) => String(v || '').trim().toLowerCase();

/**
 * webhook の更新結果 → **外す相手**（純粋）。
 *
 * @param {{changes: Array<{email: string, state: string}>, max?: number}} input
 * @returns {{emails: string[], byState: object, skipped: object, capped: number}}
 */
export function planSelectionExit({ changes, max } = {}) {
  const cap = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_EXIT_PER_CALL) : MAX_EXIT_PER_CALL;
  const allow = new Set(EXIT_STATES);
  const byState = {};
  const skipped = {};
  const seen = new Set();
  const emails = [];
  const criticalEmails = [];
  let capped = 0;

  for (const c of Array.isArray(changes) ? changes : []) {
    const email = normalize(c && c.email);
    const state = String((c && c.state) || '');
    if (!email) { skipped.no_email = (skipped.no_email || 0) + 1; continue; }
    if (!allow.has(state)) { skipped[state || 'unknown_state'] = (skipped[state || 'unknown_state'] || 0) + 1; continue; }
    if (seen.has(email)) { skipped.duplicate = (skipped.duplicate || 0) + 1; continue; }
    seen.add(email);
    if (emails.length >= cap) { capped += 1; continue; }
    emails.push(email);
    if (CRITICAL_EXIT_STATES.includes(state)) criticalEmails.push(email);
    byState[state] = (byState[state] || 0) + 1;
  }
  return { emails, criticalEmails, byState, skipped, capped };
}

/**
 * 選別 list だけを触る最小の口（**GET / POST(search) / DELETE(list の members) のみ**）。
 *
 * ⚠️ 移行スクリプト用の `sendgridMarketingApi.js` とは**別口**にしてある。
 *    あちらは二重ゲート（env + 合言葉）で人が実行する前提、こちらは webhook が自動で使う。
 *    **できることを選別 list からの除去だけに絞る**ことで、事故の範囲を構造的に閉じる。
 */
export function createSelectionExitClient({ apiKey, fetchImpl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  const call = async (method, path, body) => {
    const res = await doFetch(`https://api.sendgrid.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };

  return {
    /** 選別 list の id（**名前が一致するものだけ**） */
    async selectionListIds() {
      const r = await call('GET', '/v3/marketing/lists?page_size=100');
      if (r.status !== 200) return null;
      const out = [];
      for (const l of (r.body && r.body.result) || []) {
        if (SELECTION_LIST_NAMES.includes(String(l.name))) out.push(String(l.id));
      }
      return out;
    },
    /** アドレス → contact id（50 件ずつ） */
    async contactIds(emails) {
      const list = [...new Set((emails || []).map(normalize))].filter(Boolean);
      const ids = [];
      for (let i = 0; i < list.length; i += 50) {
        // eslint-disable-next-line no-await-in-loop -- API の上限に合わせる
        const r = await call('POST', '/v3/marketing/contacts/search/emails', { emails: list.slice(i, i + 50) });
        if (r.status !== 200) continue;          // 見つからない・失敗は「外す相手が居ない」と同じ
        for (const hit of Object.values((r.body && r.body.result) || {})) {
          const id = hit && hit.contact && hit.contact.id;
          if (id) ids.push(String(id));
        }
      }
      return [...new Set(ids)];
    },
    /** アドレス → contact id（**引けたかどうか**も返す。引けない＝安全側に倒せない） */
    async contactIdsChecked(emails) {
      const list = [...new Set((emails || []).map(normalize))].filter(Boolean);
      const byEmail = new Map();
      let lookupFailed = false;
      for (let i = 0; i < list.length; i += 50) {
        // eslint-disable-next-line no-await-in-loop -- API の上限に合わせる
        const r = await call('POST', '/v3/marketing/contacts/search/emails', { emails: list.slice(i, i + 50) });
        // ⚠️ 404 は「その塊に 1 件も居ない」＝**失敗ではない**（未投入の相手）
        if (r.status !== 200 && r.status !== 404) { lookupFailed = true; continue; }
        for (const [email, hit] of Object.entries((r.body && r.body.result) || {})) {
          const id = hit && hit.contact && hit.contact.id;
          if (id) byEmail.set(normalize(email), String(id));
        }
      }
      return { byEmail, lookupFailed };
    },
    /** 選別 list から外す（**list 名を確かめた id しか渡さない**） */
    async removeFromList({ listId, contactIds }) {
      const ids = [...new Set((contactIds || []).map(String))].filter(Boolean);
      if (!listId || ids.length === 0) return { status: 0, removed: 0 };
      const r = await call(
        'DELETE',
        `/v3/marketing/lists/${encodeURIComponent(listId)}/contacts?contact_ids=${encodeURIComponent(ids.join(','))}`,
      );
      return { status: r.status, removed: r.status >= 200 && r.status < 300 ? ids.length : 0 };
    },
  };
}

/**
 * 実行（**失敗しても投げない**。呼び出し元の webhook は必ず 200 を返す）。
 *
 * @param {{changes: Array, client: object, env?: object}} input
 * @returns {Promise<object>} 件数だけ（**アドレスを含まない**）
 */
export async function applySelectionExit({ changes, client, env = process.env } = {}) {
  const out = {
    enabled: false, 対象: 0, 状態別: {}, 除外した延べ件数: 0,
    list数: 0, 引き当て: 0, 上限超過: 0, errors: 0, reason: null,
    /** ⚠️ **握り潰してはいけない失敗**（ENGAGED / PROMOTED を外せなかった） */
    criticalFailure: false,
    criticalTargets: 0,
    criticalRemoved: 0,
  };
  if (isSelectionExitDisabled(env)) { out.reason = 'disabled_by_env'; return out; }

  const plan = planSelectionExit({ changes });
  out.対象 = plan.emails.length;
  out.状態別 = plan.byState;
  out.上限超過 = plan.capped;
  out.criticalTargets = plan.criticalEmails.length;

  if (!client) {
    out.reason = 'sendgrid_not_configured';
    // 反応者を外せない状態で「成功」にしない
    out.criticalFailure = plan.criticalEmails.length > 0;
    return out;
  }
  if (plan.emails.length === 0) { out.enabled = true; out.reason = 'no_targets'; return out; }
  out.enabled = true;

  const critical = new Set(plan.criticalEmails);
  try {
    const listIds = await client.selectionListIds();
    if (!Array.isArray(listIds) || listIds.length === 0) {
      out.reason = 'selection_lists_not_found';
      out.criticalFailure = critical.size > 0;
      return out;
    }
    out.list数 = listIds.length;

    const looked = typeof client.contactIdsChecked === 'function'
      ? await client.contactIdsChecked(plan.emails)
      : { byEmail: new Map((await client.contactIds(plan.emails)).map((id) => [id, id])), lookupFailed: false };
    const byEmail = looked.byEmail instanceof Map ? looked.byEmail : new Map();
    out.引き当て = byEmail.size;

    /**
     * ⚠️ **引き当てに失敗した（HTTP エラー）ときは「居ない」と見なさない。**
     *    居るのに外せていない可能性があるので、反応者が対象なら失敗として扱う。
     *    一方「検索できたが見つからない」＝ **まだ投入していない人**なので失敗ではない。
     */
    if (looked.lookupFailed && critical.size > 0) {
      out.criticalFailure = true;
      out.reason = 'contact_lookup_failed';
    }

    const ids = [...byEmail.values()];
    const criticalIds = new Set([...critical].map((e) => byEmail.get(e)).filter(Boolean));
    out.criticalRemoved = 0;
    if (ids.length === 0) {
      if (!out.reason) out.reason = 'contacts_not_found';
      return out;
    }

    /** list ごとに**上限つきで再試行**（新しい queue を作らずに一時障害を吸収する） */
    const removedPerList = [];
    for (const listId of listIds) {
      let ok = false;
      for (let attempt = 0; attempt < REMOVE_ATTEMPTS && !ok; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- list は最大 3 本 × 2 回
        const r = await client.removeFromList({ listId, contactIds: ids });
        ok = r.status >= 200 && r.status < 300;
        if (ok) out.除外した延べ件数 += r.removed;
      }
      removedPerList.push(ok);
      if (!ok) out.errors += 1;
    }
    const allListsOk = removedPerList.every(Boolean);
    if (allListsOk && criticalIds.size > 0) out.criticalRemoved = criticalIds.size;
    if (!allListsOk && criticalIds.size > 0) {
      out.criticalFailure = true;
      out.reason = out.reason || 'remove_failed';
    }
  } catch {
    out.errors += 1;
    out.reason = 'sendgrid_call_failed';
    // ⚠️ 例外でも**反応者の除去失敗は握り潰さない**
    out.criticalFailure = critical.size > 0;
  }
  return out;
}

export default applySelectionExit;
