/**
 * sendgridListReconcile.js — **AK を正本として** SendGrid の選別 list を合わせ直す（判定だけ / I/O なし）
 *
 * ## なぜ要るか（2026-09-19 の実測）
 *
 * contact を投入したあと、**遅れて届いた `delivered` イベント**で AK 側の
 * 「次に送る番号」が 2 → 3 へ進んだ人が出た。SendGrid 側の contact は投入時のまま
 * （`ak_next_message = 2` / `start-2` 在籍）なので、そのまま予約すると
 * **その人に 2 通目が再送**される。反応して離脱した人が list に残る取りこぼしも同じ形で起きる。
 *
 * これは「3 名を手で直す」話ではない。**予約の直前に毎回**、
 * AK の最新状態へ list を合わせ直す手順として持つ。cutover のたびに再利用する。
 *
 * ## 正本（この順序で判定する）
 *
 * 1. **AK が正本**。SendGrid の `ak_next_message` も list 在籍も、AK の状態に合わせる
 * 2. AK で送ってよい人（`READY`）は、**自分の通し番号の list だけ**に居る
 * 3. AK で送ってはいけない人（ENGAGED / PROMOTED / SUPPRESSED / EXHAUSTED /
 *    Customers へ昇格済み）は、**3 本すべての list に居ない**
 * 4. **AK の list 以外には触らない**（KI / nankan / review の資産を巻き込まない）
 * 5. SendGrid が受理しない宛先（`provider rejected`）は**対象外のまま**。
 *    直し方が無いので「直った」ことにしない（`unaddable` として数える）
 *
 * ⚠️ ここは**判定だけ**。実際の add / remove は呼び出し側が行う。
 * ⚠️ 要約（`summarizeReconcilePlan`）に**アドレスを入れない**。
 */

/** AK 側で「送ってはいけない」状態（list から外す） */
export const RECONCILE_EXCLUDE_STATES = Object.freeze([
  'engaged', 'promoted', 'suppressed', 'exhausted',
]);

/** 1 回の reconcile で触ってよい上限（**越えるなら人に返す**） */
export const RECONCILE_LIMITS = Object.freeze({
  /** add / remove を合わせた変更数の上限 */
  maxChanges: 3000,
  /** 1 リクエストで引ける contact 数（SendGrid の上限） */
  lookupChunk: 50,
  /** 1 リクエストで upsert する contact 数 */
  upsertChunk: 500,
  /** 1 リクエストで list から外す contact 数 */
  removeChunk: 100,
});

export const RECONCILE_ACTION = Object.freeze({
  /** 正しい list に居る。何もしない */
  OK: 'ok',
  /** 正しい list に居ない → 入れる（`ak_next_message` も書き直す） */
  ADD: 'add',
  /** 間違った list に居る → 外す */
  REMOVE: 'remove',
  /** SendGrid に居ない → 入れる（**受理されないことがある**） */
  MISSING: 'missing',
  /** AK 側で送ってはいけない人が list に居る → 全 list から外す */
  EXIT: 'exit',
  /** 判定できない（通し番号が無い等）。**触らない** */
  SKIP: 'skip',
});

const norm = (v) => String(v || '').trim().toLowerCase();
const isInt = (v) => Number.isInteger(v);

/**
 * AK の 1 人と SendGrid の現状 1 件を突き合わせる。
 *
 * @param {{email:string, nextMessageNumber?:number, state?:string, sendable:boolean}} ak
 * @param {{listIds?:string[], nextMessage?:number|null}|null} sg SendGrid 側（居なければ null）
 * @param {{listIdByMessage: Map<number,string>|object, allListIds: string[]}} ctx
 */
