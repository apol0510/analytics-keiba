/**
 * emailCopyStandard.js — **販促メールのコピー品質基準**（純粋・I/O なし）
 *
 * 正本は [`docs/EMAIL_COPY_STANDARD.md`](../../../docs/EMAIL_COPY_STANDARD.md)。
 * このモジュールは、その基準のうち**機械で判定できる部分だけ**を実装する。
 *
 * ── なぜ要るか（2026-09-15 MK 確定）────────────────────────────
 * AK から送る DRM・販促メールが「期限・価格・リンクの通知文」で終わっていた。
 * 受信者が **何の案内か → 自分に関係があるか → 何が得られるか → なぜ今検討するか
 * → 次に何をすればよいか** を理解できないまま CTA に到達していた。
 *
 * 文章の巧拙は機械で測れないが、**事務連絡に痩せた状態**は測れる:
 * 本文が 1〜2 行しかない / 特典欄が無い / preheader が本文の複製 /
 * CTA が「こちら」「ログイン」だけ、は構造で検出できる。ここはそれを担う。
 *
 * ── 適用範囲（`COPY_STANDARD_ADOPTED`）────────────────────────
 * ⚠️ **全キャンペーンには適用しない。** `campaignCatalog.js` のルール (C)
 *    「送信済み Step の文面変更は禁止」があるため、既に配信された文面は
 *    基準に合わなくても**書き換えられない**。基準を全体へ課すと、
 *    「直せないのに CI が落ちる」か「凍結を骨抜きにする」かの二択になる。
 *
 *    そこで **adopt 方式**を取る: 基準に適合させた campaign を明示的に登録し、
 *    登録済みのものだけを検査する。未登録の理由は
 *    `COPY_STANDARD_NOT_ADOPTED` に**理由つきで**必ず書く（黙って外せない）。
 *
 * ── 書き換えてよいかの判断は**このモジュールの外**────────────────
 * 送信済みかどうかの正本は `campaignCatalog.test.mjs` の `LOCKED`（`delivered`）と
 * `docs/progress.md` の実測。ここでは「基準を満たすか」だけを見る。
 */

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 基準の版。判定を変えたら上げる（docs の版と合わせる） */
export const COPY_STANDARD_VERSION = 1;

// ── しきい値 ────────────────────────────────────────────────
//
// ⚠️ 数値は「良い文章の条件」ではなく「**事務連絡に痩せていない**ことの下限」。
//    上限は設けない（長ければ良いわけではないが、長さで落とす理由も無い）。

/** 本文の下限。既存の良い文面（199〜354 文字）と痩せた文面（43〜65 文字）の間に置く */
export const MIN_BODY_CHARS = 180;
/** 本文の非空行の下限。見出し → 本文 → 価値 → オファーの 4 段が入る最小 */
export const MIN_BODY_LINES = 5;
/** 特典欄（何が得られるか）の件数。0 件は「価値の説明が無い」、5 件以上は読まれない */
export const MIN_BENEFIT_ITEMS = 2;
export const MAX_BENEFIT_ITEMS = 4;
/** 件名からブランド接頭辞を除いた実語の下限（「件名だけで内容が分かる」の下限） */
export const MIN_SUBJECT_CORE_CHARS = 10;

/** 件名のブランド接頭辞（実語の長さを測るときに外す） */
const SUBJECT_BRAND_PREFIX = /^【KEIBA\s*Analytics】/;

/**
 * ⛔ CTA ラベルがこれ**だけ**なら落とす。
 * 「押した先で何を確認できるか」が読めないため（MK 基準 5）。
 */
export const VAGUE_CTA_LABELS = Object.freeze([
  'こちら', 'こちらから', 'こちらをご覧ください', '詳細', '詳細はこちら',
  'ログイン', 'ログインする', 'サイトを見る', 'サイトへ', '見る', '開く',
  'クリック', 'お申し込み', '申し込む', '続きを読む',
]);

/**
 * ⛔ 顧客向けの文面に出してはいけない**内部運用の語**（`docs/spec.md`）。
 * 「正本」「メールには書いていません」は運営側の都合で、受信者には意味が無い。
 */
export const INTERNAL_AFFAIRS_PHRASES = Object.freeze([
  '正本', 'メールには書いていません', 'メールには書き写していません',
  'DeliveryKey', 'カタログ',
]);

