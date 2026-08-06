/**
 * automationCatalog.js — AK 専用メルマガ自動化の**プリセット定義**（純粋・I/O なし）
 *
 * ── AK 単独で完結させる ───────────────────────────────────────
 * 実装・データ・設定の正本は**すべて AK 内**。KMA の tenant / 顧客 / キャンペーン /
 * 送信元 / 配信停止 / 台帳 / env / Redis / Airtable / 料金 / UI は**一切持ち込まない**。
 * KMA から借りたのは「状態機械・冪等性・quiet hours・再試行・取消・監査」という
 * **一般的な設計の考え方だけ**で、コードもデータも共有しない。
 *
 * ── 新しい配信基盤を作らない ──────────────────────────────────
 * 自動化は **送信経路を持たない**。既存 AK の
 *   `ScheduledEmails`（ジョブ正本） / `CampaignDeliveries`（1 通ごとの正本） /
 *   既存 dispatcher（`MARKETING_CAMPAIGN_DISPATCH_ENABLED` でゲート）
 * に**そのまま乗る**。自動化がやるのは「いつ・誰に・どのキャンペーンを」を決めて
 * **既存の enqueue 契約に渡すこと**だけ。
 *
 * ── 文面は既存キャンペーンを参照するだけ ──────────────────────
 * 本文・件名・CTA・version・contentHash は `campaignCatalog.js` が単一源。
 * ここで文面を複製しない（二重管理を作らない）。
 *
 * ⚠️ **プリセットは全て初期 OFF。** 管理者が明示的に有効化するまで自動実行しない。
 */

import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

/** トリガーの種類 */
export const TRIGGER_KIND = Object.freeze({
  /** 有効期限の N 日**前** */
  DAYS_BEFORE_EXPIRY: 'days_before_expiry',
  /** 有効期限の N 日**後**（期限切れ後のカムバック） */
  DAYS_AFTER_EXPIRY: 'days_after_expiry',
  /** 契約状態 × プランで常時該当（案内系） */
  PLAN_STATE: 'plan_state',
  /** 管理者が条件を指定する */
  MANUAL_CONDITION: 'manual_condition',
});

/**
 * ⚠️ **現行 Customers schema で安全に判定できないトリガーは実装しない。**
 * 誕生日は `Customers` に生年月日フィールドが存在しないため、
 * **設計候補として分離**し、ここには入れない（schema 変更が要るため）。
 */
export const DEFERRED_TRIGGERS = Object.freeze([
  {
    id: 'birthday',
    reason: 'Customers に生年月日フィールドが存在しないため、現行 schema では判定できない',
    requiresSchemaChange: true,
    note: 'Airtable へ日付フィールドを追加する設計変更が必要。本 Phase では実装しない。',
  },
  {
    id: 'payment_pending_followup',
    reason: '未入金・確認待ちの判定は可能だが、入金確認・昇格を自動実行しない前提を明文化するまで保留',
    requiresSchemaChange: false,
    note: 'PaymentConfirmed=false かつ RequestedPlan あり で判定可能。案内メールのみ・状態変更なしで別途設計する。',
  },
]);

/** 自動化 1 件の既定値（管理者が画面で上書きできる） */
export const AUTOMATION_DEFAULTS = Object.freeze({
  /** ⚠️ 既定 OFF。明示的に有効化するまで動かない */
  enabled: false,
  /** 1 回の実行で送る上限。超えたら停止する */
  maxSendsPerRun: 200,
  /** 実行前に dry-run を必須にするか */
  requireDryRun: true,
  /** 静音時間（JST）。この時間帯は実行しない */
  quietHours: { start: 21, end: 8 },
  /** 同じ相手へ同じ自動化を再送しない最小間隔（日） */
  minResendIntervalDays: 30,
});

/**
 * プリセット。
 * `campaignId` は `campaignCatalog.js` の既存キャンペーンを指す（文面の正本はあちら）。
 */
