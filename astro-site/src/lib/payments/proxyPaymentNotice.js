/**
 * proxyPaymentNotice.js — 運営者による「代理入金連絡」の判定・組み立て（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-16 / MK 確定）
 *
 * > soken1122@gmail.com から 44,800 円の入金があり、送信フォームからの入金連絡は
 * > ないので代わりに送信してあげようと思ったが、ログインリンクやキャンペーン価格
 * > などの問題もあり諦めた。airtable も値を変更するのが手間なので諦めた。不便だ。
 *
 * 銀行入金は確認できているのに、顧客本人が入金連絡フォームを送れていない。
 * 運営者が代わりに送ろうとしても、
 *
 *   1. 申込アドレスは**ログイン中のセッションに固定**されている（`applicationIdentity.js`）
 *      ため、運営者が代理送信すると運営者のアドレスで記録されてしまう
 *   2. 会員限定のキャンペーン価格は**その会員のティアにしか画面へ出ない**ので、
 *      運営者の画面からは正しい金額で申し込めない
 *   3. Airtable を手で直すには `プラン` / `PlanType` / `Status` / `有効期限` / `PaidAt` /
 *      `PaymentEmailSent` / 退会フラグ を人間が揃える必要があり、間違えれば権限事故になる
 *
 * この 3 つが重なって、**入金済みの顧客を昇格させる現実的な手段が無い**状態だった。
 *
 * ## 何をする機能か（範囲を誤解しないこと）
 *
 * **顧客としてログインしてなりすます機能ではない。**
 * 「顧客本人が入金連絡フォームを送った」のと**同じ申込情報**（`Requested*`）を、
 * 運営者が顧客レコードへ登録するだけの運営操作である。
 *
 * - 有料権限（`プラン` / `PlanType` / `Status='active'` / `有効期限`）は**一切書かない**
 * - 昇格は従来どおり `PaymentConfirmed` を起点にした既存の単一経路だけが行う
 * - 顧客宛のメールは**送らない**（利用開始メールは昇格側が出す）
 *
 * つまりこの機能が短縮するのは「申込が存在しない」ところまでで、
 * そこから先の昇格・メール・有効期限計算は**既存フローがそのまま動く**。
 *
 * ## 使ってよい場面（応急・例外運用）
 *
 * 高齢・PC/スマホ操作が苦手・ログインできない等の理由で、顧客本人に通常の
 * 入金連絡操作を求めることが現実的でない場合に限る。**通常の申込経路ではない。**
 *
 * ## 実入金額の扱い
 *
 * 掲載価格と着金額がずれることがある（例: 掲載 44,820 円 / 着金 44,800 円）。
 * **着金額を掲載価格へ捏造しない。** `RequestedAmount` は通常フォームでも
 * 「その申込の金額」（キャンペーン・クーポンが無ければ顧客申告の振込額そのもの）
 * を入れているので、代理登録でも**運営者が確認した実入金額をそのまま入れる**。
 *
 * ⚠️ ただし `RequestedAmount` は**入金確認時にクリアされる**（`buildConfirmationFields`）。
 *    昇格後も実入金額を残すには Airtable に新しい列が要る。列は本番 schema 変更なので
 *    作らず、`PROXY_PAYMENT_NOTICE_FIELDS_READY=1` が立っているときだけ書く
 *    （`SaleTargetDate` と同じ env gate の作法）。列が無い本番では 422 にならない。
 */

import { derivePlanFromProductName } from './productName.js';
import { normalizePlan } from '../auth/planNormalization.js';
import { buildApplicationFields, isActiveStatus, jstDateString } from './bankPaymentFlow.js';

/** 代理登録であることを後から見分けるための Airtable 列（**本番未作成**・env で gate）。 */
export const PROXY_NOTICE_FIELDS = Object.freeze({
  /** 'admin_proxy'（本人送信は書かれないので、存在＝代理登録） */
  SOURCE: 'ApplicationSource',
  /** 代理登録した運営者 */
  BY: 'ApplicationProxyBy',
  /** 代理登録した日時（ISO） */
  AT: 'ApplicationProxyAt',
  /** 運営者が確認した実入金額（`RequestedAmount` と違い昇格後も残る） */
  RECEIVED_AMOUNT: 'ReceivedAmount',
  /** 代理登録した理由（監査） */
  REASON: 'ApplicationProxyReason',
});

/** 代理登録であることを表す `ApplicationSource` の値。 */
export const PROXY_SOURCE_VALUE = 'admin_proxy';

/**
 * 監査列が本番に作成済みか。**未設定なら書かない**（既存挙動のまま・422 を出さない）。
 * @param {Record<string, unknown>} [env]
 */
export function isProxyAuditFieldsEnabled(env = {}) {
  return String(env.PROXY_PAYMENT_NOTICE_FIELDS_READY || '') === '1';
}

