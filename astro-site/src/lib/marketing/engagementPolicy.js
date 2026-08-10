/**
 * 配信エンゲージメントの分類（純粋・単一源）。
 *
 * ── 目的 ────────────────────────────────────────────────────
 * 反応しない相手へ送り続けると、SendGrid 費用が増えるだけでなく
 * 迷惑メール報告とドメイン評価の悪化を招き、**届けたい相手にも届かなくなる**。
 * 反応の見込みがある相手に絞る。
 *
 * ── 会員資格とは分ける ──────────────────────────────────────
 * ここで決めるのは「**通常のマーケティングメールを送ってよいか**」だけ。
 * Customers レコードは消さないし、会員・決済・権限には一切触れない。
 * 取引メール（決済確認 / 認証 / サポート返信 / 期限通知）には**適用しない**。
 *
 * ── open を絶対視しない ─────────────────────────────────────
 * Apple Mail Privacy Protection や画像ブロックで open は落ちるし、逆に
 * プリフェッチで勝手に立つこともある。したがって:
 *   - open は「反応あり」に**倒す**ためだけに使う（ACTIVE 判定）
 *   - open が無いことを理由に切るのは **delivered が閾値に達してから**
 *   - click / 購入 / ログインは **より強いシグナル**として別枠で見る
 *
 * ⚠️ **2026-08-10 時点で click は構造的に 0**（`MARKETING_CLICK_TRACKING_ENABLED`
 *    が未設定で、Event Webhook の `click` も false）。click を有効なシグナルとして
 *    当てにしない。購入・ログインで補う。
 */

/** 状態。**unsubscribe とは別**（あちらは本人の意思表示） */
export const ENGAGEMENT = Object.freeze({
  /** 反応あり（open / click / 購入 / ログインのいずれか） */
  ACTIVE: 'active',
  /** まだ判断材料が足りない（送信回数が閾値未満） */
  UNKNOWN: 'unknown',
  /** 送ってはいるが反応が無い。**まだ止めない**（観察段階） */
  LOW_ENGAGEMENT: 'low_engagement',
  /** 通常マーケティングから除外 */
  INACTIVE: 'inactive',
  /** 全通常マーケティングから除外 */
  HARD_INACTIVE: 'hard_inactive',
});

/**
 * 閾値は**ここだけ**に置く。コードへ散らさない。
 * env で上書きできるが、既定値は運用合意（5 / 10 / 20）。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** これ以上「送信」して無反応なら LOW_ENGAGEMENT */
  lowEngagementSends: 5,
  /** これ以上「delivered」で無反応なら INACTIVE */
  inactiveDelivered: 10,
  /** これ以上「delivered」で無反応なら HARD_INACTIVE */
  hardInactiveDelivered: 20,
});

const posInt = (v, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

/**
 * env から閾値を解決する。**壊れた値は既定へ倒す**（勝手に緩めない・厳しくしない）。
 * 大小関係が壊れていたら既定へ戻す（inactive < low のような設定を許さない）。
 */
export function resolveThresholds(env = process.env) {
  const t = {
    lowEngagementSends: posInt(env?.MARKETING_LOW_ENGAGEMENT_SENDS, DEFAULT_THRESHOLDS.lowEngagementSends),
    inactiveDelivered: posInt(env?.MARKETING_INACTIVE_DELIVERED, DEFAULT_THRESHOLDS.inactiveDelivered),
    hardInactiveDelivered: posInt(env?.MARKETING_HARD_INACTIVE_DELIVERED, DEFAULT_THRESHOLDS.hardInactiveDelivered),
  };
  if (!(t.lowEngagementSends <= t.inactiveDelivered && t.inactiveDelivered <= t.hardInactiveDelivered)) {
    return { ...DEFAULT_THRESHOLDS };
  }
  return t;
}

const n0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 「意味のある行動」= open より強いシグナル。
 * click は現状ゼロなので、購入とログインが実質の判定材料になる。
 */
export function hasMeaningfulAction(stats) {
  const s = stats || {};
  return n0(s.click) > 0 || n0(s.purchases) > 0 || n0(s.logins) > 0;
}

/** 何らかの反応（open を含む） */
export function hasAnySignal(stats) {
  return hasMeaningfulAction(stats) || n0(stats?.open) > 0;
}

/**
 * 1 人ぶんの分類。
 *
 * @param {{sent?:number, delivered?:number, open?:number, click?:number,
 *          purchases?:number, logins?:number}} stats
 * @param {{thresholds?: object}} [opts]
 * @returns {{state: string, reason: string|null, blocked: boolean}}
 */
export function classifyEngagement(stats, { thresholds } = {}) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  const s = stats || {};
  const sent = n0(s.sent);
  const delivered = n0(s.delivered);

  // 反応があれば無条件で ACTIVE（**将来の購入・ログインでここへ復帰できる**）
  if (hasAnySignal(s)) {
    return { state: ENGAGEMENT.ACTIVE, reason: hasMeaningfulAction(s) ? 'meaningful_action' : 'open', blocked: false };
  }

  // 以降は「反応ゼロ」の人。どれだけ送ったかで段階を分ける。
  if (delivered >= t.hardInactiveDelivered) {
    return { state: ENGAGEMENT.HARD_INACTIVE, reason: 'no_response', blocked: true };
  }
  if (delivered >= t.inactiveDelivered) {
    return { state: ENGAGEMENT.INACTIVE, reason: 'no_response', blocked: true };
  }
  if (sent >= t.lowEngagementSends) {
    // 観察段階。**まだ止めない**（止めると復帰の機会も消える）
    return { state: ENGAGEMENT.LOW_ENGAGEMENT, reason: 'no_response', blocked: false };
  }
  return { state: ENGAGEMENT.UNKNOWN, reason: 'insufficient_data', blocked: false };
}

/** 通常マーケティングを止めるべきか */
export function isBlockedByEngagement(state) {
  return state === ENGAGEMENT.INACTIVE || state === ENGAGEMENT.HARD_INACTIVE;
}

/**
 * ⚠️ 取引メールには**絶対に適用しない**。
 * 決済確認・認証（マジックリンク）・サポート返信・期限通知は、
 * 反応が無くても届けなければならない。
 */
export const ENGAGEMENT_EXEMPT_EMAIL_TYPES = Object.freeze([
  'payment', 'auth', 'support', 'expiry', 'step', 'race_main', 'transactional',
]);

export function appliesToEmailType(emailType) {
  const t = String(emailType || '').trim().toLowerCase();
  if (!t) return false; // 種別不明には適用しない（安全側）
  return !ENGAGEMENT_EXEMPT_EMAIL_TYPES.includes(t);
}

/** 集計（管理画面の 4 区分表示用） */
export function summarizeEngagement(list, { thresholds } = {}) {
  const out = {
    [ENGAGEMENT.ACTIVE]: 0,
    [ENGAGEMENT.LOW_ENGAGEMENT]: 0,
    [ENGAGEMENT.INACTIVE]: 0,
    [ENGAGEMENT.HARD_INACTIVE]: 0,
    [ENGAGEMENT.UNKNOWN]: 0,
  };
  for (const s of Array.isArray(list) ? list : []) {
    const { state } = classifyEngagement(s, { thresholds });
    out[state] = (out[state] || 0) + 1;
  }
  return out;
}
