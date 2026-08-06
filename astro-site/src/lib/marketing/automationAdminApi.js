/**
 * automationAdminApi.js — 管理 API の**中身**（I/O は注入・テスト可能）
 *
 * Function 本体（`admin-marketing-automation.js`）は認証と依存の注入だけを行い、
 * 判断はすべてここに集約する。テストは **fake Redis だけ**で全経路を通せる。
 *
 * ── production write のハードゲート ────────────────────────────
 * `create` / `update` / `activate` / `pause` / `cancel` は
 * **`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED=true` でなければ、
 *   Redis store を初期化する前に 403 を返す**（接続 0）。
 * Phase B では production へこの env を設定しない。
 *
 * ── read も推測しない ─────────────────────────────────────────
 * `list` / `get` / `preview` / `runs` / `status` は read-only だが、
 * Redis が未設定・到達不能なら**空データを装わず** `store_unavailable` を明示する。
 */

import {
  listAutomationPresets, getAutomationPreset, DEFERRED_TRIGGERS, validateAutomationPresets,
} from './automationCatalog.js';
import {
  buildAutomationDefinition, buildAutomationRunId, buildRecipientKey, buildRun,
  summarizeAutomation, canTransition, transition, jstDateString, isQuietHours,
  AUTOMATION_STATUS,
} from './automationModel.js';
import { buildAudience, computeAudienceFingerprint } from './automationEligibility.js';
import { AutomationStoreError } from './automationStore.js';
import { getCampaign, renderCampaign } from './campaignCatalog.js';
import { computeContentHash } from '../newsletter/content-hash.js';
import { MARKETING_EMAIL_SHELL_VERSION } from './marketingEmailShell.js';

/** production write を開けるゲート（Phase B では production 未設定） */
export const WRITE_GATE_ENV = 'MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED';

/** write を伴う action（**store 初期化より前**にゲートで弾く） */
export const WRITE_ACTIONS = Object.freeze(['create', 'update', 'activate', 'pause', 'cancel']);
export const READ_ACTIONS = Object.freeze(['list', 'get', 'preview', 'runs', 'run-detail', 'status']);

export const API_REJECT = Object.freeze({
  WRITE_BLOCKED: 'write_blocked',
  STORE_UNAVAILABLE: 'store_unavailable',
  NOT_FOUND: 'not_found',
  UNKNOWN_CAMPAIGN: 'unknown_campaign',
  CAMPAIGN_DRIFT: 'campaign_drift',
  INVALID_TRANSITION: 'invalid_transition',
  VERSION_CONFLICT: 'version_conflict',
  NO_SNAPSHOT: 'no_snapshot',
  RUNNING: 'running',
  /** ACTIVE のまま設定を書き換えさせない（dry-run 統制の迂回を塞ぐ） */
  ACTIVE_LOCKED: 'active_locked',
  /** 承認しようとしている snapshot が、いまの設定の dry-run 結果と違う */
  SNAPSHOT_MISMATCH: 'snapshot_mismatch',
});

