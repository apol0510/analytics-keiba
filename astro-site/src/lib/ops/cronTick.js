/**
 * cronTick.js — 5 分ごとの定期処理を 1 つの Scheduled Function（`cron-tick`）にまとめて起動する（2026-11-01）
 *
 * ## なぜ
 *
 * Netlify の Functions 無料枠は月 125,000 回で、超えると $25/月 が加わる（2026-08〜10 の請求）。
 * 5 分ごとの Scheduled Function が 1 本あるだけで月 8,640 回を使う。
 * 同じ時刻に別々に起動していた処理を 1 回の起動の中で並べて走らせれば、
 * **各処理の間隔・即時性・中身は変えずに**起動回数だけを減らせる。
 *
 * ## 約束
 *
 * - 各処理の間隔は従来の `schedule` と同じ（5 分 / 10 分 / 15 分・UTC の分で判定）。
 * - 処理どうしは `Promise.allSettled` で並列に走らせ、1 つの失敗・例外が他を止めない。
 *   各処理の鍵（同じ tick の重複防止）・件数上限・deadline はそのまま効く。
 * - まとめた処理の Function は `schedule` を外すので公開 URL から起動できる形になる。
 *   **`cron-tick` が同じプロセス内で作った印の付いたリクエスト以外は 404 で何もしない**
 *   （`isCronTickRequest`）。印は WeakSet の中のオブジェクトなので HTTP からは作れない。
 * - 🛑 決済メール（`payment-email-dispatcher` / `cron-payment-email-reconciler`）はまとめない。
 *   1 起動 = 30 秒の予算を前提に件数上限・deadline を設計してあり（paymentEmailDispatchSchedule.guard）、
 *   決済の品質を Function 回数より優先する。
 */

export const CRON_TICK_SCHEDULE = '*/5 * * * *';
export const CRON_TICK_SLOT_MINUTES = 5;
export const CRON_TICK_LOG_TAG = '[cron-tick]';

const TICK_REQUESTS = new WeakSet();

/** cron-tick から各処理へ渡すリクエスト（印付き・本文は空の JSON） */
export function cronTickRequest() {
  const req = new Request('https://cron-tick.internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  TICK_REQUESTS.add(req);
  return req;
}

export function isCronTickRequest(req) {
  return !!req && typeof req === 'object' && TICK_REQUESTS.has(req);
}

/** cron-tick 以外からの起動に返す応答（副作用なし） */
export function directInvocationNotFound() {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

/**
 * いまの 5 分区切りで走らせる処理を選ぶ。
 * 起動が数秒遅れても同じ区切りに入るよう、分を 5 分単位に切り捨ててから判定する。
 * @param {{ name: string, every: number }[]} jobs
 * @param {Date} [now]
 */
export function dueJobs(jobs, now = new Date()) {
  const slot = Math.floor(now.getUTCMinutes() / CRON_TICK_SLOT_MINUTES) * CRON_TICK_SLOT_MINUTES;
  return jobs.filter((j) => slot % j.every === 0);
}

/**
 * @param {{ name: string, every: number, run: (req: Request) => Promise<Response|unknown> }[]} jobs
 * @param {{ now?: Date, log?: (line: string) => void }} [opts]
 */
export async function runCronTick(jobs, { now = new Date(), log = console.log } = {}) {
  const due = dueJobs(jobs, now);
  const settled = await Promise.allSettled(due.map((j) => j.run(cronTickRequest())));
  const results = due.map((j, i) => {
    const s = settled[i];
    if (s.status === 'rejected') {
      return { name: j.name, ok: false, error: String(s.reason?.message || s.reason || 'unknown').slice(0, 120) };
    }
    const status = s.value instanceof Response ? s.value.status : null;
    return { name: j.name, ok: status === null || status < 500, status };
  });
  for (const r of results) {
    log(`${CRON_TICK_LOG_TAG} ${r.name} ${r.ok ? 'ok' : 'error'} ${r.status ?? ''}${r.error ? ` ${r.error}` : ''}`.trim());
  }
  return { ran: results.length, results };
}
