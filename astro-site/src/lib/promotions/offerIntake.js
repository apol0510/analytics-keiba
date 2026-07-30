/**
 * offerIntake.js — 割引オファーの申込（`/offer/?t=<token>`）で使う判定の単一源（純粋・I/O なし）
 *
 * ── この phase がやること ────────────────────────────────────────
 * 管理画面が発行した割引 offer のトークン付き URL から、その顧客が
 * **通常価格ではなく offer の価格で** 銀行振込の申込を出せるようにする。
 * 昇格そのものは触らない: 既存の `PaymentConfirmed` → `confirm-bank-payment` が唯一の経路。
 *
 * ── 価格とプランは「クライアントが送ってきた値」を絶対に信じない ─────────
 * 既存の `/pricing/` 経路は `productName` / `transferAmount` をフォームから受け取り、
 * そこから planName / planType を導いている（同じ画面の JS が入れているため実害は無い）。
 * offer 経路は**割引価格**を扱うので、同じ作りにすると DevTools で
 * 「¥1,000 で Premium 買い切り」を申告できてしまう。
 * そこで offer 経路では:
 *   - `RequestedPlan` / `RequestedPlanType` は **offer 台帳の行**から取る
 *   - `RequestedAmount` は **offer の offerPrice**（=請求すべき金額）を書く
 *   - フォームの申告金額は `reportedAmount` として**メールにだけ**出し、差異は警告にする
 * 申告金額で Airtable を上書きしないので、金額を偽っても MK が見る「請求額」は動かない。
 *
 * ── 権限フィールドは 1 バイトも書かない ───────────────────────────
 * 書くのは `buildApplicationFields()`（`payments/bankPaymentFlow.js`）が返す申込フィールドだけ。
 * `プラン` / `有効期限` / `Status='active'` / `PaymentConfirmed=true` / `PaidAt` は書かない。
 * guard テスト（`offerIntakeFunction.guard.test.mjs`）が Function 実装を grep して固定する。
 */

import { PLAN_TYPES } from '../payments/bankPaymentFlow.js';
import { normalizePlan } from '../auth/planNormalization.js';
import { BILLING_TERM } from './promotionOfferCatalog.js';

/** offer 経路の申込に付ける Source ラベル（管理者メールと台帳 Notes 用） */
export const OFFER_INTAKE_SOURCE = 'comeback-offer';

/**
 * `RequestedPlan` に書いてよい値。
 * `confirm-bank-payment` は `RequestedPlan` を **そのまま** `プラン`（Single select）へ書くため、
 * 語彙を勝手に増やすと Airtable 側で未知の選択肢が生える。offer 経路は Premium のみ。
 */
export const REQUESTED_PLAN_ALLOW = Object.freeze(['Premium']);

/** 申告できる振込金額の上限（誤入力・悪意ある巨大値の弾き） */
export const MAX_REPORTED_AMOUNT = 1_000_000;

