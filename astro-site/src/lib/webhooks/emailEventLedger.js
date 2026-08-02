/**
 * emailEventLedger.js — メール配信反応の**恒久台帳**（純粋・I/O なし）
 *
 * ── なぜ必要か ────────────────────────────────────────────────
 * 配信基盤の Activity API は保持期間が短く（実測 3 日）、それ以前の開封・クリックは
 * **取得できない＝不明**になる。AK 側にイベントを保存していないため、
 * 「反応が無かった」のか「記録が消えただけ」なのか永久に区別できない。
 * Event Webhook で届いたイベントを AK の台帳へ append-only で残し、
 * 顧客カルテ・時系列履歴・施策判断が**事実**に基づけるようにする。
 *
 * ── このモジュールがやらないこと ───────────────────────────────
 * - 署名検証（`sendgridSignature.js` が単一源）
 * - Airtable への読み書き（呼び出し側が行う。ここは形を作るだけ）
 * - **推測での紐付け**（誰のどの配信か確定できないイベントを顧客へ結び付けない）
 *
 * ── 紐付けの正本（優先順位）─────────────────────────────────
 * メールアドレスは**主キーにしない**（同一アドレスの重複 Customers が実在し、
 * 別人へ誤って結び付ける）。送信時に `custom_args` で刻んだ識別子だけを信頼する。
 *
 *   1. `delivery_key`        … CampaignDeliveries の DeliveryKey（配信 1 通の一意キー）
 *   2. `campaign_delivery_id`… CampaignDeliveries recordId
 *   3. `customer_record_id`  … Customers recordId
 *   4. `campaign_id` + `campaign_version`
 *   5. `sg_message_id`       … 送信時に控えている場合のみ（現状は未記録）
 *
 * ⚠️ **2026-08-01 時点で、マーケ配信は custom_args を付けていない**
 *    （`marketing-campaign-dispatch.js` の送信ペイロードに custom_args が無い）。
 *    したがって現状の受信イベントは `email` しか手掛かりが無く、
 *    このモジュールは **`unresolved` として保存する**（顧客へは結び付けない）。
 *    紐付けを効かせるには送信側で custom_args を刻む変更が別途必要
 *    （**Phase 1c**。1b は Airtable テーブル作成 + env 投入。`docs/EMAIL_EVENT_LEDGER.md` §5 が段取りの単一源）。
 *
 * ── 個人情報は最小限 ──────────────────────────────────────
 * - **IP アドレス・User-Agent は保存しない**（施策判断に不要で、漏えい時の被害が大きい）
 * - クリック URL は**そのまま保存しない**。token / クエリを落とし、**分類**だけ残す
 *   （`/offer/?t=…` を保存すると台帳が実質的な認証情報の保管庫になる）
 * - メールアドレスは**ハッシュのみ**（`EmailHash`）。生アドレスは Customers 側にある
 */

/** 恒久保存するイベント種別（provider の event 名） */
export const EVENT_TYPE = Object.freeze({
  PROCESSED: 'processed',
  DELIVERED: 'delivered',
  DEFERRED: 'deferred',
  BOUNCE: 'bounce',
  DROPPED: 'dropped',
  OPEN: 'open',
  CLICK: 'click',
  SPAMREPORT: 'spamreport',
  UNSUBSCRIBE: 'unsubscribe',
  GROUP_UNSUBSCRIBE: 'group_unsubscribe',
  GROUP_RESUBSCRIBE: 'group_resubscribe',
});

const KNOWN_EVENTS = new Set(Object.values(EVENT_TYPE));

/** 紐付けの確からしさ。`unresolved` は保存するが顧客へ結び付けない */
export const RESOLUTION = Object.freeze({
  RESOLVED: 'resolved',
  UNRESOLVED: 'unresolved',
  CONFLICT: 'conflict',
});

/** 取り込みを断った理由（成功扱いにしない） */
export const REJECT = Object.freeze({
  NOT_OBJECT: 'not_object',
  NO_EVENT_TYPE: 'no_event_type',
  UNKNOWN_EVENT_TYPE: 'unknown_event_type',
  NO_TIMESTAMP: 'no_timestamp',
  NO_IDENTITY: 'no_identity',
});

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();

/** UNIX 秒 / ISO のどちらでも受ける。取れなければ null（捏造しない） */
export function parseEventTime(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // SendGrid の timestamp は UNIX 秒
    const ms = raw > 1e12 ? raw : raw * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const t = Date.parse(str(raw));
  return Number.isFinite(t) ? t : null;
}

/**
 * クリック URL を**分類**に落とす（token・クエリ・個別 ID を保存しない）。
 * 例: `https://analytics.keiba.link/offer/?t=xxxx` → `offer`
 */
