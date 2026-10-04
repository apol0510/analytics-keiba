/**
 * premiumPlusPass.js — Premium Plus の購入済み会員向けプランと「価格据え置きの枠確保」（純粋・I/O なし）
 *
 * ## 2026-10-04 MK 決定
 *
 * - 一度購入した会員の**次回の単品は定価 ¥98,000**（初回価格 ¥68,000 は 1 回だけ）。
 * - 購入済み会員には「**価格据え置きの枠確保**」を案内する。何鞍のパックかではなく、
 *   定価に戻ったあとも確保時の価格で受け取れる権利として見せる。
 *     - 10鞍確保枠: ¥680,000 = **初回価格 ¥68,000 を 10 鞍分据え置き**（有効 6 か月・好きな日に使う）。
 *       1 鞍あたりが初回価格を下回らないようにする（初回が最安という形を崩さない）
 *     - 年間オーナーズ枠: ¥1,980,000（毎週 1 鞍・52 鞍・曜日固定・**限定 5 名**・**一括払いのみ**）
 * - 初回購入の確認から 7 日以内なら、初回の ¥68,000 を枠の代金へ充当する（1 回だけ）。
 * - **補償・保証はない**（MK 決定）。的中・回収の保証なし・入金後のキャンセル返金なしを申込ボタンの近くに明記する
 *   （特商法の返品特約表示。小さくてよいが、読める大きさ・申込前に目に入る位置に置く）。
 * - 中身は自動生成（`premiumPlusDelivery.js`）。的中率などの成績表示はしない。
 *
 * 金額は**ここだけ**で決める。クライアントから金額・割引額を受け取る口は作らない。
 */
import { jstDate } from './premiumPlusDelivery.js';

export const PP_FIRST_PRICE = 68000;
export const PP_LIST_PRICE = 98000;
export const PP_CREDIT_DAYS = 7;
export const PP_ANNUAL_CAPACITY = 5;

export const PASS_PLANS = Object.freeze({
  single: Object.freeze({
    id: 'single', name: 'Premium Plus 単品', races: 1, price: PP_LIST_PRICE, validDays: 60,
    schedule: 'choose', creditable: false, compensation: 0,
  }),
  pass10: Object.freeze({
    id: 'pass10', name: '10鞍確保枠', races: 10, price: PP_FIRST_PRICE * 10, validDays: 183,
    schedule: 'choose', creditable: true, compensation: 0,
  }),
  annual: Object.freeze({
    id: 'annual', name: '年間オーナーズ枠', races: 52, price: 1980000, validDays: 365,
    schedule: 'weekly', creditable: true, compensation: 0, capacity: PP_ANNUAL_CAPACITY,
  }),
});

export const PASS_STATUS = Object.freeze({
  AWAITING: 'awaiting_payment', ACTIVE: 'active', CANCELLED: 'cancelled',
});

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

/** 通常価格（単品 ¥98,000）で同じ鞍数を買った場合 */
export function listValue(plan) { return PP_LIST_PRICE * plan.races; }

/** 本人の初回購入（確認済み・本番注文のうち最古） */
export function firstConfirmedOrder(orders, recordId) {
  return (orders || [])
    .filter((o) => o && o.recordId === recordId && o.status === 'confirmed' && o.canary !== true)
    .sort((a, b) => (Number(a.confirmedAt) || 0) - (Number(b.confirmedAt) || 0))[0] || null;
}

function confirmedAtOf(order) {
  const h = (order?.history || []).find((x) => x.action === 'confirmed');
  return Number(order?.confirmedAt) || Number(h?.at) || null;
}

/**
 * 初回 ¥68,000 の充当が使えるか。初回確認から 7 日以内・まだ充当に使っていない。
 * @returns {{ available:boolean, amount:number, deadlineMs:number|null, sourceOrderId:string|null }}
 */
export function resolveCredit({ orders, passes, recordId, nowMs }) {
  const first = firstConfirmedOrder(orders, recordId);
  const at = confirmedAtOf(first);
  if (!first || !at) return { available: false, amount: 0, deadlineMs: null, sourceOrderId: null };
  const deadlineMs = at + PP_CREDIT_DAYS * DAY_MS;
  const used = (passes || []).some((p) => p.recordId === recordId && p.creditOrderId === first.orderId
    && p.status !== PASS_STATUS.CANCELLED);
  const amount = Number.isFinite(first.amount) && first.amount > 0 ? first.amount : PP_FIRST_PRICE;
  return { available: !used && nowMs <= deadlineMs, amount, deadlineMs, sourceOrderId: first.orderId };
}

