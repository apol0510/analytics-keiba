/**
 * campaignSequence.js — キャンペーンを**複数ステップの連続配信**にする（純粋・I/O なし）
 *
 * ── 設計の骨子: ステップは「キャンペーンの変種」 ────────────────────
 * 新しい配信基盤を作らない。ステップを解決すると **campaign と同じ形のオブジェクト**
 * （件名・本文・CTA・見た目が step のもので上書きされたもの）が返る。
 * したがって既存の
 *   `renderCampaign` / `computeCampaignContentHash` / `buildCampaignPlan` /
 *   `computeCampaignDeliveryKey` / benefit guard / engagement guard / dispatcher
 * が **1 行も変わらずそのまま使える**。ステップ専用の送信経路は作らない。
 *
 * ── 冪等性 ──────────────────────────────────────────────────
 * `sequenceStep` を持つキャンペーンは DeliveryKey に `:s<step>` が入る
 * （`campaignSend.js`）。よって
 *   **campaign × version × step × 受信者 = 1 通**
 * が構造的に保証される。同じ step を二度実行しても `already_delivered` で落ちる。
 * step を進めるのは「前の step が送信済み」という**事実**（CampaignDeliveries）だけ。
 *
 * ── 同じメールの繰り返しを禁止する ────────────────────────────
 * 「規定回数まで自動配信」は、同じ文面を N 回送ってよいという意味ではない。
 * `validateSequence()` が **件名・本文の重複を構造的に拒否**する
 * （テストで固定。重複した瞬間にカタログ検証が落ちる）。
 *
 * ⚠️ 取引メール（決済・認証・サポート・期限通知）は**シーケンスにしない**。
 *    ここで扱うのは `EmailType='campaign'` のマーケティング配信だけ。
 */

/** ステップ間隔の下限（日）。連日で追いかけない */
export const MIN_STEP_DELAY_DAYS = 2;

/** 1 シーケンスの上限。これ以上は「送りすぎ」なので定義できない */
export const MAX_SEQUENCE_STEPS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

/** ステップ定義を持つキャンペーンか */
export function isSequenceCampaign(campaign) {
  const steps = campaign && campaign.sequence && campaign.sequence.steps;
  return Array.isArray(steps) && steps.length > 0;
}

/** 正規化した steps（stepNumber 昇順）。シーケンスでなければ空配列 */
export function getSequenceSteps(campaign) {
  if (!isSequenceCampaign(campaign)) return [];
  return [...campaign.sequence.steps]
    .map((s, i) => ({ ...s, stepNumber: int(s.stepNumber) ?? i + 1 }))
    .sort((a, b) => a.stepNumber - b.stepNumber);
}

/**
 * 最大配信回数。**定義より多くは送れない**（steps 数で頭打ち）。
 * 未指定なら steps 数。
 */
export function resolveMaxSends(campaign) {
  const steps = getSequenceSteps(campaign);
  if (steps.length === 0) return 1;
  const declared = int(campaign.sequence.maxSends);
  if (declared === null || declared <= 0) return steps.length;
  return Math.min(declared, steps.length);
}

/** step 定義（見つからなければ null） */
export function getStep(campaign, stepNumber) {
  const n = int(stepNumber);
  if (n === null) return null;
  return getSequenceSteps(campaign).find((s) => s.stepNumber === n) || null;
}

/**
 * step を「キャンペーンと同じ形」へ解決する。
 *
 * - 件名・本文・CTA・見た目は **step の値が優先**。step に無ければ campaign の値
 * - `benefitType` / `benefitDescription` も step で上書きできる（benefit guard 用）
 * - `sequenceStep` を必ず載せる（DeliveryKey と contentHash がこれで分かれる）
 *
 * @returns {object|null} 実効キャンペーン（未知の step なら null = fail closed）
 */
