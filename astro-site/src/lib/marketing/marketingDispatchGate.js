/**
 * marketingDispatchGate.js — マーケティング送信ジョブの識別と専用ゲート（純粋・I/O なし）
 *
 * ── 解決する問題（2026-07-30 監査）────────────────────────────────────
 * 当初設計では、マーケティングの実送信に `NEWSLETTER_AUTOMATION_ENABLED=true` が必要だった。
 * しかしこのフラグは **AK の全メール自動化のマスタースイッチ**で、実測で 16 の Function が
 * 参照している（cron-email-scheduler / send-newsletter 系 / expiry 通知 / retry-failed-emails ほか）。
 * マーケティングのためだけに ON にすると、
 *
 *   - 滞留している PENDING の ScheduledEmails が一斉に送信され得る
 *   - 期限通知・メルマガ・再送などマーケティングと無関係な経路も同時に解禁される
 *
 * そこで **マーケティング専用の送信ゲート `MARKETING_CAMPAIGN_DISPATCH_ENABLED`** を導入し、
 * 2 方向の独立性を保証する:
 *
 *   1. マーケティングを解禁しても既存メール経路は動かない
 *      （専用 dispatcher は NEWSLETTER_AUTOMATION_ENABLED を参照しない）
 *   2. 既存メール経路を解禁してもマーケティングは動かない
 *      （共有 executor はマーケティングジョブを専用ゲート無しでは処理しない）
 *
 * 判定に使うのは ScheduledEmails の **タグ付けだけ**（新フィールドを増やさない）:
 *   CreatedBy = 'admin-marketing' / TargetPlan = 'campaign:<campaignId>'
 */

import { isRecentMarketingContact } from './campaignSend.js';

/** マーケティングが作る ScheduledEmails ジョブの目印 */
export const MARKETING_JOB_CREATED_BY = 'admin-marketing';
export const MARKETING_TARGET_PLAN_PREFIX = 'campaign:';
/** JobId の接頭辞（監査・突合用） */
export const MARKETING_JOB_ID_PREFIX = 'mkt-';

/**
 * この ScheduledEmails レコードはマーケティングキャンペーンのジョブか。
 * どれか 1 つでも該当すればマーケティング扱い（**広めに判定する**）。
 * 取りこぼすと共有 executor が専用ゲート無しで送ってしまうため、疑わしきは marketing とする。
 *
 * @param {object|null} fields ScheduledEmails の fields
 */
export function isMarketingJob(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const createdBy = String(f.CreatedBy ?? '').trim().toLowerCase();
  const targetPlan = String(f.TargetPlan ?? '').trim().toLowerCase();
  const jobId = String(f.JobId ?? '').trim().toLowerCase();
  return createdBy === MARKETING_JOB_CREATED_BY
    || targetPlan.startsWith(MARKETING_TARGET_PLAN_PREFIX)
    || jobId.startsWith(MARKETING_JOB_ID_PREFIX);
}

/**
 * マーケティングの **キュー登録**（CampaignDeliveries / ScheduledEmails の作成）が有効か。
 * 既定 OFF。
 */
export function isMarketingEnqueueEnabled(env) {
  return !!env && env.MARKETING_CAMPAIGN_ENABLED === 'true';
}

/**
 * マーケティングの **実送信** が有効か。
 * `NEWSLETTER_AUTOMATION_ENABLED` とは**独立**。既定 OFF。
 */
export function isMarketingDispatchEnabled(env) {
  return !!env && env.MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true';
}

