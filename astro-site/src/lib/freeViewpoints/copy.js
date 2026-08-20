/**
 * copy.js — 「レースの見どころ」の表示文言（**仮文言 / 最終コピーは未確定**）
 *
 * 文言を有限集合としてここに閉じ込める理由:
 *   - 予想的な評価語（堅い / 狙いやすい / 軸向き / 妙味 / 波乱 …）が混ざらないことを
 *     **テストで機械的に検査**できるようにするため
 *   - 中立文を「1 つの意味」に固定するため（弱いシグナルを新情報として出さない）
 *
 * ⚠️ 最終コピー・ページ名称・URL は MK 未承認。目視確認が必要な箇所。
 */

import { TAG, RACE_STATE } from './raceViewpoints.js';

/**
 * **予想的な評価語**。すべての文言（CTA を含む）に混ざっていないことを検査する。
 * 事実の記述に徹し、こちらの判断を無料側で語らないため。
 */
export const BANNED_JUDGEMENT_WORDS = Object.freeze([
  '堅い', '堅め', '固い', '狙い', '軸向き', '妙味', '波乱', '荒れ', '勝負',
  '的中', '回収', 'おすすめ', '推奨', '有望', '期待大',
]);

/**
 * **有料項目そのものを指す語**。タグ・状態・当日相対の文言には出さない
 * （レースの見どころの説明に有料項目名が出てくる必要が無いため）。
 *
 * ⚠️ `PAID_CTA` / `HORSE_SECTION` は**例外**。
 *    「買い目は出していない / 有料版で公開している」と**明示するために言及する**必要がある。
 *    ただし言及してよいのは**語だけ**で、実際の値や馬番の組み合わせは絶対に出さない。
 */
export const BANNED_PAID_TERMS = Object.freeze([
  '本命', '対抗', '単穴', '連下', '抑え', '不要馬',
  '買い目', '馬単', '三連複', '三連単', '指数', 'スコア', '評価点', '重要度',
]);

/** @deprecated 役割別に分割した。新規利用は上の 2 つを使う。 */
export const BANNED_WORDS = Object.freeze([...BANNED_JUDGEMENT_WORDS, ...BANNED_PAID_TERMS]);

/** 一覧に出す短いタグ名（仮）。 */
export const TAG_LABEL = Object.freeze({
  [TAG.DISTANCE_CHANGE]: '距離替わり多め',
  [TAG.FIRST_COURSE]: '初コース多め',
  [TAG.JOCKEY_CHANGE]: '乗り替わり多め',
  [TAG.EASY_COMPARE]: '近走を比べやすい',
  [TAG.HARD_COMPARE]: '近走を比べにくい',
});

/** 詳細に出す 1 文（仮）。事実の記述に限る。 */
export const TAG_SENTENCE = Object.freeze({
  [TAG.DISTANCE_CHANGE]: '前走から距離を替えてきた馬が多めです。',
  [TAG.FIRST_COURSE]: 'この会場を使っていなかった馬が多めです。',
  [TAG.JOCKEY_CHANGE]: '前走から騎手が替わる馬が多めです。',
  [TAG.EASY_COMPARE]: '前走と近い条件で走る馬が多く、近走を見比べやすい組み合わせです。',
  [TAG.HARD_COMPARE]: '前走の条件がそろっておらず、近走をそのまま横に並べにくい組み合わせです。',
});

/** 状態ごとの見出し（仮）。中立は**1 つの意味に固定**する。 */
export const STATE_LABEL = Object.freeze({
  [RACE_STATE.NEUTRAL]: '目立って大きな条件変化はありません',
  [RACE_STATE.NO_HISTORY]: '近走データなし',
  [RACE_STATE.UNMATCHED]: '近走データ準備中',
});

export const STATE_SENTENCE = Object.freeze({
  [RACE_STATE.NEUTRAL]: '距離・コース・騎手のいずれも、替わる馬は平均的な範囲でした。',
  [RACE_STATE.NO_HISTORY]: '出走馬に前走の記録がありません。近走を見比べる材料が無いレースです。',
  [RACE_STATE.UNMATCHED]: '出走馬の近走をまだ全頭ぶん確認できていません。一部の馬だけで全体の傾向を出すと誤解を招くため、このレースは見どころを出していません。',
});

/** 当日相対（会場単位）の見出し（仮）。絶対タグとは別レイヤーであることを文言でも示す。 */
export const HIGHLIGHT_LABEL = Object.freeze({
  mostChanged: '条件がいちばん動く',
  easiest: 'いちばん比べやすい',
  hardest: 'いちばん比べにくい',
});

/**
 * 照合状況の注記。**「照合できなかった」と「そもそも走っていない」を混同しない**。
 * @param {{state: string, matched: number, entryCount: number, counts: object}} result
 */
