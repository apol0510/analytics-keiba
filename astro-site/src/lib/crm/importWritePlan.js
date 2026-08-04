/**
 * importWritePlan.js — 初回本番取り込みの**書き込み規則**（純粋・I/O なし）
 *
 * ── 初回の方針（固定）────────────────────────────────────────
 *   - 作るのは **CREATE_CANDIDATE だけ**。UPDATE_CANDIDATE（実測 1,177 件）は**触らない**
 *   - 既存 Customers は**上書きしない**（1 フィールドも PATCH しない）
 *   - EXCLUDED / REVIEW_REQUIRED は 1 件も書かない
 *   - 1 回の実行は **100 件まで**
 *   - 書き込み直前に既存アドレスを**取り直して**再判定する（下見からの時間差で増えた分を弾く）
 *
 * ── 新規レコードに書く値（Airtable の実スキーマにもとづく / 2026-08-05 実測）──
 *   `登録日` は **createdTime（計算フィールド）** なので**書けない**（Airtable が自動で入れる）。
 *   `Status` / `PlanType` は free 会員では**空が通常**（1,466 件中 Status 空 1,421）。だから入れない。
 *   `CreatedBy` / `ImportBatchId` / `ImportedAt` は **Customers に存在しない列**。
 *   存在すれば書くが、無くても取り込めるよう `Source` に出所とバッチを埋め込む。
 */

import { createHash } from 'node:crypto';

/** 初回実行の上限。**これを超える指定は拒否する** */
export const FIRST_RUN_MAX_ROWS = 100;

/** 新規レコードの `プラン`（Airtable singleSelect の選択肢と一致していること） */
export const IMPORT_PLAN_VALUE = 'Free';

/** 出所の目印。`Source`（singleLineText）へ `customer-import:<batchId>` の形で入れる */
export const IMPORT_SOURCE_PREFIX = 'customer-import';

/** 取り込みが**書いてよい**フィールド（allow-list。これ以外は 1 つも書かない） */
export const CREATE_ALLOWED_FIELDS = Object.freeze([
  'Email', '氏名', 'プラン', 'ポイント', 'Source',
  // 下 3 つは Customers に存在するときだけ書く（無ければ Source に集約）
  'CreatedBy', 'ImportBatchId', 'ImportedAt',
]);

/**
 * **絶対に触らないフィールド**。ここに 1 つでも入っていたら書き込みを中止する。
 * 課金・権利・配信停止・決済に関わる列は取り込みの責務ではない。
 */
export const CREATE_FORBIDDEN_FIELDS = Object.freeze([
  'PlanType', 'Status', '有効期限', 'ExpiryDate', 'PaidAt', 'PaymentConfirmed',
  'PaymentMethod', 'PaymentEmailSent', 'PaymentEmailStatus',
  'LightGrantUntil', 'LightGrantLifetime', 'LightGrantedAt', 'LightGrantedBy', 'LightGrantOp',
  'PremiumGrantUntil', 'PremiumGrantLifetime', 'PremiumGrantedAt', 'PremiumGrantedBy', 'PremiumGrantOp',
  'LifetimeSanrenpuku', 'SanrenpukuPaidAt', 'PremiumPlusEligibility', 'UpsellTarget',
  'UnsubscribedAnalyticsKeiba', 'UnsubscribedKeibaIntelligence',
  'Phone', 'ForceLogout', 'AccessEnabled', 'WithdrawalRequested',
  '登録日',   // createdTime（計算フィールド）。書こうとすると Airtable が 422 を返す
]);

/** 任意で使う監査フィールド（Customers に存在するときだけ書く） */
export const OPTIONAL_AUDIT_FIELDS = Object.freeze(['CreatedBy', 'ImportBatchId', 'ImportedAt']);

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * 新規 1 件分のフィールド。**必要最小限だけ**。
 *
 * @param {{
 *   email: string, name?: string, batchId: string, nowIso: string,
 *   availableFields?: Set<string>|null,   Customers に実在する列（null = 不明 → 監査列は書かない）
 * }} input
 */
