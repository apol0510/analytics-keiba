import rss from '@astrojs/rss';

export async function GET(context) {
  return rss({
    title: 'NANKANアナリティクス | AI・機械学習で勝つ競馬予想プラットフォーム',
    description: 'AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム。従来の感覚的予想から科学的・統計的アプローチへ。',
    site: context.site,
    items: [],
    customData: `<language>ja-jp</language>`,
  });
}