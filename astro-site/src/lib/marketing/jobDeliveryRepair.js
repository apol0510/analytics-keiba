/**
 * jobDeliveryRepair.js — **積みかけのジョブを壊さずに仕上げる**（純粋・I/O なし）
 *
 * ## なぜ要るか
 *
 * キュー登録は「ジョブ行を作る → 配信行を書く → 読み戻して確認 → `queue:unverified` を外す」
 * の順で進む。途中で実行が終わると **PENDING ＋ 印つき ＋ 配信行が一部だけ**のジョブが残る。
 * dispatcher は印を見て **1 通も送らずに block** するので事故にはならないが、
 * **そのジョブは永久に前へ進めない**。
 *
 * 既存の補完（`settleQueueWrite` の A）は**キュー登録トランザクションの中でしか動かない**。
 * 後から名指しで仕上げる入口が無いので、ここがその判定を持つ。
 *
 * ## ⚠️ 壊さない（この経路の核心）
 *
 *   - **元ジョブの `Recipients` が正本**。計画を作り直さない（母集団が変わると別ジョブになる）
 *   - **既に在る配信行は変更も削除もしない**
 *   - **既に予約済みの鍵は release しない**（`releaseClaims` は「自分が取って queue に失敗した鍵」専用）
 *   - 足りない鍵**だけ**を claim し、**claim できた分だけ**行を足す
 *   - 全員ぶん読み戻せたときだけ `queue:unverified` を外す
 */

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();

/** 仕上げに入れない理由（**入れないほうが安全**な状態）*/
export const REPAIR_REJECT = Object.freeze({
  NOT_FOUND: 'job_not_found',
  DUPLICATE_ROWS: 'duplicate_job_rows',
  NOT_MARKETING: 'not_marketing_job',
  NOT_PENDING: 'job_not_pending',
  /** 1 通でも出ている → 触らない（二重送信の芽）*/
  ALREADY_SENT: 'job_already_sent',
  /** 印が無い＝もう確認済み。仕上げる対象ではない */
  NOT_UNVERIFIED: 'job_already_verified',
  NO_RECIPIENTS: 'job_has_no_recipients',
  /** どの step の内容なのか決められない（鍵を作れない）*/
  STEP_UNRESOLVED: 'step_unresolved',
  /** 配信行を読めなかった（読めない＝不足と決めつけない）*/
  ROWS_UNAVAILABLE: 'delivery_rows_unavailable',
  /** ⚠️ 既存行の鍵が、いま計算した鍵と一致しない（別物を掴んでいる）*/
  KEY_MISMATCH: 'delivery_key_mismatch',
});

/** 配信行が「もう在る」とみなす Status（`cancelled` は巻き戻し済みなので含めない）*/
export const ACTIVE_DELIVERY_STATUS = Object.freeze(new Set(['queued', 'sent']));

/**
 * このジョブを仕上げてよいか。**1 つでも外れたら触らない**。
 *
 * @param {{rows: Array|null, isMarketing: boolean, hasUnverified: boolean}} input
 *   `rows` … `{JobId}='...'` で引いた行（**読めなければ null** = fail closed）
 */
export function canRepairJob({ rows, isMarketing, hasUnverified } = {}) {
  if (rows === null || rows === undefined) return deny(REPAIR_REJECT.ROWS_UNAVAILABLE);
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return deny(REPAIR_REJECT.NOT_FOUND);
  if (list.length > 1) return deny(REPAIR_REJECT.DUPLICATE_ROWS);
  const row = list[0] || {};
  const f = row.fields || {};
  if (isMarketing !== true) return deny(REPAIR_REJECT.NOT_MARKETING);
  const status = str(f.Status).toUpperCase();
  const sent = Number(f.SentCount);
  // ⚠️ 1 通でも出ていれば触らない
  if (Number.isFinite(sent) && sent > 0) return deny(REPAIR_REJECT.ALREADY_SENT);
  if (status === 'SENT' || status === 'EXECUTING') return deny(REPAIR_REJECT.ALREADY_SENT);
  if (status !== 'PENDING') return deny(REPAIR_REJECT.NOT_PENDING);
  // 印が無い＝確認済み。仕上げる対象ではない（触ると却って壊す）
  if (hasUnverified !== true) return deny(REPAIR_REJECT.NOT_UNVERIFIED);
  if (!row.id) return deny(REPAIR_REJECT.NOT_FOUND);
  return { ok: true, reason: null, recordId: row.id, fields: f };
}

