/**
 * SendGrid Event Webhook 受信エンドポイント（バウンス / ブロック / スパム報告 → EmailBlacklist）
 *
 * ⚠️ このエンドポイントは**公開 URL**であり、書き込む `EmailBlacklist` は
 * `newsletter-preview.js` が配信除外に使う実運用の suppression list である。
 * 署名検証を通らないリクエストで書き込ませてはならない（任意顧客を配信対象から
 * 恒久除外できてしまう）。
 *
 * 恒久ルール（2026-07-21 fail closed 化）:
 * 1. **署名検証を通ったリクエストだけを処理する**。検証は単一源
 *    `src/lib/webhooks/sendgridSignature.js` に集約し、ここに再実装しない。
 * 2. **検証鍵 `SENDGRID_WEBHOOK_VERIFICATION_KEY` が未設定なら 403**（素通り禁止）。
 *    「鍵が無いときは検証を省略する」分岐を**絶対に作らない**。
 * 3. **検証成功後にのみ body を parse する**（未検証入力を構文解析・処理しない）。
 *    未検証リクエストには構文エラー（400）を返さず、認証段の 403 を返す。
 * 4. **Airtable への書き込みは検証成功後にのみ発生する**。検証失敗時は 1 バイトも書かない。
 * 5. **ログ・応答に PII / secret を出さない**（メールアドレス・署名・鍵・reason 以外の値）。
 * 6. formula への外部入力は `airtableFormula.js` 経由（injection 遮断）。
 */

import { config } from 'dotenv';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySendgridEventWebhookSignature,
  signatureFailureStatus,
  resolveMaxSkewSec,
} from '../../src/lib/webhooks/sendgridSignature.js';
import { emailMatchFormula } from '../../src/lib/webhooks/airtableFormula.js';
import { applyPaymentEmailEvents } from '../../src/lib/payments/paymentEmailWebhook.js';
import { getRecord, patchRecord } from '../../src/lib/payments/paymentEmailDeps.js';
import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import { classifyEvent } from '../../src/lib/marketing/prospectPolicy.js';
import { planProspectEventUpdates } from '../../src/lib/marketing/prospectPipeline.js';

config();