/**
 * 冒頭で受信者との関係を作れているか（MK 基準 1）。
 * **本文の最初の 2 行**にこのどれかが要る。「いきなり期限だけ」を落とす。
 */
export const RELATION_MARKERS = Object.freeze([
  'ご登録', 'ご利用', 'お使い', 'ご契約', '会員', '体験', 'お申し込み',
  'ありがとうございます', 'お世話になっております', 'ご無沙汰',
]);

/**
 * ⛔ 会員限定ページ。**無料・見込み客向けの CTA に置かない**。
 * 権限が無い相手は認可で弾かれるので、「押す理由」を書いても到達できない
 * （MK 基準 5「実際の遷移先・権限・表示条件とは必ず一致させる」）。
 */
export const MEMBER_ONLY_CTA_PREFIXES = Object.freeze([
  '/premium-prediction/', '/premium-sanrenpuku/', '/premium-plus/',
  '/light-predictions', '/premium-predictions',
]);

/**
 * 公開導線（未ログインでも開ける）。ここに無いパスは**推測で足さない**。
 *
 * ── ⚠️ `/free/` と `/free-prediction/` は別ページ（片方は他方の旧 URL ではない）──
 *
 * | パス | 中身 | 状態 |
 * |---|---|---|
 * | `/free-prediction/{nankan,jra}/` | **有料版プレビュー**。買い目・AI総合指数・役割・不要馬まで出る | nav 掲載・noindex なし |
 * | `/free/{nankan,jra}/` | **無料コンテンツ第 2 層**（レースの見どころ）。**買い目 / pt / AI総合指数 / 役割 / 特徴量は出さない** | nav 掲載・noindex 解除済み（2026-08-20）。URL は**仮** |
 *
 * 両方とも現役で、**リダイレクトも noindex も廃止予定も無い**
 * （`/free/{nankan,jra}.astro` の冒頭に「`/free-prediction/` の役割は変更しない。
 * ここは別ページ」と明記され、当の `/free/` 自身が `/free-prediction/` へ誘導している）。
 *
 * ⚠️ したがって **`/free-prediction/` を「旧 URL」として `/free/` へ置き換えてはいけない。**
 *    買い目や指数を約束した本文を `/free/` へ送ると、約束したものが無いページに着地する。
 *    その取り違えは下の `VIEWPOINTS_ONLY_CTA_PATHS` の検査が落とす。
 */
export const PUBLIC_CTA_PATHS = Object.freeze([
  '/', '/dashboard/', '/pricing/', '/free-signup/', '/sanrenpuku-demo/',
  // 有料版プレビュー（買い目・指数・役割あり）
  '/free-prediction/nankan/', '/free-prediction/jra/',
  // 無料の「見どころ」（買い目・指数・役割なし）
  '/free/nankan/', '/free/jra/',
  '/results-showcase/nankan/', '/results-showcase/jra/',
  '/archive/nankan/', '/archive/jra/',
]);

/**
 * **着地先ごとに「そこで見られないもの」**（`docs/spec.md` §無料コンテンツ 2 層 /
 * `freePublicView.js` の公開 DTO / 各ページの表示が根拠）。
 *
 * ⚠️ 「URL が生きているか」だけでは不十分。**メールで約束した情報が着地先に実在するか**を見る。
 *    2026-09-15 のレビューで、`/free-prediction/` を「買い目・AI総合指数・全頭の役割が
 *    無料で見られるページ」として案内していた誤りが見つかった（実際は**伏せてある**）。
 *
 * | 着地先 | 見られる | 見られない |
 * |---|---|---|
 * | `/free-prediction/{nankan,jra}/` | 出走全頭の公開事実（馬番/馬名/騎手/厩舎/斤量/枠/父/性齢/過去走/通算成績）＋**上位 4 頭の印 ◎○▲△**＋レース詳細 | **買い目 / AI総合指数 / 累積スコア(pt) / 全頭の役割 / 特徴量・評価ポイント**（ダミーのモザイク表示のみ）|
 * | `/free/{nankan,jra}/` | レースの見どころ（近走・条件の替わり方）| 買い目 / pt / AI総合指数 / 役割 / 特徴量 |
 * | `/results-showcase/{nankan,jra}/` | **前日メインレースの買い目（5 点）**・的中/不的中・払戻 | 抑え（伏せる）/ AI総合指数 / 役割 |
 * | `/archive/{nankan,jra}/` | 月別・年別の的中実績 / 年間的中率 / 配当金額 | **買い目**（意図的に非公開）/ AI総合指数 / 役割 |
 * | `/sanrenpuku-demo/` | 三連複の買い目の実例と的中結果（固定デモ）| AI総合指数 / 役割 |
 * | `/pricing/` | プランごとの範囲と料金 | 買い目 / AI総合指数 / 役割 / 過去走 |
 *
 * ⚠️ 根拠を確認していないものを足さない。**「たぶん無い」で禁止語を増やさない。**
 */
