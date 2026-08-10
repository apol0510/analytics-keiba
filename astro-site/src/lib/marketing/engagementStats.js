/**
 * 顧客ごとのエンゲージメント素材を作る（純粋）。
 *
 * 入力は既存の読み取り結果（Customers の一覧と CampaignDeliveries）だけ。
 * **新しいテーブルも列も増やさない。**
 *
 * ⚠️ 反応の材料は「送信台帳」と「顧客レコード」から取れる範囲に限る。
 *    open / click の実数は `EmailEvents` にあるが、全件読みは Function の
 *    実行時間に収まらない（18,955 行）。そこで:
 *      - 送信回数は `CampaignDeliveries`（軽い）
 *      - 反応は Customers 側に残る恒久シグナル（購入・最終ログイン）を優先
 *      - open は渡された分だけ加味する（呼び出し側が持っていれば）
 *    **open が取れないことを「反応が無い」と読み替えない**。
 *    材料が足りなければ `UNKNOWN` に留まり、guard は誰も止めない（安全側）。
 */

const norm = (e) => String(e || '').trim().toLowerCase();

/**
 * @param {{
 *   list: Array<{recordId: string, fields: object, marketing?: object}>,
 *   deliveries?: Array<{fields: object}>,
 *   openByEmail?: Map<string, number>,
 *   clickByEmail?: Map<string, number>,
 * }} input
 * @returns {Map<string, {sent:number, delivered:number, open:number, click:number,
 *                        purchases:number, logins:number}>}  email → 集計
 */
export function buildEngagementStats({ list, deliveries, openByEmail, clickByEmail } = {}) {
  const stats = new Map();
  const ensure = (email) => {
    if (!stats.has(email)) {
      stats.set(email, { sent: 0, delivered: 0, open: 0, click: 0, purchases: 0, logins: 0 });
    }
    return stats.get(email);
  };

  for (const c of Array.isArray(list) ? list : []) {
    const f = c?.fields || {};
    const email = norm(f.Email);
    if (!email) continue;
    const s = ensure(email);
    // 恒久シグナル: 課金実績。**open より強い**
    if (f.PaidAt) s.purchases += 1;
    // ログイン記録があれば意味のある行動として数える（列が無ければ 0 のまま）
    if (f.LastLoginAt || f.最終ログイン) s.logins += 1;
  }

  for (const d of Array.isArray(deliveries) ? deliveries : []) {
    const f = d?.fields || {};
    if (String(f.EmailType || '') !== 'campaign') continue;
    const email = norm(f.RecipientEmail);
    if (!email) continue;
    const s = ensure(email);
    const status = String(f.Status || '');
    if (status === 'sent') {
      s.sent += 1;
      // 台帳の `sent` は provider 受理。実配信は EmailEvents だが、
      // ここでは下限として同じ数を使う（**多めに数えて早く切る方向にはしない**）。
      s.delivered += 1;
    }
  }

  if (openByEmail instanceof Map) {
    for (const [e, n] of openByEmail) {
      const s = ensure(norm(e));
      s.open += Number(n) || 0;
    }
  }
  if (clickByEmail instanceof Map) {
    for (const [e, n] of clickByEmail) {
      const s = ensure(norm(e));
      s.click += Number(n) || 0;
    }
  }

  return stats;
}