const BLACKLIST_TABLE = 'EmailBlacklist';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  // POST のみ
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ── 1. 署名検証（body parse より前・fail closed）────────────────────
  // 署名対象は「timestamp + 受信したままの body」。再直列化した JSON では一致しないため
  // ここで **必ず text() を使う**（req.json() を先に呼んではいけない）。
  let rawBody;
  try {
    rawBody = await req.text();
  } catch {
    return jsonResponse(signatureFailureStatus(), { error: 'Forbidden', reason: 'body_missing' });
  }

  const verification = verifySendgridEventWebhookSignature({
    publicKeyBase64: process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY,
    signatureBase64: req.headers.get(SIGNATURE_HEADER),
    timestamp: req.headers.get(TIMESTAMP_HEADER),
    rawBody,
    maxSkewSec: resolveMaxSkewSec(process.env),
  });

  if (!verification.ok) {
    // reason は固定コードのみ（署名・鍵・timestamp の値は出さない）
    console.warn('🚫 [sendgrid-webhook] 署名検証 NG:', verification.reason);
    return jsonResponse(signatureFailureStatus(), { error: 'Forbidden', reason: verification.reason });
  }

  // ── 2. 検証済み body の parse（ここで初めて構文エラーを 400 にする）──
  let events;
  try {
    events = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' });
  }
  if (!Array.isArray(events)) {
    return jsonResponse(400, { error: 'Expected an array of events' });
  }

  // ── 3. 処理（Airtable 書込みはここから先だけ）────────────────────
  try {
    let processed = 0;
    let failed = 0;

    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      if (!shouldProcessEvent(event)) continue;
      if (typeof event.email !== 'string' || event.email.trim() === '') continue;

      try {
        await processFailureEvent(event);
        processed += 1;
      } catch {
        // 1 件失敗で残件を止めない。例外本文はログへ出さない（PII/secret 混入の恐れ）
        failed += 1;
      }
    }

    // ── 4. Payment Email v2 の配信結果を反映（S9 本体）────────────────
    // custom_args.purpose が一致するイベントだけを対象にする。判定は
    // src/lib/payments/paymentEmailWebhook.js（純粋ロジックは paymentEmailState.js）に集約し、
    // ここには再実装しない。suppression 側（上の processFailureEvent）とは独立で、
    // 片方が失敗しても他方を止めない。
    let paymentEmail = { targeted: 0, applied: 0, skipped: 0, errors: 0, byReason: {} };
    try {
      paymentEmail = await applyPaymentEmailEvents({
        events,
        now: Date.now(),
        deps: { getRecord, patchRecord },
      });
    } catch {
      // 集計に失敗しても suppression 側の結果は返す（例外本文はログへ出さない）
      paymentEmail = { ...paymentEmail, errors: paymentEmail.errors + 1 };
    }

    // ── 5. 配信反応の恒久台帳（既定 OFF）────────────────────────────
    // 配信基盤の履歴は保持期間が短く、開封・クリックが数日で取得不能になる。
    // 届いたイベントを AK 側へ append-only で残すことで「反応なし」と「記録が消えた」を
    // 区別できるようにする。**env が true のときだけ書く**（既定は数えるだけ）。
    let ledger = {
      enabled: false, received: events.length, accepted: 0,
      attempted: 0, written: 0, failed: 0, skipped: 0, deduped: 0,
      batches: 0, failedBatches: 0, retryCount: 0,
      rejected: {}, byResolution: {}, failureReasons: {},
    };
    try {
      ledger = await applyEmailEventLedger({ events, now: Date.now() });
    } catch {
      // 台帳が失敗しても suppression / 決済メールの結果は返す（例外本文はログへ出さない）
      ledger = { ...ledger, errors: 1 };
    }

    // ── 6. 見込み客プールへの反映（既定 OFF）────────────────────────
    let prospect = { enabled: false, engaged: 0, suppressed: 0, notFound: 0, errors: 0 };
    try {
      prospect = await applyProspectEvents({ events, now: Date.now() });
    } catch {
      prospect = { ...prospect, errors: 1 };
    }

    // 件数のみ（メールアドレス・recordId を出さない）
    console.log('📨 [sendgrid-webhook] 処理完了:', {
      received: events.length,
      processed,
      failed,
      paymentEmail,
      ledger,
      prospect,
    });
    return jsonResponse(200, { success: true, received: events.length, processed, failed, paymentEmail, ledger, prospect });
  } catch {
    console.error('❌ [sendgrid-webhook] 処理エラー');
    return jsonResponse(500, { error: 'Webhook processing failed' });
  }
};

/**
 * 配信反応を恒久台帳へ積む（**既定 OFF**）。
 *
 * - 判定・正規化・冪等キー・PII 最小化は `emailEventLedger.js` が単一源。
 * - 書き込み（バッチ化・bounded retry・失敗の集計）は `emailEventLedgerWriter.js` が単一源。
 *   ここは**環境変数の gate と依存の受け渡しだけ**を行う（再実装しない）。
 * - `EMAIL_EVENT_LEDGER_ENABLED !== 'true'` なら **1 バイトも書かない**（件数だけ数える）。
 * - 書き込みは `EventKey` をマージキーにした upsert。同じイベントが再送されても 1 行。
 * - 顧客・配信を一意に解決できないイベントも **保存はする**が
 *   `ResolutionStatus=unresolved` として顧客へは結び付けない（推測しない）。
 * - **失敗を沈黙させない**。落ちた分は `failed` と `failureReasons`（固定の理由コード）に出す。
 */
/**
 * 見込み客プールへイベントを反映する（**既定 OFF**）。
 *
 * ⚠️ 反応（open / click）は状態を ENGAGED にするだけで、**Airtable へは書かない**
 *    （昇格は管理画面から明示的に行う）。除外（bounce / 苦情 / 配信停止）は**即時**。
 * ⚠️ Redis の `ak:prospect:` 配下のみ。既存の台帳・決済メール処理には触れない。
 * ⚠️ ここが失敗しても webhook 全体は 200 を返す（配信基盤の再送を招かない）。
 */