/** 振込完了日として遡れる日数（これより古い日付は入力ミスとして弾く） */
export const MAX_TRANSFER_AGE_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の暦日（YYYY-MM-DD）。UTC 基準の `toISOString()` 直読みは JST 0〜9 時に 1 日ズレる */
export function jstDay(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Airtable の filterByFormula（OfferKey 完全一致）。形式が不正なら null（DB を引かせない） */
export function buildOfferKeyFormula(offerKey) {
  const key = String(offerKey || '').trim();
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  // 32hex なのでエスケープの必要は無いが、形式検証を通った値だけを埋め込む
  return `{OfferKey}='${key}'`;
}

/**
 * 表示用にメールアドレスを伏せる（`ap****@ya****.jp`）。
 * トークンを拾った第三者に完全なアドレスを渡さないため。案内された本人は
 * 「どのアドレスで申し込めばよいか」を思い出せる程度の情報だけ受け取る。
 */
export function maskEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  const dot = domain.indexOf('.');
  const dHead = (dot > 0 ? domain.slice(0, Math.min(2, dot)) : domain.slice(0, 2));
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${dHead}${'*'.repeat(2)}${tld}`;
}

/** PlanType（Airtable 語彙）→ 画面表示の期間ラベル */
export function termLabelFromPlanType(planType) {
  const t = String(planType || '').trim().toLowerCase();
  if (t === 'lifetime') return '買い切り（永久アクセス）';
  if (t === 'annual') return '年額（1年間）';
  if (t === 'monthly') return '30日間';
  return '';
}

/** BILLING_TERM → PlanType（台帳に PlanType が無い旧行の救済用） */
export function planTypeFromTerm(term) {
  const t = String(term || '').trim().toLowerCase();
  if (t === BILLING_TERM.LIFETIME) return 'Lifetime';
  if (t === BILLING_TERM.ANNUAL) return 'Annual';
  if (t === BILLING_TERM.MONTHLY) return 'Monthly';
  return null;
}

/**
 * offer 台帳の `PlanName`（'Premium Annual' 等）→ `RequestedPlan`（'Premium'）。
 * `confirm-bank-payment` は `RequestedPlan` を verbatim で `プラン` に書くので、
 * 期間を含む名前をそのまま渡してはいけない。判定できなければ null（fail closed）。
 */
export function toRequestedPlan(planName) {
  const raw = String(planName || '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s*-\s*Campaign\s*$/i, '')
    .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|年額|30日)$/i, '')
    .trim();
  const hit = REQUESTED_PLAN_ALLOW.find((p) => p.toLowerCase() === stripped.toLowerCase());
  if (!hit) return null;
  // 既存の正規化表でも解釈できることを確認する（Airtable 側の語彙とズレたら fail closed）
  return normalizePlan(hit) ? hit : null;
}

/**
 * 検証済み offer（`verifyOfferToken()` の `.offer`）→ 申込ページに出す情報。
 * **メールアドレスは伏せ字**、トークン / TokenHash / recordId は含めない。
 *
 * @param {{ offer: object, nowMs: number }} input
 * @returns {object|null}
 */
export function buildOfferPresentation({ offer, nowMs }) {
  if (!offer || !Number.isFinite(nowMs)) return null;
  const planType = String(offer.planType || '').trim();
  const regular = Number(offer.regularPrice) || 0;
  const price = Number(offer.offerPrice) || 0;
  const discountAmount = regular > price ? regular - price : 0;
  const discountPercent = regular > 0 ? Math.round((discountAmount / regular) * 100) : 0;
  const expiresMs = Number(offer.expiresMs);
  const daysLeft = Number.isFinite(expiresMs)
    ? Math.max(0, Math.ceil((expiresMs - nowMs) / DAY_MS)) : null;

  return {
    offerId: String(offer.offerId || ''),
    planLabel: 'Premium プラン',
    termLabel: termLabelFromPlanType(planType),
    planType,
    regularPrice: regular,
    offerPrice: price,
    discountAmount,
    discountPercent,
    expiresOn: Number.isFinite(expiresMs) ? jstDay(expiresMs) : '',
    daysLeft,
    maskedEmail: maskEmail(offer.email),
    /** 管理者メール・報告メールに出す商品名（金額を含む文字列） */
    productName: buildOfferProductName({ planType, offerPrice: price }),
  };
}

/** offer 経路の商品名（メール表示専用。ここから planName を逆算しない） */
export function buildOfferProductName({ planType, offerPrice }) {
  const term = termLabelFromPlanType(planType) || String(planType || '');
  const yen = Number.isFinite(Number(offerPrice))
    ? `¥${Number(offerPrice).toLocaleString('en-US')}` : '';
  return `Premium ${term} カムバック特別価格 (${yen})`;
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

/**
 * 申込フォーム + 検証済み offer → Airtable / メールに渡す確定値。
 *
 * フォームから採るのは「誰が・いつ・いくら振り込んだと言っているか」だけ。
 * **プラン・請求金額は offer から採る**（クライアント値は請求額に影響しない）。
 *
 * @param {{ offer: object, form: object, nowMs: number }} input
 * @returns {{ ok: true, application: object, warnings: string[] }|{ ok: false, reason: string, message: string }}
 */
export function resolveOfferApplication({ offer, form, nowMs }) {
  if (!offer || typeof offer !== 'object') return fail('no_offer', 'オファーが特定できませんでした。');
  if (!form || typeof form !== 'object') return fail('no_form', '入力内容が受け取れませんでした。');
  if (!Number.isFinite(nowMs)) return fail('invalid_now', 'サーバー時刻の取得に失敗しました。');

  // ── offer 側の健全性（fail closed）─────────────────────────────
  const requestedPlan = toRequestedPlan(offer.planName);
  if (!requestedPlan) return fail('invalid_offer_plan', 'オファーのプラン設定が不正です。サポートへご連絡ください。');

  const planType = String(offer.planType || '').trim() || planTypeFromTerm(offer.term) || '';
  if (!PLAN_TYPES.includes(planType)) {
    return fail('invalid_offer_plan_type', 'オファーの期間設定が不正です。サポートへご連絡ください。');
  }

  const offerPrice = Number(offer.offerPrice);
  if (!Number.isInteger(offerPrice) || offerPrice <= 0) {
    return fail('invalid_offer_price', 'オファーの金額設定が不正です。サポートへご連絡ください。');
  }

  // ── フォーム側の検証 ─────────────────────────────────────────
  const fullName = String(form.fullName || '').trim();
  if (!fullName) return fail('missing_full_name', 'お名前を入力してください。');
  if (fullName.length > 100) return fail('full_name_too_long', 'お名前が長すぎます。');

  const email = String(form.email || '').trim().toLowerCase();
  if (!email) return fail('missing_email', 'メールアドレスを入力してください。');
  if (email !== String(offer.email || '').trim().toLowerCase()) {
    return fail('email_mismatch', 'ご案内メールを受け取ったメールアドレスをご入力ください。');
  }

  if (form.paymentCompletedConfirm !== true) {
    return fail('payment_not_confirmed', '銀行振込完了後にチェックを入れてから送信してください。');
  }

  const transferDate = String(form.transferDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transferDate)) {
    return fail('invalid_transfer_date', '振込完了日の形式が正しくありません（YYYY-MM-DD）。');
  }
  const today = jstDay(nowMs);
  if (transferDate > today) {
    return fail('future_transfer_date', '振込完了日に未来の日付は指定できません。実際に振込を完了してからご送信ください。');
  }
  if (transferDate < jstDay(nowMs - MAX_TRANSFER_AGE_DAYS * DAY_MS)) {
    return fail('transfer_date_too_old', `振込完了日が古すぎます（${MAX_TRANSFER_AGE_DAYS}日以内）。日付をご確認ください。`);
  }

  const transferName = String(form.transferName || '').trim() || fullName;
  if (transferName.length > 100) return fail('transfer_name_too_long', '振込名義人が長すぎます。');

  const reportedAmount = Number.parseInt(String(form.transferAmount ?? '').trim(), 10);
  if (!Number.isInteger(reportedAmount) || reportedAmount <= 0) {
    return fail('invalid_amount', '振込金額を正しく入力してください。');
  }
  if (reportedAmount > MAX_REPORTED_AMOUNT) return fail('amount_too_large', '振込金額が大きすぎます。');

  const remarks = String(form.remarks || '').trim().slice(0, 1000);

  // ── 金額の差異は「拒否」せず「警告」にする ────────────────────────
  // 既に振り込んだ人を締め出さない。権限は MK の入金確認まで付かないので、
  // ここで弾くより管理者メールに差異を明示するほうが安全。
  const warnings = [];
  if (reportedAmount !== offerPrice) {
    warnings.push(reportedAmount < offerPrice ? 'reported_amount_less_than_offer' : 'reported_amount_more_than_offer');
  }
  const issuedOn = Number.isFinite(Number(offer.startsMs)) ? jstDay(Number(offer.startsMs)) : '';
  if (issuedOn && transferDate < issuedOn) warnings.push('transfer_before_offer_issued');

  return {
    ok: true,
    warnings,
    application: {
      // Airtable Customers へ渡す確定値（すべて offer 由来）
      requestedPlan,
      requestedPlanType: planType,
      /** 請求すべき金額。フォームの申告値では**ない** */
      requestedAmount: offerPrice,

      // 申込者の申告内容（メール表示・MK の照合用）
      fullName,
      email,
      transferDate,
      transferName,
      reportedAmount,
      remarks,

      // 台帳・メールの識別情報
      offerKey: String(offer.offerKey || ''),
      offerId: String(offer.offerId || ''),
      customerRecordId: String(offer.customerRecordId || ''),
      productName: buildOfferProductName({ planType, offerPrice }),
      source: OFFER_INTAKE_SOURCE,
    },
  };
}

/** 警告コード → 管理者メールに出す日本語 */
export const OFFER_WARNING_LABEL = Object.freeze({
  reported_amount_less_than_offer: '申告金額がオファー価格より少ない（入金額を必ず確認）',
  reported_amount_more_than_offer: '申告金額がオファー価格より多い',
  transfer_before_offer_issued: '振込完了日がオファー発行日より前',
});
