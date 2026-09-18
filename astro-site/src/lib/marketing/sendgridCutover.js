/**
 * sendgridCutover.js — 旧 AK 配信と SendGrid Automation を**同時に live にしない**
 * （純粋・I/O なし）
 *
 * ## 何を守るのか
 *
 * 選別配信の実行が 2 つ動くと、**同じ人に同じ通が 2 回届く**。しかも片方は
 * AK の `DeliveryKey`、もう片方は SendGrid の Automation なので、**どちらの
 * 二重送信防止も相手を知らない**。防げるのは「そもそも 1 つしか live にしない」ことだけ。
 *
 * ## 3 つの状態（この順にしか進めない）
 *
 * ```
 *   ak_live ──停止──▶ frozen ──live──▶ sendgrid_live
 *      ▲                 │                   │
 *      └──状態確認のうえ再開──┘◀──Automation を Disable──┘
 * ```
 *
 * - `ak_live`: 現行。AK の cron が prospect へ送る。SendGrid Automation は無い
 * - `frozen`: **どちらも送らない**。ここで snapshot と contact import を行う
 * - `sendgrid_live`: SendGrid だけが送る。AK は prospect を 1 件も読まない
 *
 * ⚠️ `ak_live` から `sendgrid_live` へ**直接**は進めない（必ず `frozen` を挟む）。
 * ⚠️ rollback も必ず `frozen` を経由する。**同じメールを二重送信する rollback は禁止**。
 * ⚠️ `frozen` は「壊れている状態」ではない。**止まっているのが正しい状態**であり、
 *    ここに留まっている限り事故は起きない（急いで進める理由が無い）。
 *
 * ## AK 側の停止は env 1 つ（`MARKETING_PROSPECT_ENGINE`）
 *
 * | 値 | AK の挙動 |
 * |---|---|
 * | 未設定 / `ak` | **従来どおり**（1 バイトも変わらない）|
 * | `sendgrid` | prospect を**母集団に入れない**。prospect 専用 campaign は 1 件も積まない |
 *
 * ⚠️ **未知の値は `ak` へ倒す**（勝手に新経路へ行かせない）。
 * ⚠️ これは Customers 向けの配信を止めない。止めるのは **prospect 宛だけ**。
 */

export const PROSPECT_ENGINE = Object.freeze({ AK: 'ak', SENDGRID: 'sendgrid' });

/** AK 側の prospect 配信エンジンを決める env（未設定 = 従来どおり AK） */
export const PROSPECT_ENGINE_ENV = 'MARKETING_PROSPECT_ENGINE';

export const CUTOVER_STATE = Object.freeze({
  AK_LIVE: 'ak_live',
  FROZEN: 'frozen',
  SENDGRID_LIVE: 'sendgrid_live',
});

/** 進んでよい遷移だけを書く（**表に無い遷移は拒否**） */
const ALLOWED_TRANSITIONS = Object.freeze({
  [CUTOVER_STATE.AK_LIVE]: Object.freeze([CUTOVER_STATE.FROZEN]),
  [CUTOVER_STATE.FROZEN]: Object.freeze([CUTOVER_STATE.SENDGRID_LIVE, CUTOVER_STATE.AK_LIVE]),
  [CUTOVER_STATE.SENDGRID_LIVE]: Object.freeze([CUTOVER_STATE.FROZEN]),
});

/** prospect 専用 campaign を積まない理由（ログ・応答にそのまま出す） */
export const ENGINE_SKIP_REASON = 'prospect_engine_is_sendgrid';

/**
 * env → エンジン。**未知の値・未設定は `ak`**（挙動は 1 バイトも変わらない）。
 */
export function resolveProspectEngine(env = process.env) {
  const raw = String((env && env[PROSPECT_ENGINE_ENV]) || '').trim().toLowerCase();
  return raw === PROSPECT_ENGINE.SENDGRID ? PROSPECT_ENGINE.SENDGRID : PROSPECT_ENGINE.AK;
}

/**
 * この tick で prospect を扱ってよいか。
 *
 * @param {{engine: string, declaredSource: string}} input
 *   `declaredSource` は `resolveAudienceSource(campaign)` の値（`all` / `prospect` / `customer`）
 * @returns {{readProspects: boolean, skip: boolean, reason: string|null}}
 *   `skip` が true なら **その campaign は 1 件も積まない**
 */
export function decideProspectSending({ engine, declaredSource } = {}) {
  const e = engine === PROSPECT_ENGINE.SENDGRID ? PROSPECT_ENGINE.SENDGRID : PROSPECT_ENGINE.AK;
  if (e === PROSPECT_ENGINE.AK) return { readProspects: true, skip: false, reason: null };
  // SendGrid が送る側。prospect 専用 campaign は**そもそも進めない**
  if (String(declaredSource || '') === 'prospect') {
    return { readProspects: false, skip: true, reason: ENGINE_SKIP_REASON };
  }
  // `all` / `customer` の campaign は Customers 向けに続ける（prospect だけ読まない）
  return { readProspects: false, skip: false, reason: ENGINE_SKIP_REASON };
}

