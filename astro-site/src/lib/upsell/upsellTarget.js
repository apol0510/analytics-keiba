/**
 * upsellTarget.js — 「この会員にどの商品を売る導線を見せるか」の単一源（純粋・I/O なし）
 *
 * ── これは販売導線の選択であって、権利の正本ではない ─────────────────
 * `UpsellTarget` は **表示する CTA を選ぶだけ**のフィールド。
 * 会員権・決済・entitlement の正本ではない。
 *   - 何を閲覧できるか      … `entitlements/resolveEntitlements.js`
 *   - Plus を売ってよいか    … `PremiumPlusEligibility` / `premiumPlusRelease.js`
 *   - 三連複を買えるか      … `canPurchaseSanrenpuku`（有料 Premium かつ未保有）
 * UpsellTarget でこれらを上書きしない。**各商品固有の権限条件は必ず再評価する**。
 *
 * ── 1 会員に 2 商品を同時に見せない ───────────────────────────────
 * Premium 会員に「三連複」と「Premium Plus」を並べると選べなくなる。
 * この resolver は **channel を 1 つだけ**返し、選ばれなかった側の表示フラグは
 * すべて false に落とす（呼び出し側で分岐を再実装しない）。
 *
 * ── 未設定は auto（後方互換）───────────────────────────────────
 * Airtable に `UpsellTarget` が無い / 空 / 未知の値 → すべて `auto`。
 * 既存 1,400 件超への一括書き込み（migration）は不要。
 *
 * ── auto は既存の段階表示を壊さない ───────────────────────────────
 * auto の三連複導線は従来どおり `sanrenpuku/sanrenpukuCtaStage.js` の段階表示
 * （1〜3 日目は予告 / 4 日目以降に CTA / dismiss 可）に**そのまま従う**。
 * auto だからといって即時 CTA には**しない**。
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import {
  resolvePremiumPlusRelease, resolvePlusPauseNoticeView, resolvePlusAudienceView, PP_INTAKE,
} from '../premiumPlus/premiumPlusRelease.js';
import { resolveSaleTarget } from '../premiumPlus/premiumPlusSaleDate.js';

/** 管理者が選ぶ値。Airtable `UpsellTarget`（singleSelect）と 1:1。 */
export const UPSELL_TARGET = Object.freeze({
  /** システム自動判定（既定・未設定と同義） */
  AUTO: 'auto',
  /** 三連複の導線だけ（段階表示は維持） */
  SANRENPUKU: 'sanrenpuku',
  /** Premium Plus の導線だけ */
  PLUS: 'plus',
  /** 販売導線を出さない（会員機能はそのまま） */
  NONE: 'none',
});

/** Airtable のフィールド名（正本） */
export const UPSELL_TARGET_FIELD = 'UpsellTarget';

/** 管理画面表示用ラベル */
export const UPSELL_TARGET_LABEL = Object.freeze({
  auto: '自動',
  sanrenpuku: '三連複',
  plus: 'Plus',
  none: 'なし',
});

/** 実際に顧客へ出す導線（1 つだけ） */
export const UPSELL_CHANNEL = Object.freeze({
  SANRENPUKU: 'sanrenpuku',
  PLUS: 'plus',
  NONE: 'none',
});

/** 「なぜその表示になったか」。管理画面が設定値と実表示を区別して出すために使う。 */
export const UPSELL_REASON = Object.freeze({
  ADMIN_NONE: 'admin_none',
  ADMIN_PLUS: 'admin_plus',
  ADMIN_SANRENPUKU: 'admin_sanrenpuku',
  AUTO_PLUS_SALE: 'auto_plus_sale',
  AUTO_SANRENPUKU: 'auto_sanrenpuku',
  AUTO_PLUS_TEASER: 'auto_plus_teaser',
  NOT_LOGGED_IN: 'not_logged_in',
  SANRENPUKU_OWNED: 'sanrenpuku_owned',
  SANRENPUKU_NOT_ELIGIBLE: 'sanrenpuku_not_eligible',
  PLUS_NOT_ELIGIBLE: 'plus_not_eligible',
  /** 会員単位で Plus の販売を一時停止している（資格はそのまま） */
  PLUS_SALE_PAUSED: 'plus_sale_paused',
  NOTHING_TO_SELL: 'nothing_to_sell',
});

