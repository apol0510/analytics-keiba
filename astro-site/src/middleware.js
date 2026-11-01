/**
 * Astro middleware — SSR（/api/* と SSR ページ）の計測だけを行う。リクエスト・応答には一切手を加えない。
 * - Airtable API 呼び出し回数（docs/AIRTABLE_CAPACITY.md「API 呼び出しの計測」）
 * - SSR Function の起動パス（関数ログ 1 行・src/lib/ops/ssrPathLog.js・docs/SAFETY_CHECKS.md ルール 9）
 */
import { installAirtableCallMeter } from './lib/ops/airtableCallMeter.js';
import { describeSsrRequest } from './lib/ops/ssrPathLog.js';

installAirtableCallMeter({ source: 'ssr' });

export const onRequest = async (context, next) => {
  const response = await next();
  if (!context.isPrerendered) {
    try {
      console.log(describeSsrRequest(context.request, response.status));
    } catch {
      // 計測の失敗で応答を変えない
    }
  }
  return response;
};