export function classifyUrl(rawUrl) {
  const u = str(rawUrl);
  if (!u) return { category: 'none', path: '' };
  let path = '';
  try {
    const parsed = new URL(u);
    path = parsed.pathname || '';
  } catch {
    // URL として読めない場合はパスらしき部分だけ拾う（クエリは捨てる）
    path = u.split('?')[0].replace(/^https?:\/\/[^/]+/i, '');
  }
  const p = path.toLowerCase().replace(/\/+$/, '');
  const category = p.startsWith('/offer') ? 'offer'
    : p.startsWith('/pricing') ? 'pricing'
      : p.startsWith('/login') || p.startsWith('/auth') ? 'login'
        : p.startsWith('/dashboard') ? 'dashboard'
          : p.startsWith('/premium-plus') ? 'premium_plus'
            : p.startsWith('/premium-prediction') ? 'premium_prediction'
              : p.startsWith('/free-prediction') ? 'free_prediction'
                : p.includes('unsubscribe') ? 'unsubscribe'
                  : p === '' || p === '/' ? 'top' : 'other';
  // パスは残すが**クエリ・フラグメントは捨てる**（token を保存しない）
  return { category, path: p || '/' };
}

/**
 * 受信イベント 1 件を検証・正規化する。**推測で補完しない**。
 *
 * @param {object} raw provider から届いたイベント
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: REJECT.NOT_OBJECT };

  const type = lower(raw.event);
  if (!type) return { ok: false, reason: REJECT.NO_EVENT_TYPE };
  // 未知の種別は **成功扱いにしない**。呼び出し側が隔離して数える
  if (!KNOWN_EVENTS.has(type)) return { ok: false, reason: REJECT.UNKNOWN_EVENT_TYPE, eventType: type };

  const atMs = parseEventTime(raw.timestamp);
  if (atMs == null) return { ok: false, reason: REJECT.NO_TIMESTAMP, eventType: type };

  const email = lower(raw.email);
  const providerEventId = str(raw.sg_event_id);
  const providerMessageId = str(raw.sg_message_id);
  // 何一つ識別子が無いイベントは保存しても使えない
  if (!email && !providerEventId && !providerMessageId) {
    return { ok: false, reason: REJECT.NO_IDENTITY, eventType: type };
  }

  const url = type === EVENT_TYPE.CLICK ? classifyUrl(raw.url) : { category: '', path: '' };

  return {
    ok: true,
    event: {
      type,
      atMs,
      email,
      providerEventId,
      providerMessageId,
      // 送信時に刻んだ識別子（custom_args はイベントの最上位キーとして届く）
      customArgs: {
        deliveryKey: str(raw.delivery_key),
        campaignDeliveryId: str(raw.campaign_delivery_id),
        customerRecordId: str(raw.customer_record_id),
        campaignId: str(raw.campaign_id),
        campaignVersion: str(raw.campaign_version),
        purpose: str(raw.purpose),
      },
      urlCategory: url.category,
      urlPath: url.path,
      /** bounce / dropped の理由（分類のみ。本文やアドレスは入れない） */
      reasonText: [EVENT_TYPE.BOUNCE, EVENT_TYPE.DROPPED, EVENT_TYPE.DEFERRED].includes(type)
        ? str(raw.reason).slice(0, 120) : '',
      bounceClass: type === EVENT_TYPE.BOUNCE ? lower(raw.type) : '',
    },
  };
}

/**
 * イベントの一意キー（冪等性の要）。
 *
 * provider の `sg_event_id` は 1 イベント 1 値なので最優先。無い場合だけ
 * 「メッセージ + 種別 + 時刻 + 宛先ハッシュ」で合成する。
 * **open / click は複数回起こる**ので、時刻まで含めて別イベントとして残す
 * （同じ人が 3 回開いたら 3 行。集計と履歴を混同しない）。
 *
 * @param {{ event: object, hashFn: (s: string) => string }} input
 */
export function buildEventKey({ event, hashFn }) {
  if (!event) return '';
  if (event.providerEventId) return `sg:${event.providerEventId}`;
  const emailPart = event.email && typeof hashFn === 'function' ? hashFn(event.email).slice(0, 16) : 'noemail';
  const msg = event.providerMessageId || 'nomsg';
  return `c:${msg}:${event.type}:${event.atMs}:${emailPart}`;
}

/**
 * イベントを配信・顧客へ結び付ける。**推測しない**。
 *
 * @param {{ event: object, deliveryIndex?: Map<string, object> }} input
 *   deliveryIndex: DeliveryKey / recordId → { recordId, customerRecordId, campaignId, campaignVersion }
 */