export const LANDING_PAGE_HIDDEN_TERMS = Object.freeze({
  '/free-prediction/nankan/': FREE_PREVIEW_HIDDEN(),
  '/free-prediction/jra/': FREE_PREVIEW_HIDDEN(),
  '/free/nankan/': VIEWPOINTS_HIDDEN(),
  '/free/jra/': VIEWPOINTS_HIDDEN(),
  '/results-showcase/nankan/': Object.freeze(['AI総合指数', 'AI 総合指数', '抑え', '不要馬']),
  '/results-showcase/jra/': Object.freeze(['AI総合指数', 'AI 総合指数', '抑え', '不要馬']),
  '/archive/nankan/': Object.freeze(['買い目', 'AI総合指数', 'AI 総合指数', '不要馬']),
  '/archive/jra/': Object.freeze(['買い目', 'AI総合指数', 'AI 総合指数', '不要馬']),
  '/pricing/': Object.freeze(['AI総合指数', 'AI 総合指数', '過去走', '不要馬']),
});

/** `/free-prediction/` = 有料版プレビュー。印は出るが、買い目・指数・全頭役割は伏せてある */
function FREE_PREVIEW_HIDDEN() {
  return Object.freeze([
    '買い目', 'AI総合指数', 'AI 総合指数', '累積スコア', '特徴量', '評価ポイント',
    '全頭の役割', '不要馬', '抑え',
  ]);
}

/** `/free/` = レースの見どころ。評価に関わるものは一切出さない */
function VIEWPOINTS_HIDDEN() {
  return Object.freeze([
    '買い目', 'AI総合指数', 'AI 総合指数', '累積スコア', '特徴量', '評価ポイント',
    '全頭の役割', '不要馬', '抑え', '本命◎', '対抗○', '単穴▲',
  ]);
}

/** 旧名（`/free/` 専用の判定）。`LANDING_PAGE_HIDDEN_TERMS` に統合済み */
export const VIEWPOINTS_ONLY_CTA_PATHS = Object.freeze(['/free/nankan/', '/free/jra/']);

const SITE = 'https://analytics.keiba.link';

/** CTA URL からパスだけ取り出す（差し込み印はそのまま返す） */
export function ctaPathOf(url) {
  const u = str(url);
  if (!u) return '';
  if (u.startsWith('{{')) return u;
  return u.startsWith(SITE) ? u.slice(SITE.length) || '/' : u;
}

/** 本文の非空行 */
const bodyLines = (body) => str(body).split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * preheader が本文の複製になっていないか。
 * 受信箱の一覧で本文の 1 行目がそのまま見えると、**開く理由が 1 つも増えない**。
 */
function isPreheaderDuplicate(preheader, body) {
  const p = str(preheader).replace(/[。．.]$/, '');
  if (!p) return false;
  return bodyLines(body).some((line) => line.replace(/[。．.]$/, '') === p || line.includes(p));
}

/**
 * 1 通ぶんの判定。
 *
 * @param {object} step `campaignCatalog` の step（`resolveSequenceStep` 済みの形）
 * @param {{label?: string, allowMemberOnlyCta?: boolean}} [opts]
 *   `allowMemberOnlyCta` … 受信者が確実に権限を持つ campaign でだけ true にする
 * @returns {{ok: boolean, issues: Array<{code: string, message: string}>}}
 */
