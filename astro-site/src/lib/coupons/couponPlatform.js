/**
 * couponPlatform.js — **商品によらない**クーポン基盤（純粋・I/O なし）
 *
 * ## 確定方針（2026-08-20 MK）
 *
 * **クーポンは Premium Plus 専用ではない。今後ほかの商品・プランでも使う。**
 * Premium Plus は**共通クーポン基盤の最初の利用商品**にすぎない。
 * したがって「所持 / 適用 / 使用済み / 取消 / 訂正 / 再発行 / 監査履歴」の判定は
 * **ここ（共通層）**に置き、商品固有なのは
 *   - クーポン定義（割引額・期限・配布条件）
 *   - 保有状態の**置き場所**（どの列 / どの行に書くか）
 * の 2 つだけにする。**2 商品目を足すときに Premium Plus のコードをコピーしない。**
 *
 * ## 商品固有と共通の境界
 *
 * ```
 * ┌─ 共通（このファイル + couponCatalog + couponOperationHistory）────────┐
 * │ 操作の種類 / 排他規則 / 状態遷移 / 監査の書式 / 履歴レコードの形     │
 * │ fail closed の条件（台帳不明・使用済み・予約中）                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *          ▲ binding（商品ごとに 1 つ。読む/書く場所だけを教える）
 * ┌─ 商品固有 ───────────────────────────────────────────────────────────┐
 * │ Premium Plus: premiumPlusReopenCoupon.js の 3 列 + 割引条件           │
 * │ 2 商品目    : 定義を couponCatalog へ足し、binding を 1 つ書くだけ    │
 * └──────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## binding が満たす契約
 *
 * ```js
 * {
 *   couponId, version, productKey,
 *   readHolding(fields)      -> { claimed, claimedAtMs, claimedAtIso, couponId, source }
 *   buildClaimFields(input)  -> object|null   // 取得を書く（付与 / 再発行 / 顧客取得）
 *   buildClearFields(input)  -> object|null   // 取得を消す（誤取得訂正）
 *   isStorageEnabled(env)    -> boolean       // 保存先が本番で有効か（fail closed）
 * }
 * ```
 *
 * ⚠️ **共通層は Airtable も商品ページも知らない。** 判定材料は引数だけ。
 */

import { createHash } from 'node:crypto';

/**
 * 商品の識別子。**価格の正本 `promotionOfferCatalog.js` の `REGULAR_PRICE` のキーと同じ語彙**を使う
 * （新しい語彙を作らない＝価格・商品・クーポンが同じ名前で繋がる）。
 */
export const PRODUCT_KEY = Object.freeze({
  LIGHT_MONTHLY: 'light_monthly',
  PREMIUM_MONTHLY: 'premium_monthly',
  PREMIUM_ANNUAL: 'premium_annual',
  PREMIUM_LIFETIME: 'premium_lifetime',
  /** 1 日 1 鞍の単品商品（**クーポン基盤の最初の利用商品**） */
  PREMIUM_PLUS: 'premium_plus',
});

/** クーポンに対する操作（**商品によらない**） */
export const COUPON_OPERATION = Object.freeze({
  /** お客様ご自身の取得 */
  CLAIM: 'claim',
  /** 管理者が付与（**取得履歴が一度も無い会員だけ**） */
  GRANT: 'grant',
  /** 管理者が再発行（**訂正・失効で一度失った会員だけ**） */
  REISSUE: 'reissue',
  /** 誤取得の訂正（取得を取り消す。履歴は残す） */
  CORRECT: 'correct',
  /** 入金確認前の利用予約の取消 */
  REVOKE_RESERVATION: 'revokeReservation',
  /**
   * 利用予約を**使用済み**にする（管理者の手動確定）。
   *
   * ⚠️ 自動で確定できない商品のために要る。Premium Plus は単品購入で
   *    Customers に申込内容（`RequestedPlan`）を書かないため、入金確認 Function は
   *    **昇格ごとスキップ**する＝ redeem に到達しない。
   *    その商品では**この操作だけが「使い終わった」の唯一の合図**になる。
   */
  REDEEM_RESERVATION: 'redeemReservation',
});

/** `Source` 列などへ書く操作の印（**顧客の取得経路と混ざらない値**にする） */
export const COUPON_OPERATION_SOURCE = Object.freeze({
  grant: 'admin-grant',
  correct: 'admin-correct',
  reissue: 'admin-reissue',
  revokeReservation: 'admin-revoke-reservation',
  redeemReservation: 'admin-redeem-reservation',
});

