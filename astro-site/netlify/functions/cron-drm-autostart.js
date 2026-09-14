/**
 * cron-drm-autostart.js — **DRM の入口だけ**を進める（共有スケジューラから分離 / 既定 OFF）
 *
 * ── なぜ別 Function にするのか（2026-09-14 本番実測）──────────────
 * 入口を `cron-campaign-sequence` に相乗りさせると、動かすために
 * **共有の大量配信スイッチ**を開けることになる。本番の実測値は:
 *
 *   `MARKETING_SEQUENCE_SCHEDULER_ENABLED` = **false**
 *   `MARKETING_SEQUENCE_CAMPAIGN_ID` = `campaign-discount-free,-light,-premium`
 *
 * つまり DRM の入口（無料登録者 15 名）を開けるには scheduler を true にするしかなく、
 * その瞬間**割引 3 本が tick される**（step1 は 15,509 通配信済み・step2 は保留中）。
 * 15 名のために数千通のリスクを負う構造だった。
 *
 * ── この Function の性質 ──────────────────────────────────────
 * ⚠️ 読む入口スイッチは **`MARKETING_DRM_AUTOSTART_ENABLED` だけ**。
 *    `MARKETING_SEQUENCE_SCHEDULER_ENABLED` / `_ARMED` / `_CAMPAIGN_ID` は**読まない**。
 *    共有スケジューラの状態は**別任務のもの**なので、ここでは一切見ないし変えない。
 * ⚠️ 対象は**固定の許可リスト**（`DRM_ENTRY_CAMPAIGN_IDS`）だけ。
 *    `campaign-discount-*` は**構造的に選べない**（id を渡しても拒否する）。
 * ⚠️ **新しい送信経路を作らない。** キュー登録・`DeliveryKey`・二重防止・
 *    購入/停止の除外・prospect の予約は、すべて既存の `runSequenceTick` に委ねる。
 *    この Function が足すのは「入口の許可」と「人数の確認」だけ。
 * ⚠️ 送信の土台（`MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED`）は
 *    **既存のまま尊重する**（既存の安全装置を迂回しない）。
 * ⚠️ **Customers を 1 バイトも書かない。** メールもこの Function は送らない
 *    （作るのは PENDING ジョブと queued 行だけ。実送信は既存 dispatcher）。
 *
 * ── ⚠️ この Function は **HTTP から起動できない**（2026-09-14 本番実測）──────
 * `export const config = { schedule }` を持つ Netlify Function は**定期実行専用**で、
 * 公開 URL への POST は **403・本文 0 バイト**で弾かれる（認証の有無に関係ない）。
 * **payload も渡せない**ので `dryRun` / `expectedCount` を外から指定できない。
 * 同型の `cron-light-trial-grant` でも同じ挙動を確認した。
 *
 * したがって:
 *   - **定期実行（1 日 1 回）**… この Function が担当。`dryRun:false` / `manual:false`
 *   - **手動の下見・人数を確認して撃つ**… `admin-marketing` の
 *     `action: 'drmEntryRun'` から `runDrmEntry()` を呼ぶ（HTTP 到達可・secret 認証済み）
 *
 * 判定・許可リスト・`expectedCount`・委譲先はどちらの経路でも**同じこの関数**を通る。
 */

import {
  DRM_ENTRY_CAMPAIGN_IDS, DRM_ENTRY_ENV, ENTRY_ABORT,
  isEntryCampaignAllowed, readDrmEntryGates, checkExpectedCount,
} from '../../src/lib/drm/drmEntryGates.js';
import { planAutoStartEntries, AUTOSTART_SKIP_LABEL } from '../../src/lib/drm/drmAutoStart.js';
import { FUNNEL_STAGE } from '../../src/lib/drm/drmFunnel.js';
import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { resolveAutoStart } from '../../src/lib/marketing/campaignSequence.js';
import { indexDeliveries } from '../../src/lib/marketing/sequenceProgress.js';
import { resolveCustomerMarketing } from '../../src/lib/marketing/customerMarketingAudience.js';
import { loadBlacklistEmails } from '../../src/lib/newsletter/airtable-fetch.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';
import { assertFetchComplete } from '../../src/lib/marketing/marketingTargetedLoad.js';
import { runSequenceTick } from './cron-campaign-sequence.js';
import {
  createDispatchLock, TICK_LOCK_ROOT, LOCK_FAIL,
} from '../../src/lib/marketing/dispatchLock.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
const MAX_PAGES = 20;

