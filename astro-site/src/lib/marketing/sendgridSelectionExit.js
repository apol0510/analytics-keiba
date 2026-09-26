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
 * - **件数では切り捨てない。** 対象は `EXIT_CHUNK_SIZE` 件ずつ分けて外し、
 *   **時間予算**（`deadlineAtMs`）を越えそうなら新しい塊を始めない（実行時間を食い潰さない）
 *   （2026-09-26: 旧仕様は 1 回 100 件で**超過分を黙って外さなかった**。打ち切り EXHAUSTED は
 *   provider 側の suppression が無いので、外れ残ると次の号が実際に届く）
 * - **優先順**: 反応者（ENGAGED / PROMOTED）→ 打ち切り（EXHAUSTED）→ 抑止（SUPPRESSED）。
 *   時間切れで残るなら、SendGrid の suppression が独立に効く SUPPRESSED から残す
 * - **ログ・戻り値にアドレスを出さない**（件数だけ）
 * - **止めたいときは env 1 つ**（`SENDGRID_SELECTION_EXIT_DISABLED=true`）。
 *   **既定は有効**（env を足さなくても動く）
 */

import { PROSPECT_STATE } from './prospectPolicy.js';
import { listNameFor } from './sendgridAutomationPlan.js';
import { CONTINUATION_LIST_NAME, planContinuation } from './sendgridContinuation.js';

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

/**
 * 1 回の webhook で**受け付ける**対象の安全上限（暴走防止の最後の歯止め）。
 * ⚠️ 実行時間の制御は件数ではなく**時間予算**で行う。ここは通常のバッチでは届かない値にする
 *    （2026-09-26 まではここが 100 で、超過分を外さずに捨てていた）。
 */
export const MAX_EXIT_PER_CALL = 5000;

/** 1 回の除去（DELETE）で渡す contact 数。対象はこの単位で分けて外す */
export const EXIT_CHUNK_SIZE = 100;

/**
 * 時間予算。`deadlineAtMs` が渡されなければ**呼び出し時刻＋既定値**。
 * 1 塊の見積り（検索 2 回＋ list 3 本の除去）を残せないときは新しい塊を始めない。
 */
export const DEFAULT_EXIT_BUDGET_MS = 5000;
export const EXIT_CHUNK_ESTIMATE_MS = 1500;

