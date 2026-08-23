/**
 * couponNotice.js — 「お客様に知らせるべきことがあるか」の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-08-23 / MK 指摘）
 *
 * > クーポンを再発行したら顧客に通知は？
 *
 * **無かった。** 管理画面でクーポンを渡しても、お客様がたまたまマイページを開かない限り
 * 気づけない。渡したのに使われないのは、渡していないのと同じ。
 *
 * ## 何を知らせるか
 *
 * | 状態 | 知らせる |
 * |---|---|
 * | 受け取れるクーポンがある（未取得）| ✅ 受け取ってもらう必要がある |
 * | 取得済みでまだ使っていない | ✅ 使えることを知ってもらう |
 * | お申し込みに適用済み / ご利用済み | ❌ お客様の行動は終わっている |
 * | 対象外 / 確認できない | ❌ 断定しない |
 *
 * ## 「新しいか」の見分け方
 *
 * `signature` が**中身から決まる**ので、
 *   - 同じクーポンを見たあとは出ない（毎回赤い点が出て意味を失わない）
 *   - **もう一度渡し直すと取得日時が変わる → 別の signature → また知らせる**
 *
 * ⚠️ 既読の保存先は呼び出し側（ブラウザの localStorage）。ここは純粋なまま。
 */

/** 知らせの種類（文言はここが持つ。画面で作らない） */
export const COUPON_NOTICE_KIND = Object.freeze({
  /** まだ受け取っていない（受け取れる） */
  CLAIMABLE: 'claimable',
  /** 受け取り済みで、まだ使っていない */
  USABLE: 'usable',
});

const TEXT = Object.freeze({
  claimable: 'クーポンを受け取れます',
  usable: 'お使いいただけるクーポンがあります',
});

/**
 * いま知らせるべきことを 1 つ返す（無ければ `show: false`）。
 *
 * @param {{ claimed?: boolean, canClaim?: boolean,
 *           usage?: { used?: boolean, reserved?: boolean, known?: boolean },
 *           claimedAt?: string, expiryText?: string }} coupon
 *   `/api/upsell.json` の `coupon`
 * @returns {{ show: boolean, kind: string, label: string, signature: string, count: number }}
 */
export function describeCouponNotice(coupon) {
  const c = coupon || {};
  const none = { show: false, kind: '', label: '', signature: '', count: 0 };
  const usage = c.usage || {};

  // 使い終わった / 申込に適用済み / 確認できない → お客様の行動は残っていない
  if (usage.used === true || usage.reserved === true) return none;
  // ⚠️ 状態を確認できていないときに「使えます」と言わない
  if (c.claimed === true && usage.known === false) return none;

  if (c.claimed === true) {
    const at = String(c.claimedAt || '').trim();
    if (!at) return none;                      // いつ渡したか分からないものは知らせない
    return {
      show: true,
      kind: COUPON_NOTICE_KIND.USABLE,
      label: TEXT.usable,
      // ⚠️ 渡し直すと取得日時が変わる＝別の知らせとして必ずもう一度出る
      signature: `usable:${at}`,
      count: 1,
    };
  }
  if (c.canClaim === true) {
    return {
      show: true,
      kind: COUPON_NOTICE_KIND.CLAIMABLE,
      label: TEXT.claimable,
      // 未取得のうちは中身が変わらないので、一度見たら出続けない
      signature: `claimable:${String(c.expiryText || 'open')}`,
      count: 1,
    };
  }
  return none;
}

/**
 * まだ見ていない知らせか。
 * ⚠️ 既読の値が読めない（保存できない環境）ときは**知らせる側**へ倒す。
 *    見落として損をするのはお客様なので、出しすぎる方が安全。
 */
export function isCouponNoticeUnseen(notice, seenSignature) {
  const n = notice || {};
  if (n.show !== true || !n.signature) return false;
  return String(seenSignature || '') !== n.signature;
}