export const DRM_LOG_TAG = '[drm-autostart]';

/**
 * **入口の多重起動を止める鍵**（#526 と同じ仕組み・**別の名前**）。
 *
 * ⚠️ #526 が入れた `tick:campaign-sequence` の鍵は
 *    `cron-campaign-sequence` の**定期実行エントリ**にある。
 *    入口は `runSequenceTick` を**直接**呼ぶので、その鍵の下を通らない。
 *    鍵なしだと、日次の定期実行と管理画面からの手動実行が重なったとき
 *    **同じ人を 2 回 queue し得る**（配信行を書く前に両方が「未送信」と読む）。
 *    #526 が共有 cron で塞いだのと同じ穴なので、入口にも同じ鍵を掛ける。
 * ⚠️ **名前を分ける**こと。共有 cron と同じ鍵にすると、互いの実行を
 *    無関係に塞き止めてしまう（割引 3 本の tick を DRM が止めることになる）。
 */
export const DRM_TICK_LOCK_ID = 'tick:drm-autostart';
/** 次の定期実行（1 日 1 回）より十分短く、実行時間より十分長く */
export const DRM_TICK_LOCK_TTL_SEC = 240;

const auth = (key) => ({ Authorization: `Bearer ${key}` });
const log = (payload) => {
  try { console.log(`${DRM_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});

/** 入口の候補（登録が新しい人だけ）。**全件走査しない・読み切れなければ例外** */
async function fetchCandidates({ KEY, BASE, withinDays }) {
  const out = [];
  const formula = `IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -${Number(withinDays)}, 'days'))`;
  let offset;
  let pages = 0;
  do {
    const body = { filterByFormula: formula, pageSize: 100 };
    if (offset) body.offset = offset;
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/listRecords`,
      { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`drm_candidates_fetch_${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) {
      assertFetchComplete({ table: CUSTOMERS_TABLE, offset, pages, maxPages: MAX_PAGES });
    }
  } while (offset);
  return out;
}

/** その campaign の配信行（入口の「もう受け取ったか」判定用・名指し） */
async function fetchDeliveriesForCampaign({ KEY, BASE, campaignType }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const body = {
      filterByFormula: `AND({EmailType}='campaign',{CampaignType}='${campaignType}')`,
      pageSize: 100,
    };
    if (offset) body.offset = offset;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
      { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`drm_deliveries_fetch_${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) {
      assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: MAX_PAGES });
    }
  } while (offset);
  return out;
}

/**
 * 入口に入る人を**数えるだけ**（read-only）。実行前の下見と、
 * live 実行前の人数確認の両方でこれを使う（**同じ数え方**）。
 */
export async function previewEntry({ env, now, campaignId }) {
  const base = getCampaign(campaignId, { includeDisabled: true });
  if (!base) return { ok: false, abort: 'unknown_campaign' };
  const auto = resolveAutoStart(base);
  if (!auto) return { ok: false, abort: 'no_autostart_declared' };

  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const campaignType = `${base.campaignId}:v${base.version}`;

  const [records, deliveries] = await Promise.all([
    fetchCandidates({ KEY, BASE, withinDays: auto.withinDays }),
    fetchDeliveriesForCampaign({ KEY, BASE, campaignType }),
  ]);
  const { emails: blacklistEmails } = await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });
  const candidates = records.map((rec) => ({
    recordId: rec.id,
    fields: rec.fields || {},
    createdTimeMs: Date.parse(rec.createdTime || '') || null,
    marketing: resolveCustomerMarketing({ fields: rec.fields || {}, nowMs: now, blacklistEmails }),
  }));
  const planned = planAutoStartEntries({
    campaign: base, candidates,
    deliveredIndex: indexDeliveries(deliveries),
    brand: BRAND, fromEmail, nowMs: now,
    expectedStage: FUNNEL_STAGE.FREE_TO_PAID,
  });
  return {
    ok: true,
    campaignId: base.campaignId,
    version: base.version,
    autoStart: auto,
    scanned: candidates.length,
    considered: planned.considered,
    wouldEnter: planned.recordIds.length,
    capped: planned.capped === true,
    carriedOver: planned.carriedOver || 0,
    skipped: planned.skipped,
    skipLabels: AUTOSTART_SKIP_LABEL,
  };
}

