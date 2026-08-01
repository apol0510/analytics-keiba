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
    let ledger = { enabled: false, received: events.length, accepted: 0, written: 0, rejected: {}, byResolution: {} };
    try {
      ledger = await applyEmailEventLedger({ events, now: Date.now() });
    } catch {
      // 台帳が失敗しても suppression / 決済メールの結果は返す（例外本文はログへ出さない）
      ledger = { ...ledger, errors: 1 };
    }

    // 件数のみ（メールアドレス・recordId を出さない）
    console.log('📨 [sendgrid-webhook] 処理完了:', {
      received: events.length,
      processed,
      failed,
      paymentEmail,
      ledger,
    });
    return jsonResponse(200, { success: true, received: events.length, processed, failed, paymentEmail, ledger });
  } catch {
    console.error('❌ [sendgrid-webhook] 処理エラー');
    return jsonResponse(500, { error: 'Webhook processing failed' });
  }
};

/**
 * 配信反応を恒久台帳へ積む（**既定 OFF**）。
 *
 * - 判定・正規化・冪等キー・PII 最小化は `emailEventLedger.js` が単一源。ここでは I/O だけ。
 * - `EMAIL_EVENT_LEDGER_ENABLED !== 'true'` なら **1 バイトも書かない**（件数だけ数える）。
 * - 書き込みは `EventKey` をマージキーにした upsert。同じイベントが再送されても 1 行。
 * - 顧客・配信を一意に解決できないイベントも **保存はする**が
 *   `ResolutionStatus=unresolved` として顧客へは結び付けない（推測しない）。
 */
async function applyEmailEventLedger({ events, now }) {
  const {
    buildLedgerBatch, assertOnlyLedgerFields, isLedgerWriteEnabled, EMAIL_EVENTS_TABLE,
  } = await import('../../src/lib/webhooks/emailEventLedger.js');
  const { createHash } = await import('node:crypto');
  const hashFn = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

  const batch = buildLedgerBatch({
    rawEvents: events,
    // 送信側が custom_args を刻むまで配信台帳の索引は空（= すべて unresolved）。
    // 索引を渡すのは **Phase 1c**（送信側の刻印）が入ってから。
    // 1b は Airtable テーブル作成 + env 投入（`docs/EMAIL_EVENT_LEDGER.md` §5 が段取りの単一源）。
    deliveryIndex: new Map(),
    receivedAtMs: now,
    hashFn,
    verification: 'verified',
    createdBy: 'sendgrid-webhook',
  });

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const enabled = isLedgerWriteEnabled(process.env) && !!AIRTABLE_API_KEY && !!AIRTABLE_BASE_ID;
  if (!enabled) {
    // 既定 OFF: 何が届いたかだけ返す（本番 write 0）
    return { enabled: false, received: batch.received, accepted: batch.accepted, written: 0, rejected: batch.rejected, byResolution: batch.byResolution };
  }

  let written = 0;
  for (const row of batch.rows) {
    if (!assertOnlyLedgerFields(row.fields)) continue; // 許可列以外が混ざったら書かない
    try {
      const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${EMAIL_EVENTS_TABLE}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
        // EventKey をマージキーにした upsert（再受信で行が増えない）
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: ['EventKey'] },
          records: [{ fields: row.fields }],
        }),
      });
      if (res.ok) written += 1;
    } catch {
      // 1 件失敗で残件を止めない（例外本文はログへ出さない）
    }
  }
  return { enabled: true, received: batch.received, accepted: batch.accepted, written, rejected: batch.rejected, byResolution: batch.byResolution };
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