export const UPSELL_REASON_LABEL = Object.freeze({
  admin_none: '管理者が「表示しない」を指定',
  admin_plus: '管理者が Plus を指定',
  admin_sanrenpuku: '管理者が三連複を指定',
  auto_plus_sale: '自動（Plus 販売対象）',
  auto_sanrenpuku: '自動（三連複の段階表示）',
  auto_plus_teaser: '自動（Plus 予告）',
  not_logged_in: 'ログインしていない / アカウント無効',
  sanrenpuku_owned: '三連複を保有済み',
  sanrenpuku_not_eligible: '三連複の購入資格なし',
  plus_not_eligible: 'Plus の販売対象外（資格・phase・route）',
  plus_sale_paused: 'Plus の販売を一時停止中（この会員のみ・資格は保持）',
  nothing_to_sell: '販売できる商品がない',
});

/** `UpsellTarget` の生値 → 正規値。未設定・未知は `auto`（後方互換・fail safe）。 */
export function normalizeUpsellTarget(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === UPSELL_TARGET.SANRENPUKU) return UPSELL_TARGET.SANRENPUKU;
  if (v === UPSELL_TARGET.PLUS) return UPSELL_TARGET.PLUS;
  if (v === UPSELL_TARGET.NONE) return UPSELL_TARGET.NONE;
  return UPSELL_TARGET.AUTO;
}

/** Airtable Customers の fields から取り出す（フィールド未作成でも安全に auto） */
export function readUpsellTarget(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  return normalizeUpsellTarget(f[UPSELL_TARGET_FIELD]);
}

/**
 * `UpsellTarget` への**書き込み**が有効か。
 * 本番 Airtable にフィールドを作るまで false（未作成フィールドへ PATCH すると 422 になり、
 * 同じ PATCH の他の更新まで巻き添えで失敗する）。読み取りは gate 不要（未設定 = auto）。
 */
export function isUpsellFieldEnabled(env) {
  return !!env && env.UPSELL_TARGET_FIELD_READY === '1';
}

const OFF_SANRENPUKU = Object.freeze({
  allowed: false, stage: 'hidden', teaser: 'none', showCta: false, showResult: false,
});
const OFF_PLUS = Object.freeze({
  allowed: false, showTeaser: false, showProductPage: false,
  showPurchaseCta: false, purchaseEnabled: false, phase: 0, intake: null,
});

/**
 * 顧客側に出す販売導線を 1 つ決める。
 *
 * @param {object} input
 * @param {unknown} input.target        Airtable `UpsellTarget` の生値（未設定可）
 * @param {object}  input.entitlements  `resolveEntitlements()` の戻り値
 * @param {object}  [input.plusRelease] `resolvePremiumPlusRelease()` の戻り値（無ければ Plus 非対象）
 * @param {object}  [input.sanrenpukuStage] `planSanrenpukuDisplay()` の戻り値。
 *   クライアントでのみ確定する（localStorage の初回閲覧時刻・dismiss）。
 *   サーバー側では省略でき、その場合 channel だけを決めて段階表示はクライアントに委ねる。
 * @returns {{
 *   target: string, channel: string, reason: string, reasonLabel: string,
 *   sanrenpuku: { allowed: boolean, stage: string, teaser: string, showCta: boolean, showResult: boolean },
 *   plus: { allowed: boolean, showTeaser: boolean, showProductPage: boolean,
 *           showPurchaseCta: boolean, purchaseEnabled: boolean, phase: number, intake: string|null },
 * }}
 */
