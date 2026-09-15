/**
 * freeSignupOnboardingSteps.js — **メルマガ無料登録者**の育成 6 通（文面の単一源）
 *
 * ── 文面はどこから来たか ────────────────────────────────────────
 * 初版は `src/lib/newsletter/step-sequences.js` の
 * `analytics-keiba:signup-onboarding`（無料登録時に enroll される既存のステップメール）
 * からの移送。営業訴求・価格・特典を新しく作っていない。
 *
 * ── なぜ移したか ──────────────────────────────────────────────
 * 元のステップメールは **配信系統が別**（`StepEnrollments` + `cron-email-scheduler`）で、
 *   - **送信が未実装**（`step-enroll.js` の注記どおり「実際に送るのは将来の Phase 3」）
 *   - `DeliveryKey` が無い＝**二重送信を構造的に防げない**
 *   - 購入停止・配信停止・反応別 routing を**持たない**
 * だった。DRM の入口を**既存の配信経路 1 本**（`CampaignDeliveries` / 既存 dispatcher）へ
 * 載せるため、campaign として定義し直した。**新しい配信基盤は作っていない。**
 *
 * ── 移送時に直した 2 点（どちらも既存仕様への整合。新規の訴求ではない）──────
 * 1. **Step2 の間隔 1 日 → 2 日**。`campaignSequence.MIN_STEP_DELAY_DAYS = 2` に反するため。
 * 2. **Step4 の「メインレース10点 / 双方向馬単」→「最大5点 / 一方向の馬単」**。
 *    2026-07-09 に確定した現行仕様（`CLAUDE.md`「メインレース5点ロジック」）と
 *    食い違っており、そのまま送ると**事実と違う案内**になるため。
 *
 * ── 🔒 Step1 は送信済み（2026-09-14 / 14 通）。1 バイトも変更しない ─────────
 * `campaignCatalog.js` のルール (C)。`version` を上げれば届くが、
 * **step1 から全員へ配り直し**になるため上げない。
 *
 * ── 2026-09-15 コピー基準の適用（`docs/EMAIL_COPY_STANDARD.md`）──────────
 * **Step2〜6 は未送信**なので改稿した。改稿前は本文 43〜65 文字・1〜2 行で、
 * preheader が本文の複製、特典欄なし、という事務連絡だった。
 *
 * | 直した点 | 理由 |
 * |---|---|
 * | 本文を 1〜2 行から 5 行以上へ。冒頭に「ご登録いただいた方へ」の文脈 | なぜ届いたのか・何が得られるのかが読めなかった（基準 1・2）|
 * | 特典欄（`benefitTitle` / `benefitItems`）を全通に追加 | 「何が得られるのか」の欄が無かった（基準 2）|
 * | preheader を本文の複製から変更 | 受信箱の一覧で開く理由が増えていなかった（基準 6）|
 * | `badge` / `ctaNote` を追加 | 見出し → 本文 → 価値 → CTA のメリハリ（基準 6）|
 * | **Step5・Step6 の CTA を `/premium-prediction/nankan/` → `/pricing/` `/sanrenpuku-demo/`** | ⚠️ 遷移先が**会員限定ページ**で、無料会員は認可で弾かれて到達できなかった（基準 5）|
 * | **Step6 から「三連単の個別配信」の記述を削除** | ⚠️ Premium Plus は **Premium Sanrenpuku 会員にのみ表示**し、それ以外には存在も知らせない（`CLAUDE.md` §Premium Plus）。無料会員向けの本文に書いてはいけなかった |
 *
 * ⚠️ **配信対象・順序・間隔（`delayDays`）・`campaignId`・`version`・`responseRoutes` は
 *    1 つも変えていない。** Step3 は「到達・未開封」、Step5 は「開封層」の
 *    routing 先なので、その役割のまま書き直している。
 *
 * ⚠️ 本文に配信停止リンクを書かない（送信基盤が全通に自動付与する）。
 * ⚠️ 実績の数値を手書きしない（実データのページへ誘導する）。
 * ⚠️ 価格を書かない（`/pricing/` に最新が出る）。
 */

const SITE = 'https://analytics.keiba.link';

/** 訴求角度（連投を避けるための札） */
export const FREE_SIGNUP_ANGLES = Object.freeze([
  'はじめに', '使い方', '成績の確認', '買い目の使い方', 'プランの違い', '上位プラン',
]);

/**
 * 1 ステップぶんの共通形。
 * ⚠️ 省略可能な項目は**キー自体を生やさない**（`computeCampaignContentHash` は
 *    設定済みの項目だけを見るが、送信済み Step1 の形を動かさないため）。
 */