async function applyProspectEvents({ events, now }) {
  const out = { enabled: false, engaged: 0, suppressed: 0, notFound: 0, errors: 0 };
  if (process.env.MARKETING_PROSPECT_EVENTS_ENABLED !== 'true') return out;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return out;
  out.enabled = true;

  const store = createProspectStore({
    cmd: (args) => fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`upstash_http_${r.status}`);
      return (await r.json()).result;
    }),
  });

  const { updates } = planProspectEventUpdates({ events, classify: classifyEvent });
  for (const u of updates) {
    try {
      const r = u.action === 'suppress'
        ? await store.recordSuppression({ email: u.email, nowMs: now, reason: u.reason })
        : await store.recordEngagement({ email: u.email, nowMs: now, kind: u.kind });
      if (!r.ok) { out.notFound += 1; continue; }
      if (u.action === 'suppress') out.suppressed += 1; else if (r.changed) out.engaged += 1;
    } catch { out.errors += 1; }
  }
  return out;
}

async function applyEmailEventLedger({ events, now }) {
  const {
    buildLedgerBatch, assertOnlyLedgerFields, isLedgerWriteEnabled, EMAIL_EVENTS_TABLE,
  } = await import('../../src/lib/webhooks/emailEventLedger.js');
  const { writeLedgerRows } = await import('../../src/lib/webhooks/emailEventLedgerWriter.js');
  const { fetchDeliveryIndex } = await import('../../src/lib/webhooks/emailEventDeliveryIndex.js');
  const { createHash } = await import('node:crypto');
  const hashFn = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const enabled = isLedgerWriteEnabled(process.env) && !!AIRTABLE_API_KEY && !!AIRTABLE_BASE_ID;

  // ── 配信索引（Phase 1d）─────────────────────────────────────
  // 送信側（Phase 1c）が刻んだ delivery_key を **CampaignDeliveries の実データと突き合わせる**ため
  // だけに read-only で引く。gate OFF のときは引かない（従来どおり外部 I/O ゼロ）。
  // 刻印を持つイベントが無ければ 1 リクエストも出さない。
  // 引けなかった場合は空の索引 = すべて unresolved（**推測で結び付けない**）。
  const lookup = enabled
    ? await fetchDeliveryIndex({
      rawEvents: events,
      apiKey: AIRTABLE_API_KEY,
      baseId: AIRTABLE_BASE_ID,
      fetchFn: fetch,
    }).catch(() => ({ index: new Map(), lookedUp: 0, found: 0, requests: 0, ok: false }))
    : { index: new Map(), lookedUp: 0, found: 0, requests: 0, ok: true };

  const batch = buildLedgerBatch({
    rawEvents: events,
    // 3 点（delivery_key / campaign_delivery_id / customer_record_id）が
    // 配信台帳と完全一致したイベントだけが resolved になる。
    deliveryIndex: lookup.index,
    receivedAtMs: now,
    hashFn,
    verification: 'verified',
    createdBy: 'sendgrid-webhook',
  });

  const base = {
    received: batch.received,
    accepted: batch.accepted,
    rejected: batch.rejected,
    byResolution: batch.byResolution,
    // 索引の引き具合（件数のみ。鍵・アドレス・recordId は出さない）
    lookup: { keys: lookup.lookedUp, found: lookup.found, requests: lookup.requests, ok: lookup.ok },
  };

  if (!enabled) {
    // 既定 OFF: 何が届いたかだけ返す（本番 write 0）
    return {
      enabled: false, ...base,
      attempted: 0, written: 0, failed: 0, skipped: 0, deduped: 0,
      batches: 0, failedBatches: 0, retryCount: 0, failureReasons: {},
    };
  }

  // 🛡️ 書き込み先は `MARKETING_EVENT_SINK` の単一源に従う。
  //    既定（未設定）は従来どおり Airtable のみ。`dual` で Blob と Redis カウンタを併記し、
  //    `blob` で Airtable への行追加を止める（レコード上限対策）。
  //    ⚠️ Blob は **バッチごとに固有キーで新規作成のみ**。既存 blob を読んで書き戻さない
  //       （Premium Plus 実績画像で踏んだ read-modify-write 競合を持ち込まない）。
  const {
    resolveEventSinkMode, writeEventBatch,
  } = await import('../../src/lib/webhooks/emailEventSink.js');
  const sinkMode = resolveEventSinkMode(process.env);

  let airtableResult = {
    attempted: 0, written: 0, failed: 0, skipped: 0, deduped: 0,
    batches: 0, failedBatches: 0, retryCount: 0, failureReasons: {},
  };

  const sinkEvents = batch.rows.map(toSinkEvent);
  const receivedAtMs = Date.now();

  const sink = await writeEventBatch({
    mode: sinkMode,
    events: sinkEvents,
    receivedAtMs,
    writeAirtable: async () => {
      airtableResult = await writeLedgerRows({
        rows: batch.rows,
        apiKey: AIRTABLE_API_KEY,
        baseId: AIRTABLE_BASE_ID,
        table: EMAIL_EVENTS_TABLE,
        isAllowedFields: assertOnlyLedgerFields,
        fetchFn: fetch,
      });
    },
    writeBlob: async ({ events, receivedAtMs }) => {
      const { createEmailEventBlobStore } = await import('../../src/lib/webhooks/emailEventBlobStore.js');
      const { getStore } = await import('@netlify/blobs');
      const { createHash } = await import('node:crypto');
      const store = getStore('ak-email-events');
      const blob = createEmailEventBlobStore({
        setBlob: (key, body) => store.set(key, body),
        hashFn: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
      });
      return blob.writeBatch({ events, receivedAtMs });
    },
    writeCounters: async (tally) => {
      const { makeRedisCmd } = await import('../../src/lib/marketing/deliveryKeyStore.js');
      const cmd = makeRedisCmd(process.env);
      for (const [key, byType] of Object.entries(tally)) {
        for (const [type, n] of Object.entries(byType)) {
          await cmd(['HINCRBY', key, type, String(n)]);
        }
      }
    },
  });

  // 🔑 **1 通ごと**の配信結果を DeliveryKey で引ける索引へ畳む（O(1)）。
  //    受信者単位の集計（下の engagementSignalStore）では「どの通を開いたか」が分からず、
  //    古いメールを後から開いたときに別の touch へ誤帰属する。
  //    ⚠️ **resolved なイベントだけ**（3 点が配信台帳と完全一致したもの）。
  //    ⚠️ 正本は Blob の生ログ。ここは再構築できる索引なので、失敗しても webhook を落とさない。
  let deliveryIndex = 'skipped';
  try {
    const resolvedEvents = sinkEvents.filter((e) => e && e.resolutionStatus === 'resolved');
    if (resolvedEvents.length > 0) {
      const [{ createDeliveryEventIndex }, { makeRedisCmd }] = await Promise.all([
        import('../../src/lib/webhooks/deliveryEventIndex.js'),
        import('../../src/lib/marketing/deliveryKeyStore.js'),
      ]);
      const index = createDeliveryEventIndex({ cmd: makeRedisCmd(process.env) });
      const r = await index.fold({
        events: resolvedEvents.map((e) => ({
          type: e.eventType,
          atMs: e.eventAtMs,
          deliveryKey: e.deliveryKey,
          providerEventId: e.providerEventId,
        })),
        nowMs: receivedAtMs,
      });
      deliveryIndex = r.failed > 0 ? 'degraded' : 'ok';
    }
  } catch {
    deliveryIndex = 'failed';  // 判定側は「確認できない」= 未計測として扱う
  }

  // 📬 受信者ごとの「反応した事実」を畳んでおく（開封・クリックのみ・アドレスは hash）。
  //    大量配信の engagement 判定はこの集計を読む。**生ログ（Blob）が正本**で、
  //    ここは再構成できる索引なので、失敗しても webhook は落とさない（数字が古くなるだけ）。
  //    ⚠️ sink mode に関係なく記録する（Airtable 行の有無とは独立した経路）。
  let engagementSignal = 'skipped';
  try {
    const [{ createEngagementSignalStore }, { makeRedisCmd }] = await Promise.all([
      import('../../src/lib/marketing/engagementSignalStore.js'),
      import('../../src/lib/marketing/deliveryKeyStore.js'),
    ]);
    const store = createEngagementSignalStore({ redisCmd: makeRedisCmd(process.env) });
    const r = await store.record({ events: sinkEvents, receivedAtMs });
    engagementSignal = r.ok ? 'ok' : 'failed';
  } catch {
    engagementSignal = 'failed'; // Redis 未設定・一時障害。判定側は「確認できない」として誰も除外しない
  }

  // 理由コードだけ残す（アドレス・鍵・blob 本文は出さない）
  if (sink.degraded.length > 0) {
    console.warn('⚠️ [sendgrid-webhook] event sink degraded:', sink.degraded.join(','));
  }

  // 🔎 dual の実効性を **後から read-only で確認できるように** 結果を数える。
  //    dual では Blob 失敗が致命でないため、記録しないと
  //    「Blob へ書けていないのに書けているつもり」に気づけない。
  //    ⚠️ ここが失敗しても webhook は落とさない（観測用であって本筋ではない）。
  try {
    const { makeRedisCmd } = await import('../../src/lib/marketing/deliveryKeyStore.js');
    const redis = makeRedisCmd(process.env);
    const k = 'ak:mkt:events:sink';
    const bumps = [
      ['mode_' + sinkMode, 1],
      ['airtable_' + sink.airtable, 1],
      ['blob_' + sink.blob, 1],
      ['counters_' + sink.counters, 1],
    ];
    for (const [field, n] of bumps) await redis(['HINCRBY', k, field, String(n)]);
    if (sink.degraded.length > 0) {
      await redis(['HSET', k, 'last_degraded', sink.degraded.join(',')]);
    }
    if (sink.blobKey) await redis(['HSET', k, 'last_blob_written_at', new Date().toISOString()]);
  } catch {
    // 観測できないだけ。本処理は続ける
  }

  return {
    enabled: true,
    ...base,
    ...airtableResult,
    sink: {
      mode: sinkMode, airtable: sink.airtable, blob: sink.blob, counters: sink.counters,
      engagementSignal,
      deliveryIndex,
    },
  };
}

