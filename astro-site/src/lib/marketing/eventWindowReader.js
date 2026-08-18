/**
 * eventWindowReader.js — 配信イベント台帳（Blob）から**窓のぶんだけ**読む
 *
 * ⚠️ 正本は `emailEventBlobStore.js` が書く NDJSON。
 *    **1 webhook バッチ = 1 blob**（本文は 1 行 1 イベント・最大 1000 イベント）。
 *    blob の数はイベント数ではない。`EmailBlacklist` は**アドレス 1 行の upsert 台帳**
 *    なのでイベント数には使わない（既存行は PATCH で `BounceCount+1` / `AddedAt` 据え置き）。
 * ⚠️ 読み方は既存の backfill（`admin-marketing` の `eventBackfill*`）と同じ
 *    `list({prefix}) → get(key) → parseNdjson`。**新しい経路を作らない**。
 * ⚠️ **読むだけ**。台帳へは書かない（書くのは Event Webhook だけ）。
 *    append-only / manifest 無しの設計は変更しない（日次 1 blob への
 *    read-modify-write のような multi-writer 競合を作らない）。
 *
 * ── 2026-08-18 の事故: 日全体の blob 数で上限判定していた ──────────
 * 旧実装は `list({prefix})`（**その UTC 日全体**）の件数を `MAX_EVENT_BLOBS` と比べ、
 * **実際のバッチ窓で絞る前に** `null` を返していた。
 * 送信量が増えるほど当日の blob が増えるので、健全性を**永久に読めなくなる**
 * （本番実測: 2026-08-18 の日合計 523 blob に対し上限 200 → 常に null →
 *   `batch_stats_unreadable` で自動停止）。
 *
 * 直し方は「上限を上げる」ではない（blob ごとに `get()` するので Function 時間が悪化する）。
 * **実際に読む候補まで先に絞り、その候補数へ上限を当てる**。
 *
 * ── どこまで安全に事前除外できるか（**推測で捨てない**）──────────────
 * 鍵は `buildBatchBlobKey()` が作る `ak/email-events/YYYY/MM/DD/HHMMSS-<hash12>.ndjson` で、
 * 日時部は **`receivedAtMs` の UTC・秒精度**（`emailEventBlobStore.js`）。
 * 一方、窓で切りたいのは **`eventAtMs`（provider 発行の発生時刻）** で、両者は別物:
 *
 *   `receivedAtMs` … こちらの受信時刻（`sendgrid-webhook.js` の `Date.now()`）
 *   `eventAtMs`    … provider の payload 由来（`EventAt` を `Date.parse`）
 *
 * ⚠️ **「provider 時刻が受信時刻より未来へずれる幅」に上限は無い。**
 *    SendGrid 公式仕様にあるのは「イベント発生後**最大 24 時間**リトライする」だけで、
 *    これは受信が**遅れる**側の話。repo 内の唯一の skew 定数
 *    `sendgridSignature.js` の `DEFAULT_MAX_SKEW_SEC = 24h` も
 *    **署名リプレイ防御**であってイベント時刻の契約ではない。
 *    よって「◯分以内なら未来へずれない」という前提で blob を捨ててはいけない。
 *
 * ── 代わりに使う根拠: **DeliveryKey の因果関係**（時計に依存しない）──────
 * 健全性で数えたいのは「**直前バッチの通**に起きたイベント」だけで、
 * 呼び出し側は必ず `deliveryKeys`（そのバッチの鍵集合）を渡す
 * （`cron-marketing-rollout.js`: `batchKeys && … ? readEventWindow({ deliveryKeys: batchKeys }) : null`）。
 *
 * その鍵の通が**送られる前に**、その通のイベントを受信することはあり得ない。そして:
 *
 *   1. `sinceMs` = `state.healthBaseline.atMs` … そのバッチの **GRANT tick** で置いた基準点
 *   2. `state.lastBatchJobIds` … その後の **QUEUE tick** で控えたジョブ（= 基準点より後）
 *   3. 健全性チェックは **GRANT 分岐**の中でしか走らず、そこへ到達するには
 *      `outstanding === 0`（`rolloutPlan.js` の `WAITING_PREVIOUS`）が要る
 *      ＝ 前バッチの queue は済んでいる
 *
 * よって `deliveryKeys` の通は**すべて `sinceMs` より後に送られた**ので、
 * それらのイベントを載せた blob の受信時刻も必ず `sinceMs` より後。
 * → **受信時刻が `sinceMs` 以前の blob には、この鍵集合のイベントは入り得ない。**
 * これは provider の時計を一切使わない（当方の受信時刻と当方の基準点の比較だけ）。
 *
 * ⚠️ したがって事前除外は **`deliveryKeys` を渡されたときだけ**行う。
 *    渡されないときは根拠が無いので**1 つも捨てない**（従来どおり全候補を読む）。
 * ⚠️ 鍵を読めない blob も捨てない。
 * ⚠️ 許容するズレは**鍵の秒切り捨てぶん（1 秒）だけ**。
 *    これは `buildBatchBlobKey` の実装から証明できる値で、経験則の定数ではない。
 */