export function resolveSequenceStep(campaign, stepNumber) {
  if (!campaign) return null;
  if (!isSequenceCampaign(campaign)) {
    // シーケンスでないキャンペーンは step 1 のみ = 従来どおり（キーも従来のまま）
    return int(stepNumber) === null || int(stepNumber) === 1 ? campaign : null;
  }
  const step = getStep(campaign, stepNumber);
  if (!step) return null;
  const max = resolveMaxSends(campaign);
  if (step.stepNumber > max) return null; // 上限を超える step は解決しない

  const pick = (key) => (step[key] !== undefined ? step[key] : campaign[key]);

  const effective = {
    ...campaign,
    subject: str(step.subject) || campaign.subject,
    body: typeof step.body === 'string' ? step.body : campaign.body,
    preheader: pick('preheader') || '',
    badge: pick('badge') || '',
    headline: pick('headline') || '',
    benefitTitle: pick('benefitTitle') || '',
    benefitItems: Array.isArray(pick('benefitItems')) ? pick('benefitItems') : null,
    ctaLabel: str(pick('ctaLabel')) || campaign.ctaLabel,
    ctaUrl: str(pick('ctaUrl')) || campaign.ctaUrl,
    ctaNote: pick('ctaNote') || '',
    footerNote: pick('footerNote') || '',
    benefitType: pick('benefitType'),
    benefitDescription: pick('benefitDescription'),
    /** ここから下がシーケンス固有（DeliveryKey / 画面表示が使う） */
    sequenceStep: step.stepNumber,
    sequenceStepCount: getSequenceSteps(campaign).length,
    sequenceMaxSends: max,
    sequenceDelayDays: int(step.delayDays) ?? 0,
    sequenceStepName: str(step.name) || `ステップ${step.stepNumber}`,
  };
  // steps 定義そのものは実効キャンペーンに残さない（contentHash を steps 全体に依存させない）
  delete effective.sequence;
  return effective;
}

/** step の待機日数（step1 は 0） */
export function stepDelayDays(campaign, stepNumber) {
  const step = getStep(campaign, stepNumber);
  if (!step) return null;
  return int(step.delayDays) ?? 0;
}

/**
 * 次に送ってよい時刻。**前の送信からの経過**で決める（固定の配信日を持たない）。
 * 前送信が無い（= step1）なら「いま」。
 */
export function computeNextSendAtMs({ campaign, stepNumber, lastSentAtMs, nowMs }) {
  const days = stepDelayDays(campaign, stepNumber);
  if (days === null) return null;
  const last = Number(lastSentAtMs);
  if (!Number.isFinite(last) || last <= 0) return Number(nowMs) || 0;
  return last + days * DAY_MS;
}

/** 画面・API 用の軽量ビュー（本文は含めない） */
export function describeSequence(campaign) {
  if (!isSequenceCampaign(campaign)) return null;
  const steps = getSequenceSteps(campaign);
  const max = resolveMaxSends(campaign);
  return {
    maxSends: max,
    stepCount: steps.length,
    steps: steps.map((s) => ({
      stepNumber: s.stepNumber,
      name: str(s.name) || `ステップ${s.stepNumber}`,
      subject: str(s.subject),
      preheader: str(s.preheader),
      delayDays: int(s.delayDays) ?? 0,
      ctaLabel: str(s.ctaLabel) || str(campaign.ctaLabel),
      benefitType: str(s.benefitType) || str(campaign.benefitType),
      /** 上限を超える step は定義されていても送らない */
      active: s.stepNumber <= max,
    })),
  };
}

/**
 * ⛔ 使ってはいけない表現。
 * 的中・利益の保証、断定的な儲け話、煽り。**1 つでも含めばカタログ検証で落ちる**。
 */
export const FORBIDDEN_PHRASES = Object.freeze([
  '的中保証', '必ず当たる', '必ず的中', '絶対に当た', '確実に当た',
  '儲かります', '必ず儲か', '絶対儲か', '損はしません', '元本保証', '利益保証',
  '100%的中', '100%当た', '返金保証', '今だけ限定', '今すぐ申し込まないと',
]);

/** 実データに基づかない数値の直書きを禁じる（的中率・回収率の手書き） */
const HARDCODED_STAT = /(的中率|回収率|勝率)\s*[:：]?\s*\d/;