export function resolveUpsellDisplay({ target, entitlements, plusRelease, sanrenpukuStage } = {}) {
  const t = normalizeUpsellTarget(target);
  const ent = entitlements || {};
  const rel = plusRelease || null;

  const out = (channel, reason, over = {}) => ({
    target: t,
    channel,
    reason,
    reasonLabel: UPSELL_REASON_LABEL[reason] || reason,
    sanrenpuku: { ...OFF_SANRENPUKU },
    plus: { ...OFF_PLUS },
    ...over,
  });

  // ── ログインできない / アカウント無効は何も売らない（fail closed）──
  if (ent.canLogin !== true) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.NOT_LOGGED_IN);

  // ── 各商品固有の権限条件（UpsellTarget では上書きしない）────────
  // 三連複: 有料 Premium 有効 かつ 未保有（保有済みは再購入 CTA を出さない）
  const srpEligible = ent.canPurchaseSanrenpuku === true;
  const srpOwned = ent.canViewSanrenpuku === true;
  // Plus: 既存 resolver が「商品ページを出してよい」と判定していること
  const plusSaleReady = !!rel && rel.showPurchaseCta === true;   // phase 4（override 含む）
  const plusTeaserReady = !!rel && rel.showTeaser === true;      // phase 2 以上
  const plusAnyReady = plusSaleReady || plusTeaserReady;
  // 会員単位の一時停止。`rel` 側で既に全フラグが false になっているので**導線は塞がる**が、
  // 理由まで「対象外」に丸めると管理画面で再開すべき相手が見分けられなくなる。
  // ⚠️ Plus だけを止める。三連複の導線には影響させない。
  const plusPaused = !!rel && rel.salePaused === true;

  const sanrenpukuView = () => {
    const s = sanrenpukuStage || null;
    return {
      allowed: true,
      stage: s ? s.stage : 'unknown',
      teaser: s ? s.teaser : 'none',
      showCta: s ? s.showCta === true : false,
      showResult: s ? s.showResult === true : false,
    };
  };
  const plusView = () => ({
    allowed: true,
    showTeaser: rel.showTeaser === true,
    showProductPage: rel.showProductPage === true,
    showPurchaseCta: rel.showPurchaseCta === true,
    purchaseEnabled: rel.purchaseEnabled === true,
    phase: Number(rel.phase) || 0,
    intake: rel.intake ?? null,
  });

  // ── 判定順: none > plus > sanrenpuku > auto ──────────────────
  if (t === UPSELL_TARGET.NONE) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.ADMIN_NONE);

  if (t === UPSELL_TARGET.PLUS) {
    // 明示指定でも Plus 側の権限条件（route / eligibility / phase）は再評価する
    if (plusPaused) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.PLUS_SALE_PAUSED);
    if (!plusAnyReady) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.PLUS_NOT_ELIGIBLE);
    return out(UPSELL_CHANNEL.PLUS, UPSELL_REASON.ADMIN_PLUS, { plus: plusView() });
  }

  if (t === UPSELL_TARGET.SANRENPUKU) {
    // 保有済みは再購入 CTA を出さない。**Plus へ勝手にフォールバックしない**
    if (srpOwned) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.SANRENPUKU_OWNED);
    if (!srpEligible) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.SANRENPUKU_NOT_ELIGIBLE);
    return out(UPSELL_CHANNEL.SANRENPUKU, UPSELL_REASON.ADMIN_SANRENPUKU, { sanrenpuku: sanrenpukuView() });
  }

  // ── auto ────────────────────────────────────────────────────
  // 1) Plus の「明示的な販売対象」（phase 4 / 即時販売）が最優先
  if (plusSaleReady) return out(UPSELL_CHANNEL.PLUS, UPSELL_REASON.AUTO_PLUS_SALE, { plus: plusView() });
  // 2) それ以外は既存の三連複 段階表示（即時 CTA にはしない）
  if (srpEligible) return out(UPSELL_CHANNEL.SANRENPUKU, UPSELL_REASON.AUTO_SANRENPUKU, { sanrenpuku: sanrenpukuView() });
  // 3) 三連複を売れない相手にだけ Plus の予告を出す（同時表示を作らない）
  if (plusTeaserReady) return out(UPSELL_CHANNEL.PLUS, UPSELL_REASON.AUTO_PLUS_TEASER, { plus: plusView() });
  // 4) どちらでもない。
  //    ⚠️ 一時停止が理由のときはそう言う。「三連複を保有済み」「販売できる商品がない」に
  //       丸めると、止めた事実が管理画面から消えて再開されないまま放置される。
  if (plusPaused) return out(UPSELL_CHANNEL.NONE, UPSELL_REASON.PLUS_SALE_PAUSED);
  return out(UPSELL_CHANNEL.NONE, srpOwned ? UPSELL_REASON.SANRENPUKU_OWNED : UPSELL_REASON.NOTHING_TO_SELL);
}

