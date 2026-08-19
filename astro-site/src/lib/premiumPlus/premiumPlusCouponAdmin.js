/**
 * premiumPlusCouponAdmin.js — 再募集クーポンの**管理者操作**の単一源（純粋・I/O なし）
 *
 * 運営者が Airtable を直接編集せずに、管理画面から次の 4 操作を行えるようにする。
 *
 * | 操作 | 何を書くか | 何を書かないか |
 * |---|---|---|
 * | **付与** `grant` | Customers のクーポン 3 列 | 資格 / 停止 / 会員権 / 決済 / 予約台帳 |
 * | **予約取消** `revokeReservation` | 予約行の `Status` / `Notes` のみ | Customers は 1 バイトも触らない |
 * | **誤取得訂正** `correct` | Customers のクーポン 3 列（取得を取り消す）| 予約台帳 |
 * | **再発行** `reissue` | Customers のクーポン 3 列（訂正後に再付与）| 予約台帳 |
 *
 * ## 既存 schema だけで行う（**列もテーブルも増やさない**）
 *
 * - 保有状態: `PP_REOPEN_COUPON_FIELDS` の 3 列（`ClaimedAt` / `CouponId` / `Source`）
 * - 予約状態: `PromotionalOffers` の**既存の予約行**（新しい種類の行を作らない）
 *
 * ⚠️ **予約台帳へ「監査専用の行」を新設しない。** あの台帳は
 *    `offerFilterModel.js` / `customerTimeline.js` / `recommendedActions.js` が
 *    `Status` / `ExpiresAt` / `OfferPrice` で顧客を分類しており、価格の無い行を混ぜると
 *    「割引オファーを 1 度も受け取っていない顧客」が誤分類される。
 *
 * ## 監査（誰が・いつ・なぜ・何を）
 *
 * `Source` 列に**構造化した 1 行**を書く。読み書きはこのモジュールだけが行う。
 *
 * ```
 * admin-grant|by=MK|at=2026-08-19T12:00:00.000Z|why=お電話でのご依頼
 * admin-correct|by=MK|at=…|prev=2026-08-18T22:07:54.803Z|from=pause-notice|why=誤操作のため訂正
 * admin-reissue|by=MK|at=…|prev=2026-08-18T22:07:54.803Z|why=訂正後に再発行
 * ```
 *
 * - **訂正でも履歴を消さない**。`prev=` に**元の取得日時**、`from=` に**元の取得元**を残すので、
 *   「もともと 8/18 に受付休止ページから取得していたが、8/19 に MK が訂正した」と後から読める。
 * - 予約取消は予約行の `Notes` に同じ体裁で残す（Customers 側は変えない）。
 *
 * ⚠️ **限界（正直に書く）**: Customers に残るのは**直近 1 回の操作だけ**。
 *    付与 → 訂正 → 再発行 と重ねると、途中の操作は `prev` / `from` に畳まれた分しか残らない。
 *    **積み上げ式の完全な操作履歴は既存 schema では持てない**（列の追加か履歴テーブルが要る）。
 *
 * ## 顧客の取得経路と混ざらない
 *
 * `admin-*` の値は**このモジュールだけ**が書く。顧客側 (`normalizeCouponSource`) の
 * allow-list は `pause-notice` / `coupon-page` のみなので、クライアントが
 * `source: 'admin-grant'` を送っても管理者操作を騙れない。
 */

import {
  PP_REOPEN_COUPON_FIELDS,
  PP_REOPEN_COUPON_FORBIDDEN_FIELDS,
  assertOnlyCouponFields,
  couponIdWithVersion,
  isReopenCouponEnabled,
  readReopenCoupon,
} from './premiumPlusReopenCoupon.js';
import { COUPON_LIFECYCLE, describeCouponLifecycle } from './premiumPlusCouponReservation.js';
import { OFFER_STATUS } from '../promotions/promotionalOffer.js';
import { isReservationRow } from '../promotions/couponReservationSource.js';

/** 管理者操作の種類 */
export const PP_COUPON_ADMIN_ACTION = Object.freeze({
  /** 未取得の会員へ管理者がクーポンを付与する */
  GRANT: 'grant',
  /** 入金確認前の利用予約を取り消す（誤申告訂正）。取得の事実は消さない */
  REVOKE_RESERVATION: 'revokeReservation',
  /** 誤って取得された記録を取り消す（取得そのものを無かったことにする）*/
  CORRECT: 'correct',
  /** 訂正・失効のあとに改めて付与し直す */
  REISSUE: 'reissue',
});