/** 年間枠の残り（申込中＋有効を数える。取消は数えない） */
export function annualSeatsLeft(passes) {
  const taken = (passes || []).filter((p) => p.plan === 'annual' && p.status !== PASS_STATUS.CANCELLED).length;
  return Math.max(0, PP_ANNUAL_CAPACITY - taken);
}

/** 購入済み会員か（確認済みの本番注文が 1 件以上） */
export function isRepeatEligible(orders, recordId) {
  return firstConfirmedOrder(orders, recordId) !== null;
}

/**
 * 購入済み会員に見せるプラン一覧（金額はサーバーで確定）。
 */
export function buildOffer({ orders, passes, recordId, nowMs }) {
  const credit = resolveCredit({ orders, passes, recordId, nowMs });
  const seats = annualSeatsLeft(passes);
  const plans = Object.values(PASS_PLANS).map((plan) => {
    const useCredit = plan.creditable && credit.available;
    const pay = plan.price - (useCredit ? credit.amount : 0);
    return {
      id: plan.id,
      name: plan.name,
      races: plan.races,
      price: plan.price,
      perRace: Math.round(plan.price / plan.races),
      listValue: listValue(plan),
      saving: listValue(plan) - plan.price,
      validDays: plan.validDays,
      schedule: plan.schedule,
      compensation: plan.compensation,
      creditApplied: useCredit ? credit.amount : 0,
      payAmount: pay,
      installments: plan.installments || 1,
      installmentAmount: plan.installments ? Math.ceil(pay / plan.installments) : pay,
      capacity: plan.capacity || null,
      seatsLeft: plan.capacity ? seats : null,
      available: plan.capacity ? seats > 0 : true,
    };
  });
  return {
    listPrice: PP_LIST_PRICE,
    firstPrice: PP_FIRST_PRICE,
    credit: { available: credit.available, amount: credit.amount, deadlineMs: credit.deadlineMs },
    plans,
  };
}

export function buildPassId(recordId, nowMs) {
  return `${recordId}:${nowMs.toString(36)}`;
}

/**
 * 申込（副作用なし・判定だけ）。
 * @returns {{ ok:true, pass:object } | { ok:false, code:string }}
 */
export function planApply({ orders, passes, recordId, planId, weekday, installments, nowMs }) {
  if (!RECORD_ID_RE.test(String(recordId || ''))) return { ok: false, code: 'invalid_member' };
  const plan = PASS_PLANS[planId];
  if (!plan) return { ok: false, code: 'unknown_plan' };
  if (!isRepeatEligible(orders, recordId)) return { ok: false, code: 'not_repeat_member' };
  const mine = (passes || []).filter((p) => p.recordId === recordId);
  if (mine.some((p) => p.status === PASS_STATUS.AWAITING)) return { ok: false, code: 'already_awaiting' };
  if (plan.capacity && annualSeatsLeft(passes) <= 0) return { ok: false, code: 'sold_out' };
  let wd = null;
  if (plan.schedule === 'weekly') {
    wd = Number(weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { ok: false, code: 'weekday_required' };
  }
  const inst = plan.installments && Number(installments) === plan.installments ? plan.installments : 1;
  const credit = resolveCredit({ orders, passes, recordId, nowMs });
  const useCredit = plan.creditable && credit.available;
  const amount = plan.price - (useCredit ? credit.amount : 0);
  return {
    ok: true,
    pass: {
      v: 1,
      passId: buildPassId(recordId, nowMs),
      recordId,
      plan: plan.id,
      planName: plan.name,
      races: plan.races,
      listPrice: plan.price,
      amount,
      installments: inst,
      firstPayment: inst > 1 ? Math.ceil(amount / inst) : amount,
      creditOrderId: useCredit ? credit.sourceOrderId : null,
      creditAmount: useCredit ? credit.amount : 0,
      schedule: plan.schedule,
      weekday: wd,
      validDays: plan.validDays,
      compensation: plan.compensation,
      status: PASS_STATUS.AWAITING,
      reservations: [],
      createdAt: nowMs,
      history: [{ at: nowMs, action: 'applied' }],
    },
  };
}

/** 入金確認（有効化）。有効期限は確認日（JST）から */
export function planConfirmPass(pass, { actor, nowMs }) {
  if (!pass) return { ok: false, code: 'pass_not_found' };
  if (pass.status === PASS_STATUS.ACTIVE) return { ok: false, code: 'already_active', idempotent: true };
  if (pass.status !== PASS_STATUS.AWAITING) return { ok: false, code: 'not_awaiting' };
  if (!String(actor || '').trim()) return { ok: false, code: 'missing_actor' };
  const startDate = jstDate(nowMs);
  const validUntil = jstDate(Date.parse(`${startDate}T12:00:00+09:00`), pass.validDays);
  return {
    ok: true,
    pass: {
      ...pass,
      status: PASS_STATUS.ACTIVE,
      activatedAt: nowMs,
      startDate,
      validUntil,
      history: [...(pass.history || []), { at: nowMs, action: 'confirmed', actor: String(actor).slice(0, 40) }].slice(-30),
    },
  };
}

export function planCancelPass(pass, { actor, reason, nowMs }) {
  if (!pass) return { ok: false, code: 'pass_not_found' };
  if (pass.status !== PASS_STATUS.AWAITING) return { ok: false, code: 'not_awaiting' };
  if (!String(actor || '').trim()) return { ok: false, code: 'missing_actor' };
  if (!String(reason || '').trim()) return { ok: false, code: 'missing_reason' };
  return {
    ok: true,
    pass: {
      ...pass,
      status: PASS_STATUS.CANCELLED,
      cancelledAt: nowMs,
      history: [...(pass.history || []), { at: nowMs, action: 'cancelled', actor: String(actor).slice(0, 40), reason: String(reason).slice(0, 120) }].slice(-30),
    },
  };
}

/** 年間枠の配信日（開始日以降の指定曜日・期限まで・最大 races 回） */
export function weeklyDates(pass) {
  if (pass.schedule !== 'weekly' || !DATE_RE.test(String(pass.startDate || ''))) return [];
  const out = [];
  let t = Date.parse(`${pass.startDate}T12:00:00+09:00`);
  while (new Date(t).getUTCDay() !== pass.weekday) t += DAY_MS;
  while (out.length < pass.races) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d > pass.validUntil) break;
    out.push(d);
    t += 7 * DAY_MS;
  }
  return out;
}