/**
 * 実処理。**テストからはここを直接呼ぶ**（HTTP の器を挟まない）。
 *
 * @param {{env, now, campaignId, dryRun, expectedCount, deps}} args
 */
export async function runDrmEntry({
  env = process.env, now = Date.now(), campaignId = DRM_ENTRY_CAMPAIGN_IDS[0],
  dryRun = true, expectedCount = null,
  /**
   * **人が起動したか**（管理画面・手動 POST）。
   *
   * ⚠️ `true` なら `expectedCount` を**必須**にする。付けずに実行しようとしたら
   *    `expected_count_required` で止まり、**queue 0 / send 0** で返る。
   *    以前は `expectedCount !== null` から推測していたため、
   *    「`dryRun:false` だけ渡す」と人数の確認を通らずに走り得た。
   * ⚠️ 定期実行（`false`）は `maxPerTick` と入口の窓が上限になる。
   */
  manual = false,
  deps = {},
} = {}) {
  // ⚠️ **許可リスト以外は撃てない**（割引 3 本を構造的に排除する）
  if (!isEntryCampaignAllowed(campaignId)) {
    return {
      ok: false, abort: ENTRY_ABORT.CAMPAIGN_NOT_ALLOWED,
      campaignId, allowed: [...DRM_ENTRY_CAMPAIGN_IDS], sideEffects: 'none',
    };
  }

  const gates = readDrmEntryGates(env);
  const preview = deps.previewEntry || previewEntry;

  // ── 下見（ゲートが閉じていても返す。**書き込みゼロ**）──────────────
  if (dryRun) {
    let seen;
    try {
      seen = await preview({ env, now, campaignId });
    } catch (e) {
      return { ok: false, abort: 'preview_failed', detail: String((e && e.message) || 'unknown'), sideEffects: 'none' };
    }
    return { ...seen, mode: 'drm-entry-preview', dryRun: true, gates, sideEffects: 'none' };
  }

  // ── ここから先は実行（ゲートが全部開いていること）──────────────────
  if (!gates.allOpen) {
    const body = { ok: false, abort: ENTRY_ABORT.GATE_CLOSED, missing: gates.missing, sideEffects: 'none' };
    log(body);
    return body;
  }

  // ── 下見の人数と一致しなければ **1 通も送らない** ──────────────────
  let seen;
  try {
    seen = await preview({ env, now, campaignId });
  } catch (e) {
    return { ok: false, abort: 'preview_failed', detail: String((e && e.message) || 'unknown'), sideEffects: 'none' };
  }
  if (!seen.ok) return { ...seen, sideEffects: 'none' };

  const counted = checkExpectedCount({
    planned: seen.wouldEnter, expectedCount,
    manual: manual === true || expectedCount !== null,
  });
  if (!counted.ok) {
    const body = {
      ok: false, abort: counted.reason,
      planned: counted.planned, expected: counted.expected,
      sideEffects: 'none',
      note: '下見の人数と一致しないため、1 通も送らずに止めました。',
    };
    log(body);
    return body;
  }

  /**
   * ── 既存の tick に委ねる（**キュー登録を作り直さない**）─────────────
   *
   * `runSequenceTick` は `DeliveryKey` の二重防止・購入/停止の除外・
   * 配信行の読み戻し確認・失敗時のジョブ取消まで既に持っている。
   * ここで作り直すと、その安全装置が**もう 1 本のコピー**になって必ずズレる。
   *
   * ⚠️ 渡す env は **この呼び出しのためだけの合成**。共有スケジューラの
   *    実際の env（`MARKETING_SEQUENCE_SCHEDULER_ENABLED=false` 等）は**変更しない**。
   *    入口を開けてよいと決めたのは `MARKETING_DRM_AUTOSTART_ENABLED` なので、
   *    その判断をこの呼び出しの中だけで伝える。
   * ⚠️ `campaignId` を**明示で渡す**ので `MARKETING_SEQUENCE_CAMPAIGN_ID` は
   *    読まれない（＝割引 3 本は tick されない）。
   * ⚠️ 送信の土台（`MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED`）は
   *    合成せず**実際の値のまま**渡す（既存の安全装置を迂回しない）。
   */
  const tickEnv = {
    ...env,
    MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
    MARKETING_SEQUENCE_ARMED: '',
  };
  // ── 入口の多重起動を止める（#526 と同じ仕組み・別の鍵）──────────────
  //    ⚠️ **取れなければ 1 件も積まない**（Redis へ届かないときも積まない）。
  const makeLock = deps.createDispatchLock || createDispatchLock;
  let lock = null;
  let token = null;
  try {
    const makeCmd = deps.makeRedisCmd || makeRedisCmd;
    lock = makeLock({ cmd: makeCmd(env), root: TICK_LOCK_ROOT });
    const got = await lock.acquire({ jobId: DRM_TICK_LOCK_ID, ttlSec: DRM_TICK_LOCK_TTL_SEC });
    if (!got.ok) {
      const body = {
        ok: false,
        abort: got.reason === LOCK_FAIL.BUSY ? 'entry_busy' : 'entry_lock_unavailable',
        sideEffects: 'none',
      };
      log(body);
      return body;
    }
    token = got.token;
  } catch {
    const body = { ok: false, abort: 'entry_lock_unavailable', sideEffects: 'none' };
    log(body);
    return body;
  }

  const tick = deps.runSequenceTick || runSequenceTick;
  let result;
  try {
    result = await tick({ env: tickEnv, now, campaignId });
  } catch (e) {
    const body = { ok: false, abort: 'tick_failed', detail: String((e && e.message) || 'unknown'), sideEffects: 'unknown' };
    log(body);
    return body;
  } finally {
    try { await lock.release({ jobId: DRM_TICK_LOCK_ID, token }); } catch { /* TTL で切れる */ }
  }

  const entered = (result && result.autoStart && result.autoStart.entered) || 0;
  const body = {
    mode: 'drm-entry',
    campaignId,
    dryRun: false,
    expectedCount: counted.expected,
    previewed: seen.wouldEnter,
    entered,
    /** ⚠️ 下見と違えば必ず出す（黙って通さない） */
    countDrift: entered !== counted.expected ? { expected: counted.expected, entered } : null,
    tick: result,
  };
  log(body);
  return body;
}