export const PP_COUPON_ADMIN_ACTION_LABEL = Object.freeze({
  grant: 'クーポンを付与',
  revokeReservation: '利用予約を取り消す',
  correct: '誤取得を訂正（取得を取り消す）',
  reissue: 'クーポンを再発行',
});

/** `Source` 列に書く管理者操作の印（顧客側の allow-list とは**別**） */
export const PP_COUPON_ADMIN_SOURCE = Object.freeze({
  grant: 'admin-grant',
  correct: 'admin-correct',
  reissue: 'admin-reissue',
});

/** 操作を断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const PP_COUPON_ADMIN_REJECT = Object.freeze({
  UNKNOWN_ACTION: 'unknown_action',
  MISSING_ACTOR: 'missing_actor',
  MISSING_REASON: 'missing_reason',
  /** 予約台帳を読めていない（＝使用済みか判断できない）*/
  LEDGER_UNAVAILABLE: 'ledger_unavailable',
  /** 保存先が本番で有効化されていない */
  STORAGE_DISABLED: 'coupon_storage_disabled',
  /** 既に取得済み（二重付与）*/
  ALREADY_CLAIMED: 'already_claimed',
  /** 取得していない（訂正対象が無い）*/
  NOT_CLAIMED: 'not_claimed',
  /** 使用済み（再利用させない）*/
  ALREADY_REDEEMED: 'already_redeemed',
  /** 入金確認待ちの利用予約が残っている */
  RESERVATION_ACTIVE: 'reservation_active',
  /** 取り消せる利用予約が無い */
  NO_RESERVATION: 'no_reservation',
  /** 既に取り消し済み / 使用済みで取り消せない */
  RESERVATION_NOT_REVOCABLE: 'reservation_not_revocable',
});

export const PP_COUPON_ADMIN_REJECT_TEXT = Object.freeze({
  unknown_action: '未知の操作です。',
  missing_actor: '操作者名を入力してください（監査記録に残ります）。',
  missing_reason: '操作理由を入力してください（監査記録に残ります）。',
  ledger_unavailable: '予約台帳を確認できないため操作できません。'
    + 'このクーポンが既に使用済みかどうかを判断できない状態で書き換えると、'
    + '使用済みクーポンを再利用可能にしてしまいます。台帳を読める状態に戻してから操作してください。',
  coupon_storage_disabled: 'クーポンの保存先が本番で有効化されていないため操作できません。',
  already_claimed: '既にクーポンを取得済みです（二重付与はできません）。'
    + '付与し直す場合は、先に誤取得訂正を行ってください。',
  not_claimed: 'この会員はクーポンを取得していないため、訂正するものがありません。',
  already_redeemed: 'このクーポンは既に使用済みです。'
    + '使用済みのクーポンを取得状態に戻す／再発行することはできません。',
  reservation_active: '入金確認待ちの利用予約が残っています。'
    + '先に「利用予約を取り消す」を行ってください'
    + '（予約を残したまま取得状態を書き換えると、予約と取得の整合が崩れます）。',
  no_reservation: '取り消せる利用予約がありません。',
  reservation_not_revocable: 'この利用予約は既に使用済み／取消済みのため取り消せません。',
});

/** 監査文字列の上限（Airtable の 1 行テキストに収める） */
const MAX_ACTOR = 32;
const MAX_REASON = 160;

