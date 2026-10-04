/**
 * /api/premium-plus-pass.json — 購入済み会員向けプラン（単品 定価・10鞍確保枠・年間オーナーズ枠）
 *
 * - 対象は **`ak_session` の recordId だけ**。購入済み（確認済みの本番注文あり）でなければ 404。
 * - 金額は `premiumPlusPass.js` がサーバーで決める。body の金額は読まない（受け取る口が無い）。
 * - 案内は購入済み会員に常に出す（2026-10-04 MK 指示: 当日レースの終了を待たない）。
 *
 * GET  → { offerVisible, offer, passes, bank }
 * POST { action:'apply', plan, weekday? } → 申込（入金待ち）＋管理者へ通知
 * POST { action:'reserve', passId, saleDate }            → 好きな日に使う枠の日付予約
 */
export const prerender = false;

import { verifySession } from '../../lib/auth/index.js';
import { readSessionCookie } from '../../lib/auth/sessionCookie.js';
import { makeRedisCmd } from '../../lib/premiumPlus/premiumPlusFunnelServer.js';
import { createOrderStore } from '../../lib/premiumPlus/premiumPlusOrderService.js';
import { createPassStore, applyPass, reservePass } from '../../lib/premiumPlus/premiumPlusPassStore.js';
import {
  buildOffer, describePassesForMember, isRepeatEligible, buildAdminNotice, PP_BANK,
} from '../../lib/premiumPlus/premiumPlusPass.js';
import { jstDate } from '../../lib/premiumPlus/premiumPlusDelivery.js';
import { fetchCustomerFields, sendPlusMail } from '../../lib/premiumPlus/premiumPlusMail.js';
import { ADMIN_EMAIL } from '../../../netlify/functions/config/email-config.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0' };
const out = (status, body) => new Response(JSON.stringify(body), { status, headers: NO_STORE });
const notFound = () => out(404, { error: 'not_found' });

const ERROR_JA = {
  unknown_plan: 'プランを選んでください。',
  weekday_required: '配信曜日を選んでください。',
  already_awaiting: 'お振込み待ちのお申し込みがあります。入金確認後に次のお申し込みができます。',
  sold_out: '年間オーナーズ枠は満席になりました。',
  invalid_date: '日付を選んでください。',
  too_late: '当日の予約はできません。前日までにお選びください。',
  after_expiry: 'ご利用期限を過ぎた日は選べません。',
  no_credits: '確保した枠はすべて予約済みです。',
  already_reserved: 'その日は既にお届けが決まっています。',
  not_active: '入金確認後にご予約いただけます。',
  in_progress: '処理中です。少し待ってからもう一度お試しください。',
  store_unavailable: '一時的に処理できませんでした。少し待ってからもう一度お試しください。',
};

async function session(request, nowMs) {
  const secret = process.env.SESSION_SIGNING_SECRET;
  const token = readSessionCookie(request.headers.get('cookie') || '');
  if (!secret || !token) return null;
  const v = await verifySession({ token, secret, now: nowMs });
  const recordId = v.ok ? String(v.payload?.sub || '') : '';
  return recordId || null;
}

export async function GET({ request }) {
  const nowMs = Date.now();
  const recordId = await session(request, nowMs);
  if (!recordId) return notFound();
  const cmd = makeRedisCmd(process.env);
  if (!cmd) return out(503, { error: 'unavailable' });
  try {
    const orders = await createOrderStore({ redisCmd: cmd }).list();
    if (!isRepeatEligible(orders, recordId)) return notFound();
    const passes = await createPassStore({ redisCmd: cmd }).list();
    const offerVisible = true;
    const mine = describePassesForMember(passes, { recordId, nowMs });
    return out(200, {
      offerVisible,
      offer: buildOffer({ orders, passes, recordId, nowMs }),
      passes: mine,
      bank: mine.some((p) => p.status === 'awaiting_payment') ? PP_BANK : null,
      minReserveDate: jstDate(nowMs, 1),
      serverNowMs: nowMs,
    });
  } catch {
    return out(503, { error: 'unavailable' });
  }
}

export async function POST({ request }) {
  const nowMs = Date.now();
  const recordId = await session(request, nowMs);
  if (!recordId) return notFound();
  const cmd = makeRedisCmd(process.env);
  if (!cmd) return out(503, { error: ERROR_JA.store_unavailable });
  let body;
  try { body = await request.json(); } catch { return out(400, { error: '不正なリクエストです。' }); }
  try {
    const orders = await createOrderStore({ redisCmd: cmd }).list();
    if (!isRepeatEligible(orders, recordId)) return notFound();
    const store = createPassStore({ redisCmd: cmd });
    let r;
    if (body?.action === 'apply') {
      r = await applyPass({
        store, orders, recordId, planId: String(body.plan || ''), weekday: body.weekday, nowMs,
      });
      if (r.ok) {
        // 管理者へ通知（失敗しても申込は成立している。管理画面の一覧が正本）
        const fields = await fetchCustomerFields(recordId);
        const notice = buildAdminNotice({ pass: r.pass, fullName: fields?.['氏名'], email: fields?.Email });
        const sent = await sendPlusMail({ to: ADMIN_EMAIL, ...notice, customArgs: { purpose: 'premium_plus_pass_admin_notice' } });
        console.log('🧾 [premium-plus-pass] 申込:', { plan: r.pass.plan, adminNotice: sent });
      }
    } else if (body?.action === 'reserve') {
      r = await reservePass({ store, orders, recordId, passId: String(body.passId || ''), saleDate: String(body.saleDate || ''), nowMs });
    } else {
      return out(400, { error: '不正なリクエストです。' });
    }
    if (!r.ok) return out(r.status || 409, { error: ERROR_JA[r.code] || '受け付けできませんでした。', code: r.code });
    const passes = await store.list();
    return out(200, { ok: true, code: r.code, passes: describePassesForMember(passes, { recordId, nowMs }), bank: r.code === 'applied' ? PP_BANK : null });
  } catch {
    return out(503, { error: ERROR_JA.store_unavailable });
  }
}