const step = ({
  n, delayDays, angle, name, subject, preheader, badge, headline, body,
  benefitTitle, benefitItems, ctaLabel, ctaUrl, ctaNote,
}) => ({
  stepNumber: n,
  delayDays,
  angle,
  name,
  subject,
  preheader,
  ...(badge ? { badge } : {}),
  headline,
  body: body.join('\n'),
  ...(benefitTitle ? { benefitTitle } : {}),
  ...(benefitItems ? { benefitItems } : {}),
  ctaLabel,
  ctaUrl,
  ...(ctaNote ? { ctaNote } : {}),
  benefitType: 'free_content',
  benefitDescription: '無料のままご覧いただける予想・買い目・結果のご案内です',
});

export const FREE_SIGNUP_ONBOARDING_STEPS = Object.freeze([
  // ── 🔒 送信済み（2026-09-14 / 14 通）。1 バイトも変更しない ────────────
  step({
    n: 1, delayDays: 0, angle: 'はじめに',
    name: 'ご登録のお礼と入口',
    subject: '【KEIBA Analytics】ご登録ありがとうございます（まずはここから）',
    preheader: 'まずは本日の無料予想をご覧ください。',
    headline: 'ご登録ありがとうございます',
    body: [
      'KEIBA Analytics へのご登録ありがとうございます。',
      'AIが南関競馬・中央競馬のメインレースを分析し、本命・買い目を無料で公開しています。',
      '',
      'まずは本日の無料予想をご覧ください。',
    ],
    ctaLabel: '無料予想を見る',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
  }),
  // ── ここから未送信。コピー基準を適用（2026-09-15）────────────────────
  //
  // Step1 の次にあたる**最初の改稿可能な接点**。事務連絡ではなく
  // 「続きを読みたくなる入口」にする（何が見られるか / 今日すぐ試せること）。
  step({
    n: 2, delayDays: 2, angle: '使い方',
    name: '予想ページの見方',
    subject: '【KEIBA Analytics】予想ページの見方（まずは上位 4 頭の印から）',
    preheader: '出走全頭の騎手・斤量・過去走と、上位 4 頭の印を公開しています。',
    badge: '使い方',
    headline: 'まずは上位 4 頭の印からご覧ください',
    body: [
      'ご登録ありがとうございます。予想ページの見方をご案内します。',
      '',
      '予想ページでは、出走する全頭の馬番・馬名・騎手・厩舎・斤量・枠・父・性齢と、',
      '過去走・通算成績を公開しています。',
      '',
      'そのうえで、上位 4 頭に印を付けています。',
      '◎本命・○対抗・▲単穴・△連下最上位の 4 つです。',
      '',
      '最初にご覧いただきたいのは◎本命と○対抗の 2 頭です。',
      'この 2 頭がその日の軸になります。',
      '',
      'なお、このページは有料版のプレビューです。',
      'AI予測買い目・AI総合指数・累積スコア・役割は伏せてあります。',
    ],
    // ⚠️ `/free-prediction/` で**実際に無料で見られるもの**だけを書く
    //    （`docs/spec.md` の公開範囲 / `freePublicView.js` の公開 DTO が根拠）。
    benefitTitle: '無料でご覧いただけるもの',
    benefitItems: [
      '出走全頭の騎手・厩舎・斤量・枠・父・性齢',
      '過去走と通算成績',
      '上位 4 頭の印（◎○▲△）',
    ],
    ctaLabel: '今日の出走馬と印を見る',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
    ctaNote: 'ログインは不要です。そのままご覧いただけます。',
  }),
  // ⚠️ 「到達・未開封」の routing 先（`responseRoutes` の delivered → step3）。
  //    案内を積み増すのではなく、**実績のページで入口を変える**役割。
  step({
    n: 3, delayDays: 3, angle: '成績の確認',
    name: '直近の実績',
    subject: '【KEIBA Analytics】的中した日も外した日も、そのまま公開しています',
    preheader: '都合のよい日だけを選んで載せることはしていません。',
    badge: '記録',
    headline: '実績はデータのまま公開しています',
    body: [
      'ご登録いただいた方へ、これまでの結果の見方をご案内します。',
      '',
      'AI 予想の的中実績を、月別・年別のアーカイブで公開しています。',
      '',
      '的中した日だけを選んで載せることはしていません。',
      '外した日もそのまま残していますので、予想の精度はご自身で確かめられます。',
      '',
      '月ごとに並んでいるので、まずは直近の 1 か月をご覧ください。',
      '無料予想をご覧いただくときの参考にしていただければ幸いです。',
    ],
    // ⚠️ `/archive/nankan/` に実際に出ている項目だけを書く（年間的中率・月別・配当金額）。
    //    「回収率」はこのページに出ていないため書かない。
    benefitTitle: 'アーカイブで確認できること',
    benefitItems: [
      '月別・年別の的中実績',
      '年間の的中率',
      '配当金額',
    ],
    ctaLabel: '直近 1 か月の実績を確認する',
    ctaUrl: `${SITE}/archive/nankan/`,
    ctaNote: '数字はページのものが最新です。',
  }),
  // ⚠️ 元のステップメールは「最大10点 / 双方向馬単」。現行仕様（2026-07-09 確定）に合わせた。
  // ⚠️ 2026-09-15: CTA を `/free-prediction/` → `/results-showcase/nankan/` へ。
  //    買い目は `/free-prediction/` では**伏せてある**（モザイク）ため、
  //    「買い目を見る」と案内して送る先として成立していなかった。
  //    実際に買い目が見られる公開ページは、前日のメインレース買い目を出している
  //    `/results-showcase/`（有料版で配信した 5 点をそのまま公開している）。
  step({
    n: 4, delayDays: 7, angle: '買い目の使い方',
    name: '買い目の考え方',
    subject: '【KEIBA Analytics】メインレースの買い目を 5 点に絞っている理由',
    preheader: '前日にお届けした 5 点を、結果と並べてそのまま公開しています。',
    badge: '買い目',
    headline: 'メインレースの買い目は最大5点です',
    body: [
      'ご登録いただいた方へ、買い目の考え方をご案内します。',
      '',
      'メインレースの買い目は、全プラン共通で最大5点に絞っています。',
      '本命を軸にした一方向の馬単（本命 → 相手 5 頭）です。',
      '',
      '点数を増やして当たりやすく見せる、という作りにはしていません。',
      '上位プランでもメインレースの点数は増えません。増えるのは見られるレース数です。',
      '',
      '有料版でお届けした前日のメインレース買い目は、結果と並べて公開しています。',
      '実際にどのような 5 点になるのか、そのままご確認いただけます。',
    ],
    benefitTitle: '前日の買い目と結果で分かること',
    benefitItems: [
      '有料版でお届けしたメインレースの買い目',
      '的中・不的中',
      '払戻（的中時）',
    ],
    ctaLabel: '前日の買い目と結果を見る',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    ctaNote: '有料会員へ配信した買い目を、毎日そのまま公開しています。',
  }),
  // ⚠️ 「開封層」の routing 先（`responseRoutes` の opened → step5）。
  //    読んでいる方には使い方の続きより先に**プランの違い**を出す。
  // ⚠️ CTA は `/pricing/`。会員限定ページは無料会員が到達できない。
  step({
    n: 5, delayDays: 14, angle: 'プランの違い',
    name: 'プラン比較',
    subject: '【KEIBA Analytics】無料・Light・Premium で見られる範囲の違い',
    preheader: '違うのはレース数です。買い目の作り方はどのプランでも同じです。',
    badge: 'プラン',
    headline: '違いは「見られるレース数」です',
    body: [
      'ご登録いただいた方へ、プランごとの違いをまとめました。',
      '',
      '無料のままでも、メインレースの予想と前日の買い目・結果はご覧いただけます。',
      '',
      'Light では各開催のメインレース買い目を、',
      'Premium では中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
      '',
      '買い目の作り方や指数の出し方は、どのプランでも同じです。',
      '違うのはご覧いただけるレース数と情報の範囲だけです。',
      '',
      'いまのまま無料でご利用いただいても構いません。',
    ],
    benefitTitle: 'プランごとの違い',
    benefitItems: [
      '無料 … メインレースの予想と前日の結果',
      'Light … 各開催のメインレース買い目',
      'Premium … 中央・南関の有料予想を全会場',
    ],
    ctaLabel: 'プランごとの範囲と料金を見る',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'プランごとにご覧いただける範囲と料金が並べて出ています。',
  }),
  // ⚠️ Premium Plus（三連単の個別配信）は **Premium Sanrenpuku 会員にのみ表示**し、
  //    それ以外には存在も知らせない（`CLAUDE.md`）。無料会員向けの本文に書かない。
  step({
    n: 6, delayDays: 21, angle: '上位プラン',
    name: '三連複という別軸',
    subject: '【KEIBA Analytics】馬単とは別軸の「三連複」という予想',
    preheader: '3 頭の組み合わせを自動で絞り込む、もうひとつの買い方です。',
    badge: '三連複',
    headline: '馬単とは別軸の買い目もあります',
    body: [
      'ご登録いただいた方へ、最後にもうひとつの予想をご紹介します。',
      '',
      'これまでご覧いただいてきた買い目は馬単ですが、',
      '三連複の予想もご用意しています。',
      '',
      '本命・対抗・単穴の 3 頭の相関関係を AI が分析し、',
      '全ての組み合わせから買い目を自動で絞り込みます。',
      '3 頭の組み合わせのため、配当の出方も馬単とは異なります。',
      '',
      'どのような買い目になるかは、実際のレースの例でご覧いただけます。',
    ],
    benefitTitle: '三連複について',
    benefitItems: [
      '3 頭の相関関係から自動で絞り込み',
      '対象は南関東 4 会場',
      '馬単とは別軸の狙い方',
    ],
    ctaLabel: '三連複の買い目の例を見る',
    ctaUrl: `${SITE}/sanrenpuku-demo/`,
    ctaNote: '実際のレースでの買い目と結果を載せています。',
  }),
]);

export default FREE_SIGNUP_ONBOARDING_STEPS;
