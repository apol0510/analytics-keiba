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

/** 予想的な評価語。文言に混ざっていないことをテストで検査する。 */
export const BANNED_WORDS = Object.freeze([
  '堅い', '堅め', '固い', '狙い', '軸向き', '妙味', '波乱', '荒れ', '勝負',
  '本命', '対抗', '単穴', '連下', '抑え', '不要馬',
  '買い目', '馬単', '三連複', '三連単', '指数', 'スコア', '評価点', '重要度',
  '的中', '回収', 'おすすめ', '推奨',
]);

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

export default { TAG_LABEL, TAG_SENTENCE, STATE_LABEL, STATE_SENTENCE, HIGHLIGHT_LABEL, BANNED_WORDS, coverageNote };