/** 台帳行 → sink が扱う形。**allow-list は Blob store 側が最終判断する**。 */
function toSinkEvent(row) {
  const f = (row && row.fields) || {};
  return {
    eventKey: f.EventKey,
    eventType: f.EventType,
    eventAtMs: f.EventAt ? Date.parse(f.EventAt) : undefined,
    campaignId: f.CampaignId,
    campaignVersion: f.CampaignVersion,
    deliveryKey: f.DeliveryKey,
    campaignDeliveryRecordId: f.CampaignDeliveryRecordId,
    customerRecordId: f.CustomerRecordId,
    emailHash: f.EmailHash,
    bounceClass: f.BounceClass,
    reasonText: f.ReasonText,
    providerEventId: f.ProviderEventId,
    providerMessageId: f.ProviderMessageId,
    resolutionStatus: f.ResolutionStatus,
  };
}

// イベント処理判定
function shouldProcessEvent(event) {
  const failureEvents = [
    'bounce',        // バウンス（hard/soft）
    'blocked',       // ブロック
    'dropped',       // ドロップ
    'spamreport',    // スパム報告
    'unsubscribe'    // 配信停止
  ];

  return failureEvents.includes(event.event);
}

// 配信失敗イベント処理
async function processFailureEvent(event) {
  const email = event.email;
  const bounceInfo = analyzeWebhookBounce(event);

  // ログにメールアドレスを出さない（件数・種別のみ）
  console.log('📧 [sendgrid-webhook] 配信失敗:', { event: event.event, type: bounceInfo.type, severity: bounceInfo.severity });

  await recordWebhookBounce(email, bounceInfo, event);
}

