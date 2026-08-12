/**
 * campaignCatalog.js — マーケティングキャンペーン定義の単一源（純粋・I/O なし）
 *
 * 件名・本文を Function や管理画面へ散らさない。**追加・編集はこのファイルだけ**で完結させる。
 *
 * ── 各キャンペーンが必ず持つもの ────────────────────────────────────
 *   campaignId / version / name / subject / body / recommendedSegments /
 *   ctaUrl / ctaLabel / enabled / audienceRule
 *
 * ── version の意味（冪等性の鍵）────────────────────────────────────
 *   version を上げると DeliveryKey が変わり、**同じ人へもう一度送れる**ようになる。
 *   逆に言えば version を変えない限り同じ相手には二度と送られない。
 *   本文を直したのに version を据え置くと「直した内容が届かない」ので、
 *   実質的な内容変更をしたら必ず version を上げること。
 *
 * ── audienceRule（誤爆防止）──────────────────────────────────────
 *   「期限切れ会員へのカムバック」を有効会員へ送るような事故を構造的に防ぐ。
 *   enforce=true のキャンペーンは、条件に合わない受信者を dry-run 時点で除外し、
 *   除外理由（segment_mismatch）を件数表示する。汎用キャンペーンは制限しない。
 *
 * ⚠️ 本文に配信停止リンクを書かないこと。送信基盤
 *    （execute-scheduled-emails-background）が全通に配信停止リンクと
 *    List-Unsubscribe ヘッダを自動付与する。二重に出さない。
 * ⚠️ 本番 URL は `https://analytics.keiba.link/` のみ（CLAUDE.md §本番 URL ルール）。
 *    `analytics.keiba.jp` / `*.netlify.app` は使用禁止（guard テストで検査）。
 */

import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import {
  buildComebackEmailContent,
  DEFAULT_COMEBACK_COMBO,
} from '../promotions/comebackEmailTemplate.js';
import { OFFER_URL_PLACEHOLDER } from '../promotions/offerCampaignLink.js';
import {
  renderMarketingEmail, applyGrantExpiry,
  UNSUBSCRIBE_PLACEHOLDER, GRANT_EXPIRY_PLACEHOLDER,
} from './marketingEmailShell.js';
import { REGULAR_PRICE, resolveOffer } from '../promotions/promotionOfferCatalog.js';
import {
  isSequenceCampaign, resolveSequenceStep, describeSequence, validateAllSequences,
} from './campaignSequence.js';

/**
 * カムバック割引案内が案内する条件。**オファーカタログの正本から取る**
 * （価格をここに書き写すと `/pricing/` とズレる）。
 */
const COMEBACK_OFFER_TERMS = (() => {
  const r = resolveOffer('premium-annual-half');
  if (!r.ok) throw new Error(`campaignCatalog: premium-annual-half を解決できない (${r.error})`);
  return r.offer;
})();

const SITE = 'https://analytics.keiba.link';

/**
 * 差し込み可能なプレースホルダ（これ以外は使わない）。
 *
 * ⚠️ `{{salutation}}` は**完成した宛名**（敬称込み）。テンプレート側で
 *    `{{salutation}} 様` のように敬称を後付けしてはいけない。
 *    氏名が無い会員が大多数のため、後付けすると「お客様 様」という二重敬称になる。
 */
export const CAMPAIGN_PLACEHOLDERS = Object.freeze(['{{salutation}}']);

/**
 * **送信直前まで解決を遅らせる**プレースホルダ。
 *
 * 顧客ごとに違う値（割引オファーの専用 URL）は、キュー登録時点では確定させられない。
 * そこで `ctaUrl` にだけこの印を残し、専用 dispatcher が 1 通ずつ差し替える。
 *
 * ⚠️ 使ってよいのは `requiresOfferUrl: true` のキャンペーンの **`ctaUrl` だけ**。
 *    本文・件名に残った場合は `renderCampaign` が null を返して送信を止める。
 *    解決されないまま送ると「誰も使えない URL」を配ることになる。
 */
export const CAMPAIGN_DEFERRED_PLACEHOLDERS = Object.freeze([OFFER_URL_PLACEHOLDER]);

/** 氏名が空のときの呼びかけ（敬称を含む完成形） */
export const NAME_FALLBACK = 'お客様';

/**
 * 完成した宛名を 1 つ作る（render 側の責務）。
 *   氏名あり … `山田 様`
 *   氏名なし … `お客様`（「お客様 様」にしない）
 */
export function buildSalutation(rawName) {
  const name = sanitizeName(rawName);
  return name === NAME_FALLBACK ? NAME_FALLBACK : `${name} 様`;
}

/** キャンペーンを使用停止にする理由（管理画面にそのまま出す） */
export const CAMPAIGN_DISABLED_REASON = Object.freeze({
  NO_CTA: 'CTA 未設定のため利用不可（案内先ページが確定していません）',
  TEMPLATE_PLACEHOLDER: '本文が初期テンプレートのままのため利用不可（件名・本文・CTA を設定してください）',
  /** 文面は完成しているが、前提となる運用がまだ整っていない下書き */
  DRAFT: '下書き（前提となる運用が未成立のため利用不可）',
});

/**
 * キャンペーン定義。
 *
 * audienceRule:
 *   contracts … 許可する契約状態（空配列 = 制限なし）
 *   plans     … 許可するプラン区分（空配列 = 制限なし）
 *   enforce   … true なら不一致を dry-run で除外する / false なら警告のみ
 */
