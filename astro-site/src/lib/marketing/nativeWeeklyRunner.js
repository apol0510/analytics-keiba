/**
 * nativeWeeklyRunner.js — 週次の 1 枠について、元々の会員の list を**段階ごとに 1 歩だけ**進める。
 *
 * 呼び出し元: `cron-sendgrid-weekly.js`（`SENDGRID_WEEKLY_NATIVE_ENABLED=true` のときだけ）。
 * 依存（Airtable / SendGrid / Redis）は注入する（テストで本番へ出ない）。
 *
 * 戻り値の意味:
 *   { defer: true }                   … 今回は Single Send を作らない（次の実行で続ける）
 *   { defer: false, ready: true, listId }  … native を足して予約してよい
 *   { defer: false, ready: false }    … native を足さずに予約する（fail closed）
 *
 * ⚠️ 例外は外へ投げない。読めない・書けないときは「native を足さない」へ倒す（反応した見込み客の週次は止めない）。
 */

import {
  NATIVE_STAGE, NATIVE_STATUS, NATIVE_FAIL,
  buildNativeAudience, planNativeStage, evaluateImport, planListCleanup,
  nativeListName, summarizeNativeAudience,
} from './nativeWeeklySync.js';

const code = (e) => String((e && e.code) || (e && e.message) || 'error').slice(0, 80);

/**
 * @param {{
 *   slot: {dateKey: string, sendAt: string},
 *   nowMs: number,
 *   deps: {
 *     redis: Function|null,
 *     readState: Function, writeState: Function,
 *     loadInputs: () => Promise<object>,        // buildNativeAudience の入力（customers 等）
 *     sendgrid: () => object,                   // createNativeSendgrid の結果を返す
 *     referencedListIds: () => Promise<Set<string>|null>,  // 予約中・下書きの Single Send が使う list
 *   },
 * }} input
 */
export async function runNativeWeeklyStep({ slot, nowMs, deps }) {
  const dateKey = slot && slot.dateKey;
  const slotMs = Date.parse(String(slot && slot.sendAt));
  const summary = { enabled: true, dateKey, stage: null, reason: null };
  const noNative = (reason) => ({ defer: false, ready: false, listId: null, summary: { ...summary, reason } });

  if (typeof deps.redis !== 'function') return noNative('redis_unavailable');

  let state = null;
  try { state = await deps.readState(deps.redis, dateKey); } catch (e) { return noNative(`state_read:${code(e)}`); }
  const plan = planNativeStage({ nowMs, slotMs, state });
  summary.stage = plan.stage;

  const fail = async (reason, extra = {}) => {
    try {
      await deps.writeState(deps.redis, dateKey, { ...(state || {}), ...extra, status: NATIVE_STATUS.FAILED, reason, updatedAtMs: nowMs });
    } catch { /* 状態を残せなくても native は足さない */ }
    return noNative(reason);
  };

  if (plan.stage === NATIVE_STAGE.WAIT) {
    // 予約済みなのに Single Send が無い＝食い違い。native を足さずに作る（既存の週次を止めない）
    if (plan.reason === 'already_scheduled') return noNative('state_scheduled_but_send_missing');
    return { defer: true, summary: { ...summary, reason: plan.reason } };
  }
  if (plan.stage === NATIVE_STAGE.SCHEDULE_WITH_NATIVE) {
    return { defer: false, ready: true, listId: String(state.listId), summary: { ...summary, expected: state.expected } };
  }
  if (plan.stage === NATIVE_STAGE.SCHEDULE_WITHOUT_NATIVE) {
    if (!state || state.status !== NATIVE_STATUS.FAILED) return fail(plan.reason || 'deadline');
    return noNative(plan.reason || state.reason || 'failed');
  }

  let sg;
  try { sg = deps.sendgrid(); } catch (e) { return fail(`sendgrid:${code(e)}`); }

  if (plan.stage === NATIVE_STAGE.CHECK) {
    try {
      await sg.listLists();   // list id が native であることを確かめてから人数を読む
      const jobs = [];
      for (const id of state.jobIds || []) {
        // eslint-disable-next-line no-await-in-loop
        jobs.push(await sg.getImportStatus(id));
      }
      const listCount = await sg.getListCount(state.listId);
      const ev = evaluateImport({ jobs, listCount, expected: Number(state.expected) });
      if (ev.status === 'failed') return fail(ev.reason, { listCount });
      if (ev.status === 'pending') {
        await deps.writeState(deps.redis, dateKey, { ...state, listCount, pendingReason: ev.reason, updatedAtMs: nowMs });
        return { defer: true, summary: { ...summary, reason: ev.reason, expected: state.expected, listCount } };
      }
      const next = { ...state, status: NATIVE_STATUS.READY, listCount, updatedAtMs: nowMs };
      await deps.writeState(deps.redis, dateKey, next);
      return { defer: false, ready: true, listId: String(state.listId), summary: { ...summary, expected: state.expected, listCount } };
    } catch (e) {
      return { defer: true, summary: { ...summary, reason: `check:${code(e)}` } };
    }
  }

  // ── BUILD ──────────────────────────────────────────────
  let built;
  try {
    const inputs = await deps.loadInputs();
    built = buildNativeAudience({ ...inputs, nowMs });
  } catch (e) {
    return fail(`${NATIVE_FAIL.INPUT_UNAVAILABLE}:${code(e)}`);
  }
  if (!built.ok) {
    const b = /** @type {any} */ (built);
    return fail(`${b.reason}:${(b.missing || []).join('+')}`);
  }
  if (built.emails.length === 0) return fail(NATIVE_FAIL.EMPTY_AUDIENCE, { audience: summarizeNativeAudience(built) });

  try {
    const lists = await sg.listLists();
    const name = nativeListName(dateKey);
    const existing = lists.find((l) => l.name === name);
    // 状態の無い同名 list は途中で止まった残り。中身が古い可能性があるので作り直す
    if (existing) await sg.deleteList(existing.id);
    const listId = await sg.createList(name);
    const up = await sg.upsertToList({ listId, emails: built.emails });
    const next = {
      status: NATIVE_STATUS.IMPORTING,
      listId, listName: name,
      expected: up.accepted, rejected: up.rejected, jobIds: up.jobIds,
      digest: built.digest,
      audience: summarizeNativeAudience(built),
      builtAtMs: nowMs, updatedAtMs: nowMs,
    };
    await deps.writeState(deps.redis, dateKey, next);

    // 古い native list の片付け（失敗しても今回の枠は進める）
    let cleaned = 0;
    try {
      const refs = await deps.referencedListIds();
      for (const id of planListCleanup({ lists, referencedListIds: refs, nowMs })) {
        if (id === listId) continue;
        // eslint-disable-next-line no-await-in-loop
        await sg.deleteList(id);
        cleaned += 1;
      }
    } catch { /* 片付けは次回へ */ }

    return {
      defer: true,
      summary: { ...summary, reason: 'importing', expected: up.accepted, rejected: up.rejected, jobs: up.jobIds.length, cleaned, audience: summarizeNativeAudience(built) },
    };
  } catch (e) {
    return fail(`build:${code(e)}`);
  }
}

export default runNativeWeeklyStep;
