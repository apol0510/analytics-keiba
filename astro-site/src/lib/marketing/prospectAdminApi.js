/**
 * prospectAdminApi.js — 見込み客プールの管理 API の**中身**（I/O は注入）
 *
 * `/admin/premium-plus-eligibility/` から、対象の取り込み・状況確認・下見・
 * 昇格・除外までを 1 画面で扱えるようにするための判断をここへ集約する。
 *
 * ── production write のハードゲート ────────────────────────────
 * `intake` / `promote` / `suppress` は
 * **`MARKETING_PROSPECT_WRITE_ENABLED=true` でなければ、Redis / Airtable を
 *   初期化する前に 403**（接続 0）。自動配信の write ゲートとは**別の鍵**にして、
 * 「顧客台帳への登録」と「メール配信」を別々に開けられるようにする。
 *
 * ── 応答に PII を出さない ─────────────────────────────────────
 * 件数・状態・理由コードだけを返す。**アドレスの一覧は返さない**
 * （管理者が個別に確認したいときは 1 件ずつ `lookup` で引く）。
 */

import {
  planProspectIntake, summarizeProspects, PROSPECT_STATE, SUPPRESS_REASON,
  normalizeEmail, MAX_SENDS_WITHOUT_ENGAGEMENT, MIN_DAYS_BETWEEN_SENDS,
} from './prospectPolicy.js';
import { buildProspectAudience, planPromotions } from './prospectPipeline.js';
import { ProspectStoreError, emailHash } from './prospectStore.js';

export const PROSPECT_WRITE_GATE_ENV = 'MARKETING_PROSPECT_WRITE_ENABLED';
export const PROSPECT_WRITE_ACTIONS = Object.freeze(['intake', 'promote', 'suppress']);
export const PROSPECT_READ_ACTIONS = Object.freeze(['status', 'preview', 'lookup', 'promotion-preview']);

export const PROSPECT_REJECT = Object.freeze({
  WRITE_BLOCKED: 'prospect_write_blocked',
  STORE_UNAVAILABLE: 'prospect_store_unavailable',
  NOT_FOUND: 'not_found',
  TOO_MANY: 'too_many_rows',
});

/** 1 回の取り込みで受け取る最大行数（**まとめて全部入れない**） */
export const INTAKE_MAX_ROWS = 2000;
/** 1 回の昇格で Airtable へ作る最大件数 */
export const PROMOTE_MAX_PER_RUN = 100;

const str = (v) => String(v ?? '').trim();
const reject = (code, extra) => ({ ok: false, code, ...(extra || {}) });

export function isProspectWriteEnabled(env) {
  return !!env && env[PROSPECT_WRITE_GATE_ENV] === 'true';
}

/**
 * @param {{store, env, now, loadCustomerEmails, loadBlacklist,
 *          createCustomers, availableFields}} deps
 */