import { parseNdjson, blobDatePrefix } from '../webhooks/deliveryEventBackfill.js';
import { windowDates, summarizeEventWindow } from './batchEventWindow.js';
import { HARD_MAX_BATCH_SIZE } from '../comeback/lightTrialAutoGrant.js';

/**
 * 1 通ぶんの窓で見込むイベント数の許容（delivered / open / bounce …）。
 * 本番実測（2026-08-18）: 直前バッチ 197 名に対し窓内 blob **189**・NDJSON **213 行**
 * ＝ 約 **0.96 blob/名**・約 1.08 イベント/名。**4 倍**を上限側の余裕として取る。
 */
export const EVENTS_PER_RECIPIENT_ALLOWANCE = 4;

/**
 * 1 回の判定で **実際に読む（get する）** blob 数の **backstop**（暴走時の歯止め）。
 *
 * ⚠️ これは「その日の blob 数」ではなく**窓に関係する候補数**に当てる。
 *    日全体へ当てると、送信量が増えるだけで永久に読めなくなる（2026-08-18 の事故）。
 *
 * ⚠️ **これは「この件数までなら必ず読める」という保証ではない。**
 *    真の制約は `READ_DEADLINE_MS`（wall-clock budget）で、件数上限は
 *    「際限なく `get` を積まない」ための backstop にすぎない。
 *
 * ⚠️ 値の出どころ: `emailEventBlobStore` は **1 webhook バッチ = 1 blob** で、
 *    SendGrid は実質 1 イベント 1 POST（本番実測 1 blob ≒ 1.13 イベント）なので
 *    **blob 数はおおむね送信量に比例**する。1 回の付与呼び出しは
 *    `HARD_MAX_BATCH_SIZE`（`lightTrialAutoGrant.js` = 500）を超えないため、
 *    その 4 倍を目安に置く。
 *    ⚠️ ただし候補 blob には**同じ時間帯の別 campaign / 別 touch の webhook** も
 *    入り得るので、**「500 × 4 なら構造的に必ず収まる」とは言えない**。
 *    収まらなければ従来どおり `null`（fail closed）で止まる。
 */
export const MAX_EVENT_BLOBS = HARD_MAX_BATCH_SIZE * EVENTS_PER_RECIPIENT_ALLOWANCE;

/**
 * **この読み取り全体（list + 全 get）に使ってよい実時間**。
 * 既存の時間歯止め（`emailEventLedgerWriter.js` の `LEDGER_TOTAL_DEADLINE_MS = 8000`）に合わせる。
 * ここは 1 tick の一部（他に Airtable 読みもある）なので短めに取り、
 * 超えたら**数え切れていない**として `null`（fail closed）。
 *
 * ⚠️ **これが本当の制約。** `MAX_EVENT_BLOBS` は単なる backstop（暴走時の件数上限）で、
 *    「この件数までなら必ず読める」という保証ではない。
 */