export function buildCreateFields({ email, name, batchId, nowIso, availableFields } = {}) {
  const e = str(email);
  if (!e) return null;
  const fields = {
    Email: e,
    'プラン': IMPORT_PLAN_VALUE,
    'ポイント': 0,
    Source: `${IMPORT_SOURCE_PREFIX}:${str(batchId)}`,
  };
  const nm = str(name);
  if (nm) fields['氏名'] = nm;   // 一意に決まったときだけ（決まらなければ書かない）

  const have = availableFields instanceof Set ? availableFields : null;
  if (have) {
    if (have.has('CreatedBy')) fields.CreatedBy = IMPORT_SOURCE_PREFIX;
    if (have.has('ImportBatchId')) fields.ImportBatchId = str(batchId);
    if (have.has('ImportedAt')) fields.ImportedAt = str(nowIso);
  }
  return fields;
}

/**
 * 書いてよいフィールドだけか。**1 つでも禁止列があれば false**（呼び出し側は中止する）。
 */
export function assertOnlyCreateFields(fields) {
  const keys = Object.keys(fields || {});
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (CREATE_FORBIDDEN_FIELDS.includes(k)) return false;
    if (!CREATE_ALLOWED_FIELDS.includes(k)) return false;
  }
  return true;
}

/** 行単位の冪等キー（アドレスは復元できない） */
export function computeCreateRowKey({ batchId, email }) {
  const b = str(batchId); const e = str(email).toLowerCase();
  if (!b || !e) return '';
  return createHash('sha256').update(`import-create:${b}:${e}`, 'utf8').digest('hex').slice(0, 32);
}

/** バッチ単位の冪等キー（同じ内容のバッチを二度実行しない） */
export function computeBatchKey({ batchId, previewId, offset, size }) {
  const seed = [str(batchId), str(previewId), int(offset), int(size)].join('|');
  if (!str(batchId) || !str(previewId)) return '';
  return createHash('sha256').update(`import-batch:${seed}`, 'utf8').digest('hex').slice(0, 32);
}

/** 実行を断る理由（固定コード） */
export const RUN_REJECT = Object.freeze({
  WRITE_DISABLED: 'write_disabled',
  NO_CONFIRMATION: 'no_confirmation',
  CONFIRMATION_MISMATCH: 'confirmation_mismatch',
  PREVIEW_INVALID: 'preview_invalid',
  OVER_LIMIT: 'over_limit',
  NOTHING_TO_WRITE: 'nothing_to_write',
  COUNT_MISMATCH: 'count_mismatch',
  FIELDS_NOT_READY: 'fields_not_ready',
});

export const RUN_REJECT_LABEL = Object.freeze({
  write_disabled: '取り込みの書き込みが有効化されていません（CUSTOMER_IMPORT_WRITE_ENABLED）。',
  no_confirmation: '実行には確認文字列が必要です。',
  confirmation_mismatch: '確認文字列が一致しません。',
  preview_invalid: '下見が無効です（期限切れ・ファイル差し替え・改ざんのいずれか）。',
  over_limit: `初回は 1 回 ${FIRST_RUN_MAX_ROWS} 件までです。`,
  nothing_to_write: '作成する行がありません。',
  count_mismatch: '確認した件数と実行しようとした件数が違います。',
  fields_not_ready: '書き込み先の列が揃っていません。',
});

/**
 * 実行時に打ち込ませる確認文字列。**バッチごとに変わる**ので使い回せない。
 * 例: `IMPORT imp-2026-08-05-001 100`
 */
export function buildConfirmationPhrase({ batchId, count }) {
  return `IMPORT ${str(batchId)} ${int(count)}`;
}

/**
 * 二重ゲート + 上限の検査。**1 つでも欠ければ実行しない**（fail closed）。
 *
 * @param {{
 *   env?: object,
 *   confirmation?: string,
 *   batchId: string,
 *   requestedCount: number,
 *   availableCount: number,
 *   previewOk: boolean,
 *   maxRows?: number,
 * }} input
 */