export const AUTOMATION_PRESETS = Object.freeze([
  {
    automationId: 'expiry-d7',
    name: '有効期限 7 日前リマインド',
    description: '有効期限の 7 日前に、更新のご案内を 1 通送る。',
    trigger: { kind: TRIGGER_KIND.DAYS_BEFORE_EXPIRY, days: 7 },
    campaignId: 'premium-renewal',
    audienceRule: { contracts: [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON], plans: [], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'expiry-d0',
    name: '有効期限 当日リマインド',
    description: '有効期限の当日に、更新のご案内を 1 通送る。',
    trigger: { kind: TRIGGER_KIND.DAYS_BEFORE_EXPIRY, days: 0 },
    campaignId: 'premium-renewal',
    audienceRule: { contracts: [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON], plans: [], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'comeback-d7',
    name: '期限切れ 7 日後カムバック',
    description: '有効期限から 7 日後に、復帰のご案内を 1 通送る。',
    trigger: { kind: TRIGGER_KIND.DAYS_AFTER_EXPIRY, days: 7 },
    campaignId: 'expired-comeback',
    audienceRule: { contracts: [MK_CONTRACT.EXPIRED], plans: [], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'comeback-d30',
    name: '期限切れ 30 日後カムバック',
    description: '有効期限から 30 日後に、復帰のご案内を 1 通送る。',
    trigger: { kind: TRIGGER_KIND.DAYS_AFTER_EXPIRY, days: 30 },
    campaignId: 'expired-comeback',
    audienceRule: { contracts: [MK_CONTRACT.EXPIRED], plans: [], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'free-to-light',
    name: 'Free 会員へ Light 案内',
    description: 'Free 会員へ Light プランのご案内を送る。',
    trigger: { kind: TRIGGER_KIND.PLAN_STATE },
    // ⚠️ Free → Light の汎用案内に**そのまま使える既存キャンペーンが無い**。
    //    `comeback-light-30d-granted` は「無料付与済み」を前提にした文面なので、
    //    付与が成功した相手にしか送ってはいけない（誤送信になる）。
    //    そこで既定は未選択にし、**管理者が画面で選ぶ**まで ACTIVE 化できないようにする。
    campaignId: null,
    audienceRule: { contracts: [], plans: [MK_PLAN.FREE], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'light-to-premium',
    name: 'Light 会員へ Premium 案内',
    description: 'Light 会員へ Premium プランのご案内を送る。',
    trigger: { kind: TRIGGER_KIND.PLAN_STATE },
    campaignId: 'premium-renewal',
    audienceRule: { contracts: [], plans: [MK_PLAN.LIGHT], enforce: true },
    ...AUTOMATION_DEFAULTS,
  },
  {
    automationId: 'manual-condition',
    name: '手動条件指定',
    description: '管理者が対象条件・実行日時・テンプレートを指定する任意キャンペーン。',
    trigger: { kind: TRIGGER_KIND.MANUAL_CONDITION },
    campaignId: null,      // 管理者が選ぶ
    audienceRule: { contracts: [], plans: [], enforce: false },
    ...AUTOMATION_DEFAULTS,
  },
]);

/** id → プリセット */
export function getAutomationPreset(automationId) {
  return AUTOMATION_PRESETS.find((a) => a.automationId === String(automationId ?? '').trim()) || null;
}

/** 画面一覧用（設定と影響が一目で分かる形） */
export function listAutomationPresets() {
  return AUTOMATION_PRESETS.map((a) => ({
    automationId: a.automationId,
    name: a.name,
    description: a.description,
    trigger: a.trigger,
    campaignId: a.campaignId,
    audienceRule: a.audienceRule,
    既定: {
      有効: a.enabled,
      '1回の上限': a.maxSendsPerRun,
      'dry-run必須': a.requireDryRun,
      quietHours: `${a.quietHours.start}:00-${a.quietHours.end}:00 JST`,
      再送間隔日数: a.minResendIntervalDays,
    },
  }));
}

/** プリセット定義の健全性（テストと起動時チェック用） */
export function validateAutomationPresets() {
  const errors = [];
  const seen = new Set();
  for (const a of AUTOMATION_PRESETS) {
    if (seen.has(a.automationId)) errors.push(`automationId 重複: ${a.automationId}`);
    seen.add(a.automationId);
    if (a.enabled !== false) errors.push(`${a.automationId}: 既定が OFF でない`);
    if (!Object.values(TRIGGER_KIND).includes(a.trigger?.kind)) {
      errors.push(`${a.automationId}: 未知の trigger.kind`);
    }
    if (a.trigger?.kind === TRIGGER_KIND.DAYS_BEFORE_EXPIRY
      || a.trigger?.kind === TRIGGER_KIND.DAYS_AFTER_EXPIRY) {
      if (!Number.isInteger(a.trigger.days) || a.trigger.days < 0) {
        errors.push(`${a.automationId}: trigger.days が不正`);
      }
    }
    if (!Number.isInteger(a.maxSendsPerRun) || a.maxSendsPerRun <= 0) {
      errors.push(`${a.automationId}: maxSendsPerRun が不正`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export default AUTOMATION_PRESETS;