export const COUPON_OPERATION_LABEL = Object.freeze({
  claim: 'お客様ご自身の取得',
  grant: 'クーポンを付与',
  reissue: 'クーポンを再発行',
  correct: '誤取得を訂正（取得を取り消す）',
  revokeReservation: '利用予約を取り消す',
  redeemReservation: '利用予約を使用済みにする',
});

/** 操作を断る理由（**商品によらない**） */
export const COUPON_REJECT = Object.freeze({
  UNKNOWN_ACTION: 'unknown_action',
  MISSING_ACTOR: 'missing_actor',
  MISSING_REASON: 'missing_reason',
  /** 予約台帳を読めていない（＝使用済みか判断できない） */
  LEDGER_UNAVAILABLE: 'ledger_unavailable',
  /** 保存先が本番で有効化されていない */
  STORAGE_DISABLED: 'coupon_storage_disabled',
  ALREADY_CLAIMED: 'already_claimed',
  NOT_CLAIMED: 'not_claimed',
  ALREADY_REDEEMED: 'already_redeemed',
  RESERVATION_ACTIVE: 'reservation_active',
  NO_RESERVATION: 'no_reservation',
  RESERVATION_NOT_REVOCABLE: 'reservation_not_revocable',
  /** 使用済みにできる予約が無い（取消済み・報告が期限後 など） */
  RESERVATION_NOT_REDEEMABLE: 'reservation_not_redeemable',
  /** 過去に取得履歴がある → 付与ではなく再発行 */
  HISTORY_EXISTS: 'coupon_history_exists',
  /** 過去の取得履歴が無い → 再発行ではなく付与 */
  NO_HISTORY: 'coupon_no_history',
  /** 組み立てた fields が binding の許可範囲外だった */
  FIELD_ALLOW_LIST: 'field_allow_list_violation',
});

export const COUPON_REJECT_TEXT = Object.freeze({
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
  reservation_not_redeemable: '使用済みにできる利用予約がありません'
    + '（入金確認待ちの予約がある場合だけ実行できます）。',
  coupon_history_exists: 'この会員には過去の取得履歴があります。'
    + '「クーポンを付与」ではなく「クーポンを再発行」を使ってください'
    + '（履歴のある会員への付与と、初めての付与を取り違えないため）。',
  coupon_no_history: 'この会員には過去の取得履歴がありません。'
    + '「クーポンを再発行」ではなく「クーポンを付与」を使ってください'
    + '（再発行は、訂正・失効で一度失った方へ渡し直す操作です）。',
  field_allow_list_violation: '書き込み対象のフィールドが許可範囲外です。',
});

/** 監査文字列の上限（1 行テキストに収める） */
export const MAX_ACTOR = 32;
export const MAX_REASON = 160;