export const READ_DEADLINE_MS = 8000;

/** 同時に走らせる `get` の本数（1 件ずつ直列に読むと候補数ぶん時間がかかる） */
export const BLOB_READ_CONCURRENCY = 12;

/**
 * 予算切れのときに **SDK へ返す** HTTP status。
 *
 * ⚠️ `408` でなければならない。`@netlify/blobs` の `fetchAndRetry` は
 *    **429 / 5xx / throw を最大 5 回・5 秒 sleep で再試行**するので、
 *    abort を throw のまま返すと**予算を大きく超える**。
 *    `408` は再試行対象外で、`Store.get` / `Store.list` が
 *    `BlobsInternalError` を投げる（＝こちらは `null` へ倒せる）。
 *    v10.7.9 の実装で「408 は 1 回だけ・再試行なし」を実測確認済み。
 */
export const DEADLINE_STATUS = 408;

/** 予算切れを表す番兵（`null` は「blob が空」と紛れるので使わない） */
const DEADLINE = Symbol('event-window-deadline');

/** blob store の名前（既存 backfill と同一） */
export const EVENT_STORE = 'ak-email-events';

/**
 * 鍵の時刻は**秒まで**（`buildBatchBlobKey` が `HHMMSS`）。
 * 実際の受信時刻は `[R, R + 1000)` の幅を持つ。
 */
export const KEY_TIME_GRANULARITY_MS = 1000;

/** `ak/email-events/YYYY/MM/DD/HHMMSS-<hash>.ndjson` （`buildBatchBlobKey` の逆） */
const KEY_RE = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})-[a-f0-9]{8,64}\.ndjson$/;

/**
 * blob の鍵から**受信時刻（UTC・秒精度の下限）**を取り出す。
 *
 * ⚠️ **writer が作り得ない日時は必ず `null`**（fail closed）。
 *    `Date.UTC` は 4/31 を 5/1 へ、秒 60 を次分へ**黙って繰り上げる**ので、
 *    復元した値を分解し直して**入力と完全一致**することを確かめる。
 *    （`buildBatchBlobKey` は実在時刻からしか鍵を作らないので、
 *      繰り上がる鍵は「writer 以外が置いたもの」＝時刻として信用しない）
 *
 * @returns {number|null} 読めなければ `null`（＝**時刻で除外してはいけない**）
 */
