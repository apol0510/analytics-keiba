/**
 * queueJobPreparation.js — 「まだ配信行を確かめていないジョブ」を送らせない（純粋・I/O なし）
 *
 * ── 何が起きたか（2026-08-18 / 2026-08-20 の本番事故）────────────────
 * キュー登録は「`ScheduledEmails` に **PENDING** ジョブを作る → `CampaignDeliveries` を
 * upsert する」の順で進む。ジョブは**作った瞬間から dispatcher の対象**（`{Status}='PENDING'`）
 * なので、2 の途中で実行が終わると
 *
 *   - 配信行が無い PENDING ジョブ（orphan）が残る
 *   - dispatcher はその全員を `delivery_not_found` で skip し、`dispatch_failed` で自動停止する
 *   - 取り消すと automation が同じ相手を積み直し、また同じ形で落ちる
 *
 * という詰みになる。#385 で「読み戻して確認できたときだけ成功」「駄目なら巻き戻す」を入れたが、
 * **実行そのものが途中で終わると補償コードにも到達しない**（2026-08-20 に再発）。
 *
 * ── ここが守ること ────────────────────────────────────────────
 * ⚠️ **ジョブは「未検証」の印を付けて作る。** 配信行の実在を読み戻して確認できてから
 *    印を外す（＝送ってよい状態にする）。印が付いたままのジョブは dispatcher が送らない。
 *    途中で実行が終わっても、残るのは**送られないジョブ**だけになる。
 * ⚠️ **同じ JobId の行を二重に作らない。** `JobId` は plan fingerprint 由来で決まるので、
 *    同じ母集団・同じ本文なら**同じ JobId** になる。失敗して積み直すと、既存行があるのに
 *    `createRecord` がもう 1 行作ってしまい、同じ JobId の行が 2 つできる
 *    （2026-08-20 に本番で発生）。既存行があるなら**それを作り直して使う**。
 * ⚠️ 送信済み（SENT / 送信数 > 0）のジョブは**絶対に作り直さない**（二重送信になる）。
 *
 * 印は `Notes` の中の固定トークンで表す。**新しいフィールドも新しい Status も増やさない**
 * （Airtable の単一選択に選択肢を足すと本番スキーマ変更が要る。Notes は既に
 *  `shell:v1` / `content:...` / `cancelled by ...` を入れている自由記述）。
 */

/** 「配信行をまだ確認していない」ことを表す固定トークン */
export const QUEUE_UNVERIFIED_NOTE = 'queue:unverified';

/** ジョブ行に対して取ってよい操作 */
export const JOB_ROW_ACTION = Object.freeze({
  /** 新しく作る（同じ JobId の行が無い） */
  CREATE: 'create',
  /** 既存行を作り直して使う（同じ JobId の未送信ジョブがある） */
  REUSE: 'reuse',
  /** 何もしない（**送信済み**なので積み直さない） */
  REJECT: 'reject',
});

export const JOB_ROW_REJECT = Object.freeze({
  ALREADY_SENT: 'job_already_sent',
  /** 行は読めたが状態を判断できない = fail closed */
  UNKNOWN_STATE: 'job_state_unknown',
  /** 同じ JobId の行が複数ある（過去の二重作成）。人が片付けるまで書かない */
  DUPLICATE_ROWS: 'job_rows_duplicated',
});

const str = (v) => String(v ?? '').trim();

/** 未検証の印を付ける（既に付いていれば増やさない） */
export function markUnverified(notes) {
  const base = str(notes);
  if (hasUnverifiedMark(base)) return base;
  return base ? `${base} ${QUEUE_UNVERIFIED_NOTE}` : QUEUE_UNVERIFIED_NOTE;
}

/** 未検証の印を外す（配信行を読み戻して確認できたときだけ呼ぶ） */
export function clearUnverified(notes) {
  return str(notes)
    .split(/\s+/)
    .filter((t) => t && t !== QUEUE_UNVERIFIED_NOTE)
    .join(' ');
}

/** 印が付いているか */
export function hasUnverifiedMark(notes) {
  return str(notes).split(/\s+/).includes(QUEUE_UNVERIFIED_NOTE);
}

/**
 * このジョブは送ってよいか（dispatcher が使う）。
 *
 * ⚠️ **fail closed**。`notes` が読めない・空のときは「確認できていない」として送らない…
 *    ではなく、**印が無ければ送ってよい**とする。理由: 既存の運用中ジョブ
 *    （この修正より前に積まれたもの）には印が無く、印を必須にすると
 *    積み残しが一斉に送れなくなる。印は「送るな」の側にだけ効かせる。
 */
export function isQueueVerified(notes) {
  return !hasUnverifiedMark(notes);
}

/**
 * 同じ `JobId` の既存行をどう扱うか。
 *
 * @param {{rows: Array<{id: string, fields: object}>|null}} input
 *   `rows` … `{JobId}='...'` で引いた行（読めなければ `null` = fail closed）
 */
export function decideJobRowAction({ rows } = {}) {
  if (rows === null || rows === undefined) {
    return { action: JOB_ROW_ACTION.REJECT, reason: JOB_ROW_REJECT.UNKNOWN_STATE, recordId: null };
  }
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { action: JOB_ROW_ACTION.CREATE, reason: null, recordId: null };
  if (list.length > 1) {
    return { action: JOB_ROW_ACTION.REJECT, reason: JOB_ROW_REJECT.DUPLICATE_ROWS, recordId: null };
  }
  const row = list[0] || {};
  const f = row.fields || {};
  const status = str(f.Status).toUpperCase();
  const sent = Number(f.SentCount);
  // 1 通でも出ていれば作り直さない（積み直し = 二重送信）
  if (status === 'SENT' || status === 'EXECUTING' || (Number.isFinite(sent) && sent > 0)) {
    return { action: JOB_ROW_ACTION.REJECT, reason: JOB_ROW_REJECT.ALREADY_SENT, recordId: row.id || null };
  }
  if (!row.id) {
    return { action: JOB_ROW_ACTION.REJECT, reason: JOB_ROW_REJECT.UNKNOWN_STATE, recordId: null };
  }
  // PENDING（未検証の作りかけ）/ CANCELLED（巻き戻し済み）は作り直して使える
  return { action: JOB_ROW_ACTION.REUSE, reason: null, recordId: row.id };
}

export default decideJobRowAction;