/**
 * **二重稼働の検査**。live が 2 つある状態を作らせない。
 *
 * @param {{akProspectSending: boolean, sendgridAutomationLive: boolean}} input
 * @returns {{ok: boolean, violation: string|null, state: string}}
 */
export function assertSingleEngine({ akProspectSending, sendgridAutomationLive } = {}) {
  const ak = akProspectSending === true;
  const sg = sendgridAutomationLive === true;
  if (ak && sg) return { ok: false, violation: 'both_engines_live', state: 'conflict' };
  if (ak) return { ok: true, violation: null, state: CUTOVER_STATE.AK_LIVE };
  if (sg) return { ok: true, violation: null, state: CUTOVER_STATE.SENDGRID_LIVE };
  return { ok: true, violation: null, state: CUTOVER_STATE.FROZEN };
}

/**
 * 状態遷移の可否。**表に無い遷移は拒否**（`ak_live` → `sendgrid_live` は通さない）。
 */
export function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[String(from)] || [];
  if (allowed.includes(String(to))) return { ok: true, reason: null };
  return { ok: false, reason: from === to ? 'no_change' : 'transition_not_allowed' };
}

/**
 * 本番切替の手順（**この順序でしか実行しない**）。
 *
 * ⚠️ `approval: true` の段は **MK 承認の直前で停止**する（自動で越えない）。
 */
export const CUTOVER_STEPS = Object.freeze([
  Object.freeze({
    order: 1,
    id: 'stop_ak_prospect',
    title: '旧 AK prospect 配信を止める',
    detail: `production の ${PROSPECT_ENGINE_ENV}=sendgrid を設定して redeploy する`,
    state: CUTOVER_STATE.FROZEN,
    approval: true,
    reversible: true,
  }),
  Object.freeze({
    order: 2,
    id: 'verify_stopped',
    title: '止まったことを確かめる',
    detail: 'prospect 宛の enqueue が 0 件・送信待ちジョブ 0 件であることを read-only で確認する',
    state: CUTOVER_STATE.FROZEN,
    approval: false,
    reversible: true,
  }),
  Object.freeze({
    order: 3,
    id: 'snapshot',
    title: '状態を控える',
    detail: 'prospect 索引 / 台帳 / 通し番号別件数を read-only で控える（digest つき）',
    state: CUTOVER_STATE.FROZEN,
    approval: false,
    reversible: true,
  }),
  Object.freeze({
    order: 4,
    id: 'import_contacts',
    title: 'SendGrid へ contact を import する',
    detail: '通し番号別の list へ upsert する（**この時点では Automation は live にしない**）',
    state: CUTOVER_STATE.FROZEN,
    approval: true,
    reversible: true,
  }),
  Object.freeze({
    order: 5,
    id: 'verify_import',
    title: 'import の結果を確かめる',
    detail: 'list ごとの contact 数が通し番号別件数と一致することを確認する',
    state: CUTOVER_STATE.FROZEN,
    approval: false,
    reversible: true,
  }),
  Object.freeze({
    order: 6,
    id: 'set_live',
    title: 'Automation を live にする',
    detail: '0 人の入口は作らない。live にするのは対象が居る Automation だけ',
    state: CUTOVER_STATE.SENDGRID_LIVE,
    approval: true,
    reversible: true,
  }),
  Object.freeze({
    order: 7,
    id: 'verify_single_engine',
    title: '二重稼働 0 を確かめる',
    detail: 'AK 側 prospect 送信 0 件 ＋ SendGrid の送信が始まっていることを両方確認する',
    state: CUTOVER_STATE.SENDGRID_LIVE,
    approval: false,
    reversible: true,
  }),
]);

/** rollback の手順（**同じメールを二重送信する rollback は作らない**） */
export const ROLLBACK_STEPS = Object.freeze([
  Object.freeze({
    order: 1,
    id: 'disable_automations',
    title: 'SendGrid Automation をすべて Disable にする',
    detail: '送信中の 1 通が出ることはあるが、次の 1 通は出なくなる',
    state: CUTOVER_STATE.FROZEN,
  }),
  Object.freeze({
    order: 2,
    id: 'reconcile',
    title: 'SendGrid で送られた通を AK 側の台帳へ反映する',
    detail: 'Event Webhook の delivered を数え直し、通し番号の進みを合わせる',
    state: CUTOVER_STATE.FROZEN,
  }),
  Object.freeze({
    order: 3,
    id: 'resume_ak',
    title: `${PROSPECT_ENGINE_ENV} を外して AK を再開する`,
    detail: '**再開前に通し番号の進みが合っていることを確認する**（合っていなければ再開しない）',
    state: CUTOVER_STATE.AK_LIVE,
  }),
]);

/**
 * いま何段目か → 次にやること。**承認が要る段は `stop: true`** を返す。
 */
export function nextCutoverStep(completedIds = []) {
  const done = new Set((Array.isArray(completedIds) ? completedIds : []).map(String));
  const next = CUTOVER_STEPS.find((s) => !done.has(s.id)) || null;
  if (!next) return { done: true, step: null, stop: false };
  return { done: false, step: next, stop: next.approval === true };
}

export default resolveProspectEngine;
