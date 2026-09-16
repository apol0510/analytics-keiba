/**
 * unsubscribeOutcome.js — 配信停止を「どこへ記録し、成功と言ってよいか」の単一源（純粋・IO なし）
 *
 * ## なぜ要るか（2026-09-16）
 *
 * 配信対象は **2 つの母集団**に分かれている:
 *
 * | 母集団 | 保管場所 | 送信直前の除外 |
 * |---|---|---|
 * | 会員・登録者 | Airtable `Customers` | `UnsubscribedAnalyticsKeiba` |
 * | 見込み客（CSV 取り込み）| Redis `ak:prospect:` | `state=SUPPRESSED` |
 *
 * ところが配信停止 Function は **Customers しか見ていなかった**。
 * 見込み客が配信停止を押すと `email-not-found` になり、ワンクリック仕様に従って
 * **200 を返すのに 1 ビットも記録されない**。押した本人は止めたつもりで、翌週も届く。
 * 現に配信の大半は見込み客宛なので、これが「配信停止が効かない」の主因だった。
 *
 * ## 決めたこと
 *
 * - 停止は **両方の母集団へ書きにいく**。どちらかに記録できれば成功
 * - **記録できなかったのに 2xx を返さない**（fail closed）。
 *   2xx はメールクライアントにとって「止まった」の意味なので、握り潰すと
 *   利用者は止まったと信じたまま届き続ける
 * - 「どこにも居ない」だけは別扱い。ワンクリックでは 200（目的は達成されており、
 *   かつアドレスの存在有無を漏らさない）
 * - **配信再開（resubscribe）は Customers だけ**。見込み客の抑止は解除しない
 *   （一度止めた人を再取り込みや再登録で復活させない＝要件「retry / re-enrollment で復活しない」）
 */

/** 各保存先の結果コード。 */
export const SINK_RESULT = Object.freeze({
  /** 実際に書き込んだ */
  RECORDED: 'recorded',
  /** 既にその状態だった（冪等・成功扱い）*/
  ALREADY: 'already',
  /** その母集団に居なかった */
  NOT_FOUND: 'not-found',
  /** 設定が無い等で試せなかった */
  UNAVAILABLE: 'unavailable',
  /** 試したが失敗した */
  ERROR: 'error',
});

/** 保存先の名前。 */
export const SINK = Object.freeze({
  CUSTOMER: 'customer',
  PROSPECT: 'prospect',
});

const SUCCESS = new Set([SINK_RESULT.RECORDED, SINK_RESULT.ALREADY]);
const FAILED = new Set([SINK_RESULT.UNAVAILABLE, SINK_RESULT.ERROR]);

/**
 * どの保存先へ書きにいくかを決める。
 *
 * @param {{action?: string}} input `'unsubscribe'` | `'resubscribe'`
 * @returns {{customer: boolean, prospect: boolean}}
 */
export function planUnsubscribeSinks({ action } = {}) {
  const resubscribe = action === 'resubscribe';
  return {
    customer: true,
    // ⚠️ 再開で見込み客の抑止を**解除しない**。止めた意思は再取り込みでも残す
    prospect: !resubscribe,
  };
}

/**
 * 各保存先の結果から、リクエスト全体の成否を決める。
 *
 * @param {{customer?: string, prospect?: string}} results 保存先 → SINK_RESULT
 * @returns {{ok: boolean, reason: string|null, recorded: string[], failed: string[]}}
 */
export function summarizeUnsubscribeOutcome(results = {}) {
  const entries = Object.entries(results).filter(([, v]) => typeof v === 'string');
  const recorded = entries.filter(([, v]) => SUCCESS.has(v)).map(([k]) => k);
  const failed = entries.filter(([, v]) => FAILED.has(v)).map(([k]) => k);

  // 1 つでも記録できていれば成功。以後その相手には送られない
  if (recorded.length > 0) return { ok: true, reason: null, recorded, failed };

  // 記録ゼロ。失敗が混ざっているなら**成功と言わない**（握り潰さない）
  if (failed.length > 0) return { ok: false, reason: 'unsubscribe-write-failed', recorded, failed };

  // どこにも居なかった
  return { ok: false, reason: 'email-not-found', recorded, failed };
}
