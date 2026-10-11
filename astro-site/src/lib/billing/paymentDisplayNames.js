/**
 * paymentDisplayNames.js — 決済関連で顧客に見える名称の**単一源**（決済会社をまたいで共通・純粋）
 *
 * 2026-10-11 MK 確定: AK の決済関連名称から競馬関連の語を排除する。基本名称は「Analytics Premium」。
 *
 * 対象（決済会社が顧客に表示する・決済の識別に使う名称）:
 *   決済アカウントの表示名 / Product・Price の表示名 / カード明細名 / Checkout / 請求書・領収書 /
 *   カスタマーポータルの見出し / 決済会社（Stripe・Paddle・PayPal）が送る顧客向け決済メールの商品名・事業者表示 /
 *   AK の申込・入金メールに載せる商品名（申込の商品名）
 *
 * 対象外（変えない）: AK のサイト名・ドメイン（analytics.keiba.link）・提供サービスの説明・法定表示・必要な事業説明。
 *   名称の制約と、商品内容の説明は区別する（説明文で中央・南関の対象を書くのは可）。
 *
 * 新しい決済会社（Paddle / PayPal）の商品名・表示名も必ずここを通す（assertPaymentDisplayName）。
 */

/** 基本名称 */
export const PAYMENT_BASE_NAME = 'Analytics Premium';

/**
 * 決済関連名称に使ってはいけない語。比較は NFKC 正規化 + 大文字化で行う（KEIBA / keiba / Keiba / ｋｅｉｂａ を同一視）。
 * ⚠️ 語を足すときは既存の商品名・明細表記がすべて通ることをテストで確かめる。
 */
export const PAYMENT_BANNED_WORDS = Object.freeze(['KEIBA', '競馬', '馬券']);

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
