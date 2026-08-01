/**
 * emailEventLedgerWriter.js — 台帳 `EmailEvents` への**書き込み経路**（I/O は注入）
 *
 * ── なぜ分離するか ────────────────────────────────────────────
 * PR #199 の初版は「1 行 = 1 リクエストを逐次 PATCH し、`res.ok` でなければ黙って捨てる」
 * 実装だった。台帳は append-only で**後から復元できない**ため、次の 3 つが致命的になる:
 *
 *   1. **沈黙**: 403 / 404 / 422 / 429 のどれで落ちたか分からず、欠測に気付けない
 *   2. **取りこぼし**: 1 通の配信で数百イベントが届くと逐次 PATCH が Airtable の
 *      レート制限（5 req/s）に当たり、429 のたびに 1 行ずつ静かに消える
 *   3. **一時障害＝恒久欠測**: 5xx / timeout に再試行が無い
 *
 * 本モジュールは **10 件/リクエストのバッチ upsert**・**bounded retry**・
 * **失敗の明示的な集計**を担う。判定・列組み立ては `emailEventLedger.js` が単一源で、
 * ここでは**組み上がった行を送るだけ**（列名を組み立てない）。
 *
 * ── 安全側の設計 ──────────────────────────────────────────
 * - `fetchFn` / `sleepFn` を注入（テストは実ネットワークを使わない）
 * - 再試行は **429 / 5xx / timeout / transport error だけ**。
 *   **403 / 404 / 422 / 400 は恒久エラーとして即座に諦める**（叩き続けない）
 * - 試行回数・backoff・全体の締切をすべて**固定上限**で縛る（無限再試行なし）
 * - Airtable の**応答本文を読まない**（PII / secret 混入の恐れ。status と Retry-After だけ見る）
 * - 落ちた理由は**固定の理由コード**でのみ集計する（アドレス・ID・本文を出さない）
 * - upsert（`EventKey` マージ）なので、再送・provider のリトライで**行は増えない**
 */

/** 1 リクエストに載せる最大レコード数（Airtable の upsert 上限） */
export const LEDGER_BATCH_SIZE = 10;

/** 1 バッチあたりの最大試行回数（初回 + 再試行 2 回） */
export const LEDGER_MAX_ATTEMPTS = 3;

/** backoff の基準値と上限（指数だが上限で頭打ち） */
export const LEDGER_BASE_BACKOFF_MS = 200;
export const LEDGER_MAX_BACKOFF_MS = 2000;

/** 1 リクエストのタイムアウト */
export const LEDGER_REQUEST_TIMEOUT_MS = 5000;

/** 全バッチ合計の締切（Function 全体を道連れにしないための上限） */
export const LEDGER_TOTAL_DEADLINE_MS = 8000;

/** 失敗理由コード（**これ以外を集計へ出さない**） */
export const WRITE_FAILURE = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  TRANSPORT_ERROR: 'transport_error',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  UNPROCESSABLE: 'unprocessable',
  BAD_REQUEST: 'bad_request',
  CLIENT_ERROR: 'client_error',
  FIELD_NOT_ALLOWED: 'field_not_allowed',
  DEADLINE_EXCEEDED: 'deadline_exceeded',
  UNKNOWN: 'unknown',
});

/**
 * HTTP status を「再試行してよいか」で分類する。
 * **恒久エラー（設定ミス・列不足・権限不足）は再試行しない**。叩き続けても直らず、
 * Function の実行時間を食って他の処理まで巻き込むため。
 */
export function classifyWriteStatus(status) {
  if (status === 429) return { reason: WRITE_FAILURE.RATE_LIMITED, retryable: true };
  if (status >= 500) return { reason: WRITE_FAILURE.SERVER_ERROR, retryable: true };
  if (status === 403) return { reason: WRITE_FAILURE.FORBIDDEN, retryable: false };
  if (status === 404) return { reason: WRITE_FAILURE.NOT_FOUND, retryable: false };
  if (status === 422) return { reason: WRITE_FAILURE.UNPROCESSABLE, retryable: false };
  if (status === 400) return { reason: WRITE_FAILURE.BAD_REQUEST, retryable: false };
  if (status >= 400) return { reason: WRITE_FAILURE.CLIENT_ERROR, retryable: false };
  return { reason: WRITE_FAILURE.UNKNOWN, retryable: false };
}

/** 例外（ネットワーク断・タイムアウト）を分類する。**本文・メッセージは見ない**。 */
export function classifyWriteError(err) {
  const name = err && typeof err === 'object' ? String(err.name || '') : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { reason: WRITE_FAILURE.TIMEOUT, retryable: true };
  }
  return { reason: WRITE_FAILURE.TRANSPORT_ERROR, retryable: true };
}

/** 指数 backoff（上限で頭打ち・負値なし）。`Retry-After`（秒）があれば優先するが上限は同じ。 */
export function backoffMs(attempt, retryAfterSec) {
  const fromHeader = Number(retryAfterSec);
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.min(Math.round(fromHeader * 1000), LEDGER_MAX_BACKOFF_MS);
  }
  const exp = LEDGER_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, LEDGER_MAX_BACKOFF_MS);
}

