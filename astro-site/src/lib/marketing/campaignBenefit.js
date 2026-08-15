/**
 * 「そのメールは受け取る人に何の得があるか」を宣言させる（純粋・単一源）。
 *
 * ── なぜ ────────────────────────────────────────────────────
 * 得の無い一斉送信は、開かれないだけでなく迷惑メール報告を集め、
 * **ドメイン評価を落として届けたい相手にも届かなくする**。
 * 大量配信では「受信者の具体的メリット」を宣言していないキャンペーンを
 * **構造的に送れなくする**（fail closed）。
 *
 * 少数への手動送信（テスト・個別対応）まで縛ると運用が回らないので、
 * **閾値を超える配信にだけ**適用する。
 */

/** 認めるメリットの種類。ここに無いものは大量配信できない。 */
export const BENEFIT_TYPE = Object.freeze({
  /** Light / Premium の期間限定無料利用 */
  FREE_ACCESS: 'free_access',
  /** 価格の割引・特別価格 */
  DISCOUNT: 'discount',
  /** 通常は有料の分析・指数・予想の開放 */
  CONTENT_UNLOCK: 'content_unlock',
  /** 明確な新機能 / 新サービス */
  NEW_FEATURE: 'new_feature',
  /** 上記以外で、受信者に直接価値がある特典 */
  EXCLUSIVE_PERK: 'exclusive_perk',
  /**
   * **無料で見られる範囲の案内**（新しい権利は付かない）。
   *
   * 無料体験が終わった方への案内のように、「いま無料で何が見られるか」を伝えるもの。
   * `free_access`（期間限定で有料プランを無料開放）とは別物なので分けている。
   * ⚠️ これを `free_access` と書くと「まだ無料で使える」という誤解になる。
   */
  FREE_CONTENT: 'free_content',
  /** 運用テスト専用（一般顧客へは構造的に送れないキャンペーンだけ） */
  OPERATIONAL_TEST: 'operational_test',
});

const VALID = new Set(Object.values(BENEFIT_TYPE));

/**
 * 大量配信とみなす人数。これ以下なら benefit 未宣言でも送れる
 * （個別対応・少数テストを止めない）。
 */
export const BULK_THRESHOLD = 200;

export const BENEFIT_REJECT = Object.freeze({
  MISSING_TYPE: 'benefit_type_missing',
  UNKNOWN_TYPE: 'benefit_type_unknown',
  MISSING_DESCRIPTION: 'benefit_description_missing',
  DESCRIPTION_TOO_VAGUE: 'benefit_description_too_vague',
  BULK_NOT_ALLOWED: 'bulk_send_not_allowed',
});

/**
 * 「サイトを見てください」だけの文言を弾く。
 * **具体的な得**が書かれているかを、人が読まなくても最低限ふるいに掛ける。
 */
const VAGUE_ONLY = [
  'サイトを見て', 'ご覧ください', 'チェックして', 'お知らせします',
  '更新しました', '公開しました', 'ご案内します',
];

export function isTooVague(description) {
  const d = String(description || '').trim();
  if (d.length < 15) return true; // 具体的な得を 15 文字未満で書けない
  // 「見てください」系の語しか無い＝得が書かれていない
  const hasVague = VAGUE_ONLY.some((v) => d.includes(v));
  const hasConcrete = /無料|割引|OFF|円|開放|限定|特典|新機能|プレゼント|延長|付与|特別価格|優待|先行/.test(d);
  return hasVague && !hasConcrete;
}

/**
 * キャンペーンが大量配信してよいかを判定する。
 *
 * @param {{campaign: object, recipientCount: number, bulkThreshold?: number}} input
 * @returns {{ok: boolean, reason: string|null, bulk: boolean}}
 */
export function checkBenefitForSend({ campaign, recipientCount, bulkThreshold = BULK_THRESHOLD } = {}) {
  const c = campaign || {};
  const n = Number(recipientCount);
  const bulk = Number.isFinite(n) && n > bulkThreshold;

  // 少数配信は従来どおり（個別対応・テストを止めない）
  if (!bulk) return { ok: true, reason: null, bulk: false };

  // 大量配信では宣言が要る（**未設定は送れない** = fail closed）
  if (c.bulkSendAllowed === false) {
    return { ok: false, reason: BENEFIT_REJECT.BULK_NOT_ALLOWED, bulk: true };
  }
  const type = String(c.benefitType || '').trim();
  if (!type) return { ok: false, reason: BENEFIT_REJECT.MISSING_TYPE, bulk: true };
  if (!VALID.has(type)) return { ok: false, reason: BENEFIT_REJECT.UNKNOWN_TYPE, bulk: true };

  const desc = String(c.benefitDescription || '').trim();
  if (!desc) return { ok: false, reason: BENEFIT_REJECT.MISSING_DESCRIPTION, bulk: true };
  if (isTooVague(desc)) return { ok: false, reason: BENEFIT_REJECT.DESCRIPTION_TOO_VAGUE, bulk: true };

  return { ok: true, reason: null, bulk: true };
}

export const BENEFIT_REJECT_LABEL = Object.freeze({
  [BENEFIT_REJECT.MISSING_TYPE]: '受信者のメリット（benefitType）が未設定です',
  [BENEFIT_REJECT.UNKNOWN_TYPE]: 'benefitType が認められていない値です',
  [BENEFIT_REJECT.MISSING_DESCRIPTION]: 'メリットの具体的な説明（benefitDescription）がありません',
  [BENEFIT_REJECT.DESCRIPTION_TOO_VAGUE]: 'メリットの説明が「見てください」だけで具体的な得がありません',
  [BENEFIT_REJECT.BULK_NOT_ALLOWED]: 'このキャンペーンは大量配信が禁止されています（再利用にはメリットの確認が必要）',
});
