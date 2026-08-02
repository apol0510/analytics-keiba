/**
 * campaignCustomArgs.js — マーケ配信の **custom_args**（Phase 1c / 純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * Phase 1b で台帳 `EmailEvents` は動き始めたが、マーケ配信は送信時に識別子を刻んでいない。
 * そのため届く open / click は `email` しか手掛かりが無く、**すべて `unresolved`**（顧客へ結び付けない）。
 * 同一アドレスの重複 Customers が実在するため、**メールアドレスで推測紐付けをしてはならない**。
 * 送信時に「どの配信の 1 通か」を刻んでおけば、受信側は推測せずに確定できる。
 *
 * ── 権威データはどこにあるか（再生成しない）──────────────────────
 * 送信の 1 通は enqueue 時点で `CampaignDeliveries` に 1 行できている
 * （`admin-marketing.js` → `campaignSend.js#buildDeliveryRecords` が
 * `DeliveryKey` をマージキーに upsert 済み）。
 * したがって custom_args の値は **その行から読むだけ**にする。
 *
 *   - `delivery_key`          … `CampaignDeliveries.DeliveryKey`（**再計算しない**）
 *   - `campaign_delivery_id`  … `CampaignDeliveries` の Airtable recordId（作成後にしか存在しない）
 *   - `customer_record_id`    … `CampaignDeliveries.CustomerRecordId`（enqueue 時の権威値）
 *   - `campaign_id` / `campaign_version` … `CampaignDeliveries.CampaignType`（`<id>:v<n>`）
 *
 * `computeDeliveryKey` をここで呼ばないのは意図的。送信側で作り直すと、
 * enqueue 時と 1 文字でも条件が違ったときに**別の鍵**が刻まれ、台帳と配信台帳が永久に噛み合わなくなる。
 *
 * ── fail closed ──────────────────────────────────────────────
 * 1 つでも欠ける / 形式が違う / enqueue 時の顧客と食い違うなら **`ok:false` を返す**。
 * 呼び出し側は**そのアドレスへ送らない**。紐付けできない配信を増やさないため。
 *
 * ── 入れてはいけない値 ────────────────────────────────────────
 * 生メールアドレス・氏名・token・OfferKey・URL・secret。custom_args は provider 側に保存され、
 * Event Webhook で戻ってきて台帳にも載る。**識別子だけ**を刻む。
 */

/** custom_args のキー（**受信側 `emailEventLedger.js` と同一の綴り**。片方だけ変えない） */
export const CUSTOM_ARG_KEYS = Object.freeze({
  DELIVERY_KEY: 'delivery_key',
  CAMPAIGN_DELIVERY_ID: 'campaign_delivery_id',
  CUSTOMER_RECORD_ID: 'customer_record_id',
  CAMPAIGN_ID: 'campaign_id',
  CAMPAIGN_VERSION: 'campaign_version',
  PURPOSE: 'purpose',
});

/** 目的識別子。決済メール v2（`payment_confirmation_v2`）と**必ず別の値**にする */
export const MARKETING_PURPOSE = 'marketing_campaign';

/** provider の custom_args 全体のサイズ上限（安全側に十分小さく使う） */
export const MAX_CUSTOM_ARGS_BYTES = 10000;

/** 解決できなかった理由（固定コード。アドレス・ID を混ぜない） */
export const CUSTOM_ARGS_REJECT = Object.freeze({
  DELIVERY_NOT_FOUND: 'delivery_not_found',
  DELIVERY_KEY_INVALID: 'delivery_key_invalid',
  CAMPAIGN_DELIVERY_ID_INVALID: 'campaign_delivery_id_invalid',
  CUSTOMER_RECORD_ID_INVALID: 'customer_record_id_invalid',
  CUSTOMER_RECORD_ID_CONFLICT: 'customer_record_id_conflict',
  CAMPAIGN_MISMATCH: 'campaign_mismatch',
  CAMPAIGN_ID_INVALID: 'campaign_id_invalid',
  ALREADY_SENT: 'already_sent',
  VALUE_NOT_SAFE: 'value_not_safe',
  TOO_LARGE: 'too_large',
});

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const DELIVERY_KEY = /^[a-f0-9]{64}$/; // computeDeliveryKey = sha256 hex
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9]{1,4}$/;

const str = (v) => String(v ?? '').trim();

/** `<campaignId>:v<version>` を分解する。壊れていれば null（推測で補完しない）。 */
export function parseCampaignType(raw) {
  const m = /^([a-z0-9][a-z0-9-]{0,63}):v([0-9]{1,4})$/.exec(str(raw));
  return m ? { campaignId: m[1], version: m[2] } : null;
}

/**
 * ジョブに属する `CampaignDeliveries` を受信者アドレスで引けるようにする。
 *
 * - **同一ジョブの行だけ**を採る（別ジョブの行を掴むと別配信の鍵を刻んでしまう）
 * - 同一アドレスに複数行がある場合は**どれも採らない**（`conflict` として捨てる）。
 *   1 通に対して鍵が 2 つある状態を推測で片付けない。
 */
