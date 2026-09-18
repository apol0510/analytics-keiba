/**
 * webhookEventOnce.js — 同じ webhook イベントを**二度数えない**（Redis / I/O は注入）
 *
 * ## なぜ要るか（2026-09-18）
 *
 * 選別 list からの除外に失敗したとき、**SendGrid の再送**で確実に外すために
 * webhook を 5xx で返す。ところが再送されるのは**そのバッチ全体**で、
 * `prospectStore.recordDelivered()` は **呼ぶたびに `delivered` を +1 する**
 * （`applyDelivered` は無条件に加算する）。つまり再送を使うと、
 * **同じバッチに居た無関係な受信者の `delivered` まで二重に数える**。
 * `delivered` は打ち切り（10 通・無反応）の分母なので、**早く切れてしまう**。
 *
 * そこで **`sg_event_id` を鍵にした「1 回だけ」の印**を置く。
 * 再送で同じイベントが来ても、prospect への反映は**最初の 1 回だけ**になる。
 *
 * ## 守ること
 *
 * - **`SET NX` で 1 回だけ通す**（先に取れた実行だけが処理する）
 * - **TTL を付ける**（印が永久に残ると Redis が太る。再送の窓より十分長く）
 * - **鍵に PII を入れない**（`sg_event_id` は provider が振る ID）
 * - **Redis が無い / 落ちているときは「初めて」として扱う**（＝従来どおり処理する）。
 *   ただし `usable=false` を返し、**呼び出し側は 5xx による再送を使わない**
 *   （二重加算を防げない状態で再送を促さないため）
 * - 名前空間は `ak:mkt:` 配下（KMA / KI とは共有しない）
 */

export const EVENT_ONCE_PREFIX = 'ak:mkt:webhook-event:';
/** 印の寿命。SendGrid の再送はふつう数時間〜1 日なので、余裕をもって 7 日 */
export const EVENT_ONCE_TTL_SEC = 7 * 24 * 60 * 60;

/** `sg_event_id` の形（無い・壊れているイベントは印を付けられない） */
const EVENT_ID = /^[A-Za-z0-9_.:-]{8,120}$/;

export const eventOnceKey = (id) => `${EVENT_ONCE_PREFIX}${id}`;

/**
 * @param {{redisCmd?: (args: string[]) => Promise<any>}} deps
 */
export function createEventOnceStore({ redisCmd } = {}) {
  const usable = typeof redisCmd === 'function';
  return {
    usable,
    /**
     * まだ処理していないイベントだけを返す。
     *
     * ⚠️ **判定できないものは「初めて」として通す**（取りこぼしより二重処理の方が軽い…
     *    ではなく、ここでは「処理されない」方が重いため）。ただしその場合は
     *    `guarded:false` を返し、呼び出し側が再送を要求しないようにする。
     *
     * @returns {Promise<{events: object[], seen: number, guarded: boolean, errors: number}>}
     */
    async filterUnseen(events) {
      const list = Array.isArray(events) ? events : [];
      if (!usable || list.length === 0) {
        return { events: list, seen: 0, guarded: false, errors: 0 };
      }
      const out = [];
      let seen = 0; let errors = 0; let guarded = true;
      for (const ev of list) {
        const id = String((ev && ev.sg_event_id) || '').trim();
        if (!EVENT_ID.test(id)) {
          // ID が無いイベントは重複判定できない → 処理はするが保証は外れる
          guarded = false;
          out.push(ev);
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop -- 1 バッチは最大でも数百件
          const res = await redisCmd(['SET', eventOnceKey(id), '1', 'NX', 'EX', String(EVENT_ONCE_TTL_SEC)]);
          if (res === 'OK') out.push(ev);
          else if (res === null) seen += 1;              // 既に処理済み（再送）
          else { guarded = false; out.push(ev); }        // 応答が想定外 → 通すが保証は外れる
        } catch {
          errors += 1; guarded = false; out.push(ev);
        }
      }
      return { events: out, seen, guarded, errors };
    },
  };
}

export default createEventOnceStore;
