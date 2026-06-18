/**
 * レースアコーディオン close 後スクロール復元の純粋判定。
 * RaceAccordionClickClose.astro（実装）とテストが同じ関数を参照し、ロジックの乖離を防ぐ。
 * 表示専用。予想データ・指数・印・買い目には一切関与しない。
 */

/**
 * toggle 実行前の content.style.maxHeight から「今は開いている（＝これから閉じる）」かを判定。
 * 全対象ページで closed は初期 inline `max-height:0`（→ '0px'）/ close 代入も '0px'。
 * open は 'none' または '<scrollHeight>px'。'' は念のためのガード（実際には発生しない）。
 */
export function isOpenMaxHeight(maxHeight) {
  return maxHeight !== '' && maxHeight !== '0px';
}

/** 閉じた header が viewport 上端より上（画面外）のときだけ戻す。可視（>=0）なら何もしない。 */
export function shouldRestoreHeader(headerTop) {
  return headerTop < 0;
}

/** content 自身の max-height transition 完了だけを close 完了とみなす（子要素 / opacity は無視）。 */
export function isCloseTransitionEnd(eventTarget, content, propertyName) {
  return eventTarget === content && propertyName === 'max-height';
}
