/**
 * bankPaymentFlow.js — 銀行振込の「申込」と「入金確認」で Airtable に書く値の単一源。
 * ランタイム非依存・純粋関数（Airtable / fetch / Date.now に依存しない）。
 *
 * 設計の要点:
 * - 申込時点では有料権限に関わるフィールド（プラン / PlanType / 有効期限 / Status=active）を
 *   一切書かない。申込内容は Requested* に退避する。
 * - 昇格は PaymentConfirmed を起点にした confirm-bank-payment.js だけが行う。
 * - 有効期限は「入金確認日（JST）」基準で計算する。手入力させない。
 *
 * 対応する Airtable Customers フィールド（2026-07-10 追加、Meta API で存在確認済み）:
 *   RequestedPlan (singleLineText) / RequestedPlanType (singleLineText)
 *   RequestedAmount (number, precision=0) / PaymentConfirmed (checkbox)
 */

/** Lifetime プランの有効期限（永久アクセス）。 */
export const LIFETIME_EXPIRATION = '2099-12-31';

/** 正規 PlanType。bank-transfer-application.js の判定結果と揃える。 */
export const PLAN_TYPES = Object.freeze(['Monthly', 'Annual', 'Lifetime']);

/**
 * Date を JST の暦日 {y, m, d} に分解する。
 * 既存実装の `toISOString().split('T')[0]` は UTC 基準のため、JST 00:00〜09:00 に
 * 実行すると前日の日付になる。ここでは必ず JST の暦日を使う。
 * @param {Date} date
 */
function toJstParts(date) {
  // UTC+9 へずらしてから UTC ゲッタで読むと JST の暦日が得られる
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(), // 0-indexed
    d: shifted.getUTCDate(),
  };
}

