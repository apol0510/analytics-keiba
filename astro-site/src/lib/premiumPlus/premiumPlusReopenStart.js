/**
 * premiumPlusReopenStart.js — 「Premium Plus 再募集を開始した日時」の**判定の単一源**（純粋・I/O なし）
 *
 * ## 何を決めるモジュールか
 *
 * `reopenStartsAt`（再募集の開始日時）は、これまで
 * `premiumPlusReopenCoupon.js` の `terms.reopenStartsAt` に **null 固定**で置かれていた。
 * そのため優待クーポンの有効期限（開始日時 + 14 日）は導出できず、
 * 予約 write は fail closed のまま止まっていた。
 *
 * 2026-08-21 に MK が確定した運用は次のとおり:
 *
 *   - admin の「Premium Plus 再募集を開始」ボタンを**押した瞬間のサーバー時刻**が `reopenStartsAt`
 *   - client 時刻・client が送った値は**正本にしない**
 *   - 一度開始したら、二重押下・再送・並行要求でも**上書きしない**（first-write-wins）
 *   - 開始日時から **14 日**がクーポン期限（導出は既存の `resolveCouponExpiry()`）
 *   - 未設定のあいだは**現在どおり fail closed**（予約 write を作らない）
 *
 * ## ここに置くもの / 置かないもの
 *
 * | 置く | 置かない |
 * |---|---|
 * | 状態の語彙（未開始 / 開始済み / 確認できない）| Redis などの I/O（→ `premiumPlusReopenStartStore.js`）|
 * | 保存値の正規化（壊れた値を採用しない）| 割引額・通常価格（→ `premiumPlusReopenCoupon.js`）|
 * | 開始日時を載せた**実効クーポン定義**の合成 | 期限の計算式そのもの（同上 `resolveCouponExpiry`）|
 * | admin 表示用のラベル・注記 | 画面ごとの HTML |
 *
 * ## ⚠️「確認できない」を「未開始」に丸めない
 *
 * 保存先を読めなかったとき（Redis 不通・タイムアウト）に `未開始` と表示すると、
 * **実際には開始済みなのに「まだ開始していません」と読める**。運営者がもう一度押しても
 * `SET NX` で上書きはされない（＝壊れない）が、**画面が嘘をつく**のは許容しない。
 * 読めていないときは `UNKNOWN` を返し、理由をそのまま出す。
 */

import {
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_EXPIRY_NOTE,
  resolveCouponExpiry,
  formatJstDateTime,
} from './premiumPlusReopenCoupon.js';

/** 再募集の開始状態（**この 3 つしかない**） */
export const REOPEN_STATE = Object.freeze({
  /** まだ開始していない（保存先を読めたうえで「値が無い」） */
  NOT_STARTED: 'not_started',
  /** 開始済み（`reopenStartsAt` が確定している） */
  STARTED: 'started',
  /**
   * **確認できない**（保存先を読めていない）。
   * ⚠️ `NOT_STARTED` と混同しない。「読めた結果、値が無い」と「読めていない」は別の事実。
   */
  UNKNOWN: 'unknown',
});

/** 読めなかった理由（**admin にそのまま出す**） */
export const REOPEN_UNAVAILABLE = Object.freeze({
  /** 保存先（Upstash Redis）の接続情報が無い */
  NOT_CONFIGURED: 'not_configured',
  /** 読み取りに失敗した */
  READ_FAILED: 'read_failed',
  /** 制限時間内に応答が無かった */
  TIMEOUT: 'timeout',
  /** 呼び出し側が状態を渡していない（配線漏れ） */
  NOT_PROVIDED: 'not_provided',
  /** 保存されていた値が壊れていて採用できない */
  CORRUPT: 'corrupt',
});