/**
 * シーケンス定義の健全性。**ここで落ちる定義は本番に出せない**。
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateSequence(campaign) {
  const errors = [];
  if (!isSequenceCampaign(campaign)) return { ok: true, errors };

  const id = str(campaign.campaignId) || '(no id)';
  const steps = getSequenceSteps(campaign);
  const max = resolveMaxSends(campaign);

  if (steps.length > MAX_SEQUENCE_STEPS) {
    errors.push(`${id}: ステップが多すぎます（${steps.length} > ${MAX_SEQUENCE_STEPS}）`);
  }
  if (max > steps.length) errors.push(`${id}: maxSends が定義済みステップ数を超えています`);

  const seenNumbers = new Set();
  const seenSubjects = new Map();
  const seenBodies = new Map();

  steps.forEach((s, i) => {
    const label = `${id} step${s.stepNumber}`;
    if (s.stepNumber !== i + 1) errors.push(`${label}: stepNumber は 1 から連番であること`);
    if (seenNumbers.has(s.stepNumber)) errors.push(`${label}: stepNumber が重複`);
    seenNumbers.add(s.stepNumber);

    const subject = str(s.subject);
    const body = typeof s.body === 'string' ? s.body.trim() : '';
    if (!subject) errors.push(`${label}: 件名が空`);
    if (!body) errors.push(`${label}: 本文が空`);
    if (!str(s.preheader)) errors.push(`${label}: preheader が空（受信箱の一覧で本文が漏れる）`);
    if (!str(s.ctaLabel) && !str(campaign.ctaLabel)) errors.push(`${label}: CTA ラベルが無い`);
    if (!str(s.ctaUrl) && !str(campaign.ctaUrl)) errors.push(`${label}: CTA URL が無い`);
    if (!str(s.benefitType) && !str(campaign.benefitType)) errors.push(`${label}: benefitType が無い`);
    if (!str(s.benefitDescription) && !str(campaign.benefitDescription)) {
      errors.push(`${label}: benefitDescription が無い`);
    }

    // ── 同じメールの単純繰り返しを禁止 ──────────────────────────
    if (subject && seenSubjects.has(subject)) {
      errors.push(`${label}: 件名が step${seenSubjects.get(subject)} と同一（同じメールの繰り返し）`);
    }
    if (subject) seenSubjects.set(subject, s.stepNumber);
    if (body && seenBodies.has(body)) {
      errors.push(`${label}: 本文が step${seenBodies.get(body)} と同一（同じメールの繰り返し）`);
    }
    if (body) seenBodies.set(body, s.stepNumber);

    // ── 間隔 ────────────────────────────────────────────────
    const delay = int(s.delayDays) ?? 0;
    if (s.stepNumber === 1) {
      if (delay !== 0) errors.push(`${label}: step1 の delayDays は 0`);
    } else if (delay < MIN_STEP_DELAY_DAYS) {
      errors.push(`${label}: delayDays は ${MIN_STEP_DELAY_DAYS} 日以上`);
    }

    // ── 表現 ────────────────────────────────────────────────
    const textAll = `${subject} ${str(s.preheader)} ${body} ${str(s.headline)} ${str(s.ctaLabel)} `
      + `${str(s.ctaNote)} ${(Array.isArray(s.benefitItems) ? s.benefitItems : []).join(' ')}`;
    for (const bad of FORBIDDEN_PHRASES) {
      if (textAll.includes(bad)) errors.push(`${label}: 使用禁止の表現「${bad}」`);
    }
    if (HARDCODED_STAT.test(textAll)) {
      errors.push(`${label}: 実績数値の手書きは禁止（実データのページへ誘導する）`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/** カタログ全体の検証（テストと起動時チェック用） */
export function validateAllSequences(campaigns) {
  const errors = [];
  for (const c of Array.isArray(campaigns) ? campaigns : []) {
    errors.push(...validateSequence(c).errors);
  }
  return { ok: errors.length === 0, errors };
}