export function coverageNote(result) {
  if (!result) return '';
  const { state, matched, entryCount } = result;
  if (state === RACE_STATE.UNMATCHED) {
    return `${entryCount}頭中 ${matched}頭ぶんまで確認（残りは照合できていません）`;
  }
  if (state === RACE_STATE.NO_HISTORY) {
    return `${entryCount}頭すべてを照合、うち${entryCount}頭とも近走なし`;
  }
  return `${entryCount}頭すべての近走を集計`;
}

/**
 * 馬単位の条件変化チップ（仮）。**色だけに頼らず記号と文字でも意味が分かる**ようにする。
 * `kind` は表示側の色分けキー。
 */
export const HORSE_CHANGE_CHIP = Object.freeze({
  distanceChanged: Object.freeze({ label: '距離替わり', icon: '⇔', kind: 'distance' }),
  firstCourse: Object.freeze({ label: '初コース', icon: '◇', kind: 'course' }),
  jockeyChanged: Object.freeze({ label: '乗り替わり', icon: '⇄', kind: 'jockey' }),
  easyCompare: Object.freeze({ label: '前走と近い条件', icon: '≡', kind: 'compare' }),
});

/** タグに付ける記号（色に依存させないため）。 */
export const TAG_ICON = Object.freeze({
  [TAG.DISTANCE_CHANGE]: '⇔',
  [TAG.FIRST_COURSE]: '◇',
  [TAG.JOCKEY_CHANGE]: '⇄',
  [TAG.EASY_COMPARE]: '≡',
  [TAG.HARD_COMPARE]: '≠',
});

/** 状態に付ける記号。 */
export const STATE_ICON = Object.freeze({
  [RACE_STATE.NEUTRAL]: '＝',
  [RACE_STATE.NO_HISTORY]: '—',
  [RACE_STATE.UNMATCHED]: '⏳',
});

/**
 * `/free-prediction/` への導線（仮）。
 * 「出走馬を見に行く」ではなく、**買い目は有料版で確認できる**ことを伝える。
 *
 * ⚠️ 2026-08-20 に `/free-prediction/` は「無料予想」から**有料版のプレビュー**へ
 *    位置づけが変わった。**リンク先を「無料予想ページ」と呼ばないこと**（実態と食い違う）。
 */
export const PAID_CTA = Object.freeze({
  heading: 'このレースの買い目は有料版で公開しています',
  body: 'このページでは近走から分かる条件だけを出しています。どの馬からどう組み立てるかは有料版で公開しています。有料版のプレビューでは、各馬の過去走まで含めた詳しい内容をご確認いただけます。',
  linkLabel: '有料版のプレビューを見る →',
  planLabel: 'プランを見る →',
});

/** 馬単位の内訳の見出し（仮）。 */
export const HORSE_SECTION = Object.freeze({
  heading: '出走馬と近走から分かる条件',
  note: '印は無料で公開している上位 4 頭ぶんです。指数・評価点・買い目は含みません。',
  noChanges: '近走が確認できていないため、条件の変化は出していません。',
});


/**
 * 無料会員登録で開く拡張表示の文言（仮）。
 *
 * ⚠️ ここで約束するのは**公開事実の追加**だけ。
 *    買い目 / pt / AI総合指数 / 役割 / 特徴量は登録しても出さない。
 *    「登録すれば買い目が見える」と読める文言を書かないこと（有料価値を壊す）。
 */
export const MEMBER_EXTRAS = Object.freeze({
  lockedHeading: '無料登録で、このレースをもっと詳しく',
  lockedBody: 'メールアドレスだけで登録できます。登録すると、各馬の出走間隔・馬体重の増減・過去5走の条件の移り変わり、同じ条件を使ってきた馬の比較が見られるようになります。',
  benefits: Object.freeze([
    '出走間隔（連闘・中◯週・休養明け）',
    '前走の馬体重と増減',
    '過去5走の条件の移り変わり',
    '同じ会場・近い距離を使ってきた馬の比較',
  ]),
  note: '買い目は有料版でのみ公開しています。無料登録では公開されません。',
  ctaLabel: '無料で登録して詳しく見る →',
  // ページ冒頭の常設CTA（2026-08-20 追加）。
  // アコーディオンを開かないと登録案内が目に入らなかったため、一覧の手前にも置く。
  topLockedHeading: 'いまは「かんたん表示」です',
  topLockedBody: '無料登録すると、各レースを開いたときに下の4つが追加で表示されます。メールアドレスだけで登録でき、料金はかかりません。',
  topCtaLabel: '無料で登録する →',
  topLockedNote: '登録するとこのページの表示が増えます。買い目は有料版でのみ公開しています。',
  // 登録済みの人に「何が増えたか」を明示する（違いが分からない、という声への対応）。
  topMemberHeading: '無料登録ずみです。詳しい表示になっています',
  topMemberBody: 'レースを開くと、各馬に「出走間隔・馬体重の増減・条件の移り変わり」が付き、レースの下に「同じ条件を使ってきた馬」が出ます。',
  memberBadge: '無料登録者だけの表示',
  unlockedHeading: '会員向けの詳しい情報',
  sameConditionHeading: '同じ条件を使ってきた馬',
  sameConditionEmpty: 'このレースには、前走で同じ会場・近い距離を使った馬がいません。',
  historyHeading: '前回までのレース',
  historyHelp: '新しい順です。前の回とくらべて変わった点に印を付けています。',
});