/** {y, m(0-indexed), d} を YYYY-MM-DD へ。日が月末を超える場合は呼び出し側で正規化済みであること。 */
function formatYmd({ y, m, d }) {
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/**
 * JST の暦日で「n ヶ月後」を返す（YYYY-MM-DD）。
 * 月末の繰り上がり（1/31 + 1ヶ月）は月末日に丸める（3/3 ではなく 2/28 or 2/29）。
 * @param {Date} baseDate 基準日時（入金確認日時）
 * @param {number} months 加算する月数（12 で 1 年）
 */
export function addMonthsJst(baseDate, months) {
  const { y, m, d } = toJstParts(baseDate);
  const targetY = y + Math.floor((m + months) / 12);
  const targetM = ((m + months) % 12 + 12) % 12;
  // 対象月の日数（翌月0日 = 当月末日）。UTC で計算しても暦日数は同じ
  const daysInTargetMonth = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return formatYmd({ y: targetY, m: targetM, d: Math.min(d, daysInTargetMonth) });
}

/**
 * JST の暦日で「1年後」を返す（YYYY-MM-DD）。
 * 2/29 + 1年 は 2/28 に丸める（setFullYear の 3/1 繰り上がりを踏襲しない）。
 * @param {Date} baseDate 入金確認日時
 */
export function addOneYearJst(baseDate) {
  return addMonthsJst(baseDate, 12);
}

/**
 * PlanType から有効期限（YYYY-MM-DD）を求める。判定不能なら null（=呼び出し側で fail closed）。
 * @param {string} planType 'Monthly' | 'Annual' | 'Lifetime'
 * @param {Date} confirmedAt 入金確認日時
 * @returns {string|null}
 */
export function computeExpiration(planType, confirmedAt) {
  const t = String(planType || '').trim().toLowerCase();
  if (t === 'lifetime') return LIFETIME_EXPIRATION;
  if (t === 'annual') return addOneYearJst(confirmedAt);
  if (t === 'monthly') return addMonthsJst(confirmedAt, 1);
  return null;
}

/** Airtable の Status が「有料稼働中」か。 */
export function isActiveStatus(status) {
  return String(status || '').trim().toLowerCase() === 'active';
}

/** メール送信がどこで失敗したか。null は成功。 */
export const MAIL_FAILURE_STAGE = Object.freeze({
  NO_API_KEY: 'no_api_key',
  NO_EMAIL: 'no_email',
  PROVIDER_REJECTED: 'provider_rejected',
  PROVIDER_EXCEPTION: 'provider_exception',
});

/**
 * メール送信の結果を判定する（provider 非依存の純粋関数）。
 *
 * `PaymentEmailSent` は **provider が 2xx を返したときだけ** true にする。
 * 旧実装は昇格 PATCH に `PaymentEmailSent: true` を無条件で含めており、
 * 送信を試みる前に true が立つ上に送信失敗も握り潰していたため、
 * 「メールが 1 通も出ていないのに PaymentEmailSent=true」が発生していた。
 *
 * ⚠️ 2xx は「provider が受理した」までしか保証しない。バウンス済みアドレス等で
 * provider が受理後に配信を破棄する場合があり、実受信の保証にはならない。
 *
 * @param {object} input
 * @param {boolean} input.hasApiKey  provider の API key が設定されているか
 * @param {boolean} input.hasEmail   送信先アドレスがあるか
 * @param {number|null} [input.providerStatus] provider の HTTP status（未送信なら null）
 * @param {boolean} [input.threw]    provider 呼び出しが例外で落ちたか
 * @returns {{providerAttempted: boolean, providerAccepted: boolean, failureStage: string|null}}
 */
export function evaluateMailOutcome({ hasApiKey, hasEmail, providerStatus = null, threw = false }) {
  if (!hasApiKey) {
    return { providerAttempted: false, providerAccepted: false, failureStage: MAIL_FAILURE_STAGE.NO_API_KEY };
  }
  if (!hasEmail) {
    return { providerAttempted: false, providerAccepted: false, failureStage: MAIL_FAILURE_STAGE.NO_EMAIL };
  }
  if (threw) {
    return { providerAttempted: true, providerAccepted: false, failureStage: MAIL_FAILURE_STAGE.PROVIDER_EXCEPTION };
  }
  const accepted = Number.isInteger(providerStatus) && providerStatus >= 200 && providerStatus < 300;
  return {
    providerAttempted: true,
    providerAccepted: accepted,
    failureStage: accepted ? null : MAIL_FAILURE_STAGE.PROVIDER_REJECTED,
  };
}

/**
 * 申込フォーム送信時に Airtable へ書くフィールドを組み立てる。
 *
 * **有料権限に関わるフィールドは一切含めない。**
 * - 既存 active 会員: Status を触らない → Light active のまま維持
 * - 新規 / 非 active: Status='pending' → auth-user.js の pending ガードで Free 扱い
 *
 * 退会フラグのリセットは承認時（buildConfirmationFields）へ移した。
 * 未入金の申込だけで退会申請が取り消されるのを防ぐため。
 *
 * @param {object} input
 * @param {string|null} input.currentStatus 既存レコードの Status（新規なら null）
 * @param {string} input.fullName
 * @param {string} input.planName 正規化済みプラン名（例 'Premium'）
 * @param {string} input.planType 'Monthly' | 'Annual' | 'Lifetime'
 * @param {number|null} input.amount 振込金額（円）
 * @param {boolean} [input.isNewRecord] create パスかどうか
 * @param {string} [input.email] create パスで必須
 * @returns {Record<string, unknown>}
 */
export function buildApplicationFields({
  currentStatus,
  fullName,
  planName,
  planType,
  amount,
  isNewRecord = false,
  email,
}) {
  const fields = {
    '氏名': fullName,
    'PaymentMethod': 'Bank Transfer',
    'RequestedPlan': planName,
    'RequestedPlanType': planType,
    // 前回の承認済みフラグを落とす。これで MK は今回の申込に対して 1 回チェックするだけでよい
    'PaymentConfirmed': false,
  };

  if (Number.isFinite(amount)) fields['RequestedAmount'] = amount;

  if (isNewRecord) {
    fields['Email'] = email;
    fields['Source'] = 'nankan-analytics';
    fields['Status'] = 'pending';
    return fields;
  }

  // 既存 active 会員は Status を据え置く（Light active のまま）。
  // それ以外（free / expired / cancelled 等）は pending にして入金確認待ちにする。
  if (!isActiveStatus(currentStatus)) fields['Status'] = 'pending';

  return fields;
}

/**
 * 入金確認（PaymentConfirmed チェック）時に Airtable へ書くフィールドを組み立てる。
 *
 * 冪等性: RequestedPlan が空なら null を返す。呼び出し側は「何もせず管理者へ通知」する。
 * これにより (a) フォーム未経由の申込を推測で昇格させない (b) PaymentConfirmed の
 * 再チェックで有効期限が二重に延長されない（承認時に Requested* をクリアするため）。
 *
 * 二重メール防止: PaymentEmailSent を **この PATCH に含める**。Status pending→active で発火する
 * 既存 Automation (send-payment-confirmation-auto.js) は PaymentEmailSent=true を見て
 * 再送信をスキップする。Status=active と PaymentEmailSent=true が同一 PATCH で原子的に
 * 書かれるため、Automation が「未送信」と誤認して二重送信することがない。
 *
 * ⚠️ emailSent は **provider が実際に受理してから** 呼び出し側が渡すこと。
 * 呼び出し側（confirm-bank-payment.js）はメール送信を PATCH の前に行い、
 * その結果（evaluateMailOutcome().providerAccepted）を emailSent として渡す。
 * 送信に失敗した場合は false のままとなり、`PaymentEmailSent=true` が
 * 「送信できた証拠」として機能する。
 *
 * @param {object} input
 * @param {string|null} input.requestedPlan
 * @param {string|null} input.requestedPlanType
 * @param {Date} input.confirmedAt 入金確認日時（有効期限の基準）
 * @param {boolean} [input.emailSent] provider が確認メールを受理したか（既定 false）
 * @returns {{fields: Record<string, unknown>, expiration: string}|null}
 */
export function buildConfirmationFields({ requestedPlan, requestedPlanType, confirmedAt, emailSent = false }) {
  const plan = String(requestedPlan || '').trim();
  const planType = String(requestedPlanType || '').trim();
  if (!plan || !planType) return null; // fail closed: 推測で昇格しない

  const expiration = computeExpiration(planType, confirmedAt);
  if (!expiration) return null; // PlanType が判定不能 → 昇格しない

  return {
    expiration,
    fields: {
      'プラン': plan,
      'PlanType': planType,
      'Status': 'active',
      '有効期限': expiration,
      'PaidAt': confirmedAt.toISOString(),
      // provider が受理したときだけ true。false のままなら「メールは出ていない」ことを表す。
      'PaymentEmailSent': emailSent === true,
      // 新規プラン購入時に退会フラグをリセット（申込時ではなく入金確認時に行う）
      'WithdrawalRequested': false,
      'WithdrawalDate': null,
      'WithdrawalReason': null,
      // 再チェックによる二重延長を防ぐため申込内容をクリア。
      // PaymentConfirmed は true のまま残す（承認済みの痕跡 / Automation の再発火も起きない）。
      // 次回の申込時に buildApplicationFields が false へ戻す。
      'RequestedPlan': '',
      'RequestedPlanType': '',
      'RequestedAmount': null,
    },
  };
}