export const CAMPAIGNS = Object.freeze([
  {
    campaignId: 'marketing-canary',
    // v1 → v2（2026-08-01）/ v2 → v3（2026-08-09）: **本文は 1 文字も変えていない**。
    // 配信経路の検証をやり直すための版上げ。DeliveryKey は campaignId × version × email で
    // 決まるため、旧版で送信済みのテスト受信者へも新版なら再送できる
    //（同じ版のまま再実行すると `already_delivered` で拒否されるのが正しい挙動）。
    // 運用テスト専用なので、この版上げは**実顧客向けキャンペーンに一切影響しない**。
    // v3 は `dormant-reactivation` v2 の 14,279 件配信前カナリアのために上げた。
    benefitType: 'operational_test',
    benefitDescription: '運用テスト専用。一般顧客へは構造的に送れない',
    version: 3,
    name: 'マーケティング配信カナリア',
    description: '運用テスト専用。NEWSLETTER_TEST_RECIPIENTS に登録されたアドレスにのみ送信できる（一般顧客には送れない）。',
    subject: '【KEIBA Analytics】配信テスト',
    body: [
      '{{salutation}}',
      '',
      'KEIBA Analytics の配信システム確認用メールです。',
      '',
      'このメールは運用テストのために送信されています。',
      '通常のご案内ではありません。',
    ].join('\n'),
    // 商品案内・価格・契約誘導は入れない。CTA は仕組み上必須なのでトップのみ。
    ctaLabel: 'サイトを見る',
    ctaUrl: `${SITE}/`,
    recommendedSegments: [],
    // 契約状態・プランでは絞らない。**絞り込みは extraAudience が担う**
    //（テスト受信者の契約状態は運用で変わりうるため、ここで条件を付けると検証できなくなる）
    audienceRule: { contracts: [], plans: [], enforce: false },
    // 🛡️ env NEWSLETTER_TEST_RECIPIENTS 一致者のみ。env 未設定なら全員除外（fail closed）。
    extraAudience: 'marketing_canary_recipient',
    /** 運用テスト専用の目印。管理画面で顧客向けキャンペーンと区別して表示する */
    testOnly: true,
    enabled: true,
  },
  {
    campaignId: 'expired-comeback',
    benefitType: 'discount',
    benefitDescription: '再契約者向けの特別価格をご案内します（期間限定の割引）',
    version: 2,
    name: '期限切れ会員 カムバック',
    description: '有効期限が切れた有料会員へ、再開の案内を送る。',
    subject: '【KEIBA Analytics】もう一度、AI予想をご一緒しませんか',
    body: [
      '{{salutation}}',
      '',
      'KEIBA Analytics をご利用いただきありがとうございました。',
      '現在、お客様の有料プランは期限切れとなっております。',
      '',
      'この間もAI予想の精度改善を続けており、',
      '本命・対抗・単穴の選定ロジックと買い目の作り方を大きく見直しました。',
      '',
      '直近の的中実績は、無料で公開しています。',
      'まずは実績だけでもご覧ください。',
    ].join('\n'),
    ctaLabel: '直近の実績を見る',
    // 無料公開ページ。期限切れ会員でも閲覧できる（2026-07-30 本番 200 実測）
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    recommendedSegments: ['contract:expired'],
    audienceRule: { contracts: [MK_CONTRACT.EXPIRED], plans: [], enforce: true },
    enabled: true,
  },
  {
    /**
     * Light 30日無料を**すでに付与した**成功者への案内。
     *
     * ── 他のカムバック文面と分けている理由 ────────────────────────
     * 「期限切れカムバック」「Premium 再契約」「割引案内」は**これから何かを勧める**文面で、
     * 申込・支払いの案内が要る。こちらは**もう権利を配り終えた**あとの通知なので、
     * 申込も支払いも不要だと言い切る必要がある。同じ文面にまとめると
     * 「無料と言いながら申込を促す」ちぐはぐな案内になる。
     *
     * ── 対象は契約状態ではなく「付与に成功したこと」で決まる ──────────
     * 付与成功者は期限切れ・退会・休眠のいずれでもありうるので `enforce` はしない。
     * 誰に送るかは `grantOperationId` の引き継ぎ（`comebackEmailHandoff.js`）が
     * サーバー側で確定する。ここで契約条件を課すと、正しい相手が除外される。
     *
     * ⚠️ 本文に URL を書かない（`campaignContentDraft` が拒否する）。
     *    案内先は CTA ボタン 1 つに固定し、本文編集で壊れないようにする。
     */
    campaignId: 'comeback-light-30d-granted',
    // v1 → v2: 文面はほぼ同じだが、**共通 HTML シェルへ載せ替えて見た目が大きく変わった**。
    // 受け取る人にとって別物なので version を上げる（DeliveryKey も分かれる）。
    benefitType: 'free_access',
    benefitDescription: 'Lightプランを30日間 無料でご利用いただけます（付与済み）',
    version: 2,
    name: 'Light 30日無料付与済み案内',
    description: 'Light 30日無料を付与済みの顧客へ、申込不要で使えることを案内する。',
    subject: '【KEIBA Analytics】Lightプラン30日無料のご案内',
    // 受信箱の一覧に出る一文。本文の冒頭を奪わないよう本文には表示しない
    preheader: 'お申し込み不要。いつものメールアドレスで、すぐにご利用いただけます。',
    badge: '30日間無料',
    headline: 'Lightプランを30日間無料でご利用いただけます',
    body: [
      '以前、KEIBA Analyticsをご利用いただき、ありがとうございました。',
      '',
      'KEIBA Analyticsはその後も改善を重ね、',
      '予想ロジックや買い目の組み方、結果の見せ方などを見直してきました。',
      '',
      '改めて現在のサービスをお試しいただけるよう、',
      'Lightプランを30日間無料でご利用いただけるようにいたしました。',
      '',
      'お申し込みやお支払いの手続きは必要ありません。',
      'いつものメールアドレスでログインすると、すぐにご利用いただけます。',
      '',
      'この機会に、現在のKEIBA Analyticsをもう一度お試しいただけましたら幸いです。',
    ].join('\n'),
    // 特典の中身は**固定**。管理者が本文を編集しても消えない
    benefitTitle: 'Lightプラン（30日間無料）',
    benefitItems: [
      '各開催のメインレース買い目を閲覧できます',
      'お支払いの手続きは必要ありません',
      'ログインすればすぐにご利用いただけます',
    ],
    ctaLabel: 'KEIBA Analyticsにログイン',
    ctaUrl: `${SITE}/dashboard/`,
    ctaNote: 'お申し込み手続きは必要ありません。',
    footerNote: 'このメールは、無料期間を設定させていただいたお客様へお送りしています。',
    templateVariant: 'grant-notice',
    // 受信者ごとの無料期間の終了日を出す（読めないときは日付を断定しない）
    showGrantExpiry: true,
    grantDurationDays: 30,
    recommendedSegments: [],
    // 付与に成功したこと自体が対象条件。契約状態では絞らない
    audienceRule: { contracts: [], plans: [], enforce: false },
    enabled: true,
  },
  {
    campaignId: 'premium-renewal',
    benefitType: 'discount',
    benefitDescription: '継続手続きの案内と、継続者向けの価格をご提示します',
    version: 2,
    name: 'Premium 再契約',
    description: '期限切れ / 期限間近の Premium 会員へ継続を案内する。',
    subject: '【KEIBA Analytics】Premium プランのご利用状況と継続について',
    // 「期限切れ」「期限間近」のどちらにも不自然でない中立表現にする。
    // 三連複の買い切り閲覧権は Premium の期限と独立（resolveEntitlements:
    // canViewSanrenpuku = canLogin && LifetimeSanrenpuku。tier も Premium 期限も見ない）。
    // 買い切り分まで失効したように読まれないよう明示する。
    body: [
      '{{salutation}}',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      'Premium プランのご利用状況と継続についてご案内します。',
      '',
      'Premium では中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
      '継続をご希望の場合は、下記ページからお手続きいただけます。',
      '',
      '※ Premium Sanrenpuku（三連複）の買い切り閲覧権をお持ちの場合、',
      '　 そちらは通常 Premium プランの期限とは別に、引き続きご覧いただけます。',
      '　 本メールは通常 Premium プランについてのご案内です。',
    ].join('\n'),
    ctaLabel: '継続手続きへ',
    ctaUrl: `${SITE}/pricing/`,
    recommendedSegments: ['contract:expired', 'contract:expiring_soon'],
    audienceRule: {
      contracts: [MK_CONTRACT.EXPIRED, MK_CONTRACT.EXPIRING_SOON],
      plans: [MK_PLAN.PREMIUM, MK_PLAN.PREMIUM_SANRENPUKU],
      enforce: true,
    },
    enabled: true,
  },
  {
    campaignId: 'sanrenpuku-offer',
    benefitType: 'discount',
    benefitDescription: '三連複プランの特別価格をご案内します',
    version: 2,
    name: 'Premium Sanrenpuku 案内',
    description: '有効な Premium 会員へ三連複（買い切り）を案内する。',
    subject: '【KEIBA Analytics】三連複予想のご案内',
    body: [
      '{{salutation}}',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      '',
      'Premium 会員の方だけにご案内しております、',
      '三連複予想（買い切り）についてお知らせいたします。',
      '',
      '馬単とは別軸の買い目で、点数を絞って狙う設計です。',
      '一度のお支払いで、以降ずっとご覧いただけます。',
    ].join('\n'),
    ctaLabel: '三連複予想の詳細',
    ctaUrl: '',
    recommendedSegments: ['contract:active', 'plan:premium'],
    audienceRule: {
      contracts: [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON],
      plans: [MK_PLAN.PREMIUM],
      enforce: true,
    },
    // ⛔ 使用停止（2026-07-30）: 三連複を **説明・販売する公開ページが存在しない**。
    //   - `/pricing/` の顧客可視領域に「三連複」の記載は 0 件（本番 HTML 実測）
    //   - 実際の購入導線は `dashboard.astro` の「三連複を追加」ボタン → モーダル
    //     （`showPurchaseCta = canPurchaseSanrenpuku` でゲート／ログイン必須）
    //   - `/plan-upgrade-guide/` は旧プラン体系（三連複を会員ランクとして説明）で現行仕様と不一致
    //   案内先が確定するまで有効化しない。**推測で URL を作らない。**
    enabled: false,
    disabledReason: CAMPAIGN_DISABLED_REASON.NO_CTA,
    disabledDetail: '三連複を説明・販売する公開ページが未確定（/pricing/ に三連複の記載なし・購入導線は dashboard のモーダルのみ）',
  },
  {
    campaignId: 'premium-plus-offer',
    benefitType: 'exclusive_perk',
    benefitDescription: '1日1鞍の三連単フォーメーションを特別価格でご案内します',
    version: 2,
    name: 'Premium Plus 案内',
    description: 'Premium Plus の販売資格があり、商品ページを閲覧できる会員だけに案内する。',
    subject: '【KEIBA Analytics】1日1鞍の予想について',
    body: [
      '{{salutation}}',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      '',
      '全レースを広く狙うのではなく、その日の全開催から「1鞍だけ」を選ぶ、',
      '超精密AIによる予想をご用意しています。',
      '',
      '対象レースを増やす商品ではありません。',
      '1日1鞍に絞り込む設計です。',
    ].join('\n'),
    ctaLabel: '詳細を見る',
    ctaUrl: `${SITE}/premium-plus/`,
    recommendedSegments: ['plan:premium_sanrenpuku'],
    audienceRule: { contracts: [], plans: [MK_PLAN.PREMIUM_SANRENPUKU], enforce: true },
    // ⚠️ CTA 先 `/premium-plus/` は段階公開の対象で、PHASE 3 未満・非 eligible には 404。
    //    プラン条件だけでは全員がリンク切れに着地するため、**販売資格と PHASE を追加判定**する。
    //    判定は既存正本（resolvePremiumPlusRelease）を再利用し、PHASE 計算を複製しない。
    extraAudience: 'premium_plus_release',
    enabled: true,
  },
  {
    campaignId: 'dormant-reactivation',
    version: 2,
    // 「長期休眠」を名乗るには最終ログイン / 最終利用日の正本が要るが、Customers に無い。
    // 推測しないため、判定できる範囲（契約が無い・切れている）に名称と条件を合わせる。
    name: '休眠・無料会員 再アプローチ',
    description: '契約が無い / 切れている会員へ、無料実績ページを入口に再訪を促す。',
    subject: '【KEIBA Analytics】直近の的中実績をお届けします',
    body: [
      '{{salutation}}',
      '',
      'KEIBA Analytics です。ご無沙汰しております。',
      '',
      '毎日、前日の有料メインレース買い目と結果を無料で公開しています。',
      '当たった日も外した日も、そのまま掲載しています。',
      '',
      'お手すきのときにご覧いただければ幸いです。',
    ].join('\n'),
    // 🚫 2026-08-10: **大量配信の対象から外す**。2026-08-09 に 14,279 名へ送ったが、
    //    受信者にとっての得は「実績が見られる」だけで、配信停止申請と苦情を招いた。
    //    再利用するには benefitType / benefitDescription を宣言し直すこと。
    bulkSendAllowed: false,
    ctaLabel: '昨日の買い目と結果',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    recommendedSegments: ['contract:none', 'contract:expired', 'history:never'],
    // 課金継続中（active / expiring_soon）へ「ご無沙汰しております」を送らない。
    audienceRule: {
      contracts: [MK_CONTRACT.NONE, MK_CONTRACT.EXPIRED],
      plans: [],
      enforce: true,
    },
    enabled: true,
  },
  {
    campaignId: 'free-member-activation',
    benefitType: 'content_unlock',
    benefitDescription: '無料のまま全レースのAI予想と前日の有料買い目・結果を開放してご案内します',
    version: 1,
    name: '無料会員 活性化',
    // `dormant-reactivation` との違い:
    //   休眠再アプローチ = 「ご無沙汰しております」= **一度は接点があった前提**の文面で、
    //     入口は実績ページ（有料の中身を見せて戻ってきてもらう）。
    //   本キャンペーン   = **まだ無料の中身を使っていない人**へ、無料で何が見られるかを
    //     具体的に伝えるのが目的。入口は無料予想ページそのもの。
    // 契約の勧誘・価格・期限は書かない（活性化が目的で、販売はここでやらない）。
    description: '無料会員へ、無料で見られる範囲を具体的に案内して実際に使ってもらう。価格・契約の勧誘はしない。',
    subject: '【KEIBA Analytics】無料でご覧いただける予想のご案内',
    body: [
      '{{salutation}}',
      '',
      'KEIBA Analytics です。ご登録ありがとうございます。',
      '',
      '無料のままで、次の内容をご覧いただけます。',
      '',
      '・中央競馬（JRA）と南関競馬の全レースのAI予想',
      '・前日の有料メインレース買い目と、その結果',
      '',
      '結果は当たった日も外した日もそのまま載せています。',
      'まずは今日の予想からご覧ください。',
    ].join('\n'),
    ctaLabel: '今日の無料予想を見る',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
    recommendedSegments: ['plan:free', 'contract:none', 'history:never'],
    // 無料プラン かつ 契約なしのみ。**有料会員・期限切れには送らない**
    //（期限切れは `dormant-reactivation` / `expired-comeback` の担当）。
    audienceRule: {
      contracts: [MK_CONTRACT.NONE],
      plans: [MK_PLAN.FREE],
      enforce: true,
    },
    enabled: true,
  },
  {
    /**
     * **Light 無料体験 → 有料転換**の連続配信（4 通）。
     *
     * ── 導線 ────────────────────────────────────────────────
     *   CSV 取り込みの無料会員 → **Light 30日無料を付与** → 実際に使ってもらう → Premium へ
     *
     * ── 付与は「このキャンペーンの外」で行う（重要）──────────────
     * 付与を書けるのは次の 2 つだけで、どちらも `buildComebackPlan` を正本に使う:
     *   1. `admin-comeback-grants`（管理画面からの手動付与・`operationId` で冪等）
     *   2. `cron-light-trial-grant`（**入口の自動化**・既定 OFF・6 ゲート）
     * **このシーケンス自身は付与を 1 件も作らない。** 送るのは
     * **すでに期限付き Light 無料期間中の人**だけ
     * （`requiresActiveGrant: { tier:'light', termedOnly:true }`）。
     * 自動付与は「付与に成功した recordId」だけを Step1 の対象にするので、
     * 付与前・付与失敗の相手へメールが出ることはない。
     * 付与の正本は `promotionOfferCatalog.js` の `light-30d-free`
     * （`grantTier: light` / `durationDays: 30` / `restoresPaidContract: false`）。
     *
     * ── 期間が終わったら ──────────────────────────────────────
     * `LightGrantUntil` を過ぎると **書き込み無しで**権利が消えるだけ（純粋な時刻比較）。
     * 自動で課金されることはない。進行判定は `grant_expired` で止める。
     *
     * ── 書かないこと ────────────────────────────────────────
     * 的中・利益の保証、煽り、手書きの実績数値、価格の直書き。
     * **プラン間の買い目点数の比較も書かない**（メイン以外の点数は一律ではないため、
     * 「上位プランでも点数は増えない」は不正確。触れない）。
     */
    campaignId: 'light-trial-to-premium-sequence',
    version: 1,
    name: 'Light 無料体験 → Premium（連続配信 4 通）',
    description: 'CSV 取り込みの会員のうち 期限付き Light 無料期間中の人へ、体験の開始 → 使い方 → 期間中の確認 → Premium の提案を 4 通で案内する。付与はこのキャンペーンでは行わない（手動付与 or 入口の自動化が担当）。',
    benefitType: 'free_access',
    benefitDescription: 'Lightプランを30日間 無料でご利用いただけます（お申し込み・お支払いの手続きは不要）',
    subject: '【KEIBA Analytics】Lightプランを30日間 無料でお使いいただけます',
    body: '',
    ctaLabel: 'ログインして使いはじめる',
    ctaUrl: `${SITE}/dashboard/`,
    footerNote: 'このメールは、Lightプランの無料期間を設定させていただいたお客様へお送りしています。',
    /**
     * 受信者ごとの無料期間の**実際の終了日**（`LightGrantUntil`）を差し込む。
     * dispatcher が 1 通ずつ解決するので、付与日と送信日がズレても文面が正しい。
     * ⚠️ `grantDurationDays` は **終了日が読めなかったときだけ**の控えめな代替
     *    （「付与日から N 日間」）。日付を断定しないための保険であって主役ではない。
     */
    showGrantExpiry: true,
    grantDurationDays: 30,
    /**
     * **期限付き Light 無料期間中の人だけ**に送る（付与はしない・進行判定が確認する）。
     * `termedOnly: true` = 期限なし（`light-lifetime-free`）は対象外。
     * 「無料期間は◯日まで」と書けない相手に 30 日体験の案内を送らないため。
     */
    requiresActiveGrant: { tier: 'light', termedOnly: true },
    /**
     * **対象は CSV で取り込んだ会員だけ**（従来からの無料会員には送らない）。
     * 判定の正本は取り込み時に書いた `Source`（`crm/importedCohort.js`）。
     * `batchIds` を指定すれば特定バッチだけに絞れる（空 = 取り込み全体）。
     */
    requiresImportCohort: { batchIds: null },
    recommendedSegments: [],
    // 付与されていること自体が対象条件なので、契約状態・プランでは絞らない
    audienceRule: { contracts: [], plans: [], enforce: false },
    sequence: {
      maxSends: 4,
      steps: [
        {
          stepNumber: 1,
          delayDays: 0,
          name: '無料体験の開始',
          subject: '【KEIBA Analytics】Lightプランを30日間 無料でお使いいただけます',
          preheader: 'お申し込みは不要です。ログインするだけで、メインレースの買い目が見られます。',
          badge: '30日間 無料',
          headline: '現在、Lightプランを無料でご利用いただけます',
          body: [
            'Lightプランの無料期間を設定させていただいています。',
            'お申し込みもお支払いの手続きも必要ありません。',
            '',
            'いつものメールアドレスでログインすると、そのままご利用いただけます。',
          ].join('\n'),
          benefitTitle: '無料期間中にご覧いただけるもの',
          benefitItems: [
            '各開催のメインレース買い目',
            '買い目に対する結果（当たった日も外した日も）',
            'AI総合指数と役割（本命 / 対抗 / 単穴 など）',
          ],
          ctaLabel: 'ログインして使いはじめる',
          ctaUrl: `${SITE}/dashboard/`,
          // ⚠️ 期間は**受信者ごとの実際の終了日**（`LightGrantUntil`）を差し込む。
          //    「付与日から30日間」と固定で書かない（付与日と送信日は一致しない）。
          ctaNote: `お申し込み手続きは必要ありません。${GRANT_EXPIRY_PLACEHOLDER}`,
          benefitType: 'free_access',
          benefitDescription: 'Lightプランを30日間 無料でご利用いただけます（お申し込み・お支払いは不要）',
        },
        {
          stepNumber: 2,
          delayDays: 3,
          name: '使い方・買い目の見方',
          subject: '【KEIBA Analytics】メインレースの買い目の見方',
          preheader: '本命から相手5頭への馬単5点。買い目の読み方と、当日の使い方をご案内します。',
          badge: '使い方',
          headline: 'メインレースの買い目は、こう見ます',
          body: [
            '無料期間中にご覧いただけるメインレースの買い目について、見方をご案内します。',
            '',
            '買い目は「本命 → 相手5頭」の馬単5点です。',
            '点数を広げて当てにいくのではなく、軸を決めて絞る作り方をしています。',
            '',
            '前日には、その買い目と結果をあわせて公開しています。',
            '当たった日も外した日もそのまま残しているので、',
            'ご自身の見立てと突き合わせながらお使いいただけます。',
          ].join('\n'),
          benefitTitle: '当日の使い方',
          benefitItems: [
            'ログインしてメインレースの買い目を確認する',
            'AI総合指数と役割で、軸にする馬を見る',
            '翌日、結果ページで答え合わせをする',
          ],
          ctaLabel: 'メインレースの買い目を見る',
          ctaUrl: `${SITE}/dashboard/`,
          benefitType: 'free_access',
          benefitDescription: 'Light無料期間中のメインレース買い目と結果の見方をご案内します',
        },
        {
          stepNumber: 3,
          delayDays: 5,
          name: '期間中に確認していただきたいこと',
          subject: '【KEIBA Analytics】無料期間中にご確認いただきたいこと',
          preheader: '自動で課金されることはありません。期間中に見ておくと役立つ画面をまとめました。',
          badge: 'ご確認',
          headline: '無料期間中に見ておいていただきたいもの',
          body: [
            '無料期間のうちに確認しておいていただくと分かりやすいものをまとめました。',
            '',
            '■ メインレースの買い目と、その結果',
            '買い目だけでなく、翌日の結果まで見ていただくと精度の感触がつかめます。',
            '',
            '■ AI総合指数と役割',
            '本命・対抗・単穴などの役割と指数の並びを見ると、軸の決め方が分かります。',
            '',
            '■ お支払いについて',
            '無料期間が終わっても、自動で課金されることはありません。',
            '期間の終了日は、このメールの下部に記載しています。',
            'ご継続の場合のみ、銀行振込でお手続きいただきます。',
            'ご入金を確認してから利用期間が始まります。',
          ].join('\n'),
          ctaLabel: '無料期間中の予想を見る',
          ctaUrl: `${SITE}/dashboard/`,
          ctaNote: `このご案内の時点でお手続きは必要ありません。${GRANT_EXPIRY_PLACEHOLDER}`,
          benefitType: 'free_access',
          benefitDescription: 'Light無料期間中に確認しておくと役立つ画面と、お支払いの条件をご案内します',
        },
        {
          stepNumber: 4,
          delayDays: 7,
          name: 'Premium の提案',
          subject: '【KEIBA Analytics】他のレースもご覧になりたい場合は',
          preheader: 'Lightはメインレース。Premiumは中央・南関の有料予想を全会場ご覧いただけます。',
          badge: 'プランのご案内',
          headline: 'もっと他のレースも見たい、と思われた方へ',
          body: [
            'Lightプランをお試しいただき、ありがとうございます。',
            '',
            'Lightでご覧いただけるのは各開催のメインレースです。',
            'ここまでお使いいただいて「他のレースも見たい」と思われた場合は、',
            'Premiumプランで中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
            '',
            'メインレースだけで十分という方は、いまのままで問題ありません。',
            '無料期間の終了後に自動で課金されることはありません。',
            '終了日は下部に記載しています。',
            '',
            'このご案内は今回で最後です。',
          ].join('\n'),
          benefitTitle: '違いはご覧いただける範囲です',
          benefitItems: [
            'Light … 各開催のメインレース',
            'Premium … 中央（JRA）・南関の有料予想を全会場',
            '無料予想と前日の結果ページは、どちらでも引き続きご利用いただけます',
          ],
          ctaLabel: 'プランと料金を見る',
          ctaUrl: `${SITE}/pricing/`,
          ctaNote: '金額と内容はこちらのページが最新です。',
          footerNote: 'この一連のご案内は今回で最後です。今後は通常のお知らせのみをお送りします。',
          benefitType: 'free_access',
          benefitDescription: 'Light無料期間の内容と、Premiumでご覧いただける範囲の違いをご案内します',
        },
      ],
    },
    enabled: true,
  },
  {
    campaignId: 'comeback-offer',
    benefitType: 'discount',
    benefitDescription: 'この方だけの特別価格（割引）を発行してご案内します',
    version: 2,
    name: 'カムバック割引案内（専用URL）',
    description: '発行済みの割引オファーを、その顧客だけが使える申込 URL 付きで案内する。',
    // ⚠️ 文面を手書きしない。**offer カタログの価格から生成**する（書き間違いを防ぐ）。
    //    CTA は受信者ごとに違うため、ここでは差し込み印だけを置き、
    //    専用 dispatcher が 1 通ずつ本人の URL に差し替える（未解決なら送らない）。
    ...(() => {
      const c = buildComebackEmailContent({
        grantOffers: [],
        purchaseOffer: COMEBACK_OFFER_TERMS,
        offerUrl: OFFER_URL_PLACEHOLDER,
      });
      return { subject: c.subject, body: c.body, ctaLabel: c.ctaLabel, ctaUrl: c.ctaUrl };
    })(),
    /**
     * 受信者ごとの申込 URL が**必須**。
     * 有効なオファーを持たない人は dry-run で除外され、送信直前にも再確認される。
     * これにより「オファー発行 → URL 確定 → 送信」の順序が構造的に守られる。
     */
    requiresOfferUrl: true,
    /** 本文に書いた条件。受信者のオファーがこれと違えば `offer_mismatch` で除外する */
    offerId: COMEBACK_OFFER_TERMS.offerId,
    regularPrice: COMEBACK_OFFER_TERMS.regularPrice,
    offerPrice: COMEBACK_OFFER_TERMS.offerPrice,
    recommendedSegments: ['contract:expired', 'contract:none'],
    // オファーを発行した相手にだけ送る運用なので、契約状態では絞らない。
    // 実際の対象判定は「有効な割引オファーを持っているか」で行う（上の requiresOfferUrl）。
    audienceRule: { contracts: [], plans: [], enforce: false },
    enabled: true,
  },
  {
    campaignId: 'general-announcement',
    benefitType: 'new_feature',
    benefitDescription: '新機能・新サービスのご案内（本文未設定のため現在は送信不可）',
    version: 1,
    name: '汎用キャンペーン',
    description: 'セグメント制限なしのお知らせ。使用前に件名・本文・CTA を設定する。',
    subject: '【KEIBA Analytics】お知らせ',
    body: [
      '{{salutation}}',
      '',
      'いつも KEIBA Analytics をご利用いただきありがとうございます。',
      'お知らせがございます。詳しくは下記ページをご覧ください。',
    ].join('\n'),
    ctaLabel: 'サイトを見る',
    ctaUrl: `${SITE}/`,
    recommendedSegments: [],
    audienceRule: { contracts: [], plans: [], enforce: false },
    // ⛔ 使用停止: 本文が初期テンプレートのまま。中身を書いてから version を上げて有効化する。
    //    `isTemplateConfigured()` が未設定を検知し、dry-run 自体を fail closed にする。
    isPlaceholderTemplate: true,
    enabled: false,
    disabledReason: CAMPAIGN_DISABLED_REASON.TEMPLATE_PLACEHOLDER,
    disabledDetail: '「お知らせがございます」のみの初期文面。用途を決めて本文を書き、version を上げてから有効化する',
  },
]);