/** 拒否理由。**画面はコードではなく `message` を出す**。 */
export const PROXY_REJECT = Object.freeze({
  /** 監査のため操作者は必須 */
  OPERATOR_REQUIRED: 'operator_required',
  /** 顧客メールアドレスが空 / 形式が不正 */
  EMAIL_REQUIRED: 'email_required',
  /** Customers に該当レコードが無い（**代理登録では新規作成しない**） */
  CUSTOMER_NOT_FOUND: 'customer_not_found',
  /** 商品名からプランを判定できない */
  UNKNOWN_PLAN: 'unknown_plan',
  /** Premium Plus は対象外（対象日・クーポン・販売停止の判定を迂回させない） */
  PREMIUM_PLUS_UNSUPPORTED: 'premium_plus_unsupported',
  /** 実入金額が数値でない / 範囲外 */
  INVALID_AMOUNT: 'invalid_amount',
  /** 入金日の形式が不正 */
  INVALID_PAID_DATE: 'invalid_paid_date',
  /** 入金日が未来（着金前の登録を作らない） */
  FUTURE_PAID_DATE: 'future_paid_date',
  /** 未確認の申込が既にある（二重登録の防止） */
  ALREADY_PENDING: 'already_pending',
});

/** 画面へ出す文言（**呼び出し側で書き分けない**）。 */
export const PROXY_REJECT_MESSAGE = Object.freeze({
  [PROXY_REJECT.OPERATOR_REQUIRED]: '操作者名を入力してください（監査のため必須です）。',
  [PROXY_REJECT.EMAIL_REQUIRED]: '顧客のメールアドレスを正しく入力してください。',
  [PROXY_REJECT.CUSTOMER_NOT_FOUND]:
    'このメールアドレスの会員が見つかりません。代理登録では会員レコードを新規作成しません。'
    + '先に会員登録の有無をご確認ください。',
  [PROXY_REJECT.UNKNOWN_PLAN]: 'プランを判定できませんでした。プランと契約種別を選び直してください。',
  [PROXY_REJECT.PREMIUM_PLUS_UNSUPPORTED]:
    'Premium Plus は代理登録の対象外です（対象日・クーポン・販売停止の判定を迂回できないため）。',
  [PROXY_REJECT.INVALID_AMOUNT]: '実入金額を正しい金額で入力してください。',
  [PROXY_REJECT.INVALID_PAID_DATE]: '入金日を YYYY-MM-DD で入力してください。',
  [PROXY_REJECT.FUTURE_PAID_DATE]: '入金日に未来の日付は指定できません（着金後に登録してください）。',
  [PROXY_REJECT.ALREADY_PENDING]:
    '未確認の申込が既にあります。先に Airtable で PaymentConfirmed を確認するか、'
    + '「既存の申込を置き換える」を明示してください。',
});

/** 実入金額の許容範囲（円）。桁の打ち間違いを通さない。 */
export const MIN_RECEIVED_AMOUNT = 1;
export const MAX_RECEIVED_AMOUNT = 10_000_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reject(reason) {
  return { ok: false, reason, message: PROXY_REJECT_MESSAGE[reason] || '登録できませんでした。' };
}

/** Airtable の検索・比較と同じ正規化（trim + lowercase）。 */
export function normalizeProxyEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 代理入金連絡を受け付けてよいかを判定する（**Airtable を 1 バイトも書かない地点で行う**）。
 *
 * @param {object} input
 * @param {unknown} input.operator        操作者（監査・必須）
 * @param {unknown} input.email           顧客のメールアドレス（**運営者が明示指定する**）
 * @param {unknown} input.productName     画面の商品名（通常フォームと同じ語彙）
 * @param {unknown} input.receivedAmount  運営者が確認した実入金額（円）
 * @param {unknown} input.paidDate        入金日 'YYYY-MM-DD'
 * @param {unknown} [input.reason]        代理登録の理由（監査。任意）
 * @param {object|null} input.record      Customers の既存レコード `{ id, fields }`（無ければ null）
 * @param {boolean} [input.replaceExisting] 未確認の申込を承知で置き換えるか
 * @param {number} input.nowMs            現在時刻（未来日の判定に使う）
 * @returns {{ok:false, reason:string, message:string}
 *          |{ok:true, recordId:string, email:string, fullName:string,
 *             planName:string, planType:string, amount:number,
 *             paidDate:string, operator:string, reason:string,
 *             currentStatus:string|null, replacedPending:boolean}}
 */
