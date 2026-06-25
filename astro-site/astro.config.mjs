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

  // リンク先を hover/focus 時に先読みしてページ遷移を高速化
  // （全 <a> 内部リンク対象 / hover で先読みするので余計な帯域を使わない）
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },

  // インテグレーション
  integrations: [
    sitemap({
      // SEO最適化：優先度・更新頻度設定
      customPages: [
        // 最優先ページ（毎日更新）
        'https://analytics.keiba.link/free-prediction/',
        'https://analytics.keiba.link/premium-predictions/',
        // /standard-predictions/ は実ページ不在(404)のため customPages から除去（2026-06-25 URL正規化）
        // 高優先ページ（週1回更新）
        'https://analytics.keiba.link/free-prediction/archive/',
        'https://analytics.keiba.link/dark-horse-picks/',
        // 中優先ページ（月1回更新）
        'https://analytics.keiba.link/',
        'https://analytics.keiba.link/pricing/',
        'https://analytics.keiba.link/premium-plus/',
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
  // URL正規化: 末尾スラッシュ「有」に統一（trailingSlash:'always'）。
  // 理由: Netlify は静的ディレクトリ(/foo/index.html)を末尾スラッシュ有で 200 配信し、
  //   netlify.toml の 301 先・sitemap customPages・内部リンク多数(479)も既にスラッシュ有。
  //   これで canonical(=Astro.url 追従)も末尾スラッシュ有=直接200となり自己301が解消する。
  // build.format は既定の 'directory'（/foo/index.html）を維持。
  trailingSlash: 'always'
});
