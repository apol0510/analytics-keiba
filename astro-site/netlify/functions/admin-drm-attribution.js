/**
 * admin-drm-attribution.js — DRM の**購入帰属だけ**を読む（read-only・認証必須・bounded）
 *
 * ── なぜ送信経路から分けるのか ────────────────────────────────
 * 購入がどの 1 通に結び付くかを知るには「**いつ有料になったか**」が要る。
 * その正本は `Customers.PaidAt`（`bankPaymentFlow.buildConfirmationFields` が
 * `PaidAt: confirmedAt.toISOString()` として書く **入金確認 = 有料化確定時刻**）。
 *
 * ところが `offerCampaignFunction.guard.test.mjs` は
 * **送信経路**（`admin-marketing.js` / `marketing-campaign-dispatch.js`）が
 * 決済メール v2 のフィールドへ触れないことを守っている。これは
 * 「販促メールを出す経路が決済状態に依存して二重送信・状態汚染を起こさない」ための契約で、
 * **緩めてはいけない**。
 *
 * そこで**責務を分ける**: 送信経路は決済フィールドを一切知らないまま、
 * **分析専用のこの Function だけ**が購入確定時刻を読む。
 * これは新しい商品仕様ではなく、内部の責務分離。
 *
 * ── ここが守ること ────────────────────────────────────────────
 * ⚠️ **1 バイトも書かない。** 送信も queue 登録も dispatch 呼び出しもしない。
 * ⚠️ **全 Customers 走査をしない。** `recordIds` で名指しされた人だけ読む（上限つき）。
 * ⚠️ **raw fields を返さない・ログに出さない。** 返すのは件数と識別子だけ
 *    （アドレス・氏名・契約内容は返さない）。
 * ⚠️ 購入確定時刻が読めない / 無い / 壊れているときは **`unattributed`**。
 *    **推測で時刻を作らない。**
 * ⚠️ click は provider 側 tracking が OFF なので **direct 帰属を捏造しない**。
 *    「0 件」ではなく「測っていない」として返す。
 */

import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { isSequenceCampaign, getSequenceSteps, resolveSequenceStep } from '../../src/lib/marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../../src/lib/marketing/campaignSend.js';
import { buildDeliveryKeyFormula } from '../../src/lib/marketing/marketingTargetedLoad.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';
import { createDeliveryEventIndex } from '../../src/lib/webhooks/deliveryEventIndex.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { lookupPaidConfirmedAt } from '../../src/lib/premiumPlus/purchaseAnchorLookup.js';
import { attributePurchase, summarizeAttribution } from '../../src/lib/drm/drmAttribution.js';
import { MEASURE } from '../../src/lib/crm/deliveryMeasurement.js';

/** 配信ブランド（`lightTrialPlanLoader.js` と同じ値でなければ鍵が変わる） */
const BRAND = 'analytics-keiba';
const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 1 回で受け付ける宛先の上限（`admin-marketing` の重複確認と同じ考え方） */
export const MAX_RECORD_IDS = 500;
/** 1 回の formula に入れる鍵の数 */
const KEY_CHUNK = 40;
/** 取り切れないときは **null**（数え切れていないので 0 と言わない） */
const MAX_PAGES = 12;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
  },
  body: JSON.stringify(body),
});

const str = (v) => String(v ?? '').trim();