/** 監査値の掃除。改行・区切り文字を落として 1 行に収める */
function cleanToken(v, max) {
  return String(v ?? '')
    .replace(/[\r\n\t|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 理由は `why=` 以降を丸ごと使うので区切り文字を残せる（制御文字だけ落とす）*/
function cleanReason(v) {
  return String(v ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
}

/**
 * 監査行を組み立てる。`why=` は**必ず最後**（理由に `|` や `=` が入っても壊れない）。
 * @returns {string}
 */
export function encodeCouponAudit({ kind, actor, atIso, reason, prevClaimedAtIso, prevSource } = {}) {
  const parts = [String(kind || '').trim()];
  parts.push(`by=${cleanToken(actor, MAX_ACTOR)}`);
  parts.push(`at=${cleanToken(atIso, 40)}`);
  if (prevClaimedAtIso) parts.push(`prev=${cleanToken(prevClaimedAtIso, 40)}`);
  if (prevSource) parts.push(`from=${cleanToken(prevSource, 48)}`);
  parts.push(`why=${cleanReason(reason)}`);
  return parts.join('|');
}

/**
 * `Source` 列を読む。**顧客取得（`pause-notice` 等）も管理者操作も同じ関数で読む**。
 *
 * @returns {{ kind: string, byAdmin: boolean, actor: string, atIso: string,
 *             prevClaimedAtIso: string, prevSource: string, reason: string, raw: string }}
 */
export function parseCouponAudit(rawValue) {
  const raw = String(rawValue ?? '').trim();
  const out = {
    kind: raw, byAdmin: false, actor: '', atIso: '',
    prevClaimedAtIso: '', prevSource: '', reason: '', raw,
  };
  if (!raw || !raw.includes('|')) return out;   // 顧客取得（単純な値）はそのまま
  const whyAt = raw.indexOf('|why=');
  const head = whyAt >= 0 ? raw.slice(0, whyAt) : raw;
  out.reason = whyAt >= 0 ? raw.slice(whyAt + '|why='.length) : '';
  const [kind, ...rest] = head.split('|');
  out.kind = kind.trim();
  out.byAdmin = Object.values(PP_COUPON_ADMIN_SOURCE).includes(out.kind);
  for (const kv of rest) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq).trim();
    const v = kv.slice(eq + 1).trim();
    if (k === 'by') out.actor = v;
    else if (k === 'at') out.atIso = v;
    else if (k === 'prev') out.prevClaimedAtIso = v;
    else if (k === 'from') out.prevSource = v;
  }
  return out;
}

/** 監査を日本語 1 行にする（管理画面にそのまま出す） */
export function describeCouponAudit(parsed) {
  const a = parsed || {};
  if (!a.byAdmin) return a.raw ? `お客様ご自身の取得（${a.raw}）` : '';
  const label = {
    'admin-grant': '管理者が付与', 'admin-correct': '管理者が誤取得を訂正',
    'admin-reissue': '管理者が再発行',
  }[a.kind] || '管理者操作';
  const bits = [label];
  if (a.actor) bits.push(`実行者: ${a.actor}`);
  if (a.atIso) bits.push(`日時: ${a.atIso}`);
  if (a.prevClaimedAtIso) bits.push(`訂正前の取得日時: ${a.prevClaimedAtIso}`);
  if (a.prevSource) bits.push(`訂正前の取得元: ${a.prevSource}`);
  if (a.reason) bits.push(`理由: ${a.reason}`);
  return bits.join(' / ');
}

/** その会員の予約行だけを取り出す（**他会員の行は一切見ない**） */
export function ownReservations({ offerRows, customerRecordId }) {
  return (offerRows || []).filter((rec) => isReservationRow(rec)
    && String(((rec && rec.fields) || {}).CustomerRecordId || '') === String(customerRecordId));
}

const statusOf = (rec) => String(((rec && rec.fields) || {}).Status || '').trim().toLowerCase();

/**
 * 操作の可否を決める（**サーバー側の唯一の判定**）。
 *
 * URL 直打ち・API 直叩きでも必ずここを通す。画面がボタンを出していたかは判定材料にしない。
 *
 * ⚠️ **台帳を読めていないときは全操作を断る**（fail closed）。使用済みかどうかを
 *    確認できないまま取得状態を書き換えると、使用済みクーポンを再利用可能にしてしまう。
 *
 * @param {{ action: string, fields: object|null, offerRows: object[]|null,
 *           ledgerAvailable: boolean, env?: object, actor?: string, reason?: string,
 *           nowMs: number, customerRecordId: string }} input
 */
export function resolveCouponAdminPlanFor({
  action, fields, offerRows, ledgerAvailable, env, actor, reason, nowMs, customerRecordId,
} = {}) {
  const deny = (code) => ({ ok: false, code, message: PP_COUPON_ADMIN_REJECT_TEXT[code] || '操作できません' });
  const A = PP_COUPON_ADMIN_ACTION;
  const R = PP_COUPON_ADMIN_REJECT;

  if (!Object.values(A).includes(action)) return deny(R.UNKNOWN_ACTION);
  if (!cleanToken(actor, MAX_ACTOR)) return deny(R.MISSING_ACTOR);
  if (!cleanReason(reason)) return deny(R.MISSING_REASON);
  if (ledgerAvailable !== true) return deny(R.LEDGER_UNAVAILABLE);
  if (!Number.isFinite(nowMs)) return deny(R.UNKNOWN_ACTION);

  const held = readReopenCoupon(fields);
  const mine = ownReservations({ offerRows, customerRecordId });
  const hasRedeemed = mine.some((r) => statusOf(r) === OFFER_STATUS.REDEEMED);
  const issued = mine.find((r) => statusOf(r) === OFFER_STATUS.ISSUED) || null;
  const atIso = new Date(nowMs).toISOString();

  // ── 予約取消（Customers は 1 バイトも触らない）────────────────
  if (action === A.REVOKE_RESERVATION) {
    if (!mine.length) return deny(R.NO_RESERVATION);
    if (!issued) return deny(R.RESERVATION_NOT_REVOCABLE);
    return {
      ok: true,
      action,
      target: 'reservation',
      reservationRecordId: issued.id,
      /** 予約行に書く Notes（既存 `buildReservationRevokeFields` の reason に渡す） */
      note: encodeCouponAudit({
        kind: 'admin-revoke-reservation', actor, atIso, reason,
      }),
      customerFieldsUnchanged: true,
    };
  }

  // ── ここから先は Customers のクーポン 3 列を書く ───────────────
  if (!isReopenCouponEnabled(env)) return deny(R.STORAGE_DISABLED);
  // **使用済みは何があっても触らない**（再利用させない）
  if (hasRedeemed) return deny(R.ALREADY_REDEEMED);

  if (action === A.GRANT || action === A.REISSUE) {
    if (held.claimed) return deny(R.ALREADY_CLAIMED);
    // 入金確認待ちの予約が残ったまま付与し直さない（取得と予約の整合が崩れる）
    if (issued) return deny(R.RESERVATION_ACTIVE);
    // 再発行は「訂正・失効の後にもう一度渡す」操作。過去の取得記録を引き継ぐ
    const prev = parseCouponAudit(held.source);
    const kind = action === A.REISSUE ? PP_COUPON_ADMIN_SOURCE.reissue : PP_COUPON_ADMIN_SOURCE.grant;
    const out = {
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: atIso,
      [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: encodeCouponAudit({
        kind, actor, atIso, reason,
        prevClaimedAtIso: prev.prevClaimedAtIso || '',
        prevSource: prev.byAdmin ? prev.prevSource : (prev.raw || ''),
      }),
    };
    return guarded({ action, fields: out, atIso });
  }

  if (action === A.CORRECT) {
    if (!held.claimed) return deny(R.NOT_CLAIMED);
    // 予約が生きているうちに取得を消さない（先に予約取消）
    if (issued) return deny(R.RESERVATION_ACTIVE);
    const prevAudit = parseCouponAudit(held.source);
    const out = {
      // 取得を取り消す。**判定は ClaimedAt の有無だけ**なのでこれで未取得になる
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: null,
      // ⚠️ 履歴を消さない。元の取得日時・取得元を監査行へ畳んで残す
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: encodeCouponAudit({
        kind: PP_COUPON_ADMIN_SOURCE.correct, actor, atIso, reason,
        prevClaimedAtIso: held.claimedAtIso,
        prevSource: prevAudit.byAdmin ? prevAudit.kind : (prevAudit.raw || ''),
      }),
    };
    return guarded({ action, fields: out, atIso });
  }

  return deny(R.UNKNOWN_ACTION);
}

/** 書き込み直前の最終防衛（クーポン 3 列以外が 1 つでも混ざれば作らない） */
function guarded({ action, fields, atIso }) {
  if (!assertOnlyCouponFields(fields)) {
    return { ok: false, code: 'field_allow_list_violation', message: 'field allow-list violation' };
  }
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) {
    if (k in fields) {
      return { ok: false, code: 'forbidden_field', message: 'forbidden field' };
    }
  }
  return { ok: true, action, target: 'customer', fields, atIso };
}

/**
 * 操作前後の状態を 1 つの形にまとめる（**画面に「操作前 → 操作後」を出すため**）。
 * 判定は既存の単一源 `describeCouponLifecycle` に任せる（別ロジックを作らない）。
 */
export function describeCouponAdminState({ fields, offerRows, ledgerAvailable, customerRecordId }) {
  const life = describeCouponLifecycle({
    fields, offerRows: ledgerAvailable ? offerRows : null,
    ledgerAvailable, customerRecordId,
  });
  const held = readReopenCoupon(fields);
  const audit = parseCouponAudit(held.source);
  return {
    lifecycle: life.state,
    lifecycleLabel: life.label,
    ledgerAvailable: life.ledgerAvailable,
    claimed: held.claimed,
    claimedAtIso: held.claimedAtIso,
    couponId: held.couponId,
    reservationCount: life.reservationCount,
    /** 直近 1 回の操作（誰が・いつ・なぜ）。顧客取得ならその旨 */
    audit,
    auditText: describeCouponAudit(audit),
  };
}

/**
 * いまこの会員に対して実行できる操作（**画面のボタン活性はこれだけで決める**）。
 * ⚠️ 画面がボタンを出したかどうかはサーバーの判定材料にしない。
 *    ここは表示用で、実際の可否は `resolveCouponAdminPlanFor` が再判定する。
 */
export function describeCouponAdminActions({
  fields, offerRows, ledgerAvailable, env, customerRecordId,
}) {
  const state = describeCouponAdminState({ fields, offerRows, ledgerAvailable, customerRecordId });
  const mine = ownReservations({ offerRows: ledgerAvailable ? offerRows : [], customerRecordId });
  const hasRedeemed = ledgerAvailable === true && mine.some((r) => statusOf(r) === OFFER_STATUS.REDEEMED);
  const issued = ledgerAvailable === true && mine.some((r) => statusOf(r) === OFFER_STATUS.ISSUED);
  const storage = isReopenCouponEnabled(env);
  const A = PP_COUPON_ADMIN_ACTION;
  const R = PP_COUPON_ADMIN_REJECT;

  const base = ledgerAvailable === true;
  const mk = (action, enabled, blockedBy) => ({
    action, label: PP_COUPON_ADMIN_ACTION_LABEL[action], enabled, blockedBy: blockedBy || '',
  });

  if (!base) {
    return {
      state,
      /** 台帳が読めないときは**全操作を伏せる**（押せるように見せない）*/
      actions: Object.values(A).map((a) => mk(a, false, PP_COUPON_ADMIN_REJECT_TEXT[R.LEDGER_UNAVAILABLE])),
      storageReady: storage,
      // ⚠️ 使用済みかどうかも**分からない**。false（＝使用済みでない）と断定しない
      redeemed: null,
      lifecycleIsUnknown: true,
    };
  }
  const claimBlock = hasRedeemed ? R.ALREADY_REDEEMED
    : (!storage ? R.STORAGE_DISABLED
      : (issued ? R.RESERVATION_ACTIVE : (state.claimed ? R.ALREADY_CLAIMED : null)));
  const correctBlock = hasRedeemed ? R.ALREADY_REDEEMED
    : (!storage ? R.STORAGE_DISABLED
      : (issued ? R.RESERVATION_ACTIVE : (!state.claimed ? R.NOT_CLAIMED : null)));
  const revokeBlock = issued ? null : (mine.length ? R.RESERVATION_NOT_REVOCABLE : R.NO_RESERVATION);
  // 再発行は「過去に取得記録がある（訂正済み）」ときの操作。無ければ付与を使う
  const reissueBlock = claimBlock
    || (state.audit.prevClaimedAtIso || state.audit.byAdmin ? null : R.NOT_CLAIMED);

  return {
    state,
    actions: [
      mk(A.GRANT, !claimBlock, claimBlock ? PP_COUPON_ADMIN_REJECT_TEXT[claimBlock] : ''),
      mk(A.REVOKE_RESERVATION, !revokeBlock, revokeBlock ? PP_COUPON_ADMIN_REJECT_TEXT[revokeBlock] : ''),
      mk(A.CORRECT, !correctBlock, correctBlock ? PP_COUPON_ADMIN_REJECT_TEXT[correctBlock] : ''),
      mk(A.REISSUE, !reissueBlock, reissueBlock ? PP_COUPON_ADMIN_REJECT_TEXT[reissueBlock] : ''),
    ],
    storageReady: storage,
    /** 使用済みは操作できない、を画面で必ず伝える */
    redeemed: hasRedeemed,
    lifecycleIsUnknown: state.lifecycle === COUPON_LIFECYCLE.UNKNOWN,
  };
}
