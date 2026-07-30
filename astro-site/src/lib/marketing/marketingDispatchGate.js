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
 * マーケティングジョブは **専用ゲートが true のときだけ**処理を許す。
 * これにより「既存メール解禁のつもりで NEWSLETTER_AUTOMATION_ENABLED を ON にしたら、
 * 承認していないキャンペーンまで飛んだ」を構造的に防ぐ。
 *
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function canSharedExecutorSend(fields, env) {
  if (!isMarketingJob(fields)) return { allowed: true, reason: null };
  if (isMarketingDispatchEnabled(env)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'marketing_dispatch_disabled' };
}

/**
 * 送信直前の再検証で、この宛先へ送ってよいか。
 *
 * キュー登録時（dry-run）と実送信の間には時間差がある。その間に配信停止・バウンス・退会が
 * 起きても、固定宛先リストを持つジョブは**そのまま送られてしまう**（共有 executor は
 * explicit な宛先リストに対して再チェックを行わない）。ここで必ず再判定する。
 *
 * @param {{
 *   email: string,
 *   providerSuppressed: Set<string>|null,  null = 確認できなかった → 送らない
 *   blocked?: Set<string>,                 AK EmailBlacklist（HARD/SOFT 両方）
 *   unsubscribed?: Set<string>,
 *   withdrawn?: Set<string>,
 * }} input
 * @returns {{ send: boolean, status: string, reason: string|null }}
 *   status は CampaignDeliveries.Status に入れる値（skipped-* / queued）
 */
export function verifyBeforeSend({ email, providerSuppressed, blocked, unsubscribed, withdrawn }) {
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
  return { send: true, status: 'queued', reason: null };
}
