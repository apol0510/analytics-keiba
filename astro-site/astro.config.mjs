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
        // /premium-predictions/ は旧stub(noindex→/premium-prediction/nankan/)のため customPages から除去（2026-06-25 旧URL整理）
        // /standard-predictions/ は実ページ不在(404)のため customPages から除去（2026-06-25 URL正規化）
        // 高優先ページ（週1回更新）
        'https://analytics.keiba.link/free-prediction/archive/',
        'https://analytics.keiba.link/dark-horse-picks/',
        // 中優先ページ（月1回更新）
        'https://analytics.keiba.link/',
        'https://analytics.keiba.link/pricing/',
        // アーカイブハブ・カテゴリトップ（SSRのため明示出力）
        'https://analytics.keiba.link/archive/',
        'https://analytics.keiba.link/archive/jra/',
        'https://analytics.keiba.link/archive/nankan/',
      ],
      filter: (page) => {
        // 管理画面・プロトタイプページを除外
        if (page.includes('/admin/')) return false;
        // Premium Plus は Premium Sanrenpuku 会員限定の非公開商品。存在を知らせないため常に除外する
        if (page.includes('/premium-plus')) return false;
        if (page.includes('-prototype')) return false;
        if (page.includes('-demo')) return false;
        // 旧URL（リダイレクト元）はサイトマップから除外
        if (page.includes('/archive-jra')) return false;
        // JRA会場フラグメント（タブ初回選択時に fetch する内部用HTML断片）はサイトマップ非掲載
        if (page.includes('/free-prediction/jra/fragment/')) return false;
        // 旧予想URLの整理（2026-06-25）: stub(noindex) / 重複・stale な会場別 legacy ページを除外。
        // 正規URLは除外しない:
        //   '/premium-predictions'（複数形s）は旧stub/会場別のみ。新 '/premium-prediction/'(単数slash) は不一致。
        //   '/free-prediction-'（ハイフン）は旧stub(-jra)/会場別(-funabashi/-urawa)のみ。新 '/free-prediction/'(slash) は不一致。
        //   '/light-predictions-jra' は正規のため除外せず、会場別 -funabashi/-urawa のみ個別指定。
        const LEGACY_EXCLUDES = [
          '/premium-predictions',         // 旧premium stub + 旧会場別(複数形)
          '/free-prediction-',            // 旧free stub(-jra) + 旧会場別(-funabashi/-urawa)
          '/prediction-jra',              // 旧JRA stub (/prediction-jra)
          '/light-predictions-funabashi', // 旧light会場別
          '/light-predictions-urawa',     // 旧light会場別
        ];
        if (LEGACY_EXCLUDES.some((p) => page.includes(p))) return false;
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
