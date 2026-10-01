import rss from '@astrojs/rss';

// 内容がビルド時に決まる（items は空・リクエスト依存なし）ので静的生成する。
// SSR のままだと RSS リーダーの巡回ごとに Function が起動し、Netlify の Functions 枠を消費する（2026-10-01）。
export const prerender = true;

export async function GET(context) {
  return rss({
    title: 'KEIBA Analytics | AI・機械学習で勝つ競馬予想プラットフォーム',
    description: 'AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム。従来の感覚的予想から科学的・統計的アプローチへ。',
    site: context.site,
    items: [],
    customData: `<language>ja-jp</language>`,
  });
}