export function parseBlobKeyReceivedAtMs(key) {
  const m = KEY_RE.exec(String(key ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  // 秒は 0..59（`p2(getUTCSeconds())` は 60 を作らない。閏秒も JS の時刻には出ない）
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (!Number.isFinite(t)) return null;
  // **繰り上がりを許さない**（4/31 → 5/1、2/29(非閏年) → 3/1 などを弾く）
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) {
    return null;
  }
  return t;
}

/**
 * この blob を**読む必要があるか**（＝窓に関係し得るか）。
 *
 * 捨ててよいのは、**`deliveryKeys` で直前バッチへ scope しているとき**に
 * 「受信時刻が基準点以前」と**鍵から確定できる**ものだけ。
 * その鍵集合の通は `sinceMs` より後に送られているので（ヘッダの因果関係を参照）、
 * 受信がそれ以前の blob には該当イベントが入り得ない。
 *
 * ⚠️ `scoped` でないときは**1 つも捨てない**（provider 時計に上限が無く、
 *    「受信が古い＝イベントも古い」とは言えないため）。
 * ⚠️ 鍵を読めないときも捨てない（**推測で捨てない**）。
 *
 * @returns {boolean} 読むなら true（**判断できないものは true**）
 */
export function isBlobInWindow({
  key, sinceMs, scoped = false, granularityMs = KEY_TIME_GRANULARITY_MS,
} = {}) {
  if (scoped !== true) return true;              // scope が無ければ絞る根拠が無い
  const since = Number(sinceMs);
  if (!Number.isFinite(since)) return true;      // 窓が無いなら絞らない
  const received = parseBlobKeyReceivedAtMs(key);
  if (received === null) return true;            // 鍵を読めない＝**推測で捨てない**
  // 鍵は秒切り捨てなので実受信は [received, received + granularity)
  return received + granularityMs > since;
}

/**
 * `promise` を**実時間の締切**と競走させる。締切なら `DEADLINE` を返す。
 *
 * ⚠️ 未完了の I/O は捨てるので、後から reject しても unhandled にならないよう
 *    `catch` を付けておく。**実 I/O 自体の中断は `createDeadlineFetch` が行う**
 *    （ここは「SDK が abort を尊重しなくても必ず返る」ための二重化）。
 */
async function raceDeadline(promise, deadlineAtMs, nowFn) {
  const remaining = deadlineAtMs - nowFn();
  const pending = Promise.resolve(promise);
  pending.catch(() => {});                       // 破棄する側の unhandled 防止
  if (remaining <= 0) return DEADLINE;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), remaining);
    // Node では pending なタイマーが event loop を保持する。締切用は保持させない
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 実 I/O を**締切で中断する** fetch を作る（`getStore({ fetch })` へ差し込む）。
 *
 * `@netlify/blobs` v10.7.9 の `get` / `list` には `signal` も `timeout` も無い
 * （`GetOptions` は `consistency` のみ）。一方 `getStore({ name, fetch })` は
 * **fetch 実装の差し替えを正式に受け付ける**（`ClientOptions.fetch?: Fetcher` →
 * `getClientOptions` が `fetch: options.fetch` を Client へ渡す）ので、
 * ここで `AbortSignal` を付けて**ソケットごと切る**。
 *
 * ⚠️ 失敗は **throw せず `408` を返す**。throw だと `fetchAndRetry` が
 *    5 回 × 5 秒 sleep で再試行し、予算を大きく超えてしまう。
 * ⚠️ その結果、通信の一時失敗も再試行せず fail closed になる。
 *    健全性判定は「読めなければ止まる」が正しいので、この方向に倒す。
 */
