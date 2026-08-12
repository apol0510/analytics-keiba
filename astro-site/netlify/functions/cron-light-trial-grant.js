/**
 * cron-light-trial-grant.js — Light 30日無料体験の**入口**（自動付与 → Step1 登録 / 既定 OFF）
 *
 * ⚠️ **4 つのゲートが全て開くまで、Customers へ 1 バイトも書かない。**
 *      1. `COMEBACK_GRANT_FIELDS_READY=1`       … 既存の付与ゲート（列の実在）
 *      2. `COMEBACK_GRANT_ENABLED=true`         … 既存の付与ゲート（実行許可）
 *      3. `LIGHT_TRIAL_AUTOGRANT_ENABLED=true`  … 自動化の許可
 *      4. `LIGHT_TRIAL_AUTOGRANT_ARMED=<今日の JST 日付>`（翌日には自動的に閉じる）
 *    1・2 は**手動付与と同じゲート**を再利用する（自動化のための抜け道を作らない）。
 *
 * ⚠️ **配信系ゲート（`MARKETING_CAMPAIGN_ENABLED` /
 *    `MARKETING_CAMPAIGN_DISPATCH_ENABLED`）は要求しない。**
 *    この Function は**権利を付けるだけ**で、メールを 1 通も作らないため。
 *
 * ── やること（付与だけ）──────────────────────────────────────
 *   ① 対象コホート（CSV 取り込み）を数える → 観測できなければ**中止**
 *   ② 候補を選ぶ（過去付与・有料・期限なし付与・付与中・配信不可を除外）
 *   ③ **先頭 N 件だけ付与**（既定 100・`buildComebackPlan` の計画をそのまま PATCH）
 *
 * ── やらないこと ────────────────────────────────────────────
 *   **キュー登録も送信もしない。** Step1 は別工程（管理画面の dry-run → キュー登録）で、
 *   付与に成功して無料期間中になった人だけが対象になる。
 *   付与に失敗した人は権利が無いので Step1 の対象に**入りようがない**。
 *
 * ── 段階実行（14,000 件規模でも全体 abort しない）──────────────
 *   **offset の正本は作らない。** 付与済みは次回の候補判定で外れるので、
 *   再実行すると自然に次の N 件へ進む。失敗した人は候補に残り、次回再評価される。
 *   並びは recordId 昇順で決定的（同じ入力なら毎回同じ 100 件）。
 *
 * ── dry-run（書き込みゼロ）──────────────────────────────────
 *   `{"dryRun": true}` を POST すると、**ゲートが閉じていても**
 *   「CSV 対象総数 / 付与候補 / 除外理由別件数」を返す（read-only）。
 *   手動呼び出しには `x-admin-secret` が必要。
 *
 * ⚠️ この Function が書くのは **Customers の LightGrant\* だけ**。
 *    メールも、キューの行（ScheduledEmails / CampaignDeliveries）も**一切作らない**。
 */

import {
  readAutoGrantGates, summarizeAutoGrantRun,
  AUTOGRANT_ABORT, AUTOGRANT_SKIP_LABEL, HARD_MAX_BATCH_SIZE,
} from '../../src/lib/comeback/lightTrialAutoGrant.js';
import { COHORT_SKIP_LABEL } from '../../src/lib/crm/importedCohort.js';
import { chunkTargets } from '../../src/lib/comeback/comebackGrantPlan.js';
import { loadAndPlanLightTrial } from '../../src/lib/comeback/lightTrialPlanLoader.js';

const CUSTOMERS_TABLE = 'Customers';

export const TRIAL_LOG_TAG = '[light-trial-grant]';

