/**
 * premiumPlusReopenStart.js — 「その会員の Premium Plus 再募集を開始した日時」の**判定の単一源**
 *                             （純粋・I/O なし）
 *
 * ## 会員単位である（2026-08-22 MK 仕様変更）
 *
 * 再募集の開始は **会員ごと**に決める。管理者が「この会員の再募集を開始」を押した
 * 瞬間のサーバー時刻が、**その会員の** `reopenStartsAt` になる。
 *
 *   - **A 会員を開始しても B 会員は未開始のまま**（他会員へ影響しない）
 *   - B 会員を後日開始したら、**B の期限は B の開始時刻 + 14 日**
 *   - 未開始の会員は**現在どおり fail closed**（予約 write を作らない・期限を出さない）
 *
 * ⚠️ **サイト全体で 1 個の開始日時は持たない。** 旧実装（`ak:pp:reopen:v1:start` に
 *    1 個だけ置く方式）は**正本ではない**。本番では 1 度も書かれていない状態で廃止した。
 *    「全体で開始する」概念をコードへ戻さないこと。
 *
 * ## ここに置くもの / 置かないもの
 *
 * | 置く | 置かない |
 * |---|---|
 * | 状態の語彙（未開始 / 開始済み / 確認できない）| Redis などの I/O（→ `premiumPlusReopenStartStore.js`）|
 * | 保存値の正規化（壊れた値を採用しない）| 割引額・通常価格（→ `premiumPlusReopenCoupon.js`）|
 * | 会員 1 人ぶんの**実効クーポン定義**の合成 | 期限の計算式そのもの（同上 `resolveCouponExpiry`）|
 * | admin 表示用のラベル・注記・確認文言 | 販売可否（`salePaused` / eligibility / phase / route）|
 *
 * ## 再募集の開始は「売れるようにする」操作ではない
 *
 * この軸が決めるのは **その会員のクーポン有効期限の起点だけ**。
 * `PremiumPlusSalePaused` / `PremiumPlusEligibility` / `PremiumPlusReleaseOverride` /
 * PHASE / route / 販売 CTA / クーポン保有（3 列）は**一切変えない**。
 * 開始済みでも `salePaused` の会員は**従来どおり購入できない**（判定は既存の単一源のまま）。
 *
 * ## ⚠️「確認できない」を「未開始」に丸めない
 *
 * 保存先を読めなかったとき（Redis 不通・タイムアウト）に `未開始` と表示すると、
 * **実際には開始済みなのに「まだ開始していません」と読める**。もう一度押しても
 * `HSETNX` で上書きはされない（＝壊れない）が、**画面が嘘をつく**のは許容しない。
 * 読めていないときは `UNKNOWN` を返し、理由をそのまま出す。
 */

import {
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_EXPIRY_NOTE,
  resolveCouponExpiry,
  formatJstDateTime,
} from './premiumPlusReopenCoupon.js';

/** 再募集の開始状態（**この 3 つしかない**。会員 1 人ぶんの状態） */
export const REOPEN_STATE = Object.freeze({
  /** まだ開始していない（保存先を読めたうえで「この会員の値が無い」） */
  NOT_STARTED: 'not_started',
  /** 開始済み（この会員の `reopenStartsAt` が確定している） */
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
  /** 会員の指定が不正（recordId の形式違反）*/
  INVALID_MEMBER: 'invalid_member',
});