/**
 * キャンペーンが実送信に使える状態か（本文・CTA が設定済みか）。
 * 初期テンプレートのままの本文で顧客へ送らないための fail closed 判定。
 *
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
export function isTemplateConfigured(campaign) {
  // 連続配信は **step1 が完成していれば使える**（親の body は空でよい）。
  // 各ステップの中身は `validateSequence()` が別途検査する（件名・本文の重複も禁止）。
  const c = isSequenceCampaign(campaign) ? resolveSequenceStep(campaign, 1) : campaign;
  if (!c) return { ok: false, reason: 'unknown_campaign', detail: null };
  if (c.isPlaceholderTemplate === true) {
    return { ok: false, reason: 'template_not_configured', detail: c.disabledDetail || null };
  }
  if (typeof c.subject !== 'string' || c.subject.trim() === '') {
    return { ok: false, reason: 'template_not_configured', detail: '件名が空です' };
  }
  if (typeof c.body !== 'string' || c.body.trim() === '') {
    return { ok: false, reason: 'template_not_configured', detail: '本文が空です' };
  }
  if (typeof c.ctaUrl !== 'string' || c.ctaUrl.trim() === '') {
    return { ok: false, reason: 'cta_not_configured', detail: c.disabledDetail || 'CTA URL が未設定です' };
  }
  return { ok: true, reason: null, detail: null };
}

/** キャンペーンが選択可能か（enabled かつ テンプレート設定済み）。 */
export function isCampaignUsable(campaign) {
  if (!campaign || campaign.enabled !== true) return false;
  return isTemplateConfigured(campaign).ok;
}