function log(payload) {
  try { console.log(`${TRIAL_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const auth = (key) => ({ Authorization: `Bearer ${key}` });

/** 付与を書く（**計画どおりの fields だけ**）。成功した recordId を返す */
async function applyGrants({ KEY, BASE, targets }) {
  const written = new Set();
  let failed = 0;
  for (const group of chunkTargets(targets)) {
    const records = group
      .filter((t) => t && t.recordId && t.grantFields && Object.keys(t.grantFields).length > 0)
      .map((t) => ({ id: t.recordId, fields: t.grantFields }));
    if (records.length === 0) continue;
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ records, typecast: false }),
    });
    if (!res.ok) { failed += records.length; continue; }
    const data = await res.json().catch(() => ({}));
    for (const rec of data.records || []) if (rec && rec.id) written.add(rec.id);
  }
  return { written, failed };
}

/**
 * 実処理。**テストからはここを直接呼ぶ**。
 * @param {{env: object, now: number, dryRun?: boolean}} args
 */
export async function runLightTrialGrant({ env = process.env, now = Date.now(), dryRun = false } = {}) {
  const gates = readAutoGrantGates(env, now);
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;

  // ゲートが閉じているときは **dry-run（read-only）だけ**通す。実行は即終了。
  if (!gates.allOpen && !dryRun) {
    const body = { ok: false, abort: AUTOGRANT_ABORT.GATES_CLOSED, missing: gates.missing, sideEffects: 'none' };
    log(body);
    return body;
  }
  if (!KEY || !BASE) return { ok: false, abort: 'airtable_not_configured', sideEffects: 'none' };

  // ①②③ 下見と実行で**同じ 1 本**を通る（formula / sort / 関所 / 指紋が構造的に一致）
  const loaded = await loadAndPlanLightTrial({ env, nowMs: now, gates });
  if (!loaded.ok) {
    const body = { ok: false, abort: loaded.abort, sideEffects: 'none', fetch: loaded.fetch || null };
    log(body);
    return body;
  }
  const planned = loaded.planned;

  const view = {
    offerId: planned.offerId,
    operationId: planned.operationId,
    batchSize: planned.batchSize,
    batchSizeSource: planned.batchSizeSource,
    hardMax: HARD_MAX_BATCH_SIZE,
    cohort: {
      // ⚠️ 全件走査をやめたので**コホート全体の数ではない**（取得できた範囲）
      観測できた件数: planned.cohort ? planned.cohort.inCohort : 0,
      バッチ別: planned.cohort ? planned.cohort.byBatch : {},
      走査件数: planned.counts ? planned.counts.scanned : 0,
      全件走査していない: planned.cohort ? planned.cohort.partial === true : false,
    },
    今回処理予定: planned.counts ? planned.counts.batchSize : 0,
    /** 正確な残数は出さない（全件走査しないと分からないため） */
    残り: null,
    まだ候補がある: loaded.fetch ? loaded.fetch.moreAvailable : null,
    取得ページ数: loaded.fetch ? loaded.fetch.pagesFetched : null,
    取得件数: loaded.fetch ? loaded.fetch.recordsFetched : null,
    関所取得件数: loaded.fetch ? loaded.fetch.barrierRecords : null,
    関所: {
      付与済み: planned.barrier ? planned.barrier.granted : 0,
      Step1未処理: planned.barrier ? planned.barrier.outstanding : 0,
      片付いた: planned.barrier ? planned.barrier.resolved : 0,
      次バッチ可: planned.barrier ? planned.barrier.nextBatchAllowed : true,
    },
    planFingerprint: planned.planFingerprint || '',
    除外理由: Object.fromEntries(
      Object.entries((planned.counts && planned.counts.byReason) || {})
        .map(([k, v]) => [AUTOGRANT_SKIP_LABEL[k] || COHORT_SKIP_LABEL[k] || k, v]),
    ),
  };

  if (dryRun) {
    const body = {
      ok: true, mode: 'dry-run', sideEffects: 'none',
      gates: { allOpen: gates.allOpen, missing: gates.missing },
      ...view,
      notice: 'これは下見です。**1 バイトも書いていません**（付与もキュー登録もしていません）。',
    };
    log({
      mode: 'dry-run',
      observed: view.cohort.観測できた件数,
      batch: view.今回処理予定,
      moreAvailable: view.まだ候補がある,
    });
    return body;
  }

  if (!planned.ok) {
    const body = { ok: false, ...view, abort: planned.abort, reason: planned.reason, sideEffects: 'none' };
    log(summarizeAutoGrantRun({ plan: planned }));
    return body;
  }

  // ④ 付与（**ここが唯一 Customers を書く**。メールは 1 通も作らない）
  //    ここへ来るのは 関所が開いている（Step1 未処理 0 件）ときだけ
  const { written, failed } = await applyGrants({ KEY, BASE, targets: planned.plan.targets });

  const summary = summarizeAutoGrantRun({ plan: planned, granted: written.size, failed });
  log(summary);
  return {
    ok: true,
    ...view,
    granted: written.size,
    failed,
    sideEffects: 'granted_only',
    note: '付与だけを行いました。**キュー登録も送信もしていません**（Step1 は別工程）。',
  };
}

/** Netlify Functions v2 のエントリ */
export default async function handler(req) {
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const dryRun = body && body.dryRun === true;

  // 手動呼び出し（dry-run 含む）は管理シークレット必須
  if (dryRun) {
    const SECRET = process.env.COMEBACK_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
    const provided = req.headers.get('x-admin-secret');
    if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
    if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  }

  try {
    const out = await runLightTrialGrant({ env: process.env, now: Date.now(), dryRun });
    return json(200, out);
  } catch (e) {
    log({ ok: false, error: String((e && e.message) || 'unknown') });
    return json(200, { ok: false, error: 'run_failed', sideEffects: 'unknown' });
  }
}

/** JST 10:30 に 1 回。ゲートが閉じていれば即終了（副作用ゼロ） */
export const config = {
  schedule: '30 1 * * *',
};
