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
import { validateResponseRoutes } from '../drm/drmRouting.js';

export const MIN_STEP_DELAY_DAYS = 2;

/**
 * 1 シーケンスの上限。
 *
 * ⚠️ **6 → 36 へ引き上げ（2026-08-15）。** 事業要件が
 * 「無反応の相手にも数十回の接点を作って反応を見る」に変わったため。
 *
 * 「送りすぎ」の防御はステップ数の上限ではなく、
 * **`sequencePolicy` の頻度上限（既定 7 日で 2 通）と最小間隔**が担う。
 * ステップ数だけ絞っても、短期間に詰めて送れば同じことになる。
 * ここは「際限なく定義できない」ための天井にとどめる。
 */
export const MAX_SEQUENCE_STEPS = 36;

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
    /** 訴求角度。**連投を避けるための札**（画面と `sequencePolicy` が使う） */
    angle: str(step.angle) || null,
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

/**
 * **入口の自動開始**の宣言（`sequence.autoStart`）。
 *
 * ⚠️ `cron-campaign-sequence` は既定では **step1 を自動で撃たない**（母集団が最大になるため）。
 *    この宣言がある campaign だけ、**限定した入口の候補**に対して step1 を自動で送れる。
 *    宣言が無ければ 1 ミリも挙動は変わらない。
 *
 * 宣言の形:
 *   `autoStart: { kind: 'free_signup', withinDays: 14, maxPerTick: 50 }`
 *
 * - `kind`        … 入口の種類（**既知のものだけ**。増やすときはここに足す）
 * - `withinDays`  … 登録から何日以内の人を入口の候補にするか（**過去に遡って撃たない**）
 * - `maxPerTick`  … 1 回の実行で入口へ入れる上限（一気に開けない）
 */
export const AUTO_START_KIND = Object.freeze({
  /** メルマガ無料登録（`auth-user` が作る Free レコード） */
  FREE_SIGNUP: 'free_signup',
});

/** 入口候補を数えるときの既定 */
export const AUTO_START_DEFAULTS = Object.freeze({ withinDays: 14, maxPerTick: 50 });

/** 入口の宣言を取り出す（無ければ `null`） */
export function resolveAutoStart(campaign) {
  const raw = campaign && campaign.sequence && campaign.sequence.autoStart;
  if (!raw || typeof raw !== 'object') return null;
  const kind = str(raw.kind);
  if (!Object.values(AUTO_START_KIND).includes(kind)) return null;
  const withinDays = int(raw.withinDays) ?? AUTO_START_DEFAULTS.withinDays;
  const maxPerTick = int(raw.maxPerTick) ?? AUTO_START_DEFAULTS.maxPerTick;
  if (withinDays < 1 || maxPerTick < 1) return null;
  return { kind, withinDays, maxPerTick };
}

/**
 * 入口候補を **Airtable から絞って読むときの窓**（日数）。
 *
 * ⚠️ **超集合でなければならない。** 進行中の人が窓から外れると、
 *    管理画面の一覧から消えて「送れる人数」も「止まっている理由」も嘘になる。
 *    そこで「入口の窓 ＋ シーケンス全体の所要日数 × 無反応での間隔延長 ＋ 余白」を取る。
 */
export function resolveAutoStartAudienceWindowDays(campaign) {
  const auto = resolveAutoStart(campaign);
  if (!auto) return null;
  const span = getSequenceSteps(campaign).reduce((a, s) => a + (int(s.delayDays) ?? 0), 0);
  const factor = Math.max(1, int(campaign.sequencePolicy && campaign.sequencePolicy.slowdownFactor) ?? 1);
  return auto.withinDays + span * factor + 30;
}

/** step の待機日数（step1 は 0） */
/**
 * この連続配信が**どの母集団を相手にするか**の宣言（campaign 側の SSOT）。
 *
 * ── なぜ campaign 側で宣言するのか ────────────────────────────
 * 出所の絞り込みは長らく「呼び出しの引数」だけで決めていた。
 * 共有スケジューラは引数を渡さないので、既定の `all` になり、
 * **prospect 索引（約 12,000）まで母集団に入る**。
 * DRM の 3 本は**無料登録した実 Customers を育てる**ための道のりで、
 * prospect を混ぜてよい相手ではない（2026-09-14 の事故もこれが効いた）。
 *
 * env で持たせるのは**禁止**（`cron-drm-autostart` の `tickEnv = { ...env }` を通じて
 * 入口へ漏れる。2026-09-14 に本番で踏んだ）。だから **campaign の宣言**にする。
 *
 * ⚠️ 既定は `'all'`（**宣言しない campaign の挙動は 1 バイトも変わらない**）。
 * ⚠️ これは**狭める方向にしか効かない**。呼び出しが別の出所を要求したら
 *    広げるのではなく**矛盾として止める**（`runSequenceTick` 側で fail closed）。
 *
 * @returns {'all'|'prospect'|'customer'}
 */
export function resolveAudienceSource(campaign) {
  const raw = String(
    ((campaign && campaign.sequence) || {}).audienceSource ?? '',
  ).trim().toLowerCase();
  if (raw === 'prospect') return 'prospect';
  if (raw === 'customer') return 'customer';
  return 'all';
}

/** 宣言された母集団が既知の語かどうか（未知語を黙って `all` に倒さないため） */
export function isKnownAudienceSource(campaign) {
  const raw = ((campaign && campaign.sequence) || {}).audienceSource;
  if (raw === undefined || raw === null || raw === '') return true;
  return ['all', 'prospect', 'customer'].includes(String(raw).trim().toLowerCase());
}

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
  // ⚠️ 母集団の宣言が未知語なら**黙って `all` に倒さない**（広い方へ倒れると事故になる）
  if (!isKnownAudienceSource(campaign)) {
    return {
      ok: false,
      errors: [`sequence.audienceSource が不正です: ${
        String(((campaign && campaign.sequence) || {}).audienceSource)
      }（all / prospect / customer のいずれか）`],
    };
  }
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

  /**
   * 反応別 routing の宣言（`sequence.responseRoutes`）。
   * ⚠️ 実行時（`normalizeRoutes`）は知らない条件を黙って捨てるので、
   *    **書き間違いが「静かに線形のまま」になる**。宣言の形はここで落とす。
   */
  // ── 入口の自動開始の宣言 ────────────────────────────────────
  const rawAuto = campaign.sequence && campaign.sequence.autoStart;
  if (rawAuto !== undefined && rawAuto !== null) {
    if (typeof rawAuto !== 'object' || Array.isArray(rawAuto)) {
      errors.push(`${id}: sequence.autoStart は object で宣言すること`);
    } else if (!Object.values(AUTO_START_KIND).includes(str(rawAuto.kind))) {
      errors.push(`${id}: 未知の autoStart.kind「${str(rawAuto.kind)}」`);
    } else {
      const w = int(rawAuto.withinDays);
      const m = int(rawAuto.maxPerTick);
      if (w !== null && w < 1) errors.push(`${id}: autoStart.withinDays は 1 以上`);
      if (m !== null && m < 1) errors.push(`${id}: autoStart.maxPerTick は 1 以上`);
      // ⚠️ 入口を自動で開けるなら、**購入・停止で降りられる**ことが前提
      if (campaign.stopOnPurchase === false) {
        errors.push(`${id}: autoStart を宣言するなら購入で停止すること（stopOnPurchase: false は禁止）`);
      }
    }
  }

  errors.push(...validateResponseRoutes(campaign, {
    maxSends: max,
    stepNumbers: steps.map((s2) => s2.stepNumber),
  }).errors);

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