export function resolveAttribution({ event, deliveryIndex = new Map() } = {}) {
  const ca = (event && event.customArgs) || {};
  const candidates = [];

  if (ca.deliveryKey && deliveryIndex.has(ca.deliveryKey)) candidates.push(deliveryIndex.get(ca.deliveryKey));
  if (ca.campaignDeliveryId && deliveryIndex.has(ca.campaignDeliveryId)) candidates.push(deliveryIndex.get(ca.campaignDeliveryId));

  // 送信時の刻印だけを信頼する。email 単独では**結び付けない**
  if (candidates.length === 0) {
    return {
      status: RESOLUTION.UNRESOLVED,
      reason: ca.deliveryKey || ca.campaignDeliveryId ? 'delivery_not_found' : 'no_custom_args',
      deliveryKey: ca.deliveryKey || '',
      campaignDeliveryId: '',
      customerRecordId: ca.customerRecordId || '',
      campaignId: ca.campaignId || '',
      campaignVersion: ca.campaignVersion || '',
    };
  }

  // 複数の候補が食い違う場合は conflict（どちらかを選ばない）
  const ids = new Set(candidates.map((c) => str(c.recordId)));
  if (ids.size > 1) {
    return { status: RESOLUTION.CONFLICT, reason: 'multiple_deliveries', deliveryKey: ca.deliveryKey || '', campaignDeliveryId: '', customerRecordId: '', campaignId: '', campaignVersion: '' };
  }

  const hit = candidates[0];
  // custom_args の顧客と台帳の顧客が食い違うなら結び付けない（誤紐付け防止）
  if (ca.customerRecordId && str(hit.customerRecordId) && ca.customerRecordId !== str(hit.customerRecordId)) {
    return { status: RESOLUTION.CONFLICT, reason: 'customer_mismatch', deliveryKey: ca.deliveryKey || '', campaignDeliveryId: '', customerRecordId: '', campaignId: '', campaignVersion: '' };
  }

  return {
    status: RESOLUTION.RESOLVED,
    reason: '',
    deliveryKey: str(hit.deliveryKey) || ca.deliveryKey || '',
    campaignDeliveryId: str(hit.recordId),
    customerRecordId: str(hit.customerRecordId) || ca.customerRecordId || '',
    campaignId: str(hit.campaignId) || ca.campaignId || '',
    campaignVersion: str(hit.campaignVersion) || ca.campaignVersion || '',
  };
}

/** 台帳へ書いてよい列（これ以外は書かない） */
export const LEDGER_WRITABLE_FIELDS = Object.freeze([
  'EventKey', 'EventType', 'EventAt', 'ReceivedAt',
  'DeliveryKey', 'CampaignDeliveryRecordId', 'CustomerRecordId',
  'CampaignId', 'CampaignVersion',
  'Provider', 'ProviderMessageId', 'ProviderEventId',
  'UrlCategory', 'UrlPath', 'ReasonText', 'BounceClass',
  'EmailHash', 'VerificationStatus', 'ResolutionStatus', 'ResolutionReason', 'CreatedBy',
]);

/** 台帳に**絶対に現れてはいけない**列（個人情報・機微値） */
export const LEDGER_FORBIDDEN_FIELDS = Object.freeze([
  'Email', 'IP', 'IpAddress', 'UserAgent', 'Url', 'RawUrl', 'RawPayload', 'Token', 'OfferKey', 'TokenHash',
]);

/**
 * 台帳 1 行を組み立てる。**許可列だけ**を返す。
 *
 * @param {{ event: object, attribution: object, eventKey: string, receivedAtMs: number,
 *           hashFn?: (s:string)=>string, verification?: string, createdBy?: string }} input
 */
export function buildLedgerFields({
  event, attribution, eventKey, receivedAtMs, hashFn, verification = 'verified', createdBy = 'sendgrid-webhook',
} = {}) {
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const fields = {
    EventKey: str(eventKey),
    EventType: str(event.type),
    EventAt: iso(event.atMs),
    ReceivedAt: iso(receivedAtMs),
    DeliveryKey: str(attribution.deliveryKey),
    CampaignDeliveryRecordId: str(attribution.campaignDeliveryId),
    CustomerRecordId: str(attribution.customerRecordId),
    CampaignId: str(attribution.campaignId),
    CampaignVersion: str(attribution.campaignVersion),
    Provider: 'sendgrid',
    ProviderMessageId: str(event.providerMessageId),
    ProviderEventId: str(event.providerEventId),
    UrlCategory: str(event.urlCategory),
    UrlPath: str(event.urlPath),
    ReasonText: str(event.reasonText),
    BounceClass: str(event.bounceClass),
    // 生アドレスは保存しない（照合はハッシュで足りる）
    EmailHash: event.email && typeof hashFn === 'function' ? hashFn(event.email).slice(0, 32) : '',
    VerificationStatus: str(verification),
    ResolutionStatus: str(attribution.status),
    ResolutionReason: str(attribution.reason),
    CreatedBy: str(createdBy),
  };
  // 空文字は書かない（Airtable 側の型ゆれを避ける）
  for (const k of Object.keys(fields)) {
    if (fields[k] === '' || fields[k] === null) delete fields[k];
  }
  return fields;
}

