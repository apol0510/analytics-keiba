/**
 * upsellExplain.js — 管理画面向け「なぜこの CTA が出ているのか」の説明生成（純粋・I/O なし）
 *
 * ── これは説明レイヤーであって判定ではない ────────────────────────
 * CTA の判定は `upsellTarget.js`（`resolveUpsellDisplay` / `resolveUpsellForCustomer`）と
 * `premiumPlusRelease.js` が正本。このモジュールは **その結果を読んで日本語にするだけ**で、
 * しきい値・優先順位・fail closed 条件を一切持たない。判定を再実装しないこと。
 *
 * ── 管理者が区別できるようにする 3 つの値 ──────────────────────────
 *   1. 自動判定 CTA      … UpsellTarget を無視して auto で解決したらどうなるか
 *   2. 現在の設定        … Airtable の UpsellTarget（自動 / 三連複 / Plus / なし）
 *   3. 実際に出る CTA    … 1 と 2 を踏まえた最終結果（顧客側 resolver と同一）
 * 管理者が手動指定している間も「自動なら何が出るか」を並べて見せる。
 *
 * ── 経過日数を捏造しない ────────────────────────────────────────
 * `PaidAt` は 2026-07-10 の入金確認フロー刷新以降しか書かれておらず、旧会員は構造的に空。
 * 経過日数が取れないときは推測せず「加入日（PaidAt）が未記録」と明示する。
 */

import {
  PP_ROUTE,
  PP_ELIGIBILITY,
  PP_ELIGIBILITY_LABEL,
  PREMIUM_30D_DAYS,
} from '../premiumPlus/premiumPlusRelease.js';
import {
  UPSELL_TARGET,
  UPSELL_CHANNEL,
  UPSELL_REASON,
  UPSELL_TARGET_LABEL,
  describeUpsellDisplay,
  normalizeUpsellTarget,
  readUpsellTarget,
  resolveUpsellForCustomer,
} from './upsellTarget.js';

/** 顧客に出る CTA の日本語名（管理画面表示用） */
export const UPSELL_CHANNEL_LABEL = Object.freeze({
  sanrenpuku: '三連複',
  plus: 'Plus',
  none: 'なし',
});

export const ROUTE_LABEL = Object.freeze({
  sanrenpuku: 'A（三連複購入者）',
  premium_30d: `B（Premium ${PREMIUM_30D_DAYS}日）`,
  premium_admin: 'C（管理者指定）',
  none: '対象外',
});

/**
 * 「自動」を選んだときに何が起きるかの説明（管理画面に常設する）。
 * 優先順位の正本は `resolveUpsellDisplay` の auto 分岐。ここは**その文章化**であり、
 * 順序を変えるときは必ず両方を直す（guard テストで対応を固定している）。
 */
export const UPSELL_AUTO_RULE_TEXT = Object.freeze([
  'Plus の販売条件が成立している → Plus のみ表示',
  'それ以外で三連複を購入できる → 三連複のみ表示',
  'どちらでもなく Plus の予告段階 → Plus の予告のみ表示',
  '2 商品を同時に表示することはありません',
]);

/**
 * 経過日数の表示文字列。取れないときは推測しない。
 *
 * ⚠️ `daysSincePremium = null` には**意味の異なる 2 通り**がある。混同しないこと。
 *   1. ROUTE A（三連複保有）… `resolvePlusRoute` が最初に短絡して常に null を返す。
 *      三連複保有者に「Premium 加入からの 30 日」は無関係なので**判定対象外**であって、
 *      PaidAt が無いという意味ではない（実データでは PaidAt があるのに null になる）。
 *   2. PaidAt が本当に無い … 2026-07-10 の入金確認フロー刷新より前の会員は構造的に空。
 *
 * 1 を「未記録」と表示すると、データ欠損だと誤読させる（2026-08-07 の表示不備）。
 *
 * @param {number|null} days   `resolvePremiumPlusRelease().daysSincePremium`
 * @param {{ route?: string, hasPaidAt?: boolean }} [opts]
 */
export function describeDaysSincePremium(days, opts = {}) {
  const { route, hasPaidAt } = opts || {};
  if (route === PP_ROUTE.SANRENPUKU) {
    return 'ROUTE A（三連複保有）のため判定対象外';
  }
  if (typeof days === 'number' && Number.isFinite(days)) return `${days} 日`;
  // ROUTE A 以外で日数が出ないのは PaidAt が読めないとき。
  // PaidAt があるのに算出できない場合は、その事実をそのまま出す（未記録と言い切らない）。
  if (hasPaidAt === true) return '加入日（PaidAt）はあるが経過日数を算出できません';
  return '加入日（PaidAt）が未記録';
}