// Webhookバウンス分析
function analyzeWebhookBounce(event) {
  const eventType = event.event;
  const reason = (event.reason || '').toLowerCase();

  // Hard Bounce判定
  if (eventType === 'bounce') {
    const hardBounceReasons = [
      'invalid',
      'not exist',
      'unknown user',
      'mailbox not found',
      'no such user',
      'user unknown',
      'recipient address rejected'
    ];

    if (hardBounceReasons.some(indicator => reason.includes(indicator))) {
      return {
        type: 'hard',
        reason: `hard-bounce: ${reason}`,
        severity: 'high',
        source: 'webhook'
      };
    } else {
      return {
        type: 'soft',
        reason: `soft-bounce: ${reason}`,
        severity: 'medium',
        source: 'webhook'
      };
    }
  }

  // その他の失敗タイプ
  if (eventType === 'blocked') {
    return {
      type: 'blocked',
      reason: `blocked: ${reason}`,
      severity: 'high',
      source: 'webhook'
    };
  }

  if (eventType === 'dropped') {
    return {
      type: 'dropped',
      reason: `dropped: ${reason}`,
      severity: 'high',
      source: 'webhook'
    };
  }

  if (eventType === 'spamreport') {
    return {
      type: 'spam',
      reason: 'spam report',
      severity: 'critical',
      source: 'webhook'
    };
  }

  return {
    type: eventType,
    reason: reason,
    severity: 'medium',
    source: 'webhook'
  };
}