export const REOPEN_UNAVAILABLE_NOTE = Object.freeze({
  not_configured: '再募集の開始状態を保存する場所（Upstash Redis）へ接続できないため、'
    + '開始済みかどうかを確認できません。',
  read_failed: '再募集の開始状態の読み取りに失敗したため、開始済みかどうかを確認できません。'
    + '時間をおいて再読込してください。',
  timeout: '再募集の開始状態を制限時間内に読み取れなかったため、開始済みかどうかを確認できません。',
  not_provided: '再募集の開始状態を読み込んでいないため、開始済みかどうかを確認できません。',
  corrupt: '保存されている再募集の開始日時が不正な値のため、開始済みとして扱えません。',
  unknown: '再募集の開始状態を確認できませんでした。',
});

export function describeReopenUnavailable(reason) {
  return REOPEN_UNAVAILABLE_NOTE[String(reason || '')] || REOPEN_UNAVAILABLE_NOTE.unknown;
}

/** 状態のラベル（admin 表示。顧客画面には出さない） */
export const REOPEN_STATE_LABEL = Object.freeze({
  not_started: '未開始',
  started: '開始済み',
  unknown: '確認できない',
});

/**
 * 採用してよい開始日時か。
 *
 * ⚠️ **仮の日付・壊れた値を通さない**。パースできない / 現実的でない年は採用しない
 * （採用してしまうと、そこから 14 日の期限が導出され顧客画面に出てしまう）。
 */
export const REOPEN_MIN_YEAR = 2020;
export const REOPEN_MAX_YEAR = 2100;

/**
 * 保存値 → ISO 文字列（採用できないなら null）。
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeReopenStartsAt(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  if (y < REOPEN_MIN_YEAR || y > REOPEN_MAX_YEAR) return null;
  return new Date(ms).toISOString();
}

/**
 * 開始日時を載せた**実効クーポン定義**を返す（`PP_REOPEN_COUPON` は変更しない）。
 *
 * - 未開始 / 採用できない値 → **基準定義をそのまま返す**（＝ `expiresDetermined:false` の fail closed）
 * - 開始済み → `reopenStartsAt` と、そこから導出した `expiresAt` を持つ定義
 *
 * ⚠️ 期限の計算式はここに書かない。導出は既存の `resolveCouponExpiry()`（＝ 開始 + `expiryDays`）
 *    に任せる。日数を 2 か所に書くとズレる。
 *
 * @param {unknown} startsAtIso
 * @param {object} [def] 基準となるクーポン定義
 */
export function withReopenStart(startsAtIso, def = PP_REOPEN_COUPON) {
  const iso = normalizeReopenStartsAt(startsAtIso);
  if (!iso) return def;
  const base = def || PP_REOPEN_COUPON;
  // 既存の `expiresAt` は捨ててから導出する（`resolveCouponExpiry` は既存値を優先するため）
  const draft = {
    ...base,
    terms: { ...(base.terms || {}), reopenStartsAt: iso, expiresAt: null, expiresDetermined: false },
  };
  const { expiresAtIso, determined } = resolveCouponExpiry(draft);
  // 導出できないなら**開始していないものとして扱う**（仮の期限を作らない）
  if (determined !== true || !expiresAtIso) return base;
  return Object.freeze({
    ...draft,
    terms: Object.freeze({ ...draft.terms, expiresAt: expiresAtIso, expiresDetermined: true }),
  });
}

/**
 * 開始操作の確認文言（**admin の確認ダイアログの単一源**）。
 * ⚠️ 画面側で文言を作り直さないこと（「取り消せない」ことが伝わらない版が生まれる）。
 */
export const REOPEN_START_CONFIRM_TEXT = [
  'Premium Plus の再募集を開始します。',
  '',
  '・開始日時は「いまのサーバー時刻」で確定します',
  '・一度開始すると、この画面からは変更・取り消しできません',
  '・優待クーポンの有効期限が「開始日時から14日間」で自動的に確定します',
  '',
  '実行しますか？',
].join('\n');