export const REOPEN_UNAVAILABLE_NOTE = Object.freeze({
  not_configured: 'この会員の再募集の開始状態を保存する場所（Upstash Redis）へ接続できないため、'
    + '開始済みかどうかを確認できません。',
  read_failed: 'この会員の再募集の開始状態の読み取りに失敗したため、開始済みかどうかを確認できません。'
    + '時間をおいて再読込してください。',
  timeout: 'この会員の再募集の開始状態を制限時間内に読み取れなかったため、開始済みかどうかを確認できません。',
  not_provided: 'この会員の再募集の開始状態を読み込んでいないため、開始済みかどうかを確認できません。',
  corrupt: 'この会員に保存されている再募集の開始日時が不正な値のため、開始済みとして扱えません。',
  invalid_member: '会員の指定が不正なため、再募集の開始状態を確認できません。',
  unknown: 'この会員の再募集の開始状態を確認できませんでした。',
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
 * Airtable の recordId 形式（`premiumPlusFunnelStore.js` と同じ規則）。
 * ⚠️ 任意文字列を保存先の識別子に使わない（鍵空間の汚染・他会員の取り違えを防ぐ）。
 */
export const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

/** 会員の識別子として受け付けてよい形か */
export function isSafeCustomerRecordId(id) {
  return typeof id === 'string' && RECORD_ID_RE.test(id);
}

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
 * **その会員の**開始日時を載せた実効クーポン定義を返す（`PP_REOPEN_COUPON` は変更しない）。
 *
 * - 未開始 / 採用できない値 → **基準定義をそのまま返す**（＝ `expiresDetermined:false` の fail closed）
 * - 開始済み → その会員の `reopenStartsAt` と、そこから導出した `expiresAt` を持つ定義
 *
 * ⚠️ 期限の計算式はここに書かない。導出は既存の `resolveCouponExpiry()`（＝ 開始 + `expiryDays`）
 *    に任せる。日数を 2 か所に書くとズレる。
 * ⚠️ 戻り値を**別の会員に使い回さない**。会員ごとに呼ぶこと。
 *
 * @param {unknown} startsAtIso その会員の開始日時
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
 *
 * ⚠️ 画面側で文言を作り直さないこと（「取り消せない」「その会員だけ」が伝わらない版が生まれる）。
 * ⚠️ **対象会員が誰なのかを必ず入れる**（会員単位の操作なので、取り違えが最悪の事故）。
 *
 * @param {{ memberLabel?: string }} input 会員の識別に使う表示名（アドレス等）
 */
export function buildReopenStartConfirmText({ memberLabel } = {}) {
  const who = String(memberLabel || '').trim() || 'この会員';
  return [
    `${who} の Premium Plus 再募集を開始します。`,
    '',
    '・開始日時は「いまのサーバー時刻」で確定します',
    '・一度開始すると、この画面からは変更・取り消しできません',
    `・${who} の優待クーポンの有効期限が「開始日時から14日間」で確定します`,
    '・他の会員には影響しません（会員ごとの操作です）',
    '・これは販売を開ける操作ではありません（購入可否は販売の一時停止・販売資格が決めます）',
    '',
    '実行しますか？',
  ].join('\n');
}

/**
 * **会員 1 人ぶんの**再募集開始状態を 1 つの表示モデルにする（admin / API 共用）。
 *
 * @param {{ available?: boolean, startsAtIso?: unknown, reason?: string,
 *           def?: object, memberLabel?: string }} input
 * @returns {{ state: string, label: string, startsAtIso: string, startsAtText: string,
 *             expiresAtIso: string, expiresAtText: string, expiryDetermined: boolean,
 *             started: boolean, startable: boolean, available: boolean,
 *             reason: string, note: string, confirmText: string }}
 */
export function resolveReopenStatus({
  available, startsAtIso, reason, def = PP_REOPEN_COUPON, memberLabel,
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
    confirmText: buildReopenStartConfirmText({ memberLabel }),
  };

  if (available !== true) {
    const why = String(reason || REOPEN_UNAVAILABLE.NOT_PROVIDED);
    return {
      ...empty,
      state: REOPEN_STATE.UNKNOWN,
      label: REOPEN_STATE_LABEL.unknown,
      available: false,
      // ⚠️ 読めていないあいだは押させない（押しても `HSETNX` で壊れないが、画面が嘘をつかない側へ倒す）
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
      note: 'この会員の再募集はまだ開始していません。開始するとその時刻が確定し、'
        + `この会員のクーポン有効期限（開始から ${Number(def?.terms?.expiryDays) || 14} 日）も確定します。`
        + '他の会員には影響しません。',
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
    note: 'この会員の再募集は開始済みです。開始日時は変更できません（記録は上書きしない設計です）。',
  };
}

/** 開始操作を断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const REOPEN_START_REJECT = Object.freeze({
  /** 保存先が使えない（**書かない**） */
  UNAVAILABLE: 'reopen_store_unavailable',
  /** 会員の指定が不正 */
  INVALID_MEMBER: 'reopen_invalid_member',
  /** 既に開始済み（**上書きしない**。エラーではなく冪等な成功として返す） */
  ALREADY_STARTED: 'reopen_already_started',
});