/** 使える総鞍数（補償鞍を含む） */
export function totalCredits(pass) {
  return pass.races + (pass.compensationGranted ? Number(pass.compensation) || 0 : 0);
}

/** この枠で提供する日（年間=曜日から自動 / それ以外=予約した日） */
export function passDeliveryDates(pass) {
  if (pass.status !== PASS_STATUS.ACTIVE) return [];
  return pass.schedule === 'weekly' ? weeklyDates(pass) : [...(pass.reservations || [])].sort();
}

/**
 * 日付の予約（好きな日に使う枠）。翌日以降・有効期限内・残りがある・同じ日を二重に使わない。
 * 当日分は朝に自動生成されるため、当日の予約は受け付けない（生成済みの買い目を後から渡さない）。
 */
export function planReserve({ pass, passes, orders, recordId, saleDate, nowMs }) {
  if (!pass || pass.recordId !== recordId) return { ok: false, code: 'pass_not_found' };
  if (pass.status !== PASS_STATUS.ACTIVE) return { ok: false, code: 'not_active' };
  if (pass.schedule !== 'choose') return { ok: false, code: 'weekly_pass' };
  if (!DATE_RE.test(String(saleDate || ''))) return { ok: false, code: 'invalid_date' };
  const tomorrow = jstDate(nowMs, 1);
  if (saleDate < tomorrow) return { ok: false, code: 'too_late' };
  if (saleDate > pass.validUntil) return { ok: false, code: 'after_expiry' };
  const reserved = pass.reservations || [];
  if (reserved.length >= totalCredits(pass)) return { ok: false, code: 'no_credits' };
  const taken = new Set(memberDeliveryDates({ orders, passes, recordId }));
  if (taken.has(saleDate)) return { ok: false, code: 'already_reserved' };
  return {
    ok: true,
    pass: {
      ...pass,
      reservations: [...reserved, saleDate].sort(),
      history: [...(pass.history || []), { at: nowMs, action: 'reserved', date: saleDate }].slice(-60),
    },
  };
}

/** 本人に提供する全日付（単発注文＋枠） */
export function memberDeliveryDates({ orders, passes, recordId }) {
  const dates = new Set();
  for (const o of orders || []) {
    if (o && o.recordId === recordId && o.status === 'confirmed' && o.canary !== true && DATE_RE.test(String(o.saleDate || ''))) dates.add(o.saleDate);
  }
  for (const p of passes || []) if (p && p.recordId === recordId) for (const d of passDeliveryDates(p)) dates.add(d);
  return [...dates].sort();
}