// Webhookバウンス記録
async function recordWebhookBounce(email, bounceInfo, originalEvent) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log('⚠️ [sendgrid-webhook] Airtable 環境変数未設定');
    return;
  }

  // 既存レコード確認 → 更新 or 新規作成
  // **検索に失敗したときは何もしない（fail closed）**。「見つからなかった」と区別せずに
  // 新規作成すると、Airtable の一時障害のたびに重複レコードが増える。
  const lookup = await findExistingRecord(email);
  if (!lookup.ok) {
    console.log('⚠️ [sendgrid-webhook] 既存レコード検索に失敗（作成せずスキップ）');
    return;
  }

  if (lookup.record) {
    await updateExistingRecord(lookup.record, bounceInfo);
  } else {
    await createNewRecord(email, bounceInfo, originalEvent);
  }
}

/**
 * 既存レコード検索（formula injection 遮断 + LOWER(TRIM()) 正規化一致）。
 * @returns {{ok: true, record: object|null} | {ok: false}} ok=false は**判定不能**（作成もしない）
 */
async function findExistingRecord(email) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const formula = emailMatchFormula(email);
  const searchUrl =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${BLACKLIST_TABLE}` +
    `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  try {
    const response = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!response.ok) return { ok: false };
    const data = await response.json();
    return { ok: true, record: data.records.length > 0 ? data.records[0] : null };
  } catch {
    return { ok: false };
  }
}

// 既存レコード更新
async function updateExistingRecord(record, bounceInfo) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const currentBounceCount = record.fields.BounceCount || 0;
  const newBounceCount = currentBounceCount + 1;

  // Hard bounceまたは閾値到達でステータス更新
  let newStatus = record.fields.Status || 'SOFT_BOUNCE';
  if (bounceInfo.type === 'hard' || bounceInfo.severity === 'critical' || newBounceCount >= 5) {
    newStatus = 'HARD_BOUNCE';
  }

  const updateData = {
    fields: {
      BounceCount: newBounceCount,
      BounceType: bounceInfo.type,
      Status: newStatus,
      Notes: `${record.fields.Notes || ''}\nWebhook ${new Date().toISOString()}: ${bounceInfo.reason}`
    }
  };

  const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${BLACKLIST_TABLE}/${record.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updateData)
  });

  if (response.ok) {
    console.log('✅ [sendgrid-webhook] 既存レコード更新:', { bounceCount: newBounceCount, status: newStatus });
  } else {
    // Airtable 応答本文はログへ出さない（メール等が含まれうる）
    console.log('❌ [sendgrid-webhook] 既存レコード更新失敗:', response.status);
  }
}

// 新規レコード作成
async function createNewRecord(email, bounceInfo, originalEvent) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  const recordData = {
    fields: {
      Email: email,
      BounceCount: 1,
      BounceType: bounceInfo.type,
      Status: bounceInfo.type === 'hard' || bounceInfo.severity === 'critical' ? 'HARD_BOUNCE' : 'SOFT_BOUNCE',
      AddedAt: new Date().toISOString().split('T')[0],
      Notes: `Webhook bounce: ${bounceInfo.reason} - Event: ${originalEvent.event}`
    }
  };

  const response = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${BLACKLIST_TABLE}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(recordData)
  });

  if (response.ok) {
    console.log('✅ [sendgrid-webhook] 新規レコード作成');
  } else {
    console.log('❌ [sendgrid-webhook] 新規レコード作成失敗:', response.status);
  }
}
