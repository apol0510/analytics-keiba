/**
 * paymentDisplayNames.js — 決済関連で顧客に見える名称の**単一源**（決済会社をまたいで共通・純粋）
 *
 * 2026-10-11 MK 確定: AK の決済関連名称から競馬関連の語を排除する。基本名称は「Analytics Premium」。
 * 2026-10-15 MK 確定（追記 7）: 禁止語を「中央・南関・JRA・NANKAN・中央競馬・地方競馬・南関東・その他競馬や馬券を直接示す表現」へ広げ、
 *   PayPal の月額プラン名を許可リスト（PAYPAL_PLAN_NAMES）の 3 つに固定する。Stripe は停止・不使用（新しい名前を送らない）。
 *
 * 対象（決済会社が顧客に表示する・決済の識別に使う名称）:
 *   決済アカウントの表示名 / Product・Price の表示名 / カード明細名 / Checkout / 請求書・領収書 /
 *   カスタマーポータルの見出し / 決済会社（Stripe・Paddle・PayPal）が送る顧客向け決済メールの商品名・事業者表示 /
 *   AK の申込・入金メールに載せる商品名（申込の商品名）
 *
 * 決済会社へ渡す説明文・メタデータ（custom_id 等）・戻り先 URL・Webhook URL も対象（2026-10-15 MK 確定）。
 *   PayPal の戻り先・Webhook は中立ホスト checkout.tirol.link を通す（paypalCore.paypalReturnUrls）。
 *
 * 対象外（変えない）: AK 自身の画面（サイト名・ドメイン・会場区分「全会場・中央版・南関版」・サービス内容の説明・法定表示）。
 *   決済会社の審査で求められる事業内容の申告は事実どおり（名称の制約と事業の説明は区別する）。
 *
 * 新しい決済会社（Paddle / PayPal）の商品名・表示名も必ずここを通す（assertPaymentDisplayName）。
 */

/** 基本名称 */
export const PAYMENT_BASE_NAME = 'Analytics Premium';

/**
 * 決済関連名称に使ってはいけない語。比較は NFKC 正規化 + 大文字化で行う（KEIBA / keiba / Keiba / ｋｅｉｂａ を同一視）。
 * ⚠️ 語を足すときは既存の商品名・明細表記がすべて通ることをテストで確かめる。
 */
export const PAYMENT_BANNED_WORDS = Object.freeze([
  // 2026-10-11
  'KEIBA', '競馬', '馬券',
  // 2026-10-15 MK 確定（会場名・団体名）
  '中央', '南関', 'JRA', 'NANKAN', '中央競馬', '地方競馬', '南関東',
  // 2026-10-15 MK 確定「その他、競馬や馬券を直接示す関連表現」（Claude 案の具体化。checkout.tirol.link の公開文言の禁止語と同じ方向）
  'HORSE', 'RACING', 'JOCKEY', 'BETTING', 'GAMBL', '騎手', '競走馬', '馬単', '馬連', '三連単', '三連複', '大井', '船橋', '川崎', '浦和',
]);

/**
 * PayPal の月額プラン名（Plan の name）の許可リスト（2026-10-15 MK 確定・大文字小文字・スペースまで完全一致）。
 * キーは内部の商品 ID（stripePlans.STRIPE_PLANS の id・VenueAccess の対応は変えない）。
 * サイト内の商品区分（全会場・中央版・南関版）はこの名前と別に持つ（AK の画面の表示は変えない）。
 * Plan の description も同じ文字列（中立・何も足さない。Claude 案）。
 */
export const PAYPAL_PLAN_NAMES = Object.freeze({
  'premium': 'Analytics Premium',
  'premium-jra': 'Analytics Premium J',
  'premium-nankan': 'Analytics Premium N',
});

const norm = (t) => String(t ?? '').normalize('NFKC').toUpperCase();

/** 禁止語を含むか（純粋） */
export function hasBannedPaymentWord(text) {
  const t = norm(text);
  return PAYMENT_BANNED_WORDS.some((w) => t.includes(norm(w)));
}

/** 決済会社へ送る前の検査。禁止語を含めば例外（fail closed：その名前で商品・表示を作らない） */
export function assertPaymentDisplayName(text, where = 'payment display name') {
  if (hasBannedPaymentWord(text)) {
    const err = new Error(`${where} に決済関連の禁止語が含まれています`);
    err.code = 'banned_payment_word';
    throw err;
  }
  return text;
}

/** PayPal の Plan 名は許可リストの値だけ（それ以外は例外＝その名前で作らない・直さない）*/
export function assertPaypalPlanName(planId, text) {
  const want = PAYPAL_PLAN_NAMES[planId];
  if (!want || text !== want) {
    const err = new Error(`PayPal plan name for ${planId} is not the approved name`);
    err.code = 'unapproved_paypal_plan_name';
    throw err;
  }
  return assertPaymentDisplayName(text, `paypal plan ${planId}`);
}
