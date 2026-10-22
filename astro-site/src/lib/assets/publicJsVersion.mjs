/**
 * public/js/*.js の版（中身の sha256 先頭 10 桁）。
 *
 * ⚠️ /js/*.js はファイル名が固定のまま `Cache-Control: max-age=31536000` で配信されていた
 *    （2026-10-22 実測）。一度読んだブラウザは 1 年間古い計測・金額表示のまま動く。
 *    BaseLayout は `?v=<この値>` を付けて読み込み、中身が変われば URL も変わるようにする。
 *
 * 中身を変えたらこの値も更新する（publicJsVersion.test.mjs が実ファイルと突き合わせて落とす）。
 * 計算: shasum -a 256 astro-site/public/js/<name>.js | cut -c1-10
 */
export const PUBLIC_JS_VERSION = Object.freeze({
  'submission-result': 'c5092cb092',
  'campaign-price': 'dcbfb242cc',
  'funnel-analytics': '3b9b7cae16',
});

/** `/js/<name>.js?v=<hash>`。未登録の名前は例外（版なしで配信しない）。 */
export function publicJsSrc(name) {
  const v = PUBLIC_JS_VERSION[name];
  if (!v) throw new Error(`publicJsSrc: unknown asset ${name}`);
  return `/js/${name}.js?v=${v}`;
}