/** 行を `size` 件ずつに分割する（Airtable の 1 リクエスト上限に合わせる） */
export function chunkRows(rows = [], size = LEDGER_BATCH_SIZE) {
  const n = Math.max(1, Math.min(Number(size) || LEDGER_BATCH_SIZE, LEDGER_BATCH_SIZE));
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * 送信前に `EventKey` の重複を落とす。
 *
 * Airtable の upsert は **同一リクエスト内に同じマージキーが 2 件あるとリクエストごと失敗する**。
 * 1 行の重複でバッチ 10 件全部が落ちるのを防ぐため、**送る前に**畳む（後勝ちではなく先勝ち）。
 */
export function dedupeRowsByEventKey(rows = []) {
  const seen = new Set();
  const unique = [];
  let deduped = 0;
  for (const row of rows) {
    const key = String((row && row.fields && row.fields.EventKey) || (row && row.eventKey) || '');
    if (!key) { deduped += 1; continue; }
    if (seen.has(key)) { deduped += 1; continue; }
    seen.add(key);
    unique.push(row);
  }
  return { rows: unique, deduped };
}

function countReason(map, reason, n = 1) {
  map[reason] = (map[reason] || 0) + n;
}

/**
 * 1 バッチを送る。**成功するか、恒久エラーになるか、試行上限に達するまで**。
 * 応答本文は読まない（status と Retry-After のみ）。
 */
async function sendBatch({ url, apiKey, batch, fetchFn, sleepFn, requestTimeoutMs, deadlineAt, nowFn }) {
  let retries = 0;
  let lastReason = WRITE_FAILURE.UNKNOWN;

  for (let attempt = 1; attempt <= LEDGER_MAX_ATTEMPTS; attempt += 1) {
    if (nowFn() >= deadlineAt) return { ok: false, reason: WRITE_FAILURE.DEADLINE_EXCEEDED, retries };

    let res;
    try {
      res = await fetchFn(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        // EventKey をマージキーにした upsert（再受信で行が増えない）
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: ['EventKey'] },
          records: batch.map((row) => ({ fields: row.fields })),
        }),
        signal: makeTimeoutSignal(requestTimeoutMs),
      });
    } catch (err) {
      const c = classifyWriteError(err);
      lastReason = c.reason;
      if (!c.retryable || attempt === LEDGER_MAX_ATTEMPTS) return { ok: false, reason: lastReason, retries };
      retries += 1;
      await sleepFn(backoffMs(attempt));
      continue;
    }

    if (res && res.ok) return { ok: true, retries };

    const status = res ? Number(res.status) : 0;
    const c = classifyWriteStatus(status);
    lastReason = c.reason;
    // 恒久エラーは再試行しない（設定ミス・列不足・権限不足は叩いても直らない）
    if (!c.retryable || attempt === LEDGER_MAX_ATTEMPTS) return { ok: false, reason: lastReason, retries };
    retries += 1;
    const retryAfter = res && typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
    await sleepFn(backoffMs(attempt, retryAfter));
  }

  return { ok: false, reason: lastReason, retries };
}

/** 実行環境が対応していればリクエスト単位のタイムアウトを付ける（無ければ undefined） */
function makeTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // 実行環境が未対応でも送信自体は継続する
  }
  return undefined;
}

/**
 * 台帳行をバッチ upsert する。**書き込み結果を必ず数える**（沈黙させない）。
 *
 * @returns {{attempted:number, written:number, failed:number, skipped:number, deduped:number,
 *            batches:number, failedBatches:number, retryCount:number,
 *            failureReasons:Record<string,number>}}
 */
export async function writeLedgerRows({
  rows = [],
  apiKey,
  baseId,
  table,
  isAllowedFields = () => true,
  fetchFn,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowFn = () => Date.now(),
  requestTimeoutMs = LEDGER_REQUEST_TIMEOUT_MS,
  totalDeadlineMs = LEDGER_TOTAL_DEADLINE_MS,
  batchSize = LEDGER_BATCH_SIZE,
} = {}) {
  const failureReasons = {};
  const empty = {
    attempted: 0, written: 0, failed: 0, skipped: 0, deduped: 0,
    batches: 0, failedBatches: 0, retryCount: 0, failureReasons,
  };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // 1) 送る前に重複を畳む（同一リクエスト内の重複マージキーはリクエストごと落ちる）
  const { rows: unique, deduped } = dedupeRowsByEventKey(rows);

  // 2) 許可列だけの行に絞る（逸脱は送らずに理由を残す）
  const sendable = [];
  let skipped = 0;
  for (const row of unique) {
    if (isAllowedFields(row.fields)) sendable.push(row);
    else { skipped += 1; countReason(failureReasons, WRITE_FAILURE.FIELD_NOT_ALLOWED); }
  }

  const url = `https://api.airtable.com/v0/${baseId}/${table}`;
  const batches = chunkRows(sendable, batchSize);
  const deadlineAt = nowFn() + totalDeadlineMs;

  let written = 0;
  let failed = 0;
  let failedBatches = 0;
  let retryCount = 0;

  for (const batch of batches) {
    const r = await sendBatch({ url, apiKey, batch, fetchFn, sleepFn, requestTimeoutMs, deadlineAt, nowFn });
    retryCount += r.retries;
    if (r.ok) {
      written += batch.length;
    } else {
      failed += batch.length;
      failedBatches += 1;
      countReason(failureReasons, r.reason, batch.length);
    }
  }

  return {
    attempted: sendable.length,
    written,
    failed,
    skipped,
    deduped,
    batches: batches.length,
    failedBatches,
    retryCount,
    failureReasons,
  };
}
