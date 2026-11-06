/**
 * AK の回収率を公開するかどうかのスイッチ（2026-11-06 MK 指示で一時非表示）。
 *
 * 🛑 新しい回収率の算定方式が MK に決まるまで true にしない。
 *    いま aiBetPoints.js が返す recoveryRate は非採用の方式（本線＋抑えの全組が分母。
 *    通算で南関 66.8% / 中央 76.2%）で、true にするとその値が「回収率」として公開される。
 *    入門講座 Step 1・2・4・5・6・7（193.9% 前提）の転送もこのスイッチで外れる。
 *    #870 の revert でも固定 73% / 静的ページの 173% が戻るので、revert で再表示しない。
 *
 * 再表示は、新方式の実装と同じ PR で行う。方式の履歴は docs/BET_POINT_LOGIC.md「回収率の算定方式の状態」。
 * 集計・archive のデータはそのまま持ち続ける。
 * 馬・騎手の条件別回収率は AK の成績ではないので、このスイッチの対象外。
 */
export const RECOVERY_RATE_PUBLIC = false;

/** 非公開の間は null を返す。テンプレートの `!= null` 判定でカードごと消える */
export const publicRate = (value) => (RECOVERY_RATE_PUBLIC ? value : null);