/**
 * `UpsellTarget` から Premium Plus 側へ渡す管理者フラグを導出する（**唯一の導出元**）。
 *
 * 顧客側（`resolveUpsellForCustomer`）と管理プレビュー（`premiumPlusPreview.js`）が
 * **同じ導出**を使うためにここへ切り出す。呼び出し側で条件を書き直さないこと。
 *
 *   adminPlusTarget      … ROUTE B の「加入 30 日以上 / PaidAt あり」を免除するか
 *                          （`UpsellTarget=plus` または `PremiumPlusReleaseOverride=phase4`）
 *   adminPlusAuthorized  … 販売資格 review / 未設定を免除するか（**明示指定のときだけ**）
 *
 * ⚠️ `blocked` は免除しない。Airtable の `PremiumPlusEligibility` も書き換えない。
 * ⚠️ auto / sanrenpuku / none では `adminPlusAuthorized` を立てない
 *    （既存の自動判定の意味を変えないため）。
 *
 * @param {{ target: string, member?: { releaseOverride?: string|null } }} input
 */
export function resolvePlusAdminFlags({ target, member } = {}) {
  const t = normalizeUpsellTarget(target);
  const isPlus = t === UPSELL_TARGET.PLUS;
  return {
    adminPlusTarget: isPlus || (member && member.releaseOverride === 'phase4') === true,
    adminPlusAuthorized: isPlus,
  };
}

/**
 * Airtable の 1 レコードから販売導線を決める（純粋・I/O なし）。
 * サーバー側（API / 管理一覧）の唯一の入口。呼び出し側で判定を組み立て直さない。
 *
 * ⚠️ `adminPlusTarget` をここで渡すのが要点。管理者が Plus を明示指定した有効 Premium は、
 *    `PaidAt` が空でも（ROUTE C として）販売対象になる。資格・phase・受付時間の判定は不変。
 *
 * `targetOverride` は **管理画面の説明生成専用**（`upsellExplain.js` が「auto ならどうなるか」を
 * 求めるために使う）。未指定なら従来どおり fields の `UpsellTarget` を読む。顧客向け経路では
 * 渡さないこと（guard テストで固定）。Airtable への書き込みは一切発生しない。
 *
 * @param {{ fields: object|null, nowMs?: number, sanrenpukuStage?: object, fallbackAnchor?: unknown,
 *          targetOverride?: unknown }} input
 */
