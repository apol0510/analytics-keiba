/**
 * cron-tick — 5 分ごとの定期処理を 1 回の起動でまとめて走らせる Scheduled Function（2026-11-01）
 *
 * 各処理の間隔・中身・鍵・件数上限は従来どおり。起動回数だけを減らす（src/lib/ops/cronTick.js）。
 * 5 本 × 個別起動（1 日 864 + 144 + 96 = 1,104 回）→ 1 日 288 回（月 約 24,500 回減）。
 *
 * | 処理 | 間隔 | 従来の schedule |
 * |---|---|---|
 * | cron-marketing-rollout | 5 分 | `*\/5 * * * *` |
 * | cron-marketing-dispatch | 5 分 | `*\/5 * * * *` |
 * | cron-premium-plus-delivery | 5 分 | `*\/5 * * * *` |
 * | cron-prospect-worker | 10 分 | `*\/10 * * * *` |
 * | cron-email-scheduler | 15 分 | `*\/15 * * * *` |
 *
 * 🛑 決済メール（payment-email-dispatcher / cron-payment-email-reconciler）と
 *    重い処理（cron-campaign-sequence・中央値 13.5 秒）は個別のまま。
 * 手動で 1 回走らせるときは Netlify UI の **Run now**（その時刻の区切りに当たる処理だけが走る）。
 */
import '../../src/lib/ops/cronTickMeter.js';
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
import { runCronTick } from '../../src/lib/ops/cronTick.js';
import rollout from './cron-marketing-rollout.js';
import dispatch from './cron-marketing-dispatch.js';
import premiumPlusDelivery from './cron-premium-plus-delivery.js';
import prospectWorker from './cron-prospect-worker.js';
import emailScheduler from './cron-email-scheduler.js';

// 実際の計測は先頭の cronTickMeter.js の import で入る（import は本体より先に評価されるため）。
// この呼び出しは同じ source での再確認で、同じプロセスでは何もしない（airtableCallMeter の guard test が文字で検査する）。
installAirtableCallMeter({ source: 'cron-tick' });

export const CRON_TICK_JOBS = Object.freeze([
  { name: 'cron-marketing-rollout', every: 5, run: rollout },
  { name: 'cron-marketing-dispatch', every: 5, run: dispatch },
  { name: 'cron-premium-plus-delivery', every: 5, run: premiumPlusDelivery },
  { name: 'cron-prospect-worker', every: 10, run: prospectWorker },
  { name: 'cron-email-scheduler', every: 15, run: emailScheduler },
]);

export default async function handler() {
  const out = await runCronTick(CRON_TICK_JOBS);
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ⚠️ Netlify は schedule をソースから静的に読む。定数参照にせず文字列で書く（cronTick.js の CRON_TICK_SCHEDULE と一致を test で検査）
export const config = {
  schedule: '*/5 * * * *',
};