/**
 * 初めての人向けの補足（2026-08-20 追加）。
 *
 * 対象は**競馬を始めたばかりの人**。「初コース」「乗り替わり」「中◯週」も知らない前提で書く。
 *
 * ⚠️ 書いてよいのは**事実の言い換え**だけ。
 *    「だから狙える / 危ない」のような**予想の評価は書かない**（`BANNED_JUDGEMENT_WORDS` で検査）。
 */

/** タグ・チップの用語をやさしく言い換えた注釈。 */
export const TERM_HELP = Object.freeze({
  [TAG.DISTANCE_CHANGE]: '前回より長い（または短い）距離を走る馬が多いレースです。',
  [TAG.FIRST_COURSE]: 'この競馬場を走るのが初めての馬が多いレースです。',
  [TAG.JOCKEY_CHANGE]: '前回と違う騎手が乗る馬が多いレースです。',
  [TAG.EASY_COMPARE]: '前回と似た条件で走る馬が多いので、前回の結果をそのまま見比べやすいレースです。',
  [TAG.HARD_COMPARE]: '前回と条件が違う馬が多いので、前回の着順だけを並べても比べにくいレースです。',
});

/** 馬ごとのチップの注釈。 */
export const CHIP_HELP = Object.freeze({
  distanceChanged: '前回と走る距離が 200m 以上ちがいます。',
  firstCourse: 'この競馬場で走るのは初めてです。',
  jockeyChanged: '前回とちがう騎手が乗ります。',
  easyCompare: '前回と同じ競馬場・近い距離なので、前回の結果を参考にしやすい馬です。',
  interval: '前回のレースからどれくらい間が空いたかです。',
  layoff: '3か月ちかく走っていなかったあと、久しぶりのレースです。',
  runAfterLayoff: '長い休みのあと、今日が何戦目かです。使われて調子が戻ってくることがあります。',
  bodyWeight: '前回のレースのときの体重と、その前の回からの増減です。',
});

/** 休み明け・叩き◯戦目の見せ方（仮）。 */
export const LAYOFF_LABEL = Object.freeze({
  layoff: { icon: '🏖', label: '休み明け', kind: 'layoff' },
  runAfterLayoff: { icon: '🔁', kind: 'run' },   // ラベルは「叩き◯戦目」を組み立てる
});

/** 「中◯週」など、そのままでは読めない言い方の補足。 */
export const INTERVAL_HELP = Object.freeze({
  連闘: '前の週にも走ったばかりです。',
  休養明け: '3か月ちかく走っていませんでした。',
  default: '前回のレースからの空き具合です。',
});

/** ページの使い方（初回だけ開いて見せる）。 */
export const HOW_TO_USE = Object.freeze({
  heading: 'このページの使い方',
  lead: '今日走る全レースについて、出走馬の「前回のレース」と何がちがうかをまとめています。',
  steps: Object.freeze([
    { title: 'まず一覧をながめる', body: '各レースに付いた印で、そのレースの特徴がひと目で分かります。' },
    { title: '気になるレースを開く', body: '「このレースの見かたと出走馬」を押すと、出走する馬の一覧が出ます。' },
    { title: '馬ごとのちがいを見る', body: 'どの馬の条件が前回から変わったのかが、馬ごとに分かります。' },
  ]),
  note: '買い目（どの馬を買うか）は有料版で公開しています。このページには含みません。',
  toggleOpen: '使い方を見る',
  toggleClose: '使い方を閉じる',
});

/** 用語補足の出し分けトグル。 */
export const HELP_TOGGLE = Object.freeze({
  on: 'かんたん表示：オン',
  off: 'かんたん表示：オフ',
  hint: '競馬用語にやさしい説明を付けます',
});

export default {
  TAG_LABEL, TAG_SENTENCE, STATE_LABEL, STATE_SENTENCE, HIGHLIGHT_LABEL,
  BANNED_WORDS, BANNED_JUDGEMENT_WORDS, BANNED_PAID_TERMS, coverageNote, MEMBER_EXTRAS, TERM_HELP, CHIP_HELP, LAYOFF_LABEL, INTERVAL_HELP, HOW_TO_USE, HELP_TOGGLE, HORSE_CHANGE_CHIP, TAG_ICON, STATE_ICON, PAID_CTA, HORSE_SECTION,
};