export function resolveUpsellForCustomer({
  fields, nowMs = Date.now(), sanrenpukuStage, fallbackAnchor, targetOverride,
  // 開催の例外リスト（中央・南関とも開催が無い日）。**未指定でも販売は続く**
  raceCalendar,
} = {}) {
  const target = targetOverride === undefined
    ? readUpsellTarget(fields)
    : normalizeUpsellTarget(targetOverride);
  const entitlements = resolveEntitlements(fromAirtableFields(fields || {}), nowMs);
  const member = resolvePlusMemberFromFields(fields, { nowMs, fallbackAnchor });
  // いま売るのは何日分か。既定は販売可で、例外日だけ次の販売日へ送る
  const saleTarget = resolveSaleTarget(nowMs, { calendar: raceCalendar });
  const adminFlags = resolvePlusAdminFlags({ target, member });
  // 16:30 以降は翌日分（例外日なら次の販売日分）を売る
  const nextDaySellable = saleTarget.isNextDay && saleTarget.sellable === true;
  const plusRelease = resolvePremiumPlusRelease({
    ...member,
    ...adminFlags,
    nowMs,
    nextDaySellable,
  });
  const view = resolveUpsellDisplay({ target, entitlements, plusRelease, sanrenpukuStage });
  // ── 受付休止ページ（停止中に直 URL で来たお客様への案内）────────────
  // 停止していない会員では常に false ＝ 既存の 404 挙動も CTA も一切変わらない。
  // ⚠️ 管理者が Plus 以外の導線を指定している会員には出さない。
  //    `none` は「販売導線を出さない」、`sanrenpuku` は「三連複だけを見せる」という
  //    管理者の判断なので、休止案内で Plus の存在を知らせてはいけない。
  // ── Plus の対象会員か（**販売停止に依存しない**）────────────────────
  // クーポンの取得資格は「停止中かどうか」ではなく「Plus の対象で、再募集が開始済みか」で決める。
  // ⚠️ 再募集の開始は販売停止の解除を含むので、停止を条件にすると
  //    **開始した瞬間に取得できなくなる**（2026-08-22 に判明した不整合）。
  const plusAudience = (() => {
    const v = resolvePlusAudienceView({
      ...member, ...adminFlags, nowMs, nextDaySellable,
    });
    const targetAllows = target === UPSELL_TARGET.AUTO || target === UPSELL_TARGET.PLUS;
    return { ...v, isPlusAudience: v.wouldShowProductPage === true && targetAllows };
  })();
  const pauseNotice = (() => {
    // ⚠️ release と**同じ入力**で解く。片方だけ条件を足すと
    //    「商品ページは 404 なのに休止案内は出る」ようなズレが生まれる。
    const v = resolvePlusPauseNoticeView({
      ...member,
      ...adminFlags,
      nowMs,
      nextDaySellable,
    });
    const targetAllows = target === UPSELL_TARGET.AUTO || target === UPSELL_TARGET.PLUS;
    return { ...v, showPauseNotice: v.showPauseNotice === true && targetAllows };
  })();
  return { ...view, entitlements, plusRelease, member, saleTarget, pauseNotice, plusAudience };
}

/** 管理画面の「実表示」列に出す短い説明 */
export function describeUpsellDisplay(view) {
  if (!view) return '';
  if (view.channel === UPSELL_CHANNEL.PLUS) {
    // ⚠️ 2026-08-13〜 16:30 以降は「受付時間外」ではなく**翌日分の受付中**。
    //    ただし翌日に開催が無い / 確認できないときは CLOSED（売らない）のまま。
    //    「売らない」と「別の日を売る」を同じ状態にしないため、専用値で判定する。
    if (view.plus.showPurchaseCta) {
      if (!view.plus.purchaseEnabled) return 'Plus CTA（操作不可）';
      return view.plus.intake === PP_INTAKE.NEXT_DAY_OPEN ? 'Plus CTA（翌日分受付中）' : 'Plus CTA';
    }
    return 'Plus 予告';
  }
  if (view.channel === UPSELL_CHANNEL.SANRENPUKU) {
    if (view.sanrenpuku.showCta) return '三連複CTA';
    if (view.sanrenpuku.teaser === 'day2' || view.sanrenpuku.teaser === 'day3') return `三連複予告(${view.sanrenpuku.teaser})`;
    if (view.sanrenpuku.stage === 'unknown') return '三連複（段階表示）';
    return '三連複（表示待ち）';
  }
  return '表示なし';
}