/**
 * 一覧（本文は含めない軽量メタ。管理画面のセレクト用）。
 * **無効なものも理由付きで返す**（管理者が「なぜ使えないか」を画面で分かるようにする）。
 */
export function listCampaigns({ includeDisabled = true } = {}) {
  return CAMPAIGNS
    .filter((c) => includeDisabled || isCampaignUsable(c))
    .map((c) => {
      const tpl = isTemplateConfigured(c);
      const usable = isCampaignUsable(c);
      return {
        campaignId: c.campaignId,
        version: c.version,
        name: c.name,
        description: c.description,
        subject: c.subject,
        ctaLabel: c.ctaLabel,
        ctaUrl: c.ctaUrl,
        recommendedSegments: c.recommendedSegments,
        audienceRule: c.audienceRule,
        extraAudience: c.extraAudience || null,
        testOnly: c.testOnly === true,
        /** 連続配信の定義（本文は含めない。件名・間隔・上限だけ） */
        sequence: describeSequence(c),
        enabled: c.enabled === true,
        usable,
        disabledReason: usable ? null : (c.disabledReason || tpl.detail || tpl.reason || '利用不可'),
      };
    });
}

/**
 * campaignId → 定義。未知 / 無効なら null（fail closed）。
 * `includeDisabled: true` は管理画面が理由を表示するときだけ使う（送信経路では使わない）。
 */