export function evaluateCopyStandard(step, opts = {}) {
  const s = step || {};
  const label = str(opts.label) || 'step';
  const issues = [];
  const add = (code, message) => issues.push({ code, message: `${label}: ${message}` });

  const subject = str(s.subject);
  const preheader = str(s.preheader);
  const body = str(s.body);
  const lines = bodyLines(body);
  const items = Array.isArray(s.benefitItems) ? s.benefitItems.filter((x) => str(x)) : [];

  // 1. 冒頭で受信者との関係を作る
  const opening = lines.slice(0, 2).join(' ');
  if (opening && !RELATION_MARKERS.some((m) => opening.includes(m))) {
    add('no_relation_opening',
      '冒頭 2 行に受信者との関係を示す言葉が無い（なぜこの案内が届いたのかが読めない）');
  }

  // 2. 事務連絡に痩せていない
  if (body.length < MIN_BODY_CHARS) {
    add('body_too_thin', `本文が ${body.length} 文字（下限 ${MIN_BODY_CHARS}）。価値の説明が入らない`);
  }
  if (lines.length < MIN_BODY_LINES) {
    add('body_too_few_lines', `本文の行数が ${lines.length}（下限 ${MIN_BODY_LINES}）。メリハリが付かない`);
  }

  // 3. 商品の価値を伝える欄
  if (!str(s.benefitTitle)) add('no_benefit_title', '特典欄の見出しが無い（何が得られるかの欄が無い）');
  if (items.length < MIN_BENEFIT_ITEMS) {
    add('too_few_benefit_items', `特典欄が ${items.length} 件（下限 ${MIN_BENEFIT_ITEMS}）`);
  }
  if (items.length > MAX_BENEFIT_ITEMS) {
    add('too_many_benefit_items', `特典欄が ${items.length} 件（上限 ${MAX_BENEFIT_ITEMS}）`);
  }

  // 4. preheader は開く理由を足す（本文の複製にしない）
  if (!preheader) add('no_preheader', 'preheader が無い');
  else if (isPreheaderDuplicate(preheader, body)) {
    add('preheader_duplicates_body', 'preheader が本文の複製（受信箱で開く理由が増えない）');
  }

  // 5. 件名だけで内容が分かる
  const core = subject.replace(SUBJECT_BRAND_PREFIX, '').trim();
  if (core.length < MIN_SUBJECT_CORE_CHARS) {
    add('subject_too_vague', `件名の実語が ${core.length} 文字（下限 ${MIN_SUBJECT_CORE_CHARS}）`);
  }

  // 6. CTA 直前に「押す理由」がある
  const ctaLabel = str(s.ctaLabel);
  if (!ctaLabel) add('no_cta_label', 'CTA ラベルが無い');
  else if (VAGUE_CTA_LABELS.includes(ctaLabel)) {
    add('vague_cta_label', `CTA が「${ctaLabel}」だけで、何を確認できるか読めない`);
  }
  if (!str(s.ctaNote)) add('no_cta_note', 'CTA の補足が無い（押した先で何が起きるか書かれていない）');

  // 7. 遷移先が受信者の権限と一致する
  const path = ctaPathOf(s.ctaUrl);
  if (!path) add('no_cta_url', 'CTA URL が無い');
  else if (!path.startsWith('{{')) {
    if (!opts.allowMemberOnlyCta
      && MEMBER_ONLY_CTA_PREFIXES.some((p) => path.startsWith(p))) {
      add('member_only_cta', `CTA が会員限定ページ（${path}）。権限が無い相手は到達できない`);
    } else if (!PUBLIC_CTA_PATHS.includes(path)
      && !MEMBER_ONLY_CTA_PREFIXES.some((p) => path.startsWith(p))) {
      add('unknown_cta_path', `CTA のパス（${path}）が公開導線の一覧に無い。推測で URL を作らない`);
    }
  }

  // 8. 内部運用の語を顧客へ出さない
  const all = [subject, preheader, body, str(s.headline), ctaLabel, str(s.ctaNote),
    items.join(' ')].join('\n');

  // 9. **約束したものが着地先に実在するか**
  //
  // ⚠️ 判定するのは「押した先で何が得られるか」を書く面
  //    （CTA ラベル / CTA 補足 / 特典欄）だけ。本文の散文は商品の説明として
  //    landing 先に無いものに触れることがあり（例: Light の範囲を説明しつつ /pricing/ へ送る）、
  //    そこまで見ると誤検知になるため**あえて見ない**。
  const hidden = LANDING_PAGE_HIDDEN_TERMS[path];
  if (hidden) {
    const promiseSurface = [ctaLabel, str(s.ctaNote), str(s.benefitTitle), items.join(' ')].join('\n');
    const promised = hidden.filter((t) => promiseSurface.includes(t));
    if (promised.length) {
      add('promise_not_on_landing_page',
        `CTA 周り（ラベル / 補足 / 特典欄）が「${promised.join('・')}」を得られるものとして`
        + `案内しているが、着地先 ${path} では見られない`);
    }
  }
  for (const bad of INTERNAL_AFFAIRS_PHRASES) {
    if (all.includes(bad)) add('internal_affairs', `顧客向けの文面に内部運用の語「${bad}」がある`);
  }

  return { ok: issues.length === 0, issues };
}

