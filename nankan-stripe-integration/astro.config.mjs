import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

const { STRIPE_MODE, STRIPE_SECRET_KEY, PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = loadEnv(
  process.env.NODE_ENV || 'development',
  process.cwd(),
  ''
);

export default defineConfig({
  output: 'server', // API Routes 実行のため
  server: { port: 4321 },
  vite: {
    define: {
      // 環境変数を明示的に定義
      'process.env.STRIPE_MODE': JSON.stringify(STRIPE_MODE),
      'process.env.STRIPE_SECRET_KEY': JSON.stringify(STRIPE_SECRET_KEY),
      'process.env.PUBLIC_SUPABASE_URL': JSON.stringify(PUBLIC_SUPABASE_URL),
      'process.env.SUPABASE_SERVICE_ROLE_KEY': JSON.stringify(SUPABASE_SERVICE_ROLE_KEY),
      'process.env.STRIPE_STANDARD_PRICE_ID_TEST': JSON.stringify(loadEnv('development', process.cwd(), '').STRIPE_STANDARD_PRICE_ID_TEST),
      'process.env.STRIPE_PREMIUM_PRICE_ID_TEST': JSON.stringify(loadEnv('development', process.cwd(), '').STRIPE_PREMIUM_PRICE_ID_TEST),
      'process.env.SITE_URL': JSON.stringify(loadEnv('development', process.cwd(), '').SITE_URL),
    },
    envPrefix: ['PUBLIC_', 'STRIPE_', 'SUPABASE_']
  }
});