export function createProspectAdminApi(deps = {}) {
  const {
    store, env, now, loadCustomerEmails, loadBlacklist, createCustomers, availableFields,
  } = deps;
  const nowMs = typeof now === 'function' ? now() : (now || 0);
  const nowIso = new Date(nowMs).toISOString();

  const guard = async (fn) => {
    if (!store) return reject(PROSPECT_REJECT.STORE_UNAVAILABLE, { 接続: { redis: false } });
    try { return await fn(); }
    catch (e) {
      if (e instanceof ProspectStoreError) {
        return reject(PROSPECT_REJECT.STORE_UNAVAILABLE, { redisFailure: e.code, 接続: { redis: false } });
      }
      throw e;
    }
  };

  /** 索引から prospect をまとめ読みする（500 件ずつ） */
  const loadByHashes = async (hashes) => {
    const out = [];
    for (let i = 0; i < hashes.length; i += 500) {
      out.push(...await store.loadMany(hashes.slice(i, i + 500)));
    }
    return out;
  };

  return {
    // ── read ────────────────────────────────────────────────
    async status() {
      const counts = await guard(async () => store.counts());
      if (counts && counts.ok === false) return counts;
      return {
        ok: true, mode: 'prospect-status', sideEffects: 'none',
        件数: counts,
        設定: {
          '無反応で諦める送信回数': MAX_SENDS_WITHOUT_ENGAGEMENT,
          '同一相手への最小間隔（日）': MIN_DAYS_BETWEEN_SENDS,
          '1 回の取り込み上限': INTAKE_MAX_ROWS,
          '1 回の昇格上限': PROMOTE_MAX_PER_RUN,
        },
        writeEnabled: isProspectWriteEnabled(env),
        注意: '一覧にメールアドレスは出しません（件数と状態のみ）。',
      };
    },

    /** 今日の prospect 配信の下見。**1 通も送らない・1 行も書かない** */
    async preview({ maxRecipients, runId }) {
      const res = await guard(async () => {
        const hashes = await store.activeHashes();
        const prospects = await loadByHashes(hashes);
        const [customerEmails, blacklist] = await Promise.all([loadCustomerEmails(), loadBlacklist()]);
        return buildProspectAudience({
          prospects, customerEmails, blacklistEmails: blacklist, nowMs,
          runId: str(runId) || `prospect-${nowIso.slice(0, 10)}`,
          buildKey: (email) => `${str(runId) || 'preview'}:${emailHash(email).slice(0, 16)}`,
          maxRecipients,
        });
      });
      if (res && res.ok === false) return res;
      return {
        ok: true, mode: 'prospect-preview', sideEffects: 'none', dryRun: true,
        件数: res.counts, 除外理由: res.skipped,
        notice: '**1 通も送っていません。1 行も書いていません。**',
      };
    },

    /** 昇格の下見。**Airtable へ書かない** */
    async promotionPreview({ batchId }) {
      const res = await guard(async () => {
        const hashes = await store.engagedHashes();
        const prospects = await loadByHashes(hashes);
        const customerEmails = await loadCustomerEmails();
        return planPromotions({
          prospects, customerEmails, nowIso,
          batchId: str(batchId) || `prospect-${nowIso.slice(0, 10)}`,
          availableFields, maxPerRun: PROMOTE_MAX_PER_RUN,
        });
      });
      if (res && res.ok === false) return res;
      return {
        ok: true, mode: 'prospect-promotion-preview', sideEffects: 'none', dryRun: true,
        件数: res.counts, 除外理由: res.skipped,
        書き込む列: res.promote.length > 0 ? Object.keys(res.promote[0].fields) : [],
        notice: '**Airtable へ 1 行も書いていません。**',
      };
    },

    /** 1 件だけ状態を引く（管理者が個別に確認する用） */
    async lookup({ email }) {
      const e = normalizeEmail(email);
      if (!e) return reject(PROSPECT_REJECT.NOT_FOUND);
      const p = await guard(async () => store.load(e));
      if (p && p.ok === false) return p;
      if (!p) return reject(PROSPECT_REJECT.NOT_FOUND);
      // ⚠️ 応答にアドレスを含めない
      return {
        ok: true, mode: 'prospect-lookup', sideEffects: 'none',
        状態: p.state, 送信回数: p.sends, 最終送信: p.lastSentAt,
        反応: p.engagedAt ? { 時刻: p.engagedAt, 種別: p.engagedKind } : null,
        除外: p.suppressedAt ? { 時刻: p.suppressedAt, 理由: p.suppressedReason } : null,
        登録済み: p.state === PROSPECT_STATE.PROMOTED,
      };
    },

    // ── write（呼び出し側がゲートを通した後だけ来る）──────────
    /** CSV 行の取り込み。**Customers に居るアドレスは入れない** */
    async intake({ rows, batchId }) {
      const list = Array.isArray(rows) ? rows : [];
      if (list.length > INTAKE_MAX_ROWS) {
        return reject(PROSPECT_REJECT.TOO_MANY, { 上限: INTAKE_MAX_ROWS, 受領: list.length });
      }
      return guard(async () => {
        const [customerEmails, blacklist] = await Promise.all([loadCustomerEmails(), loadBlacklist()]);
        // 既に prospect に居るものは policy で弾くため、事前に集合を作る
        const existing = new Set();
        for (const r of list) {
          const e = normalizeEmail(r && r.email);
          if (!e) continue;
          if (await store.load(e)) existing.add(e);
        }
        const plan = planProspectIntake({
          rows: list, customerEmails, existingEmails: existing,
          blacklistEmails: blacklist, nowMs, batchId,
        });
        let added = 0;
        for (const p of plan.add) {
          const r = await store.addIfAbsent(p);
          if (r.added) added += 1;
        }
        return {
          ok: true, mode: 'prospect-intake',
          件数: { ...plan, 実際に追加: added }, 除外理由: plan.skipped,
        };
      });
    },

    /** 反応した prospect を Airtable Customers へ登録する */
    async promote({ batchId, confirmCount }) {
      return guard(async () => {
        const hashes = await store.engagedHashes();
        const prospects = await loadByHashes(hashes);
        const customerEmails = await loadCustomerEmails();
        const plan = planPromotions({
          prospects, customerEmails, nowIso,
          batchId: str(batchId) || `prospect-${nowIso.slice(0, 10)}`,
          availableFields, maxPerRun: PROMOTE_MAX_PER_RUN,
        });
        // ⚠️ 下見で見た件数と一致しなければ書かない（TOCTOU の窓を塞ぐ）
        if (Number.isInteger(confirmCount) && confirmCount !== plan.promote.length) {
          return reject('count_mismatch', { 申告: confirmCount, 実際: plan.promote.length });
        }
        if (plan.promote.length === 0) {
          return { ok: true, mode: 'prospect-promote', 件数: plan.counts, 作成: 0 };
        }
        const created = await createCustomers(plan.promote.map((p) => p.fields));
        // 作成できたものだけ PROMOTED にする（失敗は次回に持ち越す）
        let marked = 0;
        for (let i = 0; i < plan.promote.length; i += 1) {
          if (created && created.okIndexes instanceof Set && !created.okIndexes.has(i)) continue;
          await store.recordPromotion({ email: plan.promote[i].email, nowMs });
          marked += 1;
        }
        return {
          ok: true, mode: 'prospect-promote',
          件数: plan.counts, 作成: created ? created.created : 0, 状態更新: marked,
          除外理由: plan.skipped,
        };
      });
    },

    /** 手動での即時除外（苦情の連絡を受けたとき等） */
    async suppress({ email, reason }) {
      const e = normalizeEmail(email);
      if (!e) return reject(PROSPECT_REJECT.NOT_FOUND);
      return guard(async () => {
        const r = await store.recordSuppression({
          email: e, nowMs, reason: str(reason) || SUPPRESS_REASON.MANUAL,
        });
        if (!r.ok) return reject(PROSPECT_REJECT.NOT_FOUND);
        return { ok: true, mode: 'prospect-suppress', 変更: r.changed, 状態: r.prospect.state };
      });
    },

    summarize: (list) => summarizeProspects(list),
  };
}

export default createProspectAdminApi;
