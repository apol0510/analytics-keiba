// ステップメール enroll の単一窓口（Phase 2.3）
//
// 役割: 新規 free 登録時に StepEnrollments へ1件 enroll 行を作成する処理を集約する。
//   - 確定.4.1（多重 enroll 防止）: 作成前に同一 RecipientEmail + StepSequenceId + Status=active を
//     read-only 検索し、在れば作成しない（冪等）。enroll 作成は本ファイルのみに限定する。
//   - enroll-from-now（確定.5）: 新規 free 登録のみ enroll。既存会員のバックフィルはしない。
//
// 触れてよい書込み対象は StepEnrollments の enroll 行のみ。
//   - SendGrid / メール送信なし
//   - ScheduledEmails ジョブ作成なし
//   - CampaignDeliveries 書込みなし
//   - Customers 書込みなし
//   - enqueue / cron 起動なし
//
// 安全フラグ: 本ファイルは enroll 行作成のみ（送信ではない）。実際に「送る」のは将来の
//   Phase 3 で、master NEWSLETTER_AUTOMATION_ENABLED ＋ STEP_EMAIL_AUTOMATION_ENABLED の
//   両ガード下でのみ行う。enroll 自体は送信を発生させない。

import { randomUUID, createHash } from 'node:crypto';
import { getSequence } from './step-sequences.js';

export const SIGNUP_ONBOARDING_SEQUENCE_ID = 'analytics-keiba:signup-onboarding';
const STEP_ENROLLMENTS_TABLE = 'StepEnrollments';

/** email を 5-tier 除外・DeliveryKey と同じ規則で正規化（trim + lowercase） */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/** Airtable formula 文字列内で安全に使うため値の単一引用符をエスケープ */
function escapeForFormula(value) {
  return String(value).replace(/'/g, "\\'");
}

/**
 * StepEnrollments の create 用 fields ペイロードを構築（純粋関数・副作用なし・POSTしない）。
 * @returns {{ fields: object, enrollmentId: string }}
 */
export function buildEnrollmentPayload({ email, customerRecordId = null, source = 'unknown', now = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new Error('buildEnrollmentPayload: invalid email');
  }
  const enrollmentId = randomUUID();
  const enrolledAt = (now ? new Date(now) : new Date()).toISOString();
  const fields = {
    EnrollmentId: enrollmentId,
    StepSequenceId: SIGNUP_ONBOARDING_SEQUENCE_ID,
    RecipientEmail: normalized,
    EnrolledAt: enrolledAt,
    CurrentStepNumber: 1,
    Status: 'active',
    Metadata: JSON.stringify({
      planAtEnroll: 'free',
      source,
      createdBy: 'phase-2.3-enroll',
    }),
  };
  if (customerRecordId) fields.CustomerRecordId = String(customerRecordId);
  return { fields, enrollmentId };
}

/**
 * 既存 active enrollment を read-only 検索（多重 enroll 防止用）。
 * @returns {Promise<{ id: string, fields: object } | null>}
 */
export async function findActiveEnrollment({ apiKey, baseId, email, stepSequenceId = SIGNUP_ONBOARDING_SEQUENCE_ID }) {
  const normalized = normalizeEmail(email);
  const formula = `AND({RecipientEmail}='${escapeForFormula(normalized)}', {StepSequenceId}='${escapeForFormula(stepSequenceId)}', {Status}='active')`;
  const params = new URLSearchParams({ filterByFormula: formula, pageSize: '1' });
  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${STEP_ENROLLMENTS_TABLE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`findActiveEnrollment failed: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const data = await res.json();
  return (data.records && data.records[0]) || null;
}

/**
 * 新規 free 登録時の signup-onboarding enroll を作成する単一窓口。
 *   - 既存 active があれば作成せず { created:false, reason:'already-active', ... } を返す（冪等）。
 *   - 無ければ StepEnrollments に1件 create し { created:true, ... } を返す。
 *   - StepEnrollments の enroll 行作成のみ。送信・他テーブル書込みは行わない。
 *
 * 呼び出し側（auth-user.js 等）では try/catch でベストエフォートにし、enroll 失敗が
 * 登録本処理を壊さないようにすること。
 *
 * @returns {Promise<{ created: boolean, enrollmentId: string|null, recordId: string|null, reason: string }>}
 */
export async function enrollSignupOnboarding({ apiKey, baseId, email, customerRecordId = null, source = 'auth-user-free-signup', now = null }) {
  if (!apiKey || !baseId) throw new Error('enrollSignupOnboarding: missing apiKey/baseId');
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) throw new Error('enrollSignupOnboarding: invalid email');

  // 1) 多重 enroll 防止: 既存 active を read-only 検索
  const existing = await findActiveEnrollment({ apiKey, baseId, email: normalized });
  if (existing) {
    return {
      created: false,
      enrollmentId: existing.fields?.EnrollmentId || null,
      recordId: existing.id,
      reason: 'already-active',
    };
  }

  // 2) 新規 create（StepEnrollments のみ）
  const { fields, enrollmentId } = buildEnrollmentPayload({ email: normalized, customerRecordId, source, now });
  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${STEP_ENROLLMENTS_TABLE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`enrollSignupOnboarding create failed: HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  const created = await res.json();
  return { created: true, enrollmentId, recordId: created.id, reason: 'created' };
}

// --- ローカル dry-run 確認用メモ（実行はしない）---
// 既存 active 検索のみ（read-only・書込みなし）を試すには:
//   AIRTABLE_API_KEY=... AIRTABLE_BASE_ID=... node --input-type=module -e '
//     import { findActiveEnrollment } from "./src/lib/newsletter/step-enroll.js";
//     console.log(await findActiveEnrollment({ apiKey:process.env.AIRTABLE_API_KEY, baseId:process.env.AIRTABLE_BASE_ID, email:"someone@example.com" }));
//   '
// ※ enrollSignupOnboarding() は StepEnrollments への POST(create) を伴うため、
//   実行は「Airtable 書込みカナリア」= 承認後のみ。getSequence で定義の存在も検証可:
//   getSequence(SIGNUP_ONBOARDING_SEQUENCE_ID) // → null でないこと
void getSequence; // 参照保持（将来 enroll 前にシーケンス有効性チェックへ拡張可能）
void createHash; // 予約（将来 DeliveryKey 連携時に使用）