/** 優先順（小さいほど先に外す）。反応者は list に残ると翌日の号が届くので最優先 */
const EXIT_PRIORITY = Object.freeze({
  [PROSPECT_STATE.ENGAGED]: 0,
  [PROSPECT_STATE.PROMOTED]: 0,
  [PROSPECT_STATE.EXHAUSTED]: 1,
  [PROSPECT_STATE.SUPPRESSED]: 2,
});

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
  const picked = [];
  let capped = 0;

  for (const c of Array.isArray(changes) ? changes : []) {
    const email = normalize(c && c.email);
    const state = String((c && c.state) || '');
    if (!email) { skipped.no_email = (skipped.no_email || 0) + 1; continue; }
    if (!allow.has(state)) { skipped[state || 'unknown_state'] = (skipped[state || 'unknown_state'] || 0) + 1; continue; }
    if (seen.has(email)) { skipped.duplicate = (skipped.duplicate || 0) + 1; continue; }
    seen.add(email);
    if (picked.length >= cap) { capped += 1; continue; }
    picked.push({ email, state, i: picked.length });
    byState[state] = (byState[state] || 0) + 1;
  }
  /** 優先順に並べる（同じ優先度の中では届いた順を保つ） */
  picked.sort((a, b) => (EXIT_PRIORITY[a.state] - EXIT_PRIORITY[b.state]) || (a.i - b.i));
  const emails = picked.map((x) => x.email);
  const criticalEmails = picked.filter((x) => CRITICAL_EXIT_STATES.includes(x.state)).map((x) => x.email);
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
    /**
     * 継続配信の list を引く（**名前が一致するものだけ**）。
     * 無ければ `null`（**webhook は list を作らない**）。
     */
    async continuationListId() {
      const r = await call('GET', '/v3/marketing/lists?page_size=100');
      if (r.status !== 200) return null;
      for (const l of (r.body && r.body.result) || []) {
        if (String(l.name) === CONTINUATION_LIST_NAME) return String(l.id);
      }
      return null;
    },
    /**
     * 継続配信の list へ入れる（**反応した人だけ**）。
     * upsert なので何度呼んでも二重にならない。
     */
    async addToContinuation({ listId, emails }) {
      const list = [...new Set((emails || []).map(normalize))].filter(Boolean);
      if (!listId || list.length === 0) return { status: 0, added: 0 };
      const r = await call('PUT', '/v3/marketing/contacts', {
        list_ids: [String(listId)],
        contacts: list.map((email) => ({ email })),
      });
      return { status: r.status, added: r.status >= 200 && r.status < 300 ? list.length : 0 };
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
export async function applySelectionExit({
  changes, client, env = process.env, deadlineAtMs, nowFn = Date.now,
} = {}) {
  const out = {
    enabled: false, 対象: 0, 状態別: {}, 除外した延べ件数: 0,
    list数: 0, 引き当て: 0, 上限超過: 0, errors: 0, reason: null,
    /** 分けて外した塊の数と、**時間切れで手を付けなかった**対象の数（0 と区別して出す） */
    塊数: 0, 時間切れ残り: 0,
    /** ⚠️ **握り潰してはいけない失敗**（ENGAGED / PROMOTED を外せなかった） */
    criticalFailure: false,
    criticalTargets: 0,
    criticalRemoved: 0,
    /** 反応した人を継続配信の list へ渡した結果（**選別を止めるだけで終わらせない**） */
    continuation: { 対象: 0, 入れた件数: 0, skipped: null },
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

    const deadline = Number.isFinite(deadlineAtMs) ? deadlineAtMs : nowFn() + DEFAULT_EXIT_BUDGET_MS;
    /** 外せた（全 list で成功した）人。継続 list へ渡すのはこの人たちだけ */
    const removedEmails = new Set();
    let anyFound = false;
    let criticalLeft = 0;

    for (let i = 0; i < plan.emails.length; i += EXIT_CHUNK_SIZE) {
      const chunk = plan.emails.slice(i, i + EXIT_CHUNK_SIZE);
      /**
       * ⚠️ **時間予算を越えそうなら新しい塊を始めない。**
       *    途中で打ち切られると「外したのか分からない」状態が残るので、始める前に判断する。
       *    最初の塊だけは必ず処理する（予算 0 でも 1 件も外さない、にはしない）。
       */
      if (i > 0 && nowFn() + EXIT_CHUNK_ESTIMATE_MS > deadline) {
        const rest = plan.emails.slice(i);
        out.時間切れ残り = rest.length;
        criticalLeft = rest.filter((e) => critical.has(e)).length;
        break;
      }
      out.塊数 += 1;

      // eslint-disable-next-line no-await-in-loop -- 塊を順に処理する（SendGrid へ押し寄せない）
      const looked = typeof client.contactIdsChecked === 'function'
        ? await client.contactIdsChecked(chunk)
        // eslint-disable-next-line no-await-in-loop -- 同上
        : { byEmail: new Map((await client.contactIds(chunk)).map((id) => [id, id])), lookupFailed: false };
      const byEmail = looked.byEmail instanceof Map ? looked.byEmail : new Map();
      out.引き当て += byEmail.size;

      /**
       * ⚠️ **引き当てに失敗した（HTTP エラー）ときは「居ない」と見なさない。**
       *    居るのに外せていない可能性があるので、反応者が対象なら失敗として扱う。
       *    一方「検索できたが見つからない」＝ **まだ投入していない人**なので失敗ではない。
       */
      const chunkCritical = chunk.filter((e) => critical.has(e));
      if (looked.lookupFailed && chunkCritical.length > 0) {
        out.criticalFailure = true;
        out.reason = out.reason || 'contact_lookup_failed';
      }

      const ids = [...byEmail.values()];
      if (ids.length === 0) continue;
      anyFound = true;

      /** list ごとに**上限つきで再試行**（新しい queue を作らずに一時障害を吸収する） */
      let allListsOk = true;
      for (const listId of listIds) {
        let ok = false;
        for (let attempt = 0; attempt < REMOVE_ATTEMPTS && !ok; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- list は最大 3 本 × 2 回
          const r = await client.removeFromList({ listId, contactIds: ids });
          ok = r.status >= 200 && r.status < 300;
          if (ok) out.除外した延べ件数 += r.removed;
        }
        if (!ok) { out.errors += 1; allListsOk = false; }
      }
      if (allListsOk) {
        for (const e of chunk) if (byEmail.has(e)) removedEmails.add(e);
        out.criticalRemoved += chunkCritical.filter((e) => byEmail.has(e)).length;
      } else if (chunkCritical.length > 0) {
        out.criticalFailure = true;
        out.reason = out.reason || 'remove_failed';
      }
    }

    /** 反応者を時間切れで残したら**握り潰さない** */
    if (criticalLeft > 0) {
      out.criticalFailure = true;
      out.reason = out.reason || 'time_budget_exhausted';
    } else if (out.時間切れ残り > 0 && !out.reason) {
      out.reason = 'time_budget_exhausted';
    }
    if (!anyFound) {
      if (!out.reason) out.reason = 'contacts_not_found';
      return out;
    }

    /**
     * ── 反応した人を**次の導線へ渡す**（止めるだけで終わらせない）───────
     *
     * ⚠️ **外してから入れる。** 先に入れると、選別 list と継続 list の両方に
     *    居る瞬間ができる。
     * ⚠️ 継続 list が無ければ**作らない**（webhook に list を作らせない）。
     * ⚠️ ここが失敗しても webhook 全体は失敗させない（選別の停止のほうが重い）。
     *    件数と理由だけ残す。
     */
    /** ⚠️ 外せた人だけを渡す（選別 list と継続 list の両方に居る状態を作らない） */
    const cont = planContinuation({
      changes: (Array.isArray(changes) ? changes : [])
        .filter((c) => removedEmails.has(normalize(c && c.email))),
    });
    out.continuation.対象 = cont.emails.length;
    if (cont.emails.length > 0 && typeof client.continuationListId === 'function') {
      const contListId = await client.continuationListId();
      if (!contListId) {
        out.continuation.skipped = 'continuation_list_not_found';
      } else {
        const r = await client.addToContinuation({ listId: contListId, emails: cont.emails });
        out.continuation.入れた件数 = r.added;
        if (r.added === 0) out.continuation.skipped = 'add_failed';
      }
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
