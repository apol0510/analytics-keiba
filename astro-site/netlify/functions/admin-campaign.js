/**
 * admin-campaign — 全会員向けキャンペーン割引の状態確認・停止・個別除外
 *
 * ## この Function がすること
 *
 *   status  … いまの状態（配布中 / 停止中 / 期間外 / 確認できない）と除外の一覧
 *   pause   … 配布を止める / 再開する
 *   exclude … 会員 1 名を対象外にする / 戻す
 *
 * ## この Function が**しないこと**
 *
 *   × 割引額・期間の変更（コードの正本 `campaignOffers.js` だけが持つ）
 *   × Customers への書き込み（プラン・権限・決済に 1 バイトも触らない）
 *   × メール送信・queue 登録
 *
 * 保存先は Redis（`campaignControlStore.js`）。**本番 Airtable の schema を増やさない**。
 *
 * 認可: `x-admin-secret`（`COMEBACK_ADMIN_SECRET` があれば優先／無ければ `PREMIUM_PLUS_ADMIN_SECRET`）
 */

import { campaignControlStore, isSafeRecordId } from '../../src/lib/promotions/campaignControlStore.js';
import { resolveCampaignAllowed, describeCampaignControl } from '../../src/lib/promotions/campaignControl.js';
import {
  isCampaignActive, describeCampaignDeadline, CAMPAIGN_WINDOW, listCampaignOffers,
  describeCampaignOfferLine, resolveCampaignOfferIdsFor,
} from '../../src/lib/promotions/campaignOffers.js';
import { resolveOffer } from '../../src/lib/promotions/promotionOfferCatalog.js';
import { fromAirtableFields, resolveEntitlements } from '../../src/lib/entitlements/resolveEntitlements.js';

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

/** 対象者の目安を数える（**読み取りだけ**。1 度の一覧取得で済ませる） */
async function countTargets({ KEY, BASE, excludedIds }) {
  const table = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  const buckets = { free: 0, light: 0, premium: 0, sanrenpuku: 0, excluded: 0 };
  let offset = '';
  let pages = 0;
  const now = Date.now();
  const excluded = new Set(excludedIds || []);
  do {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(BASE)}/${encodeURIComponent(table)}`
      + `?pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) return { available: false, buckets, reason: `http_${res.status}` };
    const data = await res.json();
    for (const rec of data.records || []) {
      if (excluded.has(rec.id)) { buckets.excluded += 1; continue; }
      const e = resolveEntitlements(fromAirtableFields(rec.fields || {}), now);
      if (e.canViewSanrenpuku === true) buckets.sanrenpuku += 1;
      else if (e.canViewPremium === true) buckets.premium += 1;
      else if (e.canViewLight === true) buckets.light += 1;
      else buckets.free += 1;
    }
    offset = data.offset || '';
    pages += 1;
    // ⚠️ 打ち切ったら「読めた件数」として出さない（0 件と取り違えない）
    if (pages > 200) return { available: false, buckets, reason: 'truncated' };
  } while (offset);
  return { available: true, buckets, reason: '' };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.COMEBACK_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: 'admin secret 未設定' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  const action = String(req.action || '').trim();
  const actor = String(req.actor || '').trim();
  const store = campaignControlStore(process.env);
  const now = Date.now();

  // ── 状態を返す（読み取りだけ）────────────────────────────
  if (action === 'status') {
    const [control, excluded] = await Promise.all([store.readControl(), store.listExcluded()]);
    const withinWindow = isCampaignActive(now);
    const view = describeCampaignControl({
      control, withinWindow,
      excludedCount: excluded.available ? excluded.ids.length : null,
    });
    const KEY = process.env.AIRTABLE_API_KEY;
    const BASE = process.env.AIRTABLE_BASE_ID;
    const targets = (KEY && BASE && req.countTargets === true)
      ? await countTargets({ KEY, BASE, excludedIds: excluded.ids })
      : { available: false, buckets: null, reason: 'not_requested' };

    return json(200, {
      ok: true,
      view,
      window: { ...CAMPAIGN_WINDOW, withinWindow, deadlineText: describeCampaignDeadline() },
      // 割引の中身は**コードが正本**。ここでは読み取って見せるだけ
      offers: listCampaignOffers().map((o) => {
        const r = resolveOffer(o.offerId);
        return {
          offerId: o.offerId,
          line: r.ok ? describeCampaignOfferLine(r.offer) : o.offerId,
        };
      }),
      // 誰に何が出るか（契約ごとの見本）
      byPlan: {
        free: resolveCampaignOfferIdsFor({}),
        light: resolveCampaignOfferIdsFor({ canViewLight: true }),
        premium: resolveCampaignOfferIdsFor({ canViewPremium: true }),
        sanrenpuku: resolveCampaignOfferIdsFor({ canViewPremium: true, canViewSanrenpuku: true }),
      },
      excluded: { available: excluded.available, ids: excluded.ids },
      targets,
      sideEffects: 'none',
    });
  }

  // ここから先は書き込み。**操作者名は必須**（誰がやったか分からない操作を通さない）
  if (!actor) return json(400, { error: '操作者名を入力してください', code: 'missing_actor' });

  if (action === 'pause') {
    const paused = req.paused === true;
    const out = await store.setPaused({ paused, actor });
    if (!out.ok) return json(503, { error: '状態を変更できませんでした', code: out.reason, sideEffects: 'none' });
    console.log('🎫 [admin-campaign] 配布状態を変更:', { paused, actor });
    return json(200, {
      ok: true, paused,
      note: paused
        ? '配布を止めました。案内も申込の割引も出なくなります。'
        : '配布を再開しました。期間内なら案内と割引が出ます。',
      sideEffects: 'campaign_paused_flag',
    });
  }

  if (action === 'exclude') {
    const recordId = String(req.recordId || '').trim();
    if (!isSafeRecordId(recordId)) return json(400, { error: 'recordId が不正です', code: 'invalid_record_id' });
    const excluded = req.excluded === true;
    const out = await store.setExcluded({ recordId, excluded, actor, reason: req.reason });
    if (!out.ok) return json(503, { error: '変更できませんでした', code: out.reason, sideEffects: 'none' });
    console.log('🎫 [admin-campaign] 個別除外を変更:', { excluded, actor });
    return json(200, {
      ok: true, excluded,
      note: excluded
        ? 'この会員には案内も割引も出なくなります。'
        : 'この会員を対象へ戻しました。',
      // ⚠️ Customers には 1 バイトも書いていない
      customerFieldsUnchanged: true,
      sideEffects: 'campaign_excluded_hash',
    });
  }

  return json(400, { error: `未知の action: ${action}` });
};