export function classifyContact(ak, sg, ctx) {
  const email = norm(ak && ak.email);
  const all = new Set((ctx && ctx.allListIds) || []);
  const listOf = (n) => {
    const m = ctx && ctx.listIdByMessage;
    if (m instanceof Map) return m.get(n) || null;
    return (m && m[n]) ? String(m[n]) : null;
  };
  if (!email) return { email: '', action: RECONCILE_ACTION.SKIP, reason: 'no_email' };

  const current = new Set(((sg && sg.listIds) || []).map(String).filter((id) => all.has(id)));

  // 送ってはいけない人 → **AK の list すべてから外す**
  if (!ak.sendable) {
    if (!sg) return { email, action: RECONCILE_ACTION.SKIP, reason: 'not_in_sendgrid' };
    if (current.size === 0) return { email, action: RECONCILE_ACTION.OK, reason: 'already_out' };
    return {
      email, action: RECONCILE_ACTION.EXIT, removeFrom: [...current],
      reason: `excluded:${norm(ak.state) || 'unknown'}`,
    };
  }

  const n = ak.nextMessageNumber;
  if (!isInt(n) || n < 1 || n > 10) return { email, action: RECONCILE_ACTION.SKIP, reason: 'bad_message_number' };
  const want = listOf(n);
  // **入れる先が無いなら触らない**（0 人の list を作らせない・取り違えない）
  if (!want) return { email, action: RECONCILE_ACTION.SKIP, reason: 'no_list_for_message' };

  const wrong = [...current].filter((id) => id !== want);

  if (!sg) {
    return { email, action: RECONCILE_ACTION.MISSING, addTo: want, nextMessage: n, reason: 'not_in_sendgrid' };
  }
  if (!current.has(want)) {
    return {
      email, action: RECONCILE_ACTION.ADD, addTo: want, nextMessage: n,
      removeFrom: wrong, reason: wrong.length > 0 ? 'wrong_list' : 'not_in_list',
    };
  }
  if (wrong.length > 0) {
    return { email, action: RECONCILE_ACTION.REMOVE, removeFrom: wrong, nextMessage: n, reason: 'also_in_wrong_list' };
  }
  // 在籍は正しい。`ak_next_message` がずれていれば入れ直して直す（upsert は冪等）
  if (isInt(sg.nextMessage) && sg.nextMessage !== n) {
    return { email, action: RECONCILE_ACTION.ADD, addTo: want, nextMessage: n, removeFrom: [], reason: 'field_mismatch' };
  }
  return { email, action: RECONCILE_ACTION.OK, reason: 'in_correct_list' };
}

/**
 * 突き合わせ結果から **remove → add の順**の計画を作る。
 *
 * ⚠️ 順序は **remove が先**。先に add すると、間違った list と正しい list の両方に
 *    居る瞬間ができ、その瞬間に予約が走ると 2 通届く。
 *
 * @param {{
 *   akEntries: Array<{email:string, nextMessageNumber?:number, state?:string, sendable:boolean}>,
 *   sendgridByEmail: Map<string, {listIds?:string[], nextMessage?:number|null}>|object,
 *   listIdByMessage: Map<number,string>|object,
 * }} input
 */
export function buildReconcilePlan({ akEntries, sendgridByEmail, listIdByMessage } = {}) {
  const lookup = sendgridByEmail instanceof Map
    ? sendgridByEmail
    : new Map(Object.entries(sendgridByEmail || {}));
  const listIds = listIdByMessage instanceof Map
    ? [...listIdByMessage.values()].map(String)
    : Object.values(listIdByMessage || {}).map(String);
  const allListIds = listIds.filter(Boolean);
  if (allListIds.length === 0) {
    return { ok: false, reason: 'list_ids_missing', removeByList: new Map(), addByList: new Map(), counts: {} };
  }

  const removeByList = new Map();
  const addByList = new Map();
  const counts = {
    [RECONCILE_ACTION.OK]: 0,
    [RECONCILE_ACTION.ADD]: 0,
    [RECONCILE_ACTION.REMOVE]: 0,
    [RECONCILE_ACTION.MISSING]: 0,
    [RECONCILE_ACTION.EXIT]: 0,
    [RECONCILE_ACTION.SKIP]: 0,
  };
  const reasons = {};
  const seen = new Set();

  for (const ak of Array.isArray(akEntries) ? akEntries : []) {
    const email = norm(ak && ak.email);
    if (!email || seen.has(email)) { counts[RECONCILE_ACTION.SKIP] += 1; continue; }
    seen.add(email);
    const r = classifyContact(ak, lookup.get(email) || null, { listIdByMessage, allListIds });
    counts[r.action] += 1;
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    for (const listId of r.removeFrom || []) {
      if (!allListIds.includes(String(listId))) continue; // AK の list 以外は触らない
      if (!removeByList.has(listId)) removeByList.set(listId, []);
      removeByList.get(listId).push(email);
    }
    if (r.addTo) {
      if (!addByList.has(r.addTo)) addByList.set(r.addTo, []);
      addByList.get(r.addTo).push({ email, nextMessage: r.nextMessage });
    }
  }

  const changes = [...removeByList.values()].reduce((a, v) => a + v.length, 0)
    + [...addByList.values()].reduce((a, v) => a + v.length, 0);

  return { ok: true, removeByList, addByList, counts, reasons, changes, listIds: allListIds };
}

