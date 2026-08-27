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
  /**
   * ⚠️ 同じ `DeliveryKey` に **cancelled / failed / skipped 等の行**が在る。
   *    `performUpsert` は `DeliveryKey` をマージキーにするので、ここで足すと
   *    **その行が `queued` に書き換わる**（＝「既存行は変更しない」に反する）。
   *    巻き戻し済み・失敗済みを黙って復活させないため、**自動では直さない**。
   */
  NON_ACTIVE_ROW: 'non_active_delivery_row',
  /** ⚠️ 同じ `DeliveryKey` の行が 2 つ以上ある（どれが正本か決められない）*/
  DUPLICATE_DELIVERY_ROWS: 'duplicate_delivery_rows',
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

  // 鍵ごとに行を集める（**1 鍵 = 1 行**が前提。崩れていたら触らない）
  const rowsByKey = new Map();
  const foreign = [];
  for (const r of Array.isArray(existingRows) ? existingRows : []) {
    const f = (r && r.fields) || {};
    const k = str(f.DeliveryKey);
    if (!k) continue;
    // ⚠️ 計算した鍵に無い行が混ざっている = 別物を掴んでいる。**触らない**
    if (!expected.has(k)) { foreign.push(str(r.id)); continue; }
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k).push(r);
  }
  if (foreign.length > 0) {
    return { ok: false, reason: REPAIR_REJECT.KEY_MISMATCH, foreignRows: foreign.slice(0, 20) };
  }

  // ⚠️ 同じ鍵に 2 行以上 = どれが正本か決められない。**触らない**
  const duplicated = [...rowsByKey.entries()].filter(([, rs]) => rs.length > 1);
  if (duplicated.length > 0) {
    return {
      ok: false,
      reason: REPAIR_REJECT.DUPLICATE_DELIVERY_ROWS,
      conflictKeys: duplicated.map(([k]) => k).slice(0, 20),
    };
  }

  /**
   * ⚠️ **`queued` / `sent` 以外の行が在る鍵は「不足」ではなく「衝突」**。
   *    `performUpsert` は `DeliveryKey` をマージキーにするので、ここで足すと
   *    `cancelled` / `failed` / `skipped` の行が **`queued` に書き換わってしまう**。
   *    巻き戻し済み・失敗済みを黙って復活させないため、**自動では直さない**。
   */
  const activeKeys = new Set();
  const conflicts = [];
  for (const [k, rs] of rowsByKey) {
    const f = (rs[0] && rs[0].fields) || {};
    if (ACTIVE_DELIVERY_STATUS.has(lower(f.Status))) activeKeys.add(k);
    else conflicts.push({ key: k, status: lower(f.Status) || '(空)', rowId: str(rs[0].id) });
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: REPAIR_REJECT.NON_ACTIVE_ROW,
      conflicts: conflicts.slice(0, 20),
      conflictCount: conflicts.length,
    };
  }

  const missing = [];
  for (const email of list) {
    const k = keyByEmail.get(email);
    // 行が 1 つも無い鍵**だけ**が不足（非 active は上で弾いている）
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

/**
 * 書き込みに失敗したあと、**どの鍵なら予約を戻してよいか**を決める。
 *
 * ⚠️ `upsertDeliveries` は 10 件ずつ投げ、**最初に失敗した batch で throw する**。
 *    つまり **前半の batch は既に書けている**。取った鍵をまとめて戻すと、
 *    **行が在るのに予約だけ消える**＝次のキュー登録で同じ人へもう 1 通積む。
 *
 * ⚠️ 戻してよいのは「**Airtable に行が無いことを確かめられた鍵**」だけ。
 *    読み戻せない・状態が分からない鍵は**戻さない**（予約を残したまま fail closed）。
 *
 * @param {{claimedKeys: string[], rowsAfter: Array|null}} input
 *   `rowsAfter` … 書き込み後に読み戻した配信行（**読めなければ null**）
 */
export function planClaimRelease({ claimedKeys, rowsAfter } = {}) {
  const claimed = [...new Set((Array.isArray(claimedKeys) ? claimedKeys : []).map(str).filter(Boolean))];
  if (claimed.length === 0) return { ok: true, release: [], keep: [], reason: null };
  // ⚠️ 読み戻せない = どれが書けたか分からない。**1 つも戻さない**
  if (rowsAfter === null || rowsAfter === undefined) {
    return { ok: false, release: [], keep: claimed, reason: REPAIR_REJECT.ROWS_UNAVAILABLE };
  }
  const written = new Set();
  for (const r of Array.isArray(rowsAfter) ? rowsAfter : []) {
    const k = str(((r && r.fields) || {}).DeliveryKey);
    if (k) written.add(k);
  }
  const release = []; const keep = [];
  for (const k of claimed) {
    // 行が在る = 書けている。**予約を戻さない**（戻すと二重送信の芽になる）
    if (written.has(k)) keep.push(k);
    else release.push(k);           // 行が無いことを確かめられた鍵だけ戻す
  }
  return { ok: true, release, keep, reason: null };
}