export function canRunFirstImport({
  env, confirmation, batchId, requestedCount, availableCount, previewOk, maxRows,
} = {}) {
  const limit = Number.isFinite(maxRows) && maxRows > 0 ? Math.min(maxRows, FIRST_RUN_MAX_ROWS) : FIRST_RUN_MAX_ROWS;
  const no = (reason) => ({ allowed: false, reason, label: RUN_REJECT_LABEL[reason] || null });

  // ゲート 1: 環境変数（production では未設定のまま）
  if (!env || env.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true') return no(RUN_REJECT.WRITE_DISABLED);
  // ゲート 2: 実行時の確認文字列
  if (!str(confirmation)) return no(RUN_REJECT.NO_CONFIRMATION);
  if (previewOk !== true) return no(RUN_REJECT.PREVIEW_INVALID);

  const req = int(requestedCount);
  const avail = int(availableCount);
  if (req <= 0 || avail <= 0) return no(RUN_REJECT.NOTHING_TO_WRITE);
  if (req > limit) return no(RUN_REJECT.OVER_LIMIT);
  if (req > avail) return no(RUN_REJECT.COUNT_MISMATCH);

  const expected = buildConfirmationPhrase({ batchId, count: req });
  if (str(confirmation) !== expected) return no(RUN_REJECT.CONFIRMATION_MISMATCH);

  return { allowed: true, reason: null, willCreate: req, limit };
}

/** 429 / 5xx だけ再試行する。**検証エラー（4xx）は再試行しない** */
export function shouldRetryStatus(status) {
  const s = int(status);
  return s === 429 || (s >= 500 && s <= 599);
}

/** 再試行の待ち時間（指数バックオフ・上限つき） */
export function retryDelayMs(attempt) {
  const n = Math.max(0, int(attempt));
  return Math.min(8000, 500 * (2 ** n));
}

export const MAX_RETRY_ATTEMPTS = 3;

/**
 * 実行結果の突合。**書いた数が計画を超えていないか**を必ず検算する。
 */
export function reconcileRun({ planned, created, skippedExisting, failed } = {}) {
  const p = int(planned); const c = int(created);
  const s = int(skippedExisting); const f = int(failed);
  return {
    planned: p, created: c, skippedExisting: s, failed: f,
    accounted: c + s + f,
    balanced: c + s + f === p,
    withinPlan: c <= p,
    note: c + s + f === p
      ? '件数は一致しています。'
      : '件数が合いません。次のバッチへ進まず、監査ログで差分を確認してください。',
  };
}

/** 実行前に画面へ必ず出す内容 */
export function describeRunPlan({
  batchId, previewId, fileHashes, previewHash, createTotal, runCount, skippedExisting, availableFields,
}) {
  const have = availableFields instanceof Set ? availableFields : new Set();
  return {
    ImportBatchId: str(batchId),
    下見ID: str(previewId),
    対象ファイルhash: (fileHashes || []).map((h) => str(h)),
    下見hash: str(previewHash),
    CREATE予定件数: int(createTotal),
    今回実行件数: int(runCount),
    既存再判定で除外: int(skippedExisting),
    上限: FIRST_RUN_MAX_ROWS,
    書き込む列: CREATE_ALLOWED_FIELDS.filter((f) => !OPTIONAL_AUDIT_FIELDS.includes(f) || have.has(f)),
    監査列の状態: OPTIONAL_AUDIT_FIELDS.map((f) => `${f}: ${have.has(f) ? '書く' : '列が無いので書かない'}`),
    rollback: [
      `対象は Source が "${IMPORT_SOURCE_PREFIX}:${str(batchId)}" の行だけ。`,
      '既定は削除ではなく隔離（プランを据え置いたまま配信対象から外す）。',
      '削除は別の高リスク操作として、外部参照・送信・利用が無いことを確認してから行う。',
    ],
    検証方法: [
      `Airtable で Source = "${IMPORT_SOURCE_PREFIX}:${str(batchId)}" の件数が 今回実行件数 と一致すること。`,
      'プラン=Free / Status 空 / 有効期限 空 / 課金・特典フィールドが空であること。',
      '同じアドレスの重複レコードが増えていないこと。',
    ],
  };
}

export default canRunFirstImport;