export function createDeadlineFetch({
  deadlineAtMs, nowFn = Date.now, fetchImpl = fetch, status = DEADLINE_STATUS,
} = {}) {
  const expired = () => new Response(null, { status });
  return async (url, options = {}) => {
    const remaining = deadlineAtMs - nowFn();
    if (remaining <= 0) return expired();        // 予算切れなら **I/O を始めない**
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (controller) {
      timer = setTimeout(() => controller.abort(), remaining);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    try {
      return await fetchImpl(url, controller ? { ...options, signal: controller.signal } : options);
    } catch {
      return expired();                          // abort も通信失敗も**再試行させない**
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * 候補を**並列**に読む。1 件でも失敗したら、締切を過ぎたら `null`（fail closed）。
 *
 * ⚠️ 並列にしても**数え方は変わらない**。`summarizeEventWindow` は
 *    `providerEventId` で重複を除き、件数を足すだけなので**順序に依存しない**。
 * ⚠️ 締切に当たったら**途中結果を返さない**（少なく数えるのが一番危ない）。
 */
async function readCandidates({ store, keys, concurrency, deadlineAtMs, nowFn }) {
  const records = [];
  let scanned = 0;
  let broken = false;
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, keys.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (;;) {
      if (broken) return;
      const i = next;
      next += 1;
      if (i >= keys.length) return;
      let text;
      try {
        // eslint-disable-next-line no-await-in-loop -- lane ごとに 1 件ずつ
        text = await raceDeadline(store.get(keys[i]), deadlineAtMs, nowFn);
      } catch {
        broken = true;
        return;
      }
      if (text === DEADLINE) { broken = true; return; }
      scanned += 1;
      if (text) records.push(...parseNdjson(text));
    }
  }));
  return broken ? null : { records, scanned };
}

/**
 * @param {{sinceMs: number, untilMs: number, campaignId: string,
 *          deliveryKeys?: Set<string>|null, getStoreImpl?: Function,
 *          maxBlobs?: number}} input
 * @returns {Promise<object|null>} `summarizeEventWindow` の戻り。読めなければ null
 */
export async function readEventWindow({
  sinceMs, untilMs, campaignId, deliveryKeys = null, getStoreImpl = null,
  maxBlobs = MAX_EVENT_BLOBS, deadlineMs = READ_DEADLINE_MS,
  concurrency = BLOB_READ_CONCURRENCY, nowFn = Date.now,
} = {}) {
  const dates = windowDates(sinceMs, untilMs);
  if (!dates || dates.length === 0) return null;

  // ⚠️ 予算は **この関数の開始時点**から取る。`list` も全 `get` も**同じ budget** に入れる
  //    （`list` が遅れた分だけ `get` の持ち時間が減る、が正しい）
  const deadlineAtMs = nowFn() + Math.max(1, Number(deadlineMs) || 0);

  let store;
  try {
    if (getStoreImpl) {
      store = getStoreImpl(EVENT_STORE);
    } else {
      const { getStore } = await import('@netlify/blobs');
      // 実 I/O を締切で中断できるよう、**fetch を差し替えた** store を作る
      store = getStore({
        name: EVENT_STORE,
        fetch: createDeadlineFetch({ deadlineAtMs, nowFn }),
      });
    }
  } catch {
    return null;
  }
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function') return null;

  /**
   * 事前除外してよいのは**直前バッチの鍵で scope しているとき**だけ。
   * 鍵が無ければ「受信が古い＝イベントも古い」と言えないので 1 つも捨てない。
   */
  const scoped = deliveryKeys instanceof Set
    ? deliveryKeys.size > 0
    : Array.isArray(deliveryKeys) && deliveryKeys.length > 0;

  // ── ① 候補を決める（**まだ 1 つも get しない**）──────────────────
  const candidates = [];
  let listedCount = 0;
  for (const date of dates) {
    const prefix = blobDatePrefix(date);
    if (!prefix) return null;
    let listed;
    try {
      // eslint-disable-next-line no-await-in-loop -- 日付ごとに 1 回
      listed = await raceDeadline(store.list({ prefix }), deadlineAtMs, nowFn);
    } catch {
      return null;
    }
    if (listed === DEADLINE) return null;        // list だけで予算を使い切った
    // ⚠️ `@netlify/blobs` の `list()` は paginate 無しなら内部で `next_cursor` を
    //    追い切って**全件**返す（v10: `collectIterator`）。取り切れないときは throw する。
    //    それでも「1 ページだけ」の形が渡ってきたら**成功扱いにしない**（暗黙の truncate 防止）。
    if (!listed || !Array.isArray(listed.blobs)) return null;
    if (listed.next_cursor || listed.cursor) return null;
    listedCount += listed.blobs.length;
    for (const b of listed.blobs) {
      const key = b && b.key;
      if (!key) continue;
      // 窓に関係し得ない blob は**候補にも入れない**（= get しない）
      if (!isBlobInWindow({ key, sinceMs, scoped })) continue;
      candidates.push(key);
    }
  }

  // ── ② 上限は「実際に読む候補」へ当てる ─────────────────────────
  //    候補が多すぎる＝数え切れない → **0 と言わずに null**（呼び出し側が fail closed）
  if (candidates.length > maxBlobs) return null;

  // ── ③ 候補だけ読む（**並列 + 時間の歯止め**）─────────────────────
  //    件数だけで止めると「読めるのに読まない」が起きるので、
  //    本当の制約である**時間**で止める。超えたら 0 と言わずに null。
  const read = await readCandidates({
    store, keys: candidates, concurrency, deadlineAtMs, nowFn,
  });
  if (read === null) return null;
  const { records, scanned } = read;

  // ⚠️ campaign / DeliveryKey / eventAtMs 窓 / providerEventId 重複排除は
  //    `summarizeEventWindow` が単一源。ここでは**一切判定しない**。
  const summary = summarizeEventWindow({ records, campaignId, sinceMs, deliveryKeys });
  return summary ? { ...summary, blobsScanned: scanned, blobsListed: listedCount, scoped } : null;
}

export default readEventWindow;