/**
 * 共有 executor（execute-scheduled-emails-background）がこのジョブを処理してよいか。
 *
 * ── マーケティングジョブは **常に** 共有 executor では送らない（2026-07-30 恒久化）──
 * 以前は「専用ゲート `MARKETING_CAMPAIGN_DISPATCH_ENABLED` が true なら共有 executor でも
 * 送れる」設計だったが、それだと
 *
 *   NEWSLETTER_AUTOMATION_ENABLED=true ＋ MARKETING_CAMPAIGN_DISPATCH_ENABLED=true
 *
 * のときに、15 分毎の `cron-email-scheduler` → 共有 executor 経由でキャンペーンが飛ぶ。
 * 共有 executor は**固定宛先リストに対して per-recipient の送信直前再検証を行わない**ため、
 * 配信停止・バウンス・退会・24h 頻度・キャンペーン固有条件の再判定を素通りしてしまう。
 *
 * そこで **env に関係なく常に skip** する。マーケティングジョブの唯一の実送信経路は
 * `marketing-campaign-dispatch`（送信直前再検証あり）に固定する。
 *
 * ⚠️ **この関数は env を受け取らない。** 引数を持たせると「env 次第で共有 executor から
 *    送れる」条件を将来また作れてしまうため、構造的に不可能にしている（guard テストで固定）。
 *
 * ⚠️ マーケティング以外のジョブ（newsletter / step / race_main / expiry 等）の挙動は
 *    一切変えない。常に `allowed: true` を返し、従来どおり共有 executor が処理する。
 *
 * @param {object|null} fields ScheduledEmails の fields
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function canSharedExecutorSend(fields) {
  if (!isMarketingJob(fields)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'marketing_job_dedicated_dispatcher_only' };
}

/**
 * 送信直前の再検証で、この宛先へ送ってよいか。
 *
 * キュー登録時（dry-run）と実送信の間には時間差がある。その間に配信停止・バウンス・退会が
 * 起きても、固定宛先リストを持つジョブは**そのまま送られてしまう**（共有 executor は
 * explicit な宛先リストに対して再チェックを行わない）。ここで必ず再判定する。
 *
 * ⚠️ キャンペーン横断の頻度ガードもここで再計算する。dry-run 時点では 24 時間空いていても、
 *    実送信までの間に別キャンペーンが送られている可能性があるため。
 *    `recentContactAtMs` には**このジョブ自身の配信記録を含めない**こと
 *    （自分の queued レコードを見て自分を止めてしまう）。
 *
 * @param {{
 *   email: string,
 *   providerSuppressed: Set<string>|null,  null = 確認できなかった → 送らない
 *   blocked?: Set<string>,                 AK EmailBlacklist（HARD/SOFT 両方）
 *   unsubscribed?: Set<string>,
 *   withdrawn?: Set<string>,
 *   recentContactAtMs?: Map<string, number>|null,  他キャンペーンの最終送信日時
 *   nowMs?: number,
 * }} input
 * @returns {{ send: boolean, status: string, reason: string|null }}
 *   status は CampaignDeliveries.Status に入れる値（skipped-* / queued）
 */
export function verifyBeforeSend({
  email, providerSuppressed, blocked, unsubscribed, withdrawn, recentContactAtMs, nowMs,
}) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!e) return { send: false, status: 'skipped-duplicate', reason: 'no_email' };

  // 確認できないなら送らない（fail closed）
  if (!(providerSuppressed instanceof Set)) {
    return { send: false, status: 'skipped-blacklist', reason: 'provider_suppression_unavailable' };
  }
  if (providerSuppressed.has(e)) return { send: false, status: 'skipped-blacklist', reason: 'provider_suppressed' };
  if (blocked instanceof Set && blocked.has(e)) return { send: false, status: 'skipped-blacklist', reason: 'blacklist' };
  if (unsubscribed instanceof Set && unsubscribed.has(e)) return { send: false, status: 'skipped-unsubscribed', reason: 'unsubscribed' };
  if (withdrawn instanceof Set && withdrawn.has(e)) return { send: false, status: 'skipped-unsubscribed', reason: 'withdrawn' };

  if (recentContactAtMs instanceof Map) {
    const last = recentContactAtMs.get(e);
    if (isRecentMarketingContact({ lastSentAtMs: last, nowMs })) {
      return { send: false, status: 'skipped-frequency-cap', reason: 'recent_marketing_contact' };
    }
  }
  return { send: true, status: 'queued', reason: null };
}