/** 書き込み対象が許可列だけかを検証する（呼び出し側の事故防止） */
export function assertOnlyLedgerFields(fields) {
  const keys = Object.keys(fields || {});
  if (keys.length === 0) return false;
  if (keys.some((k) => LEDGER_FORBIDDEN_FIELDS.includes(k))) return false;
  return keys.every((k) => LEDGER_WRITABLE_FIELDS.includes(k));
}

/**
 * 受信バッチを台帳行の配列にする。**同一 EventKey は 1 行に畳む**（同一バッチ内の重複）。
 * 取り込めなかったものは理由別に数え、成功扱いにしない。
 */
export function buildLedgerBatch({ rawEvents = [], deliveryIndex = new Map(), receivedAtMs, hashFn, verification, createdBy } = {}) {
  const rows = [];
  const seen = new Set();
  const rejected = {};
  const byResolution = {};

  for (const raw of rawEvents) {
    const norm = normalizeEvent(raw);
    if (!norm.ok) {
      rejected[norm.reason] = (rejected[norm.reason] || 0) + 1;
      continue;
    }
    const event = norm.event;
    const attribution = resolveAttribution({ event, deliveryIndex });
    const eventKey = buildEventKey({ event, hashFn });
    if (!eventKey) { rejected[REJECT.NO_IDENTITY] = (rejected[REJECT.NO_IDENTITY] || 0) + 1; continue; }
    if (seen.has(eventKey)) continue; // 同一バッチ内の重複は 1 行
    seen.add(eventKey);

    byResolution[attribution.status] = (byResolution[attribution.status] || 0) + 1;
    rows.push({
      eventKey,
      fields: buildLedgerFields({ event, attribution, eventKey, receivedAtMs, hashFn, verification, createdBy }),
    });
  }

  return { rows, rejected, byResolution, accepted: rows.length, received: rawEvents.length };
}

/**
 * 台帳から顧客 1 人の反応を集計する。
 * **台帳が無い期間は 0 ではなく「不明」**（`ledgerAvailable=false`）として扱わせる。
 */
export function summarizeCustomerEvents({ ledgerRows = [], ledgerAvailable = false } = {}) {
  if (!ledgerAvailable) {
    return {
      available: false,
      delivered: null, opens: null, clicks: null,
      firstOpenAt: null, lastOpenAt: null, firstClickAt: null, lastClickAt: null,
      bounced: null, unsubscribed: null, spamReported: null, clickCategories: [],
    };
  }
  const at = (r) => Date.parse(str(r.fields && r.fields.EventAt));
  const of = (type) => ledgerRows
    .filter((r) => lower(r.fields && r.fields.EventType) === type)
    .map((r) => at(r)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);

  const opens = of(EVENT_TYPE.OPEN);
  const clicks = of(EVENT_TYPE.CLICK);
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const cats = [...new Set(ledgerRows
    .filter((r) => lower(r.fields && r.fields.EventType) === EVENT_TYPE.CLICK)
    .map((r) => str(r.fields && r.fields.UrlCategory)).filter(Boolean))];

  return {
    available: true,
    delivered: of(EVENT_TYPE.DELIVERED).length,
    opens: opens.length,
    clicks: clicks.length,
    firstOpenAt: iso(opens[0]),
    lastOpenAt: iso(opens[opens.length - 1]),
    firstClickAt: iso(clicks[0]),
    lastClickAt: iso(clicks[clicks.length - 1]),
    bounced: of(EVENT_TYPE.BOUNCE).length + of(EVENT_TYPE.DROPPED).length,
    unsubscribed: of(EVENT_TYPE.UNSUBSCRIBE).length + of(EVENT_TYPE.GROUP_UNSUBSCRIBE).length,
    spamReported: of(EVENT_TYPE.SPAMREPORT).length,
    clickCategories: cats,
  };
}

/** 台帳への書き込みが有効か（既定 OFF。env が 'true' のときだけ） */
export function isLedgerWriteEnabled(env = {}) {
  return String(env.EMAIL_EVENT_LEDGER_ENABLED || '').trim() === 'true';
}

/** 台帳テーブル名（Airtable。作成はユーザー操作） */
export const EMAIL_EVENTS_TABLE = 'EmailEvents';