/**
 * 現在の再募集開始状態を 1 つの表示モデルにする（admin / API 共用）。
 *
 * @param {{ available?: boolean, startsAtIso?: unknown, reason?: string, def?: object }} input
 * @returns {{ state: string, label: string, startsAtIso: string, startsAtText: string,
 *             expiresAtIso: string, expiresAtText: string, expiryDetermined: boolean,
 *             started: boolean, startable: boolean, available: boolean,
 *             reason: string, note: string }}
 */
export function resolveReopenStatus({
  available, startsAtIso, reason, def = PP_REOPEN_COUPON,
} = {}) {
  const empty = {
    startsAtIso: '', startsAtText: '', expiresAtIso: '', expiresAtText: PP_REOPEN_COUPON_EXPIRY_NOTE,
    expiryDetermined: false, started: false,
    /**
     * 確認ダイアログの文言。**サーバーが配る**。
     * ⚠️ 管理画面（ブラウザ）へこのモジュールを import させないこと。
     *    このファイルは `premiumPlusReopenCoupon.js` 経由で `node:crypto` に依存する
     *    共通クーポン基盤へ繋がっており、client bundle に入れるとビルドが落ちる。
     */
    confirmText: REOPEN_START_CONFIRM_TEXT,
  };

  if (available !== true) {
    const why = String(reason || REOPEN_UNAVAILABLE.NOT_PROVIDED);
    return {
      ...empty,
      state: REOPEN_STATE.UNKNOWN,
      label: REOPEN_STATE_LABEL.unknown,
      available: false,
      // ⚠️ 読めていないあいだは押させない（押しても `SET NX` で壊れないが、画面が嘘をつかない側へ倒す）
      startable: false,
      reason: why,
      note: describeReopenUnavailable(why),
    };
  }

  const raw = startsAtIso === null || startsAtIso === undefined ? '' : String(startsAtIso).trim();
  const iso = normalizeReopenStartsAt(raw);
  if (!iso) {
    // 「値が無い」＝未開始 ／ 「値はあるが壊れている」＝確認できない（開始済み扱いにしない）
    if (raw) {
      return {
        ...empty,
        state: REOPEN_STATE.UNKNOWN,
        label: REOPEN_STATE_LABEL.unknown,
        available: true,
        startable: false,
        reason: REOPEN_UNAVAILABLE.CORRUPT,
        note: describeReopenUnavailable(REOPEN_UNAVAILABLE.CORRUPT),
      };
    }
    return {
      ...empty,
      state: REOPEN_STATE.NOT_STARTED,
      label: REOPEN_STATE_LABEL.not_started,
      available: true,
      startable: true,
      reason: '',
      note: '再募集はまだ開始していません。開始するとその時刻が確定し、'
        + `クーポンの有効期限（開始から ${Number(def?.terms?.expiryDays) || 14} 日）も確定します。`,
    };
  }

  const effective = withReopenStart(iso, def);
  const expiresAtIso = String(effective?.terms?.expiresAt || '');
  return {
    ...empty,
    state: REOPEN_STATE.STARTED,
    label: REOPEN_STATE_LABEL.started,
    available: true,
    started: true,
    // 開始済みなら二度と押させない（上書きは構造的にも起きないが、UI でも出さない）
    startable: false,
    startsAtIso: iso,
    startsAtText: formatJstDateTime(iso),
    expiresAtIso,
    expiresAtText: expiresAtIso ? formatJstDateTime(expiresAtIso) : PP_REOPEN_COUPON_EXPIRY_NOTE,
    expiryDetermined: effective?.terms?.expiresDetermined === true,
    reason: '',
    note: '再募集は開始済みです。開始日時は変更できません（記録は上書きしない設計です）。',
  };
}

/** 開始操作を断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const REOPEN_START_REJECT = Object.freeze({
  /** 保存先が使えない（**書かない**） */
  UNAVAILABLE: 'reopen_store_unavailable',
  /** 既に開始済み（**上書きしない**。エラーではなく冪等な成功として返す） */
  ALREADY_STARTED: 'reopen_already_started',
});