/** Netlify Functions v2 のエントリ。**1 日 1 回**（実送信は既存 dispatcher が行う） */
export default async function handler(req) {
  // 定期実行（スケジューラからの起動）は body を持たない
  let body = {};
  if (req && typeof req.json === 'function') {
    try { body = await req.json(); } catch { body = {}; }
  }
  const manual = Object.keys(body).length > 0;

  if (manual) {
    const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
    if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
    const provided = req.headers.get('x-admin-secret');
    if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  }

  const result = await runDrmEntry({
    env: process.env,
    now: Date.now(),
    campaignId: DRM_ENTRY_CAMPAIGN_IDS[0],
    // 定期実行は**自動**（下見ではない）。上限は maxPerTick と入口の窓
    dryRun: manual ? body.dryRun !== false : false,
    expectedCount: manual && body.expectedCount !== undefined ? body.expectedCount : null,
    manual,
  });
  return json(result && result.ok === false ? 200 : 200, result);
}

/**
 * ⚠️ **1 日 1 回**（10:00 JST）。入口は「新しく登録した人を迎える」だけなので
 *    高頻度で回す意味が無く、低頻度のほうが**実行を人が観測しやすい**。
 *    ゲート（`MARKETING_DRM_AUTOSTART_ENABLED`）が閉じている間は何も起きない。
 */
export const config = { schedule: '0 1 * * *' };

export { DRM_ENTRY_ENV };
