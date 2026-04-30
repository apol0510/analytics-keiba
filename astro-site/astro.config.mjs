// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import netlify from '@astrojs/netlify';

// https://astro.build/config
export default defineConfig({
  site: 'https://analytics.keiba.link',
  base: '/',
  output: 'server',
  adapter: netlify(),

  // インテグレーション
  integrations: [
    sitemap({
      // SEO最適化：優先度・更新頻度設定
      customPages: [
        // 最優先ページ（毎日更新）
        'https://nankan-analytics.keiba.link/free-prediction/',
        'https://nankan-analytics.keiba.link/premium-predictions/',
        'https://nankan-analytics.keiba.link/standard-predictions/',
        // 高優先ページ（週1回更新）
        'https://nankan-analytics.keiba.link/free-prediction/archive/',
        'https://nankan-analytics.keiba.link/dark-horse-picks/',
        // 中優先ページ（月1回更新）
        'https://nankan-analytics.keiba.link/',
        'https://nankan-analytics.keiba.link/pricing/',
        'https://nankan-analytics.keiba.link/premium-plus/',
        // アーカイブハブ・カテゴリトップ（SSRのため明示出力）
        'https://analytics.keiba.link/archive/',
        'https://analytics.keiba.link/archive/jra/',
        'https://analytics.keiba.link/archive/nankan/',
      ],
      filter: (page) => {
        // 管理画面・プロトタイプページを除外
        if (page.includes('/admin/')) return false;
        if (page.includes('-prototype')) return false;
        if (page.includes('-demo')) return false;
        // 旧URL（リダイレクト元）はサイトマップから除外
        if (page.includes('/archive-jra')) return false;
        return true;
      },
      changefreq: 'daily',
      priority: 0.7,
      lastmod: new Date(),
    })
  ],

  // ビルド設定
  build: {
    assets: 'assets'
  },

  // SEO設定
  trailingSlash: 'never'
});