/**
 * **基準を適用する step**（adopt 済み）。
 *
 * ⚠️ adopt は **campaign 単位ではなく step 単位**。同じ campaign でも
 *    送信済み Step はルール (C) で書き換えられず、基準に届かないまま残るため
 *    （例: `free-signup-onboarding` step1 は 2026-09-14 に 14 通 送信済み）。
 *
 * 値は `'all'`（全 step）または step 番号の配列。
 */
export const COPY_STANDARD_ADOPTED = Object.freeze({
  /** step1 は送信済み・凍結。改稿できた step2〜6 だけを adopt */
  'free-signup-onboarding': Object.freeze([2, 3, 4, 5, 6]),
  'light-to-premium-sequence': 'all',
  'sanrenpuku-upsell-sequence': 'all',
});

/**
 * adopt 済み campaign のうち、**送信済みで改稿できない Step**とその根拠。
 * ⚠️ ここに書いた step は基準の検査から外れる。**理由なしに足せない**
 *    （テストが理由の存在と、`LOCKED` の送信実績との整合を検査する）。
 */
export const COPY_STANDARD_FROZEN_STEPS = Object.freeze({
  'free-signup-onboarding': Object.freeze({
    1: '2026-09-14 に 14 通 送信済み（ルール (C) により変更不可）',
  }),
});

/** その step に基準を適用するか */
export function isCopyStandardAdopted(campaignId, stepNumber) {
  const a = COPY_STANDARD_ADOPTED[campaignId];
  if (!a) return false;
  if (a === 'all') return true;
  return a.includes(Number(stepNumber));
}

/**
 * **基準の対象外**とその理由。
 *
 * ⚠️ 「落ちるから外す」は禁止。外してよいのは
 *    **送信済み・稼働中で書き換えられない**か、**別任務が所有している**ものだけ。
 *    理由を書かずに足せないよう、テストが理由の存在を検査する。
 */
export const COPY_STANDARD_NOT_ADOPTED = Object.freeze({
  // ── 送信済み Step を含む（ルール (C) により書き換え不可）────────────
  'campaign-discount-free': '稼働中（第 2 期 2026-09-10〜09-23）。step1 15,509 通 / step2 200 通超が送信済み',
  'campaign-discount-light': '稼働中（第 2 期）。step1 5 通が送信済み、step2 も tick 済み',
  'campaign-discount-premium': '稼働中（第 2 期）。step1 13 通が送信済み、step2 も tick 済み',
  'light-trial-to-premium-sequence': 'step1 を 10 名へ送信済み（逐語凍結）。step2〜6 は別途 adopt 可',
  'expired-comeback': '単発・送信済み（version 2）',
  'premium-renewal': '単発・送信済み（version 2）',
  'sanrenpuku-offer': '単発・送信済み（version 3）',
  'premium-plus-offer': '単発・送信済み（version 3）',
  'dormant-reactivation': '単発・14,279 通 送信済み（version 2）',
  'comeback-offer': '単発・送信済み（version 2 / 68 通）。本文は offer カタログから生成',
  'comeback-light-30d-granted': '単発・送信済み（version 2）',
  'free-member-activation': '単発・送信実績あり（version 1）',
  'light-lifetime-restart': '単発。18 名の正規化済み会員向けで、既に基準相当の構成',
  // ── 別任務が所有（勝手に触らない）────────────────────────────
  'campaign-prospect-phase2': '最上位任務「反応で選別する配信基盤」が所有（#548 で追加・本番反映待ち）',
  'light-trial-post-expiry-sequence': '18 通とも特典欄・角度を持ち基準相当。Light 体験コホート専用で別途判断',
  // ── 販促メールではない ──────────────────────────────────────
  'marketing-canary': '配信経路の疎通確認用。販促メールではない',
  'general-announcement': '恒久停止中の初期テンプレート',
});

export default evaluateCopyStandard;