/** 経過日数を理由文へ差し込む断片（null のときは日数を語らない）。 */
function daysClause(days) {
  return typeof days === 'number' && Number.isFinite(days)
    ? `${PREMIUM_30D_DAYS}日以上経過（${days}日）`
    : `${PREMIUM_30D_DAYS}日以上経過`;
}

/**
 * CTA が「なぜそうなったか」を具体的な日本語 1 文にする。
 *
 * @param {object} view    `resolveUpsellDisplay` / `resolveUpsellForCustomer` の戻り値
 * @param {object} release `resolvePremiumPlusRelease` の戻り値（route / phase / eligibility）
 * @returns {string}
 */
export function describeUpsellReasonText(view, release) {
  if (!view) return '';
  const rel = release || {};
  const route = rel.route || PP_ROUTE.NONE;
  const days = rel.daysSincePremium;
  const phase = Number(rel.phase) || 0;

  switch (view.reason) {
    // ── 管理者の手動指定 ────────────────────────────────────
    case UPSELL_REASON.ADMIN_NONE:
      return '管理者が「なし」を指定しているため、販売導線を表示していません';
    case UPSELL_REASON.ADMIN_PLUS:
      return '管理者が Plus を指定しているため Plus を表示しています（販売資格・phase は再判定済み）';
    case UPSELL_REASON.ADMIN_SANRENPUKU:
      return '管理者が三連複を指定しているため三連複を表示しています（購入資格は再判定済み）';

    // ── auto ────────────────────────────────────────────────
    case UPSELL_REASON.AUTO_PLUS_SALE:
      if (route === PP_ROUTE.PREMIUM_30D) {
        return `Premium加入から${daysClause(days)}・三連複未購入のため Plus を自動表示`;
      }
      if (route === PP_ROUTE.SANRENPUKU) {
        return '三連複購入者で Plus の販売条件が成立しているため Plus を自動表示';
      }
      if (route === PP_ROUTE.PREMIUM_ADMIN) {
        return '管理者が Plus 販売対象に指定した Premium 会員のため Plus を自動表示';
      }
      return 'Plus の販売条件が成立しているため Plus を自動表示';

    case UPSELL_REASON.AUTO_PLUS_TEASER:
      return `三連複を販売できない会員で Plus が予告段階（PHASE ${phase}）のため、Plus の予告のみ自動表示`;

    case UPSELL_REASON.AUTO_SANRENPUKU:
      if (route === PP_ROUTE.PREMIUM_30D) {
        return `三連複を購入できるため三連複を自動表示（Plus は ROUTE B 成立済みだが販売条件が未成立）`;
      }
      if (typeof days === 'number' && Number.isFinite(days)) {
        return `三連複を購入できるため三連複を自動表示（Premium加入から${days}日／Plus は${PREMIUM_30D_DAYS}日以上で対象）`;
      }
      return `三連複を購入できるため三連複を自動表示（Plus は加入日（PaidAt）が未記録のため${PREMIUM_30D_DAYS}日判定ができません）`;

    // ── 何も出ない ──────────────────────────────────────────
    case UPSELL_REASON.NOT_LOGGED_IN:
      return 'アカウントが無効、または会員としてログインできない状態です';
    case UPSELL_REASON.SANRENPUKU_OWNED:
      return '三連複を保有済みのため再購入 CTA は表示しません';
    case UPSELL_REASON.SANRENPUKU_NOT_ELIGIBLE:
      return '有効な有料 Premium 契約が無いため、三連複の購入資格がありません';
    case UPSELL_REASON.PLUS_NOT_ELIGIBLE:
      return describePlusBlockReason(rel);
    case UPSELL_REASON.PLUS_SALE_PAUSED:
      // ⚠️ 「販売対象外」と書かない。資格は残っていて、再開すれば元に戻る状態。
      return 'この会員の Plus 販売を一時停止中です（販売資格・PHASE は保持したまま。'
        + '管理画面の「販売の一時停止」から再開できます）';
    case UPSELL_REASON.NOTHING_TO_SELL:
      return describeNothingToSell(rel);
    default:
      return view.reasonLabel || '';
  }
}

/** Plus が出ない具体的な理由（route → 資格 → phase の順に、最初に当たったものだけ返す）。 */
function describePlusBlockReason(rel) {
  const route = rel.route || PP_ROUTE.NONE;
  const days = rel.daysSincePremium;
  if (route === PP_ROUTE.NONE) {
    if (typeof days !== 'number' || !Number.isFinite(days)) {
      return `Plus の販売対象外（加入日（PaidAt）が未記録のため ROUTE B の${PREMIUM_30D_DAYS}日判定ができません）`;
    }
    return `Plus の販売対象外（Premium加入から${days}日で${PREMIUM_30D_DAYS}日に未達）`;
  }
  const elig = rel.eligibility;
  if (elig && elig !== PP_ELIGIBILITY.ELIGIBLE) {
    return `Plus の販売対象外（販売資格が「${PP_ELIGIBILITY_LABEL[elig] || elig}」）`;
  }
  return `Plus の販売対象外（PHASE ${Number(rel.phase) || 0}／段階公開の待機中）`;
}