/** DeliveryKey で名指しして配信行を読む（read-only・全件走査しない） */
async function readDeliveries({ apiKey, baseId, campaignType, keys }) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const group = keys.slice(i, i + KEY_CHUNK);
    const formula = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!formula) return null;
    let offset;
    let pages = 0;
    do {
      const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(DELIVERIES_TABLE)}`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('filterByFormula', formula);
      for (const f of ['DeliveryKey', 'Status', 'SentAt', 'QueuedAt']) url.searchParams.append('fields[]', f);
      if (offset) url.searchParams.set('offset', offset);
      let data;
      try {
        // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res || !res.ok) return null;
        // eslint-disable-next-line no-await-in-loop
        data = await res.json();
      } catch { return null; }
      for (const r of (data && data.records) || []) {
        const f = (r && r.fields) || {};
        const k = str(f.DeliveryKey);
        if (k) out.set(k, { sentAtMs: f.SentAt || f.QueuedAt ? Date.parse(f.SentAt || f.QueuedAt) : null });
      }
      offset = data ? data.offset : null;
      pages += 1;
      if (offset && pages >= MAX_PAGES) return null;   // 取り切れない = 数えない
    } while (offset);
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 認可: 既存の管理 Function と同じ（未認証では 1 バイトも読めない）
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!apiKey || !baseId) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(str).filter(Boolean) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません', sideEffects: 'none' });
  if (recordIds.length > MAX_RECORD_IDS) {
    return json(400, {
      error: `選択が多すぎます（上限 ${MAX_RECORD_IDS} 件）`,
      limit: MAX_RECORD_IDS, given: recordIds.length, sideEffects: 'none',
    });
  }
  const emails = Array.isArray(req.emails) ? req.emails.map((e) => str(e).toLowerCase()) : [];
  if (emails.length !== recordIds.length) {
    return json(400, {
      error: 'recordIds と emails の数が一致しません（鍵を作れません）', sideEffects: 'none',
    });
  }

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const campaignType = `${base.campaignId}:v${base.version}`;
  const steps = getSequenceSteps(base);

  // ── ① 各人の DeliveryKey（推測しない・既存の鍵の作り方をそのまま使う）──
  const keyToStep = new Map();
  const keysByIndex = [];
  for (const email of emails) {
    const list = [];
    if (email) {
      for (const st of steps) {
        const eff = resolveSequenceStep(base, st.stepNumber);
        if (!eff) continue;
        const k = computeCampaignDeliveryKey({ campaign: eff, recipientEmail: email, brand: BRAND, fromEmail });
        if (!k) continue;
        keyToStep.set(k, st.stepNumber);
        list.push(k);
      }
    }
    keysByIndex.push(list);
  }
  const allKeys = [...keyToStep.keys()];

  // ── ② 配信行（名指し）──────────────────────────────────────
  const deliveries = allKeys.length > 0
    ? await readDeliveries({ apiKey, baseId, campaignType, keys: allKeys })
    : new Map();

  // ── ③ 1 通単位の開封（索引が読めたときだけ）────────────────────
  let eventByKey = null;
  try {
    const idx = createDeliveryEventIndex({ redisCmd: makeRedisCmd(process.env) });
    const read = await idx.read(allKeys.slice(0, 500));
    if (read && read.ok === true) eventByKey = read.byKey || new Map();
  } catch { eventByKey = null; }

  // ── ④ 購入確定時刻（**既存 read-only 正本を再利用**）─────────────
  const results = [];
  const purchaseReasons = {};
  for (let i = 0; i < recordIds.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 1 レコードずつ（キャッシュあり）
    const paid = await lookupPaidConfirmedAt({ recordId: recordIds[i], env: process.env });
    purchaseReasons[paid.reason] = (purchaseReasons[paid.reason] || 0) + 1;
    if (paid.paidAtMs === null) {
      // 有料化が確認できない = 購入者として数えない（**0 とも断定しない**）
      continue;
    }
    const touches = (keysByIndex[i] || []).map((k) => {
      const d = deliveries ? deliveries.get(k) : null;
      const ev = eventByKey ? eventByKey.get(k) : null;
      return {
        step: keyToStep.get(k) ?? null,
        deliveryKey: d ? k : '',            // 配信行が無ければ「送っていない」
        campaignId: base.campaignId,
        version: base.version,
        sentAtMs: d ? d.sentAtMs : null,
        openedAtMs: ev && Number.isFinite(ev.firstOpenAtMs) ? ev.firstOpenAtMs : null,
        clicked: null,                       // **未計測**（false ではない）
        offerKey: null,
      };
    }).filter((t) => t.deliveryKey);
    results.push(attributePurchase({
      purchasedAtMs: paid.paidAtMs,
      touches,
      clickMeasured: false,                  // click tracking は OFF
    }));
  }

  const summary = summarizeAttribution(results, { clickMeasured: false });
  return json(200, {
    mode: 'drm-attribution',
    sideEffects: 'none',
    campaignId: base.campaignId,
    version: base.version,
    requested: recordIds.length,
    /** 有料化を確認できた人数（購入者） */
    purchases: results.length,
    attribution: summary,
    /** 結べたものだけ。**アドレスも recordId も返さない** */
    attributed: results
      .filter((a) => a.attribution !== 'unattributed')
      .map((a) => ({
        campaignId: a.campaignId, version: a.version, step: a.step,
        deliveryKey: a.deliveryKey, offerKey: a.offerKey, confidence: a.attribution,
      })),
    /** なぜ購入時刻を取れなかったか（件数のみ） */
    purchaseTimeReasons: purchaseReasons,
    measurement: {
      click: MEASURE.DISABLED,
      open: eventByKey ? MEASURE.ENABLED : MEASURE.UNKNOWN,
      delivered: deliveries === null ? MEASURE.UNKNOWN : MEASURE.ENABLED,
    },
    deliveriesReadable: deliveries !== null,
    notice: '名指しした宛先だけを読みました（全件走査なし）。**何も書き込んでいません。**'
      + ' PaidAt は入金確認＝有料化が確定した時刻であって、申込（checkout）時刻ではありません。'
      + ' クリックは計測していないため、direct 帰属は 0 件ではなく「測っていない」です。',
  });
};

export default handler;