export function decideProxyPaymentNotice({
  operator, email, productName, receivedAmount, paidDate, reason,
  record, replaceExisting = false, nowMs,
}) {
  const op = typeof operator === 'string' ? operator.trim() : '';
  if (!op) return reject(PROXY_REJECT.OPERATOR_REQUIRED);

  const mail = normalizeProxyEmail(email);
  if (!mail || !EMAIL_RE.test(mail)) return reject(PROXY_REJECT.EMAIL_REQUIRED);

  // **新規作成はしない。** 打ち間違いで空の顧客レコードを生やさないための fail closed。
  if (!record || !record.id) return reject(PROXY_REJECT.CUSTOMER_NOT_FOUND);

  const name = String(productName ?? '');
  // Premium Plus は対象日・クーポン・会員別の販売停止をサーバーで確定させる商品。
  // 代理登録でそれらを迂回させない（判定を二重に持たない）。
  if (/premium\s*plus/i.test(name)) return reject(PROXY_REJECT.PREMIUM_PLUS_UNSUPPORTED);

  // 商品名 → プランの読み替えは**共有の単一源**を使う（画面と食い違わせない）
  const derived = derivePlanFromProductName(name);
  const canonical = normalizePlan(derived.planName);
  if (!canonical || canonical === 'free') return reject(PROXY_REJECT.UNKNOWN_PLAN);

  const amount = typeof receivedAmount === 'number'
    ? receivedAmount
    : Number.parseInt(String(receivedAmount ?? '').replace(/[^\d]/g, ''), 10);
  if (!Number.isInteger(amount) || amount < MIN_RECEIVED_AMOUNT || amount > MAX_RECEIVED_AMOUNT) {
    return reject(PROXY_REJECT.INVALID_AMOUNT);
  }

  const paid = String(paidDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paid)) return reject(PROXY_REJECT.INVALID_PAID_DATE);
  // 通常フォームと同じ規則。着金前の申込を作らない（JST の暦日で比較）
  if (paid > jstDateString(new Date(nowMs))) return reject(PROXY_REJECT.FUTURE_PAID_DATE);

  const fields = record.fields || {};
  // 未確認の申込が残っている状態で上書きすると、
  // 「どちらの申込に対して PaymentConfirmed を押したのか」が分からなくなる。
  const outstanding = String(fields.RequestedPlan || '').trim() !== '';
  if (outstanding && !replaceExisting) return reject(PROXY_REJECT.ALREADY_PENDING);

  return {
    ok: true,
    recordId: record.id,
    email: mail,
    // 氏名は既存値を優先する（代理登録で氏名を上書きして壊さない）
    fullName: String(fields['氏名'] || '').trim(),
    planName: derived.planName,
    planType: derived.planType,
    amount,
    paidDate: paid,
    operator: op,
    reason: typeof reason === 'string' ? reason.trim() : '',
    currentStatus: fields.Status ? String(fields.Status) : null,
    replacedPending: outstanding,
  };
}

/**
 * 代理登録で Airtable へ書くフィールド。
 *
 * **昇格に関わるフィールドは 1 つも含まない。** 通常フォームと同じ `buildApplicationFields`
 * の戻り値に、監査列（env gate 付き）を足すだけ。
 *
 * @param {object} input
 * @param {ReturnType<typeof decideProxyPaymentNotice>} input.decision  `ok:true` のもの
 * @param {boolean} [input.auditFieldsReady]  監査列が本番に作成済みか
 * @param {number} input.nowMs
 * @returns {Record<string, unknown>}
 */
export function buildProxyNoticeFields({ decision, auditFieldsReady = false, nowMs }) {
  if (!decision || decision.ok !== true) {
    throw new Error('buildProxyNoticeFields: ok:true の判定結果を渡すこと');
  }

  const fields = buildApplicationFields({
    currentStatus: decision.currentStatus,
    fullName: decision.fullName,
    planName: decision.planName,
    planType: decision.planType,
    amount: decision.amount,
    // 既存レコードへの更新のみ。**新規作成の経路は使わない**
    isNewRecord: false,
  });

  // 氏名が空の会員で `氏名: ''` を書き戻さない（既存値を消さない・増やさない）
  if (!decision.fullName) delete fields['氏名'];

  if (auditFieldsReady) {
    fields[PROXY_NOTICE_FIELDS.SOURCE] = PROXY_SOURCE_VALUE;
    fields[PROXY_NOTICE_FIELDS.BY] = decision.operator;
    fields[PROXY_NOTICE_FIELDS.AT] = new Date(nowMs).toISOString();
    fields[PROXY_NOTICE_FIELDS.RECEIVED_AMOUNT] = decision.amount;
    if (decision.reason) fields[PROXY_NOTICE_FIELDS.REASON] = decision.reason;
  }

  return fields;
}

/**
 * 監査列が無い本番でも、代理登録の事実を**必ず**残すための構造化ログ行。
 * Function のログへ 1 行出す（メールは送らない）。
 * @param {ReturnType<typeof decideProxyPaymentNotice>} decision
 */
export function describeProxyNoticeForLog(decision) {
  return {
    event: 'admin_proxy_payment_notice',
    recordId: decision.recordId,
    email: decision.email,
    plan: decision.planName,
    planType: decision.planType,
    receivedAmount: decision.amount,
    paidDate: decision.paidDate,
    operator: decision.operator,
    reason: decision.reason || null,
    replacedPending: decision.replacedPending,
  };
}

/** `isActiveStatus` を再輸出（呼び出し側が自前で active 判定を書かないため）。 */
export { isActiveStatus };