/** 売れる商品が 1 つも無い理由。 */
function describeNothingToSell(rel) {
  const days = rel.daysSincePremium;
  // ROUTE A は経過日数を見ないので、null を PaidAt 欠損として語らない
  if (rel.route === PP_ROUTE.SANRENPUKU) {
    return '販売できる商品がありません（三連複は保有済み／Plus は販売条件が未成立）';
  }
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    return '販売できる商品がありません（加入日（PaidAt）が未記録のため経過日数は判定できません）';
  }
  return `販売できる商品がありません（Premium加入から${days}日／三連複の購入資格なし）`;
}

/**
 * 管理画面の詳細パネル向けに、自動判定・現在の設定・実表示をまとめて返す。
 *
 * **read-only**。Airtable への書き込み用フィールドを一切組み立てない。
 * PII（Email / 氏名 / recordId）は含めない — 呼び出し側が必要に応じて別途付ける。
 *
 * @param {{ fields: object|null, nowMs?: number, fallbackAnchor?: unknown }} input
 */
export function explainUpsell({ fields, nowMs = Date.now(), fallbackAnchor } = {}) {
  // 現在の設定での結果（＝顧客に実際に出るもの）。顧客側と同一の resolver。
  const effective = resolveUpsellForCustomer({ fields, nowMs, fallbackAnchor });
  const target = readUpsellTarget(fields);
  const isManual = target !== UPSELL_TARGET.AUTO;

  // 「自動ならどうなるか」。手動指定中でも比較できるよう常に計算する。
  // 設定が auto のときは同じ入力なので再計算せず使い回す（結果は必ず一致する）。
  const auto = isManual
    ? resolveUpsellForCustomer({ fields, nowMs, fallbackAnchor, targetOverride: UPSELL_TARGET.AUTO })
    : effective;

  const rel = effective.plusRelease || {};
  const autoRel = auto.plusRelease || {};

  return {
    // 1. 自動判定
    autoChannel: auto.channel,
    autoChannelLabel: UPSELL_CHANNEL_LABEL[auto.channel] || auto.channel,
    autoDisplay: describeUpsellDisplay(auto),
    autoReason: auto.reason,
    autoReasonText: describeUpsellReasonText(auto, autoRel),

    // 2. 現在の設定
    target,
    targetLabel: UPSELL_TARGET_LABEL[target] || target,
    isManual,

    // 3. 実表示
    channel: effective.channel,
    channelLabel: UPSELL_CHANNEL_LABEL[effective.channel] || effective.channel,
    display: describeUpsellDisplay(effective),
    reason: effective.reason,
    reasonText: describeUpsellReasonText(effective, rel),

    // 手動指定が自動判定と違う結果になっているか（管理者への注意喚起用）
    differsFromAuto: effective.channel !== auto.channel,

    // 判断材料（すべて既存 resolver の戻り値をそのまま載せる）
    hasSanrenpuku: effective.member ? effective.member.hasSanrenpuku === true : false,
    premiumActive: effective.member ? effective.member.premiumActive === true : false,
    daysSincePremium: rel.daysSincePremium ?? null,
    // ROUTE A の null（判定対象外）と PaidAt 欠損の null を区別するため、両方を渡す
    hasPaidAt: !!(effective.member && effective.member.premiumPaidAtMs !== null
      && effective.member.premiumPaidAtMs !== undefined),
    daysSincePremiumText: describeDaysSincePremium(rel.daysSincePremium, {
      route: rel.route,
      hasPaidAt: !!(effective.member && effective.member.premiumPaidAtMs !== null
        && effective.member.premiumPaidAtMs !== undefined),
    }),
    route: rel.route || PP_ROUTE.NONE,
    routeLabel: ROUTE_LABEL[rel.route] || rel.route || '対象外',
    phase: Number(rel.phase) || 0,
    eligibility: rel.eligibility ?? null,
    eligibilityLabel: PP_ELIGIBILITY_LABEL[rel.eligibility] || '—',

    // 呼び出し側が同じ解決を二重に走らせないための生の戻り値。
    // ⚠️ member / entitlements を含むため **そのまま JSON 応答に載せない**
    //    （必要な項目だけを呼び出し側が選ぶ）。
    effectiveView: effective,
  };
}

export { UPSELL_TARGET, UPSELL_CHANNEL, normalizeUpsellTarget };