export const API_REJECT_LABEL = Object.freeze({
  write_blocked: '本番自動配信は未有効です（管理者による書き込みが無効化されています）。',
  store_unavailable: '設定の保存先へ接続できません。表示できる状態がありません。',
  not_found: '自動化が見つかりません。',
  unknown_campaign: '存在しないキャンペーンです。',
  campaign_drift: 'キャンペーンの版か本文が変わっています。もう一度 dry-run して保存し直してください。',
  invalid_transition: 'その状態へは変更できません。',
  version_conflict: '他の操作で更新されています。読み直してからやり直してください。',
  no_snapshot: '先に dry-run を実行して対象を確定してください。',
  running: '実行中の自動化は変更できません。',
  active_locked: '稼働中は設定を変更できません。先に一時停止してから変更してください。',
  snapshot_mismatch: '対象がいまの設定の dry-run 結果と一致しません。もう一度 dry-run してから承認してください。',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const reject = (code, extra) => ({ ok: false, code, error: API_REJECT_LABEL[code] || code, ...(extra || {}) });

/** write ゲートの判定。**store 初期化より前に呼ぶ** */
export function isWriteEnabled(env) {
  return !!env && env[WRITE_GATE_ENV] === 'true';
}

/**
 * キャンペーンの版と本文を固定する。**カタログが正本**で自由入力を受け付けない。
 */
export function pinCampaign(campaignId) {
  const c = getCampaign(campaignId, { includeDisabled: true });
  if (!c) return { ok: false, code: API_REJECT.UNKNOWN_CAMPAIGN };
  const rendered = renderCampaign({ campaign: c, name: null });
  if (!rendered) return { ok: false, code: API_REJECT.UNKNOWN_CAMPAIGN };
  return {
    ok: true,
    campaignId: c.campaignId,
    campaignVersion: String(c.version),
    shellVersion: String(MARKETING_EMAIL_SHELL_VERSION),
    contentHash: computeContentHash(rendered.subject, rendered.html),
  };
}

/**
 * 保存後にキャンペーンが変わっていないか。変わっていたら **ACTIVE 化も run も拒否**。
 */
export function checkCampaignDrift(definition) {
  const pinned = pinCampaign(definition?.campaignId);
  if (!pinned.ok) return { ok: false, code: API_REJECT.UNKNOWN_CAMPAIGN };
  const drift = [];
  if (str(definition.campaignVersion) && str(definition.campaignVersion) !== pinned.campaignVersion) drift.push('campaignVersion');
  if (str(definition.contentHash) && str(definition.contentHash) !== pinned.contentHash) drift.push('contentHash');
  if (str(definition.shellVersion) && str(definition.shellVersion) !== pinned.shellVersion) drift.push('shellVersion');
  return drift.length === 0 ? { ok: true, pinned } : { ok: false, code: API_REJECT.CAMPAIGN_DRIFT, drift, pinned };
}

/**
 * @param {{ store, env, now, loadCustomers, loadBlacklist }} deps
 */
export function createAutomationAdminApi(deps = {}) {
  const { store, env, now, loadCustomers, loadBlacklist } = deps;
  const nowMs = typeof now === 'function' ? now() : (now || 0);
  const nowIso = new Date(nowMs).toISOString();

  /** Redis が使えないときは**推測しない** */
  const guardStore = async (fn) => {
    if (!store) return reject(API_REJECT.STORE_UNAVAILABLE, { 接続: { redis: false } });
    try { return await fn(); }
    catch (e) {
      if (e instanceof AutomationStoreError) {
        return reject(API_REJECT.STORE_UNAVAILABLE, { redisFailure: e.code, 接続: { redis: false } });
      }
      throw e;
    }
  };

  return {
    // ── read ────────────────────────────────────────────────
    async list() {
      const presets = listAutomationPresets();
      const saved = await guardStore(async () => {
        const ids = await store.listActive();
        const out = [];
        for (const id of ids) {
          const d = await store.loadDefinition(id);
          if (d) out.push(summarizeAutomation({ definition: d, lastRun: null, plannedCount: 0 }));
        }
        return out;
      });
      return {
        ok: true, mode: 'automation-list', sideEffects: 'none',
        presets, 設計候補: DEFERRED_TRIGGERS, 定義の健全性: validateAutomationPresets(),
        保存済み: saved.ok === false ? null : saved,
        保存先: saved.ok === false ? saved : { ok: true },
        writeEnabled: isWriteEnabled(env),
      };
    },

    async get({ automationId }) {
      const res = await guardStore(async () => store.loadDefinition(automationId));
      if (res && res.ok === false) return res;
      if (!res) return reject(API_REJECT.NOT_FOUND);
      return {
        ok: true, mode: 'automation-get', sideEffects: 'none',
        writeEnabled: isWriteEnabled(env),
        configVersion: res.configVersion,
        definition: res,
        campaign整合: checkCampaignDrift(res),
        summary: summarizeAutomation({ definition: res, lastRun: null, plannedCount: 0 }),
      };
    },

    /**
     * dry-run / 保存 / 実行で**同じ対象集合**を使うための単一経路。
     * ここ以外で対象集合を組み立てない（別ロジックが増えると snapshot がズレる）。
     */
    async _computeSnapshot({ definition }) {
      const occurrenceDate = jstDateString(nowMs);
      const runId = buildAutomationRunId({ automationId: definition.automationId, occurrenceDate });
      const [records, blacklist] = await Promise.all([loadCustomers(), loadBlacklist()]);
      const audience = buildAudience({
        records, definition, nowMs, blacklistEmails: blacklist,
        buildKey: (email) => buildRecipientKey({ automationRunId: runId, email }),
      });
      const fingerprint = computeAudienceFingerprint({
        automationId: definition.automationId, occurrenceDate,
        campaignId: definition.campaignId, emails: audience.recipients.map((r) => r.email),
      });
      return {
        occurrenceDate, runId, audience,
        snapshotFingerprint: fingerprint,
        snapshotCount: audience.recipients.length,
      };
    },

    /**
     * 対象の解決。**保存済みがあればそれが基準**で、preset は新規作成のときだけ使う。
     * （preset を基準にすると、update 後の実設定と dry-run が食い違う）
     */
    async _resolveDefinition({ automationId, overrides }) {
      const stored = store ? await store.loadDefinition(automationId) : null;
      if (stored) {
        const o = overrides || {};
        return {
          源: 'saved', stored,
          definition: {
            ...stored,
            ...(o.name !== undefined ? { name: str(o.name) } : {}),
            ...(o.quietHours !== undefined ? { quietHours: o.quietHours } : {}),
            ...(o.maxRecipients !== undefined ? { maxRecipients: int(o.maxRecipients) } : {}),
            ...(o.schedule !== undefined ? { schedule: str(o.schedule) } : {}),
            ...(o.trigger !== undefined ? { trigger: o.trigger } : {}),
            ...(o.campaignId !== undefined ? { campaignId: str(o.campaignId) } : {}),
          },
        };
      }
      const preset = getAutomationPreset(automationId);
      if (!preset) return null;
      return {
        源: 'preset', stored: null,
        definition: buildAutomationDefinition({ preset, overrides: overrides || {}, nowIso }),
      };
    },

    async preview({ automationId, overrides }) {
      // store が使えないなら**推測しない**（preset で代用すると保存済みと食い違う）
      if (store) {
        const probe = await guardStore(async () => store.loadDefinition(automationId));
        if (probe && probe.ok === false) return probe;
      }
      const resolved = await this._resolveDefinition({ automationId, overrides });
      if (!resolved) return reject(API_REJECT.NOT_FOUND);
      const { definition } = resolved;
      const pinned = pinCampaign(definition.campaignId);
      if (definition.campaignId && !pinned.ok) return reject(API_REJECT.UNKNOWN_CAMPAIGN);

      const snap = await this._computeSnapshot({ definition });
      return {
        ok: true, mode: 'automation-preview', sideEffects: 'none', dryRun: true,
        automationId: definition.automationId, automationRunId: snap.runId,
        occurrenceDate: snap.occurrenceDate,
        基準: resolved.源,
        writeEnabled: isWriteEnabled(env),
        configVersion: resolved.stored ? resolved.stored.configVersion : null,
        status: resolved.stored ? resolved.stored.status : 'DRAFT',
        未保存の変更あり: resolved.源 === 'saved' && !!overrides && Object.keys(overrides).length > 0,
        campaign: pinned.ok ? pinned : null,
        snapshotFingerprint: snap.snapshotFingerprint,
        snapshotCount: snap.snapshotCount,
        件数: snap.audience.counts, 除外理由: snap.audience.skipped,
        上限: definition.maxRecipients ?? definition.maxSendsPerRun,
        quietHours: definition.quietHours,
        静音時間帯か: isQuietHours({ nowMs, quietHours: definition.quietHours }),
        notice: '**1 通も送っていません。1 行も書いていません。**',
      };
    },

    async runs({ automationId }) {
      const res = await guardStore(async () => {
        const today = jstDateString(nowMs);
        const ids = [today];
        const out = [];
        for (const d of ids) {
          const r = await store.loadRun(buildAutomationRunId({ automationId, occurrenceDate: d }));
          if (r) out.push(r);
        }
        return out;
      });
      if (res && res.ok === false) return res;
      return { ok: true, mode: 'automation-runs', sideEffects: 'none', runs: res };
    },

    async runDetail({ runId }) {
      const res = await guardStore(async () => store.loadRun(runId));
      if (res && res.ok === false) return res;
      if (!res) return reject(API_REJECT.NOT_FOUND);
      return { ok: true, mode: 'automation-run-detail', sideEffects: 'none', run: res };
    },

    async status({ automationId }) {
      const g = await this.get({ automationId });
      if (g.ok === false) return g;
      return { ok: true, mode: 'automation-status', sideEffects: 'none', summary: g.summary, campaign整合: g.campaign整合 };
    },

    // ── write（呼び出し側がゲートを通した後だけ来る）──────────
    async create({ presetId, overrides }) {
      const preset = getAutomationPreset(presetId);
      if (!preset) return reject(API_REJECT.NOT_FOUND);
      // ⚠️ **管理者が指定した campaignId は preset に既定が無くても検証する**。
      //    ここを preset 側の有無で分岐すると、自由入力で存在しない ID を保存できてしまう。
      const requested = str(overrides && overrides.campaignId) || str(preset.campaignId);
      const pinned = requested ? pinCampaign(requested) : { ok: false, code: null };
      if (requested && !pinned.ok) return reject(API_REJECT.UNKNOWN_CAMPAIGN);

      const base = buildAutomationDefinition({ preset, overrides: overrides || {}, nowIso });
      const definition = {
        ...base, presetId: preset.automationId, timezone: 'Asia/Tokyo',
        maxRecipients: int(overrides?.maxRecipients) || base.maxSendsPerRun,
        schedule: str(overrides?.schedule) || 'daily',
        audience: base.audienceRule, configVersion: 1,
        ...(pinned.ok ? {
          campaignId: pinned.campaignId, campaignVersion: pinned.campaignVersion,
          shellVersion: pinned.shellVersion, contentHash: pinned.contentHash,
        } : {}),
      };
      return guardStore(async () => {
        const res = await store.saveDefinition({ definition, expectedVersion: '' });
        if (!res.ok) return reject(API_REJECT.VERSION_CONFLICT);
        return { ok: true, mode: 'automation-create', definition: res.definition };
      });
    },

    async update({ automationId, expectedVersion, overrides }) {
      return guardStore(async () => {
        const cur = await store.loadDefinition(automationId);
        if (!cur) return reject(API_REJECT.NOT_FOUND);
        if (cur.status === AUTOMATION_STATUS.RUNNING) return reject(API_REJECT.RUNNING);
        // ⚠️ **ACTIVE のまま設定を書き換えさせない。**
        //    許すと「dry-run で承認した snapshot」を保ったまま対象条件だけ広げられ、
        //    activate に置いた統制（snapshot 必須 + campaign drift 検査）を迂回できる。
        //    変更は PAUSED / DRAFT を経由させ、再 dry-run と再承認を必須にする。
        if (cur.status === AUTOMATION_STATUS.ACTIVE) {
          return reject(API_REJECT.ACTIVE_LOCKED, { status: cur.status, 手順: '一時停止 → 変更 → dry-run → ACTIVE 化' });
        }
        if (str(expectedVersion) !== str(cur.configVersion)) return reject(API_REJECT.VERSION_CONFLICT);

        const o = overrides || {};
        let pinnedFields = {};
        if (o.campaignId !== undefined) {
          const pinned = pinCampaign(o.campaignId);
          if (!pinned.ok) return reject(API_REJECT.UNKNOWN_CAMPAIGN);
          pinnedFields = {
            campaignId: pinned.campaignId, campaignVersion: pinned.campaignVersion,
            shellVersion: pinned.shellVersion, contentHash: pinned.contentHash,
          };
        }
        const next = {
          ...cur,
          ...(o.name !== undefined ? { name: str(o.name) } : {}),
          ...(o.quietHours !== undefined ? { quietHours: o.quietHours } : {}),
          ...(o.maxRecipients !== undefined ? { maxRecipients: int(o.maxRecipients) } : {}),
          ...(o.schedule !== undefined ? { schedule: str(o.schedule) } : {}),
          ...(o.trigger !== undefined ? { trigger: o.trigger } : {}),
          ...pinnedFields,
          timezone: 'Asia/Tokyo',
          // ⚠️ 設定を変えたら**承認済み snapshot を捨てる**。
          //    残すと、変更前に承認した対象で ACTIVE 化できてしまう。
          snapshotFingerprint: null, snapshotCount: null, snapshotOccurrenceDate: null,
          configVersion: int(cur.configVersion) + 1,
          updatedAt: nowIso,
        };
        const res = await store.saveDefinition({ definition: next, expectedVersion: str(cur.configVersion) });
        if (!res.ok) return reject(API_REJECT.VERSION_CONFLICT);
        return { ok: true, mode: 'automation-update', definition: res.definition };
      });
    },

    /**
     * ACTIVE 化。**snapshot 未確認・campaign 不整合では通さない。**
     *
     * ⚠️ 管理者が申告した `snapshotFingerprint` を鵜呑みにせず、
     *    **保存済み Definition から対象集合を計算し直して一致を確認**する。
     *    dry-run / 保存 / 実行がすべて同じ経路（`_computeSnapshot`）を通る。
     */
    async activate({ automationId, expectedVersion, snapshotFingerprint }) {
      const cur = await guardStore(async () => store.loadDefinition(automationId));
      if (cur && cur.ok === false) return cur;
      if (!cur) return reject(API_REJECT.NOT_FOUND);
      if (str(expectedVersion) !== str(cur.configVersion)) return reject(API_REJECT.VERSION_CONFLICT);
      if (!canTransition(cur.status, AUTOMATION_STATUS.ACTIVE)) {
        return reject(API_REJECT.INVALID_TRANSITION, { from: cur.status, to: 'ACTIVE' });
      }
      if (!str(snapshotFingerprint)) return reject(API_REJECT.NO_SNAPSHOT);
      const drift = checkCampaignDrift(cur);
      if (!drift.ok) return reject(drift.code, { drift: drift.drift || null });

      // ⚠️ 申告値と**再計算値**を突き合わせる（Airtable/Redis への書き込みより前）
      const snap = await this._computeSnapshot({ definition: cur });
      if (str(snapshotFingerprint) !== str(snap.snapshotFingerprint)) {
        return reject(API_REJECT.SNAPSHOT_MISMATCH, {
          申告: str(snapshotFingerprint).slice(0, 12),
          再計算: str(snap.snapshotFingerprint).slice(0, 12),
          再計算件数: snap.snapshotCount,
        });
      }

      return guardStore(async () => {
        const t = transition({ definition: cur, to: AUTOMATION_STATUS.ACTIVE, nowIso });
        if (!t.ok) return reject(API_REJECT.INVALID_TRANSITION, { reason: t.reason });
        const next = {
          ...t.definition,
          configVersion: int(cur.configVersion) + 1,
          // 指紋だけでなく**件数と暦日も固定**する（実行直前の照合に全部要る）
          snapshotFingerprint: snap.snapshotFingerprint,
          snapshotCount: snap.snapshotCount,
          snapshotOccurrenceDate: snap.occurrenceDate,
        };
        const res = await store.saveDefinition({ definition: next, expectedVersion: str(cur.configVersion) });
        if (!res.ok) return reject(API_REJECT.VERSION_CONFLICT);
        await store.markActive(automationId);
        return {
          ok: true, mode: 'automation-activate', definition: res.definition,
          承認したsnapshot: { 件数: snap.snapshotCount, 暦日: snap.occurrenceDate },
        };
      });
    },

    async pause({ automationId, expectedVersion }) {
      return this._transitionTo({ automationId, expectedVersion, to: AUTOMATION_STATUS.PAUSED });
    },

    /**
     * 取消。**未送信だけを止める計画**を返す。
     * ⚠️ Phase B では **Airtable への実取消は行わない**（次 Phase でハードブロック解除）。
     */
    async cancel({ automationId, expectedVersion, queueSnapshot }) {
      const res = await this._transitionTo({ automationId, expectedVersion, to: AUTOMATION_STATUS.CANCELLED });
      if (res.ok === false) return res;
      await guardStore(async () => store.unmarkActive(automationId));
      const q = queueSnapshot || {};
      return {
        ...res,
        mode: 'automation-cancel',
        cancelPlan: {
          'PENDING取消予定': int(q.pending),
          'SENT取消不可': int(q.sent),
          処理中: int(q.processing),
          'rollback不可（送信済み）': int(q.sent),
          note: '取り消せるのは未送信（PENDING）だけです。SENT は取消も再送もしません。',
          airtable実行: false,
          blockedReason: 'Phase B では Airtable への実取消をハードブロックしています。',
        },
      };
    },

    async _transitionTo({ automationId, expectedVersion, to }) {
      return guardStore(async () => {
        const cur = await store.loadDefinition(automationId);
        if (!cur) return reject(API_REJECT.NOT_FOUND);
        if (str(expectedVersion) !== str(cur.configVersion)) return reject(API_REJECT.VERSION_CONFLICT);
        if (!canTransition(cur.status, to)) {
          return reject(API_REJECT.INVALID_TRANSITION, { from: cur.status, to });
        }
        const t = transition({ definition: cur, to, nowIso });
        if (!t.ok) return reject(API_REJECT.INVALID_TRANSITION, { reason: t.reason });
        const next = { ...t.definition, configVersion: int(cur.configVersion) + 1 };
        const res = await store.saveDefinition({ definition: next, expectedVersion: str(cur.configVersion) });
        if (!res.ok) return reject(API_REJECT.VERSION_CONFLICT);
        if (to !== AUTOMATION_STATUS.ACTIVE) await store.unmarkActive(automationId);
        return { ok: true, mode: `automation-${String(to).toLowerCase()}`, definition: res.definition };
      });
    },
  };
}

export default createAutomationAdminApi;