/** 監査値の掃除。改行・区切り文字を落として 1 行に収める */
export function cleanToken(v, max = MAX_ACTOR) {
  return String(v ?? '')
    .replace(/[\r\n\t|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 理由は `why=` 以降を丸ごと使うので区切り文字を残せる（制御文字だけ落とす） */
export function cleanReason(v) {
  return String(v ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
}

/**
 * 監査行を組み立てる。`why=` は**必ず最後**（理由に `|` や `=` が入っても壊れない）。
 * ⚠️ 書式を変えると既存レコードが読めなくなる。**追加は末尾の新しいキーで行う**。
 */
export function encodeCouponAudit({
  kind, actor, atIso, reason, prevClaimedAtIso, prevSource, operationId,
} = {}) {
  const parts = [String(kind || '').trim()];
  parts.push(`by=${cleanToken(actor)}`);
  parts.push(`at=${cleanToken(atIso, 40)}`);
  if (prevClaimedAtIso) parts.push(`prev=${cleanToken(prevClaimedAtIso, 40)}`);
  if (prevSource) parts.push(`from=${cleanToken(prevSource, 48)}`);
  // ⚠️ **部分成功の回復に使う**。状態変更は済んだが履歴だけ未記録、を後から検出し、
  //    同じ OperationId で履歴だけ積み直せるようにする（二重にならない）。
  if (operationId) parts.push(`op=${cleanToken(operationId, 64)}`);
  parts.push(`why=${cleanReason(reason)}`);
  return parts.join('|');
}

/** 管理者操作の印か（顧客の取得経路と区別する唯一の判定） */
export function isAdminSource(kind) {
  return Object.values(COUPON_OPERATION_SOURCE).includes(String(kind || '').trim());
}

/**
 * 監査行を読む。**顧客取得（`pause-notice` 等）も管理者操作も同じ関数で読む**。
 */
export function parseCouponAudit(rawValue) {
  const raw = String(rawValue ?? '').trim();
  const out = {
    kind: raw, byAdmin: false, actor: '', atIso: '',
    prevClaimedAtIso: '', prevSource: '', reason: '', operationId: '', raw,
  };
  if (!raw || !raw.includes('|')) return out;   // 顧客取得（単純な値）はそのまま
  const whyAt = raw.indexOf('|why=');
  const head = whyAt >= 0 ? raw.slice(0, whyAt) : raw;
  out.reason = whyAt >= 0 ? raw.slice(whyAt + '|why='.length) : '';
  const [kind, ...rest] = head.split('|');
  out.kind = kind.trim();
  out.byAdmin = isAdminSource(out.kind);
  for (const kv of rest) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq).trim();
    const v = kv.slice(eq + 1).trim();
    if (k === 'by') out.actor = v;
    else if (k === 'at') out.atIso = v;
    else if (k === 'prev') out.prevClaimedAtIso = v;
    else if (k === 'from') out.prevSource = v;
    else if (k === 'op') out.operationId = v;
  }
  return out;
}

/** 監査を日本語 1 行にする（管理画面にそのまま出す） */
export function describeCouponAudit(parsed) {
  const a = parsed || {};
  if (!a.byAdmin) {
    if (!a.raw) return '';
    // 顧客取得。構造化されていれば日時まで出す（旧来の素の値もそのまま読める）
    const bits = [`お客様ご自身の取得（${a.kind || a.raw}）`];
    if (a.atIso) bits.push(`日時: ${a.atIso}`);
    return bits.join(' / ');
  }
  const label = {
    'admin-grant': '管理者が付与', 'admin-correct': '管理者が誤取得を訂正',
    'admin-reissue': '管理者が再発行', 'admin-revoke-reservation': '管理者が利用予約を取消',
  }[a.kind] || '管理者操作';
  const bits = [label];
  if (a.actor) bits.push(`実行者: ${a.actor}`);
  if (a.atIso) bits.push(`日時: ${a.atIso}`);
  if (a.prevClaimedAtIso) bits.push(`訂正前の取得日時: ${a.prevClaimedAtIso}`);
  if (a.prevSource) bits.push(`訂正前の取得元: ${a.prevSource}`);
  if (a.reason) bits.push(`理由: ${a.reason}`);
  return bits.join(' / ');
}

/**
 * **過去に一度でもこのクーポンを持っていたか**（付与と再発行を排他にするための判定）。
 * 判定材料は**その会員の保有状態だけ**（他会員も台帳も見ない）。
 *
 * @param {{ claimed: boolean, claimedAtIso?: string, source?: string }} holding
 * @returns {{ had: boolean, prevClaimedAtIso: string, evidence: string }}
 */
export function describeCouponHistory(holding) {
  const h = holding || {};
  const audit = parseCouponAudit(h.source);
  if (h.claimed === true) {
    return { had: true, prevClaimedAtIso: h.claimedAtIso || '', evidence: 'claimed' };
  }
  if (audit.prevClaimedAtIso) {
    return { had: true, prevClaimedAtIso: audit.prevClaimedAtIso, evidence: 'corrected' };
  }
  // 取得日時は無いが記録だけ残っている（手作業で消された等）。**履歴ありへ倒す**
  if (h.source) return { had: true, prevClaimedAtIso: '', evidence: 'source' };
  return { had: false, prevClaimedAtIso: '', evidence: 'none' };
}

/**
 * 予約の状態（**どの台帳から来たかは問わない**）。
 * @typedef {{ available: boolean, hasIssued: boolean, hasRedeemed: boolean,
 *             issuedRecordId: string|null, issuedOfferKey?: string|null,
 *             count: number|null }} ReservationView
 */

/**
 * 操作の **anchor**（＝「何を起点にした操作か」）。
 *
 * ## なぜ現在時刻を使わないか
 *
 * 冪等キーに `atIso`（wall-clock）を混ぜると、**再送のたびに別の操作**になり
 * 「同じ操作の再送で履歴が増えない」を保証できない。
 * anchor は **その操作が書き換えようとしている状態**から作るので、
 *   - 成功する前の再送 → 状態が変わっていない → **同じ anchor＝同じ OperationId**
 *   - 成功した後の再送 → その操作自体が拒否される（already_claimed 等）
 * となり、時計に依存せず「論理的に同じ操作」を同定できる。
 *
 * | 操作 | anchor |
 * |---|---|
 * | `grant` | `none`（取得履歴が無い状態からの初回付与）|
 * | `correct` | `claim:<いま取り消そうとしている取得日時>` |
 * | `reissue` | `prev:<訂正で失った取得日時>`（無ければ `src:<訂正前の取得元>`）|
 * | `revokeReservation` | `resv:<予約の OfferKey>`（無ければ `resvrec:<レコードID>`）|
 *
 * ⚠️ binding が `resolveOperationAnchor()` を持つ場合はそちらを優先する
 *    （商品側にしか無い安定 ID を使いたいときの逃げ道）。
 */
export function resolveOperationAnchor({ operation, holding, reservations, binding } = {}) {
  if (binding && typeof binding.resolveOperationAnchor === 'function') {
    const custom = binding.resolveOperationAnchor({ operation, holding, reservations });
    if (custom) return String(custom);
  }
  const held = holding || {};
  const rv = reservations || {};
  const O = COUPON_OPERATION;
  if (operation === O.REVOKE_RESERVATION) {
    if (rv.issuedOfferKey) return `resv:${rv.issuedOfferKey}`;
    return rv.issuedRecordId ? `resvrec:${rv.issuedRecordId}` : 'resv:unknown';
  }
  if (operation === O.CORRECT) return `claim:${held.claimedAtIso || ''}`;
  if (operation === O.REISSUE) {
    const audit = parseCouponAudit(held.source);
    if (audit.prevClaimedAtIso) return `prev:${audit.prevClaimedAtIso}`;
    return held.source ? `src:${audit.kind || held.source}` : 'prev:unknown';
  }
  // grant は「取得履歴が無い状態」からしか実行できないので anchor は 1 つ
  return 'none';
}

/**
 * **クーポン実体の識別子**（entity id）＝ *排他の単位*。
 *
 * ## OperationId とは**別の概念**（混同しない）
 *
 * | | 何のためか | 何から作るか |
 * |---|---|---|
 * | **entity id** | **mutation の排他**（同じクーポン状態を触る操作を直列化）| 会員 + 商品 + クーポン + 版 |
 * | **OperationId** | **履歴の冪等**（同じ論理操作の履歴を 1 件に収束）| entity の材料 + 操作種別 + anchor |
 *
 * 同じ会員・同じ商品・同じクーポンなら、**操作種別が違っても同じ鍵**を取る
 * （`claim` と `grant`、`correct` と `reissue` などが同時に走っても直列化される）。
 * OperationId を鍵にすると**種別が違う操作どうしが同時に state を書けてしまう**。
 *
 * ⚠️ 他会員・他商品・別クーポン（別 version）は**別の鍵**なので互いに待たない。
 * ⚠️ PII は含めない（sha256 の断片）。
 */
export function computeCouponEntityId({ customerRecordId, productKey, couponId, version } = {}) {
  const parts = [customerRecordId, productKey, couponId, version].map((v) => String(v ?? '').trim());
  if (parts.some((v) => !v)) return null;
  return createHash('sha256')
    .update(`ak-coupon-entity|${parts.join('|')}`, 'utf8')
    .digest('hex').slice(0, 32);
}

/**
 * **安定した冪等キー**（OperationId）＝ *履歴の一意性*。
 *
 * ⚠️ **mutation の排他には使わない**（排他は `computeCouponEntityId`）。
 *    操作種別ごとに値が変わるため、鍵にすると別種の操作が同時に state を書ける。
 *
 * ⚠️ **現在時刻を材料にしない。** 同じ論理操作の再送では必ず同じ値になる。
 * ⚠️ 会員・商品・クーポン・操作種別・anchor がすべて入るので、
 *    他会員 / 他商品 / 別操作は**必ず別のキー**になる。
 */
export function computeCouponOperationId({
  productKey, couponId, version, customerRecordId, operationType, anchor,
} = {}) {
  const parts = [productKey, couponId, version, customerRecordId, operationType, anchor]
    .map((v) => String(v ?? '').trim());
  // anchor 以外が 1 つでも欠けたら作らない（作れないまま書かせない）
  if (parts.slice(0, 5).some((v) => !v)) return null;
  return createHash('sha256')
    .update(`ak-coupon-op|${parts.join('|')}`, 'utf8')
    .digest('hex').slice(0, 32);
}

/**
 * いま実行してよい操作かを決める（**サーバー側の唯一の判定**）。
 *
 * 画面がボタンを出したかは判定材料にしない。URL 直打ち・API 直叩きでも必ずここを通す。
 *
 * ⚠️ fail closed:
 *   - 予約台帳を読めない → **全操作を断る**（使用済みか判断できない）
 *   - 使用済み → 取得状態を書き換えない
 *   - 入金確認待ちの予約が生きている → 取得状態を書き換えない
 *
 * @param {{ operation: string, holding: object, reservations: ReservationView,
 *           binding: object, env?: object, actor?: string, reason?: string,
 *           nowMs: number }} input
 */
export function resolveCouponOperationPlan({
  operation, holding, reservations, binding, env, actor, reason, nowMs, customerRecordId,
} = {}) {
  const deny = (code) => ({ ok: false, code, message: COUPON_REJECT_TEXT[code] || '操作できません' });
  const O = COUPON_OPERATION;
  const R = COUPON_REJECT;
  const ADMIN_OPS = [O.GRANT, O.REISSUE, O.CORRECT, O.REVOKE_RESERVATION, O.REDEEM_RESERVATION];

  if (!ADMIN_OPS.includes(operation)) return deny(R.UNKNOWN_ACTION);
  if (!cleanToken(actor)) return deny(R.MISSING_ACTOR);
  if (!cleanReason(reason)) return deny(R.MISSING_REASON);
  const rv = reservations || {};
  if (rv.available !== true) return deny(R.LEDGER_UNAVAILABLE);
  if (!Number.isFinite(nowMs)) return deny(R.UNKNOWN_ACTION);

  const held = holding || { claimed: false };
  const atIso = new Date(nowMs).toISOString();
  // 冪等キーは**状態から**作る（現在時刻は材料にしない）
  const anchor = resolveOperationAnchor({ operation, holding: held, reservations: rv, binding });
  const operationId = computeCouponOperationId({
    productKey: binding && binding.productKey,
    couponId: binding && binding.couponId,
    version: binding && binding.version,
    customerRecordId: (binding && binding.customerRecordId) || customerRecordId,
    operationType: operation,
    anchor,
  });

  // ── 予約取消（保有状態には触らない）────────────────────────
  if (operation === O.REVOKE_RESERVATION) {
    if (!rv.count) return deny(R.NO_RESERVATION);
    if (!rv.hasIssued || !rv.issuedRecordId) return deny(R.RESERVATION_NOT_REVOCABLE);
    if (!operationId) return deny(R.UNKNOWN_ACTION);
    return {
      ok: true,
      operation,
      target: 'reservation',
      reservationRecordId: rv.issuedRecordId,
      anchor,
      operationId,
      note: encodeCouponAudit({
        kind: COUPON_OPERATION_SOURCE.revokeReservation, actor, atIso, reason, operationId,
      }),
      customerFieldsUnchanged: true,
    };
  }

  // ── 使用済みにする（保有状態には触らない）──────────────────
  // ⚠️ 取消と同じく**予約行だけ**を書く。Customers の「取得済み」は消さない
  //    （使ったという事実と、渡したという事実は別々に残す）。
  if (operation === O.REDEEM_RESERVATION) {
    if (rv.hasRedeemed === true) return deny(R.ALREADY_REDEEMED);
    if (!rv.count) return deny(R.NO_RESERVATION);
    if (!rv.hasIssued || !rv.issuedRecordId) return deny(R.RESERVATION_NOT_REDEEMABLE);
    if (!operationId) return deny(R.UNKNOWN_ACTION);
    return {
      ok: true,
      operation,
      target: 'reservation',
      reservationRecordId: rv.issuedRecordId,
      anchor,
      operationId,
      note: encodeCouponAudit({
        kind: COUPON_OPERATION_SOURCE.redeemReservation, actor, atIso, reason, operationId,
      }),
      customerFieldsUnchanged: true,
    };
  }

  // ── ここから先は保有状態（binding の保存先）を書く ──────────
  if (!binding || binding.isStorageEnabled(env) !== true) return deny(R.STORAGE_DISABLED);
  // **使用済みは何があっても触らない**（再利用させない）
  if (rv.hasRedeemed === true) return deny(R.ALREADY_REDEEMED);

  if (operation === O.GRANT || operation === O.REISSUE) {
    if (held.claimed === true) return deny(R.ALREADY_CLAIMED);
    if (rv.hasIssued === true) return deny(R.RESERVATION_ACTIVE);
    // ⚠️ **付与と再発行は排他**。同じ状態で両方が通ると、
    //    「初めて渡した」のか「訂正後に渡し直した」のかが監査から読めなくなる。
    const history = describeCouponHistory(held);
    if (operation === O.GRANT && history.had) return deny(R.HISTORY_EXISTS);
    if (operation === O.REISSUE && !history.had) return deny(R.NO_HISTORY);

    if (!operationId) return deny(R.UNKNOWN_ACTION);
    const prev = parseCouponAudit(held.source);
    const fields = binding.buildClaimFields({
      kind: COUPON_OPERATION_SOURCE[operation], actor, atIso, reason, operationId,
      prevClaimedAtIso: prev.prevClaimedAtIso || '',
      prevSource: prev.byAdmin ? prev.prevSource : (prev.raw || ''),
    });
    if (!fields) return deny(R.FIELD_ALLOW_LIST);
    return { ok: true, operation, target: 'holding', fields, atIso, history, anchor, operationId };
  }

  if (operation === O.CORRECT) {
    if (held.claimed !== true) return deny(R.NOT_CLAIMED);
    if (rv.hasIssued === true) return deny(R.RESERVATION_ACTIVE);
    if (!operationId) return deny(R.UNKNOWN_ACTION);
    const prev = parseCouponAudit(held.source);
    const fields = binding.buildClearFields({
      kind: COUPON_OPERATION_SOURCE.correct, actor, atIso, reason, operationId,
      prevClaimedAtIso: held.claimedAtIso || '',
      prevSource: prev.byAdmin ? prev.kind : (prev.raw || ''),
    });
    if (!fields) return deny(R.FIELD_ALLOW_LIST);
    return { ok: true, operation, target: 'holding', fields, atIso, anchor, operationId };
  }

  return deny(R.UNKNOWN_ACTION);
}

/**
 * 画面のボタン活性（**案内であって根拠ではない**）。
 * 実際の可否は `resolveCouponOperationPlan` が再判定する。
 */
export function describeCouponOperationAvailability({
  holding, reservations, binding, env,
} = {}) {
  const O = COUPON_OPERATION;
  const R = COUPON_REJECT;
  const rv = reservations || {};
  const held = holding || { claimed: false };
  const mk = (operation, blockedBy) => ({
    action: operation,
    label: COUPON_OPERATION_LABEL[operation],
    enabled: !blockedBy,
    blockedBy: blockedBy ? COUPON_REJECT_TEXT[blockedBy] : '',
  });

  if (rv.available !== true) {
    // 台帳が読めないときは**全操作を伏せる**（押せるように見せない）
    return {
      actions: [O.GRANT, O.REVOKE_RESERVATION, O.REDEEM_RESERVATION, O.CORRECT, O.REISSUE]
        .map((o) => mk(o, R.LEDGER_UNAVAILABLE)),
      history: null,
      redeemed: null,
      ledgerAvailable: false,
    };
  }
  const storage = !!binding && binding.isStorageEnabled(env) === true;
  const base = rv.hasRedeemed === true ? R.ALREADY_REDEEMED
    : (!storage ? R.STORAGE_DISABLED
      : (rv.hasIssued === true ? R.RESERVATION_ACTIVE : null));
  const history = describeCouponHistory(held);
  const claimBase = base || (held.claimed === true ? R.ALREADY_CLAIMED : null);
  const grantBlock = claimBase || (history.had ? R.HISTORY_EXISTS : null);
  const reissueBlock = claimBase || (history.had ? null : R.NO_HISTORY);
  const correctBlock = base || (held.claimed !== true ? R.NOT_CLAIMED : null);
  const revokeBlock = rv.hasIssued === true ? null
    : (rv.count ? R.RESERVATION_NOT_REVOCABLE : R.NO_RESERVATION);
  // 使用済みにできるのは「入金確認待ちの予約がある」ときだけ
  const redeemBlock = rv.hasRedeemed === true ? R.ALREADY_REDEEMED
    : (rv.hasIssued === true ? null
      : (rv.count ? R.RESERVATION_NOT_REDEEMABLE : R.NO_RESERVATION));

  return {
    actions: [
      mk(O.GRANT, grantBlock),
      mk(O.REVOKE_RESERVATION, revokeBlock),
      mk(O.REDEEM_RESERVATION, redeemBlock),
      mk(O.CORRECT, correctBlock),
      mk(O.REISSUE, reissueBlock),
    ],
    history,
    redeemed: rv.hasRedeemed === true,
    ledgerAvailable: true,
    storageReady: storage,
  };
}
