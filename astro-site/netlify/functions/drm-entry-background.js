/**
 * drm-entry-background.js — **入口の重い処理はここだけが実行する**（Background / 最大 15 分）
 *
 * ── なぜ Background なのか（2026-09-14 本番実測）──────────────────
 * 入口の live を同期 Function で走らせたら **HTTP 504（gateway timeout）**。
 * 書き込みは 1 件も起きなかった（queue 0 / 送信 0）が完走できなかった。
 * scheduled Function は 30 秒で切られるので、日次経路も同じ問題を持つ。
 * そこで **手動 live も日次自動も、この 1 本へ委譲**する。
 *
 * ── ここがやること ────────────────────────────────────────────
 * **既存の `runDrmEntry()` を呼ぶだけ。** 送信ループも安全判定も**新しく作らない**。
 * 判定はすべて既存の単一源が、**この関数の中で改めて**行う:
 *
 *   入口のゲート          `drmEntryGates.readDrmEntryGates`
 *   送信の土台のゲート     同上（`MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED`）
 *   許可リスト            `drmEntryGates.isEntryCampaignAllowed`
 *   `expectedCount`       `drmEntryGates.checkExpectedCount`（**下見をやり直して**突き合わせ）
 *   購入 / 停止 / 対象外   `planAutoStartEntries` → `runSequenceTick`
 *   既送信 / DeliveryKey   `runSequenceTick`（名指しの突き合わせ・読み戻し確認）
 *
 * ⚠️ **呼び出し側から「誰に送るか」を受け取らない。** payload は
 *    `campaignId` / `expectedCount` / `manual` / `runId` だけで、
 *    アドレスも recordId も含まない。候補はここで**読み直す**ので、
 *    送信直前の再検証が短絡しない。
 * ⚠️ **202 即返し。** 結果は返さない。**既存の台帳とログ**で確認する
 *    （`CampaignDeliveries` / `ScheduledEmails` / `admin-marketing` の `drmProgress`）。
 * ⚠️ 公開 URL なので **`x-admin-secret` を必須**にする（直接 POST への防御）。
 *    さらにゲートが閉じていれば `runDrmEntry` が何もしない（二重防御）。
 */

import { runDrmEntry } from './cron-drm-autostart.js';
import { DRM_ENTRY_CAMPAIGN_IDS } from '../../src/lib/drm/drmEntryGates.js';

export const DRM_BG_LOG_TAG = '[drm-entry-bg]';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});
const log = (payload) => {
  try { console.log(`${DRM_BG_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') return json(200, {});
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 🛡️ 公開 URL への直接 POST を弾く（ゲートと合わせて二重防御）
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  if (request.headers.get('x-admin-secret') !== SECRET) return json(403, { error: 'Forbidden' });

  let body = {};
  try { body = await request.json(); } catch { body = {}; }

  const campaignId = String(body.campaignId || DRM_ENTRY_CAMPAIGN_IDS[0]).trim();
  const manual = body.manual === true;
  const expectedCount = body.expectedCount === undefined || body.expectedCount === null
    ? null : Number(body.expectedCount);
  const runId = String(body.runId || '').trim();

  log({ event: 'start', runId, campaignId, manual, expectedCount });

  /**
   * ⚠️ **`runDrmEntry` がすべてを改めて確認する。**
   *    下見（候補の読み直し）→ ゲート → 許可リスト → `expectedCount` の突き合わせ →
   *    入口の鍵 → `runSequenceTick`（購入/停止/既送信/`DeliveryKey`/読み戻し確認）。
   *    ここで結果を握り潰さず、ログへ残す（呼び出し側へは返らないため）。
   */
  let result;
  try {
    result = await runDrmEntry({
      env: process.env,
      now: Date.now(),
      campaignId,
      dryRun: false,
      expectedCount,
      manual,
    });
  } catch (e) {
    log({ event: 'error', runId, error: String((e && e.message) || 'unknown') });
    return json(202, { accepted: true, runId });
  }

  log({
    event: 'done',
    runId,
    ok: result && result.ok !== false,
    abort: (result && result.abort) || null,
    previewed: (result && result.previewed) ?? null,
    entered: (result && result.entered) ?? null,
    countDrift: (result && result.countDrift) || null,
    enqueued: (result && result.tick && result.tick.enqueued) ?? null,
    failed: (result && result.tick && result.tick.failed) ?? null,
    sideEffects: (result && result.tick && result.tick.sideEffects) || (result && result.sideEffects) || null,
  });

  // ⚠️ Background は結果を返さない契約。**台帳とログで確認する**
  return json(202, { accepted: true, runId });
}