export function getCampaign(campaignId, { includeDisabled = false } = {}) {
  const id = String(campaignId ?? '').trim();
  if (!id) return null;
  const c = CAMPAIGNS.find((x) => x.campaignId === id);
  if (!c) return null;
  if (!includeDisabled && !isCampaignUsable(c)) return null;
  return c;
}

/**
 * 表示名を安全化する。
 * - 改行・連続空白は 1 つの空白に畳む（雑な入力データの正規化）
 * - 波括弧・山括弧を含む名前は**採用せず**フォールバックへ倒す。
 *   除去して使うと `{{name}}` が「name 様」のような不自然な文面になるため、
 *   疑わしい入力は名前として使わない（fail closed）。
 */
export function sanitizeName(raw) {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!s || s === NAME_FALLBACK) return NAME_FALLBACK;
  if (/[{}<>]/.test(s)) return NAME_FALLBACK;
  return s.slice(0, 40) || NAME_FALLBACK;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * キャンペーン本文を描画する。
 *
 * - 差し込みは {{name}} のみ。未解決のプレースホルダが残ったら null（fail closed）
 * - 本文は HTML エスケープしてから <p> へ組む（顧客名由来の HTML 注入を防ぐ）
 * - 配信停止リンクは付けない（送信基盤が全通に付与する）
 *
 * @param {{ campaign: object, name?: string }} input
 * @returns {{ subject: string, html: string, text: string }|null}
 */
