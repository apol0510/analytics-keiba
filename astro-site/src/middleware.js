/**
 * Astro middleware — SSR（/api/* と SSR ページ）の Airtable API 呼び出し回数を数える。
 * 計測だけで、リクエストには一切手を加えない（docs/AIRTABLE_CAPACITY.md「API 呼び出しの計測」）。
 */
import { installAirtableCallMeter } from './lib/ops/airtableCallMeter.js';

installAirtableCallMeter({ source: 'ssr' });

export const onRequest = (_context, next) => next();