function deny(reason) { return { ok: false, reason, recordId: null, fields: null }; }

/**
 * 何が足りないかを決める。**元ジョブの宛先が正本**。
 *
 * @param {{
 *   recipients: string[],                        // 元ジョブの Recipients（正本）
 *   keyByEmail: Map<string,string>,              // 宛先 → DeliveryKey（呼び出し側が正規生成）
 *   existingRows: Array<{id, fields}>|null,      // この鍵の配信行（**読めなければ null**）
 * }} input
 */
export function planJobDeliveryRepair({ recipients, keyByEmail, existingRows } = {}) {
  const list = [...new Set((Array.isArray(recipients) ? recipients : []).map(lower).filter(Boolean))];
  if (list.length === 0) return { ok: false, reason: REPAIR_REJECT.NO_RECIPIENTS };
  if (!(keyByEmail instanceof Map)) return { ok: false, reason: REPAIR_REJECT.STEP_UNRESOLVED };
  if (existingRows === null || existingRows === undefined) {
    return { ok: false, reason: REPAIR_REJECT.ROWS_UNAVAILABLE };
  }

  const expectedKeys = [];
  for (const email of list) {
    const k = str(keyByEmail.get(email));
    // 鍵を作れない宛先がある = step / 内容が決められていない。**部分的に進めない**
    if (!k) return { ok: false, reason: REPAIR_REJECT.STEP_UNRESOLVED };
    expectedKeys.push(k);
  }
  const expected = new Set(expectedKeys);

  const activeKeys = new Set();
  const foreign = [];
  for (const r of Array.isArray(existingRows) ? existingRows : []) {
    const f = (r && r.fields) || {};
    const k = str(f.DeliveryKey);
    if (!k) continue;
    // ⚠️ 計算した鍵に無い行が混ざっている = 別物を掴んでいる。**触らない**
    if (!expected.has(k)) { foreign.push(str(r.id)); continue; }
    if (ACTIVE_DELIVERY_STATUS.has(lower(f.Status))) activeKeys.add(k);
  }
  if (foreign.length > 0) {
    return { ok: false, reason: REPAIR_REJECT.KEY_MISMATCH, foreignRows: foreign.slice(0, 20) };
  }

  const missing = [];
  for (const email of list) {
    const k = keyByEmail.get(email);
    if (!activeKeys.has(k)) missing.push({ email, key: k });
  }
  return {
    ok: true,
    reason: null,
    total: list.length,
    present: activeKeys.size,
    missing,                        // ⚠️ ここだけを claim / 追加する
    expectedKeys,
    counts: { total: list.length, present: activeKeys.size, missing: missing.length },
  };
}

/**
 * 仕上がったと言えるか。**全員ぶん読み戻せたときだけ**。
 *
 * ⚠️ 「書けた」ではなく「**読み戻して在った**」で判定する。
 */
export function verifyRepairComplete({ expectedKeys, verifiedKeys } = {}) {
  const exp = new Set((Array.isArray(expectedKeys) ? expectedKeys : []).map(str).filter(Boolean));
  if (exp.size === 0) return { ok: false, reason: REPAIR_REJECT.NO_RECIPIENTS, missing: null };
  if (!(verifiedKeys instanceof Set)) {
    return { ok: false, reason: REPAIR_REJECT.ROWS_UNAVAILABLE, missing: null };
  }
  let missing = 0;
  for (const k of exp) if (!verifiedKeys.has(k)) missing += 1;
  return { ok: missing === 0, reason: missing === 0 ? null : 'incomplete', missing, expected: exp.size };
}

/** 仕上げを許す確認文字列 */
export const REPAIR_CONFIRM = 'REPAIR CAMPAIGN JOB';