export function renderCampaign({
  campaign, name, offerUrl, unsubscribeUrl, expiryNote = '',
} = {}) {
  const c = campaign;
  if (!c || typeof c.subject !== 'string' || typeof c.body !== 'string') return null;

  // 完成した宛名を 1 つ作る。テンプレート側で敬称を足さない（「お客様 様」の防止）。
  const salutation = buildSalutation(name);
  const text = c.body.replace(/\{\{\s*salutation\s*\}\}/g, salutation);
  if (/\{\{|\}\}/.test(text) || /\{\{|\}\}/.test(c.subject)) return null; // 未解決の差し込みは送らない

  // ── CTA の差し込み（受信者ごとの申込 URL）──────────────────────
  //   requiresOfferUrl のキャンペーンは、URL が確定するまで**送れない**。
  //   ここで null を返すことで「誰も使えない URL を配る」事故を止める。
  const needsOffer = c.requiresOfferUrl === true;
  let ctaUrl = typeof c.ctaUrl === 'string' ? c.ctaUrl : '';
  if (offerUrl) {
    if (/\{\{|\}\}/.test(String(offerUrl))) return null;   // URL 自体に差し込みが残っている
    ctaUrl = ctaUrl.split(OFFER_URL_PLACEHOLDER).join(String(offerUrl));
  }
  if (ctaUrl.includes(OFFER_URL_PLACEHOLDER)) {
    // 未解決のまま残ってよいのは「キュー登録時点の本文」だけ。
    // dispatcher が差し替える前提なので、そのキャンペーンでのみ許す。
    if (!needsOffer) return null;
  } else if (needsOffer && !offerUrl) {
    // requiresOfferUrl なのに差し込み印が消えている＝テンプレートの設定ミス
    return null;
  }
  // 既知の差し込み印**以外**の `{{ }}` が CTA に残っていたら送らない
  if (/\{\{|\}\}/.test(ctaUrl.split(OFFER_URL_PLACEHOLDER).join('')) || /\{\{|\}\}/.test(c.ctaLabel || '')) {
    return null;
  }

  // ── 共通シェルで組み立てる ─────────────────────────────────────
  // 本文（管理者が編集できる部分）以外は、すべてテンプレート側の固定値。
  // 本文を編集しても、ブランド・特典・CTA・配信停止は消えない。
  //
  // 宛名は本文の先頭に置かず、シェルの宛名欄へ出す。本文に `{{salutation}}` が
  // 残っている従来テンプレートとの互換のため、置換済みテキストの先頭行が
  // 宛名と同じ場合はシェル側へ寄せて重複表示を避ける。
  const bodyLines = text.replace(/\r\n?/g, '\n').split('\n');
  const startsWithSalutation = bodyLines[0].trim() === salutation;
  const bodyText = (startsWithSalutation ? bodyLines.slice(1) : bodyLines).join('\n').trim();

  const rendered = renderMarketingEmail({
    salutation,
    badge: c.badge || '',
    headline: c.headline || '',
    preheader: c.preheader || '',
    body: bodyText,
    benefit: c.benefitItems && c.benefitItems.length
      ? { title: c.benefitTitle || '', items: c.benefitItems }
      : null,
    cta: { label: c.ctaLabel || '詳細を見る', url: ctaUrl },
    ctaNote: c.ctaNote || '',
    // 受信者ごとに違う終了日は印だけ置き、送信側が差し替える
    expiryNote: expiryNote || (c.showGrantExpiry === true ? GRANT_EXPIRY_PLACEHOLDER : ''),
    footerNote: c.footerNote || '',
    unsubscribeUrl: unsubscribeUrl || UNSUBSCRIBE_PLACEHOLDER,
  });

  // ── 無料期間の終了日 ────────────────────────────────────────
  // 印は本文の外（CTA の注記など）にも置けるので、**完成した HTML / text 全体**へ
  // 差し込む。渡されなければ印のまま残し、送信直前に dispatcher が
  // 受信者ごとの `LightGrantUntil` で解決する（プレビューと実物を一致させる）。
  if (expiryNote) {
    return {
      subject: c.subject,
      html: applyGrantExpiry(rendered.html, expiryNote),
      text: applyGrantExpiry(rendered.text, expiryNote),
    };
  }

  return { subject: c.subject, html: rendered.html, text: rendered.text };
}

/**
 * 受信者がキャンペーンの想定対象か判定する。
 * @returns {{ ok: boolean, enforced: boolean, reason: string|null }}
 */
export function matchesCampaignAudience(campaign, marketing) {
  const rule = (campaign && campaign.audienceRule) || { contracts: [], plans: [], enforce: false };
  const enforced = rule.enforce === true;
  if (!marketing) return { ok: false, enforced, reason: 'unknown_customer' };

  const contractOk = !rule.contracts?.length || rule.contracts.includes(marketing.contract);
  const planOk = !rule.plans?.length || rule.plans.includes(marketing.plan);
  if (contractOk && planOk) return { ok: true, enforced, reason: null };
  return { ok: false, enforced, reason: !contractOk ? 'contract_mismatch' : 'plan_mismatch' };
}

/**
 * 連続配信の定義がカタログ全体で健全か（テストと起動時チェック用）。
 * **ここが落ちる定義は本番に出せない**（同じメールの繰り返し・煽り表現・間隔不足など）。
 */
export function validateCampaignSequences() {
  return validateAllSequences(CAMPAIGNS);
}

export default CAMPAIGNS;