/** マイページ用: 本人の枠の状態（金額は確定値をそのまま返す） */
export function describePassesForMember(passes, { recordId, nowMs }) {
  const today = jstDate(nowMs);
  return (passes || []).filter((p) => p.recordId === recordId && p.status !== PASS_STATUS.CANCELLED)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => {
      const dates = passDeliveryDates(p);
      const used = dates.filter((d) => d < today).length;
      return {
        passId: p.passId,
        plan: p.plan,
        planName: p.planName,
        status: p.status,
        amount: p.amount,
        installments: p.installments,
        firstPayment: p.firstPayment,
        creditAmount: p.creditAmount,
        schedule: p.schedule,
        weekday: p.weekday,
        startDate: p.startDate || null,
        validUntil: p.validUntil || null,
        totalCredits: p.status === PASS_STATUS.ACTIVE ? totalCredits(p) : p.races,
        remaining: p.status === PASS_STATUS.ACTIVE ? Math.max(0, totalCredits(p) - (p.schedule === 'weekly' ? used : dates.length)) : p.races,
        upcoming: dates.filter((d) => d >= today).slice(0, 12),
        compensation: p.compensation,
        compensationGranted: p.compensationGranted === true,
      };
    });
}

export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 申込を受けたときの管理者宛通知（金額は確定値） */
export function buildAdminNotice({ pass, fullName, email }) {
  const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
  const lines = [
    'Premium Plus 枠確保の申込がありました（入金待ち）。',
    '',
    `お名前: ${fullName || '-'}`,
    `メール: ${email || '-'}`,
    `プラン: ${pass.planName}（${pass.races}鞍）`,
    `請求額: ${yen(pass.amount)}${pass.creditAmount ? `（初回購入 ${yen(pass.creditAmount)} を充当済み）` : ''}`,
    pass.installments > 1 ? `お支払い: ${pass.installments}回払い（初回 ${yen(pass.firstPayment)}）` : 'お支払い: 一括',
    pass.schedule === 'weekly' ? `配信曜日: 毎週${WEEKDAY_JA[pass.weekday]}曜日` : '配信日: 会員がマイページで選択',
    '',
    '入金を確認したら、管理画面 /admin/premium-plus-eligibility の「枠確保（入金確認）」で確定してください。',
  ];
  return { subject: `【Premium Plus】枠確保の申込: ${pass.planName} ${yen(pass.amount)}`, text: lines.join('\n') };
}

/** 有効化したときのお礼メール（買い目は書かない） */
export function buildPassThanksEmail({ pass, fullName, siteBase }) {
  const base = String(siteBase || 'https://analytics.keiba.link').replace(/\/$/, '');
  const url = `${base}/dashboard/`;
  const greeting = String(fullName || '').trim() ? `${String(fullName).trim()} 様` : 'お客様';
  const how = pass.schedule === 'weekly'
    ? `毎週${WEEKDAY_JA[pass.weekday]}曜日に1鞍ずつ、マイページでお届けします。`
    : 'マイページで、ご希望の日を選んでご利用ください（前日までにお選びください）。';
  const text = [
    greeting,
    '',
    `このたびは Premium Plus「${pass.planName}」をお申し込みいただき、誠にありがとうございます。`,
    'ご入金を確認し、枠を確保いたしました。',
    '',
    `■ 確保した枠: ${pass.races}鞍`,
    `■ ご利用期限: ${pass.validUntil}`,
    `■ ご利用方法: ${how}`,
    '■ 公開時刻: 各レースの発走予定時刻の10分前（マイページ）',
    '',
    '今後、通常価格に戻ったあとも、確保した枠はこの価格のままご利用いただけます。',
    '',
    `マイページ: ${url}`,
    '',
    'ご不明な点は、このメールにご返信ください。',
    '',
    'KEIBA Analytics',
  ].join('\n');
  return { subject: `【KEIBA Analytics】Premium Plus「${pass.planName}」の枠を確保しました`, text };
}

/** 振込先（`premium-plus-v2.astro` の振込先と同じ） */
export const PP_BANK = Object.freeze({
  bank: 'PayPay銀行', branch: '本店営業部', type: '普通', number: '8307337', holder: 'ｳｴﾌﾞｹｲﾊﾞ',
});