/** 件数だけの要約（**アドレスを含めない**） */
export function summarizeReconcilePlan(plan) {
  if (!plan || plan.ok === false) {
    return { ok: false, 理由: (plan && plan.reason) || 'unknown', 変更予定: 0 };
  }
  const per = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.length]));
  return {
    ok: true,
    一致: plan.counts[RECONCILE_ACTION.OK],
    入れ直す: plan.counts[RECONCILE_ACTION.ADD],
    間違った_list_から外す: plan.counts[RECONCILE_ACTION.REMOVE],
    'SendGrid に居ない': plan.counts[RECONCILE_ACTION.MISSING],
    退出させる: plan.counts[RECONCILE_ACTION.EXIT],
    触らない: plan.counts[RECONCILE_ACTION.SKIP],
    変更予定: plan.changes,
    list別_外す: per(plan.removeByList),
    list別_入れる: per(plan.addByList),
    理由別: plan.reasons,
  };
}

/**
 * 実行前の安全確認。**越えていたら実行しない**（人に返す）。
 */
export function assertReconcileSafety(plan, { maxChanges = RECONCILE_LIMITS.maxChanges } = {}) {
  if (!plan || plan.ok === false) return { ok: false, violation: 'plan_invalid' };
  if (plan.changes > maxChanges) {
    return { ok: false, violation: 'too_many_changes', changes: plan.changes, maxChanges };
  }
  // 同じアドレスを「外す」と「入れる」で同じ list に入れていない
  for (const [listId, emails] of plan.addByList.entries()) {
    const removing = new Set(plan.removeByList.get(listId) || []);
    for (const e of emails) {
      if (removing.has(e.email)) return { ok: false, violation: 'add_and_remove_same_list' };
    }
  }
  return { ok: true, violation: null, changes: plan.changes };
}

/**
 * 実行の順序（**remove → add**）を、呼び出し側が取り違えないように固定して返す。
 */
export function reconcileSteps(plan) {
  if (!plan || plan.ok === false) return [];
  const steps = [];
  for (const [listId, emails] of plan.removeByList.entries()) {
    for (let i = 0; i < emails.length; i += RECONCILE_LIMITS.removeChunk) {
      steps.push({ op: 'remove', listId, emails: emails.slice(i, i + RECONCILE_LIMITS.removeChunk) });
    }
  }
  for (const [listId, entries] of plan.addByList.entries()) {
    for (let i = 0; i < entries.length; i += RECONCILE_LIMITS.upsertChunk) {
      steps.push({ op: 'add', listId, entries: entries.slice(i, i + RECONCILE_LIMITS.upsertChunk) });
    }
  }
  return steps;
}

/**
 * **1 件でも受理されない宛先が混ざると batch ごと落ちる**ので、落ちたら割って通す。
 *
 * SendGrid の contacts API（upsert も `search/emails` も）は、
 * 壊れたアドレスが 1 件混ざると**リクエスト全体を 400 で返す**。
 * 2026-09-18 の投入でこれを踏み、良い宛先まで巻き添えで落ちた。
 * だから **半分に割って再試行**し、1 件まで割っても通らないものだけを
 * `provider rejected` として数える（**直せないものを直ったことにしない**）。
 *
 * @param {Array} items 送る単位（アドレスの配列など）
 * @param {(chunk:Array)=>Promise<any>} run 1 チャンクを処理する（失敗は throw）
 * @returns {Promise<{ok:number, rejected:Array, requests:number}>} rejected は**ログへ出さない**
 */
export async function runWithSplit(items, run, { minChunk = 1 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const rejected = [];
  let ok = 0; let requests = 0;
  const stack = list.length > 0 ? [list] : [];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || cur.length === 0) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- 失敗したときだけ割る
      await run(cur);
      requests += 1;
      ok += cur.length;
    } catch {
      requests += 1;
      if (cur.length <= minChunk) { rejected.push(...cur); continue; }
      const mid = Math.floor(cur.length / 2);
      stack.push(cur.slice(mid), cur.slice(0, mid));
    }
  }
  return { ok, rejected, requests };
}

export default buildReconcilePlan;