export function indexDeliveriesByRecipient(records = [], jobId = '') {
  const byEmail = new Map();
  const conflicted = new Set();
  const job = str(jobId);
  for (const rec of records || []) {
    const f = (rec && rec.fields) || {};
    if (str(f.EmailType) !== 'campaign') continue;
    if (str(f.ScheduledEmailJobId) !== job) continue;
    const email = str(f.RecipientEmail).toLowerCase();
    if (!email) continue;
    if (byEmail.has(email)) { conflicted.add(email); continue; }
    byEmail.set(email, {
      recordId: str(rec.id),
      deliveryKey: str(f.DeliveryKey),
      customerRecordId: str(f.CustomerRecordId),
      campaignType: str(f.CampaignType),
      status: str(f.Status),
    });
  }
  for (const email of conflicted) byEmail.delete(email);
  return byEmail;
}

/** 値が識別子として安全か（アドレス・URL・空白・制御文字を弾く） */
export function isSafeCustomArgValue(v) {
  const s = String(v ?? '');
  if (s.length === 0 || s.length > 128) return false;
  if (/[\s@]/.test(s)) return false;              // アドレス・空白
  if (/https?:/i.test(s)) return false;           // URL
  return /^[A-Za-z0-9._:-]+$/.test(s);            // 識別子に使う文字だけ
}

/**
 * 1 通ぶんの custom_args を組み立てる。**権威データから読むだけ**（再生成しない）。
 *
 * @param {{delivery: object|null, customerRecordId?: string, campaignId?: string,
 *          campaignVersion?: string|number, allowAlreadySent?: boolean}} input
 *   delivery: `indexDeliveriesByRecipient` の値
 *   customerRecordId: 送信直前に Customers から引いた recordId（**照合用**。優先はしない）
 *   campaignId / campaignVersion: ジョブが属するキャンペーン（照合用）
 * @returns {{ok: true, customArgs: object} | {ok: false, reason: string}}
 */
export function buildCampaignCustomArgs({
  delivery, customerRecordId = '', campaignId = '', campaignVersion = '', allowAlreadySent = false,
} = {}) {
  if (!delivery) return { ok: false, reason: CUSTOM_ARGS_REJECT.DELIVERY_NOT_FOUND };

  // 二重送信防止: 既に送信済みの行へ再送しない（ジョブが PENDING のまま残っていても）
  if (!allowAlreadySent && str(delivery.status).toLowerCase() === 'sent') {
    return { ok: false, reason: CUSTOM_ARGS_REJECT.ALREADY_SENT };
  }

  const deliveryKey = str(delivery.deliveryKey);
  if (!DELIVERY_KEY.test(deliveryKey)) return { ok: false, reason: CUSTOM_ARGS_REJECT.DELIVERY_KEY_INVALID };

  const deliveryRecordId = str(delivery.recordId);
  if (!RECORD_ID.test(deliveryRecordId)) return { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_DELIVERY_ID_INVALID };

  // 顧客は **enqueue 時に確定した値**を正とする。アドレスから引き直した値は照合にだけ使う
  const authoritativeCustomer = str(delivery.customerRecordId);
  if (!RECORD_ID.test(authoritativeCustomer)) return { ok: false, reason: CUSTOM_ARGS_REJECT.CUSTOMER_RECORD_ID_INVALID };
  const observed = str(customerRecordId);
  if (observed && observed !== authoritativeCustomer) {
    // 同一アドレスの重複 Customers 等で、いま引いた顧客と配信台帳の顧客が食い違う。
    // どちらかを選ぶと別人へ紐付く恐れがあるため**送らない**。
    return { ok: false, reason: CUSTOM_ARGS_REJECT.CUSTOMER_RECORD_ID_CONFLICT };
  }

  const parsed = parseCampaignType(delivery.campaignType);
  if (!parsed) return { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_ID_INVALID };
  const wantId = str(campaignId);
  const wantVersion = str(campaignVersion);
  if ((wantId && wantId !== parsed.campaignId) || (wantVersion && wantVersion !== parsed.version)) {
    return { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_MISMATCH };
  }
  if (!CAMPAIGN_ID.test(parsed.campaignId) || !VERSION.test(parsed.version)) {
    return { ok: false, reason: CUSTOM_ARGS_REJECT.CAMPAIGN_ID_INVALID };
  }

  const customArgs = {
    [CUSTOM_ARG_KEYS.DELIVERY_KEY]: deliveryKey,
    [CUSTOM_ARG_KEYS.CAMPAIGN_DELIVERY_ID]: deliveryRecordId,
    [CUSTOM_ARG_KEYS.CUSTOMER_RECORD_ID]: authoritativeCustomer,
    [CUSTOM_ARG_KEYS.CAMPAIGN_ID]: parsed.campaignId,
    [CUSTOM_ARG_KEYS.CAMPAIGN_VERSION]: parsed.version,
    [CUSTOM_ARG_KEYS.PURPOSE]: MARKETING_PURPOSE,
  };

  // 識別子以外（アドレス・URL・token）が紛れ込んでいないか最終確認
  for (const v of Object.values(customArgs)) {
    if (!isSafeCustomArgValue(v)) return { ok: false, reason: CUSTOM_ARGS_REJECT.VALUE_NOT_SAFE };
  }
  if (Buffer.byteLength(JSON.stringify(customArgs), 'utf8') > MAX_CUSTOM_ARGS_BYTES) {
    return { ok: false, reason: CUSTOM_ARGS_REJECT.TOO_LARGE };
  }

  return { ok: true, customArgs };
}
