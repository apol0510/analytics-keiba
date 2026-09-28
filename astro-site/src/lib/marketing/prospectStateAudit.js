/**
 * prospectStateAudit.js — prospect の **全レコード**で「state と 索引 / 抑止台帳」が一致しているかを数える
 * （判定は純粋・Redis 読み取りは注入。**書き込みは構造的にできない**）
 *
 * ## なぜ要るか（2026-09-28 の監査の死角）
 *
 * これまでの検出は 2 つだけだった:
 *   - `prospectIndexAudit` … 渡した hash 一覧（選別 list の export）が索引のどこに居るか
 *   - `prospectSequenceCheck` … 送信候補索引に居る人が送信行になるか
 * どちらも **「list に居る人」か「送信候補索引に居る人」から出発する**ので、
 * **list にも送信候補索引にも居ないレコード**（例: EXHAUSTED なのに抑止台帳が無い）は数えられない。
 *
 * ここは出発点を **Redis の鍵そのもの**にする:
 *   - `SCAN MATCH ak:prospect:*` … 全レコード鍵（`p:`）と全抑止台帳鍵（`blocked:`）
 *   - `SSCAN` × 3 索引 … レコードも台帳も無いのに索引にだけ居る hash
 * の和集合を 1 人ずつ `classifyProspectConsistency` にかける。
 *
 * ## あるべき姿（`prospectStore.casItem` / `blockEntryFor` / `prospectPolicy` の遷移から導く）
 *
 * | state | 送信候補 | 反応済み | 抑止台帳 | 抑止索引 |
 * |---|---|---|---|---|
 * | NEW / SENDING | 居る | 居ない | 無い | 居ない |
 * | ENGAGED | 居ない | 居る | 無い（※1）| 同左 |
 * | PROMOTED | 居ない | 居ない | 無い（※1）| 同左 |
 * | EXHAUSTED | 居ない | 居ない | kind=exhausted | 居る |
 * | SUPPRESSED | 居ない | 居ない | kind=suppressed | 居る |
 * | （レコード無し＝purge 済み）| 居ない | 居ない | 有る | 居る |
 *
 * ※1 EXHAUSTED の後に開封が届くと ENGAGED へ移り、**台帳（exhausted）は残る**（`applyEngagement`）。
 *    これは仕様どおりの「遅れて反応した人」で異常ではない（`LATE_REACTION` として数えるだけ）。
 *    ただし台帳が **suppressed** のまま ENGAGED / PROMOTED なのは遷移上あり得ない（苦情の後の復活）。
 *
 * ## ⚠️ アドレスは返さない
 *
 * レコードの値には配信中の生アドレスが入っている。判定の中でだけ parse し、
 * 返すのは hash と `safeRecordView`（email を含まない項目だけ）。
 */

import {
  PROSPECT_ROOT, ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX,
  prospectKey, blockedKey, isSendableState, BLOCK_KIND,
} from './prospectStore.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { isProspectCutOff } from './prospectEngagement.js';
import { safeRecordView } from './prospectIndexAudit.js';

const HASH_RE = /^[0-9a-f]{64}$/;
const RECORD_PREFIX = `${PROSPECT_ROOT}p:`;
const LEDGER_PREFIX = `${PROSPECT_ROOT}blocked:`;

/** 重さ。`critical` は**誤送信・再取り込みでの復活**に直結するもの */
export const SEVERITY = Object.freeze({ CRITICAL: 'critical', INTEGRITY: 'integrity', INFO: 'info' });

export const FINDING = Object.freeze({
  // ── critical ─────────────────────────────────────────────
  /** 送信候補の state なのに抑止台帳がある（止めた人へ送り得る）*/
  SENDABLE_WITH_LEDGER: 'SENDABLE_WITH_LEDGER',
  /** delivered の打ち切り条件を満たしているのに送信候補の state のまま（EXHAUSTED になっていない）*/
  CUTOFF_REACHED_BUT_SENDABLE: 'CUTOFF_REACHED_BUT_SENDABLE',
  /** EXHAUSTED / SUPPRESSED なのに抑止台帳が無い（CSV 再取り込みで復活する）*/
  BLOCK_STATE_WITHOUT_LEDGER: 'BLOCK_STATE_WITHOUT_LEDGER',
  /** 抑止索引に居るのに台帳鍵が無い（取り込みの照合は台帳鍵を見るので復活する）*/
  BLOCKED_INDEX_WITHOUT_LEDGER: 'BLOCKED_INDEX_WITHOUT_LEDGER',
  /** 台帳が suppressed なのに ENGAGED / PROMOTED（苦情・bounce の後の復活）*/
  REACTED_AFTER_SUPPRESSION: 'REACTED_AFTER_SUPPRESSION',
  // ── integrity ────────────────────────────────────────────
  RECORD_CORRUPT: 'RECORD_CORRUPT',
  LEDGER_CORRUPT: 'LEDGER_CORRUPT',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  /** 送信候補の state なのに送信候補索引に居ない（送られないまま取り残される）*/
  SENDABLE_NOT_IN_ACTIVE: 'SENDABLE_NOT_IN_ACTIVE',
  /** 送信候補ではない state なのに送信候補索引に居る */
  NOT_SENDABLE_IN_ACTIVE: 'NOT_SENDABLE_IN_ACTIVE',
  /** ENGAGED なのに反応済み索引に居ない（昇格されない）*/
  ENGAGED_NOT_IN_ENGAGED_INDEX: 'ENGAGED_NOT_IN_ENGAGED_INDEX',
  /** ENGAGED ではないのに反応済み索引に居る */
  NOT_ENGAGED_IN_ENGAGED_INDEX: 'NOT_ENGAGED_IN_ENGAGED_INDEX',
  /** EXHAUSTED / SUPPRESSED なのに抑止索引に居ない */
  BLOCK_STATE_NOT_IN_BLOCKED_INDEX: 'BLOCK_STATE_NOT_IN_BLOCKED_INDEX',
  /** 台帳鍵はあるのに抑止索引に居ない */
  LEDGER_NOT_IN_BLOCKED_INDEX: 'LEDGER_NOT_IN_BLOCKED_INDEX',
  /** state（EXHAUSTED / SUPPRESSED）と台帳の kind が食い違う */
  LEDGER_KIND_MISMATCH: 'LEDGER_KIND_MISMATCH',
  /** レコードが無いのに送信候補索引に居る（読めたのに送信行にならない）*/
  NO_RECORD_IN_ACTIVE: 'NO_RECORD_IN_ACTIVE',
  /** レコードが無いのに反応済み索引に居る */
  NO_RECORD_IN_ENGAGED: 'NO_RECORD_IN_ENGAGED',
  // ── info（異常ではない・数えるだけ）──────────────────────
  /** EXHAUSTED の後に反応して ENGAGED / PROMOTED（台帳 exhausted は残る仕様）*/
  LATE_REACTION: 'LATE_REACTION',
});

export const FINDING_SEVERITY = Object.freeze({
  [FINDING.SENDABLE_WITH_LEDGER]: SEVERITY.CRITICAL,
  [FINDING.CUTOFF_REACHED_BUT_SENDABLE]: SEVERITY.CRITICAL,
  [FINDING.BLOCK_STATE_WITHOUT_LEDGER]: SEVERITY.CRITICAL,
  [FINDING.BLOCKED_INDEX_WITHOUT_LEDGER]: SEVERITY.CRITICAL,
  [FINDING.REACTED_AFTER_SUPPRESSION]: SEVERITY.CRITICAL,
  [FINDING.RECORD_CORRUPT]: SEVERITY.INTEGRITY,
  [FINDING.LEDGER_CORRUPT]: SEVERITY.INTEGRITY,
  [FINDING.UNKNOWN_STATE]: SEVERITY.INTEGRITY,
  [FINDING.SENDABLE_NOT_IN_ACTIVE]: SEVERITY.INTEGRITY,
  [FINDING.NOT_SENDABLE_IN_ACTIVE]: SEVERITY.INTEGRITY,
  [FINDING.ENGAGED_NOT_IN_ENGAGED_INDEX]: SEVERITY.INTEGRITY,
  [FINDING.NOT_ENGAGED_IN_ENGAGED_INDEX]: SEVERITY.INTEGRITY,
  [FINDING.BLOCK_STATE_NOT_IN_BLOCKED_INDEX]: SEVERITY.INTEGRITY,
  [FINDING.LEDGER_NOT_IN_BLOCKED_INDEX]: SEVERITY.INTEGRITY,
  [FINDING.LEDGER_KIND_MISMATCH]: SEVERITY.INTEGRITY,
  [FINDING.NO_RECORD_IN_ACTIVE]: SEVERITY.INTEGRITY,
  [FINDING.NO_RECORD_IN_ENGAGED]: SEVERITY.INTEGRITY,
  [FINDING.LATE_REACTION]: SEVERITY.INFO,
});

const KNOWN_STATES = new Set(Object.values(PROSPECT_STATE));

const parseOrCorrupt = (raw) => {
  if (raw === null || raw === undefined) return { value: null, corrupt: false };
  if (typeof raw === 'object') return { value: raw, corrupt: false };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { value: null, corrupt: true };
    return { value: v, corrupt: false };
  } catch { return { value: null, corrupt: true }; }
};

const expectedKindFor = (state) => {
  if (state === PROSPECT_STATE.EXHAUSTED) return BLOCK_KIND.EXHAUSTED;
  if (state === PROSPECT_STATE.SUPPRESSED) return BLOCK_KIND.SUPPRESSED;
  return null;
};

/**
 * 1 人ぶんの突き合わせ（純粋）。
 *
 * @param {{recordRaw: string|null, ledgerRaw: string|null,
 *          inActive: boolean, inEngaged: boolean, inBlocked: boolean}} input
 * @param {{env?: object}} [opts] 打ち切り閾値（`isProspectCutOff` と同じ env を使う）
 * @returns {{codes: string[], state: string|null, hasRecord: boolean, hasLedger: boolean,
 *            ledgerKind: string|null, record: object|null}}
 */
export function classifyProspectConsistency(input, { env = process.env } = {}) {
  const {
    recordRaw = null, ledgerRaw = null, inActive = false, inEngaged = false, inBlocked = false,
  } = input || {};
  const codes = [];
  const rec = parseOrCorrupt(recordRaw);
  const led = parseOrCorrupt(ledgerRaw);
  if (rec.corrupt) codes.push(FINDING.RECORD_CORRUPT);
  if (led.corrupt) codes.push(FINDING.LEDGER_CORRUPT);

  const hasRecord = recordRaw !== null && recordRaw !== undefined;
  const hasLedger = ledgerRaw !== null && ledgerRaw !== undefined;
  const ledgerKind = led.value && typeof led.value.kind === 'string' ? led.value.kind : null;

  // ── 台帳と抑止索引（レコードの有無に関係なく成り立つべきこと）
  if (hasLedger && !inBlocked) codes.push(FINDING.LEDGER_NOT_IN_BLOCKED_INDEX);
  if (inBlocked && !hasLedger) codes.push(FINDING.BLOCKED_INDEX_WITHOUT_LEDGER);

  if (!hasRecord) {
    // purge 済み（台帳だけ残る）は正常。索引にだけ居るのが異常
    if (inActive) codes.push(FINDING.NO_RECORD_IN_ACTIVE);
    if (inEngaged) codes.push(FINDING.NO_RECORD_IN_ENGAGED);
    return {
      codes, state: null, hasRecord, hasLedger, ledgerKind, record: null,
    };
  }
  if (rec.corrupt) {
    return {
      codes, state: null, hasRecord, hasLedger, ledgerKind, record: null,
    };
  }

  const p = rec.value;
  const state = typeof p.state === 'string' ? p.state : null;
  if (!KNOWN_STATES.has(state)) {
    codes.push(FINDING.UNKNOWN_STATE);
    return {
      codes, state, hasRecord, hasLedger, ledgerKind, record: safeRecordView(p),
    };
  }

  const sendable = isSendableState(state);
  const wantKind = expectedKindFor(state);

  // 送信候補索引
  if (sendable && !inActive) codes.push(FINDING.SENDABLE_NOT_IN_ACTIVE);
  if (!sendable && inActive) codes.push(FINDING.NOT_SENDABLE_IN_ACTIVE);
  // 反応済み索引
  if (state === PROSPECT_STATE.ENGAGED && !inEngaged) codes.push(FINDING.ENGAGED_NOT_IN_ENGAGED_INDEX);
  if (state !== PROSPECT_STATE.ENGAGED && inEngaged) codes.push(FINDING.NOT_ENGAGED_IN_ENGAGED_INDEX);

  if (sendable) {
    if (hasLedger) codes.push(FINDING.SENDABLE_WITH_LEDGER);
    // 打ち切りは delivered を記録した書き込みで EXHAUSTED になるはず（`applyDelivered`）
    if (isProspectCutOff(p, { env })) codes.push(FINDING.CUTOFF_REACHED_BUT_SENDABLE);
  } else if (wantKind) {
    if (!hasLedger) codes.push(FINDING.BLOCK_STATE_WITHOUT_LEDGER);
    else if (ledgerKind !== wantKind && !led.corrupt) codes.push(FINDING.LEDGER_KIND_MISMATCH);
    if (!inBlocked) codes.push(FINDING.BLOCK_STATE_NOT_IN_BLOCKED_INDEX);
  } else if (hasLedger && !led.corrupt) {
    // ENGAGED / PROMOTED に台帳がある: exhausted なら遅れた反応（仕様どおり）、suppressed は遷移上あり得ない
    if (ledgerKind === BLOCK_KIND.EXHAUSTED) codes.push(FINDING.LATE_REACTION);
    else codes.push(FINDING.REACTED_AFTER_SUPPRESSION);
  }

  return {
    codes, state, hasRecord, hasLedger, ledgerKind, record: safeRecordView(p),
  };
}

/** 異常（info 以外）を 1 つでも含むか */
export const isAnomaly = (codes) => (codes || []).some((c) => FINDING_SEVERITY[c] !== SEVERITY.INFO);

// ─────────────────────────────────────────────────────────────
// 読み取り（I/O は注入）。**許可した読み取りコマンドしか出さない**
// ─────────────────────────────────────────────────────────────

/** 出してよいコマンド。書き込み系は 1 つも無い */
export const READ_ONLY_OPS = Object.freeze(['SCAN', 'SSCAN', 'MGET', 'SMISMEMBER']);

export const AUDIT_SOURCE = Object.freeze({
  KEYS: 'keys',       // SCAN ak:prospect:* → レコード鍵と台帳鍵
  ACTIVE: 'active',   // SSCAN 送信候補索引
  ENGAGED: 'engaged', // SSCAN 反応済み索引
  BLOCKED: 'blocked', // SSCAN 抑止索引
});
const INDEX_BY_SOURCE = Object.freeze({
  [AUDIT_SOURCE.ACTIVE]: ACTIVE_INDEX,
  [AUDIT_SOURCE.ENGAGED]: ENGAGED_INDEX,
  [AUDIT_SOURCE.BLOCKED]: BLOCKED_INDEX,
});
const INDEX_KEYS = new Set([ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX]);

/** 1 窓で SCAN に渡す COUNT の上限（Function の実行時間と応答の大きさを抑える）*/
export const MAX_WINDOW_COUNT = 1000;
/** MGET / SMISMEMBER 1 回あたりの件数 */
const CHUNK = 250;

export class ProspectStateAuditError extends Error {
  constructor(code) { super(`prospect_state_audit:${code}`); this.name = 'ProspectStateAuditError'; this.code = code; }
}

/**
 * 読み取り専用の Redis ラッパー。コマンドと鍵を**送る前に**確かめる。
 * @param {{cmd: Function, pipeline?: Function}} deps
 */
export function createStateAuditReader({ cmd, pipeline } = {}) {
  if (typeof cmd !== 'function') throw new ProspectStateAuditError('cmd_required');

  const check = (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (!READ_ONLY_OPS.includes(op)) throw new ProspectStateAuditError(`read_only_violation:${op}`);
    if (op === 'SCAN') {
      const i = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
      const pat = i >= 0 ? String(args[i + 1] || '') : '';
      if (!pat.startsWith(PROSPECT_ROOT)) throw new ProspectStateAuditError('scan_out_of_namespace');
    } else if (op === 'SSCAN' || op === 'SMISMEMBER') {
      if (!INDEX_KEYS.has(String(args[1]))) throw new ProspectStateAuditError('index_out_of_namespace');
    } else if (op === 'MGET') {
      for (const k of args.slice(1)) {
        const s = String(k);
        if (!s.startsWith(RECORD_PREFIX) && !s.startsWith(LEDGER_PREFIX)) {
          throw new ProspectStateAuditError('mget_out_of_namespace');
        }
      }
    }
    return args.map(String);
  };

  const run = async (args) => {
    const res = await cmd(check(args));
    if (res === undefined) throw new ProspectStateAuditError('unknown_result');
    return res;
  };
  const runMany = async (list) => {
    const checked = list.map(check);
    if (typeof pipeline === 'function') {
      const res = await pipeline(checked);
      if (!Array.isArray(res) || res.length !== checked.length) throw new ProspectStateAuditError('pipeline_shape');
      return res;
    }
    const out = [];
    // eslint-disable-next-line no-await-in-loop -- pipeline が無いときだけの退避
    for (const a of checked) out.push(await cmd(a));
    return out;
  };

  const parseScan = (res) => {
    if (!Array.isArray(res) || res.length !== 2 || !Array.isArray(res[1])) {
      throw new ProspectStateAuditError('scan_shape');
    }
    return { cursor: String(res[0]), items: res[1].map(String) };
  };

  return {
    /** 1 窓ぶんの hash を集める。**0 件でも cursor が進めば正常**（SCAN の仕様）*/
    async window({ source, cursor = '0', count = MAX_WINDOW_COUNT }) {
      const n = Math.max(1, Math.min(MAX_WINDOW_COUNT, Number(count) || MAX_WINDOW_COUNT));
      const cur = /^\d+$/.test(String(cursor)) ? String(cursor) : '0';
      if (source === AUDIT_SOURCE.KEYS) {
        const { cursor: next, items } = parseScan(await run(['SCAN', cur, 'MATCH', `${PROSPECT_ROOT}*`, 'COUNT', n]));
        const records = []; const ledgers = [];
        for (const k of items) {
          if (k.startsWith(RECORD_PREFIX)) {
            const h = k.slice(RECORD_PREFIX.length);
            if (HASH_RE.test(h)) records.push(h);
          } else if (k.startsWith(LEDGER_PREFIX)) {
            const h = k.slice(LEDGER_PREFIX.length);
            if (HASH_RE.test(h)) ledgers.push(h);
          }
          // index / stats / promo-lock などは対象外
        }
        return { cursor: next, records, ledgers, members: [] };
      }
      const key = INDEX_BY_SOURCE[source];
      if (!key) throw new ProspectStateAuditError('unknown_source');
      const { cursor: next, items } = parseScan(await run(['SSCAN', key, cur, 'COUNT', n]));
      return {
        cursor: next, records: [], ledgers: [], members: items.filter((h) => HASH_RE.test(h)),
      };
    },

    /** hash ごとにレコード・台帳・3 索引の所属を読む（1 往復の pipeline を塊ごとに）*/
    async inspect(hashes) {
      const list = [...new Set((hashes || []).map(String))].filter((h) => HASH_RE.test(h));
      const out = new Map();
      for (let i = 0; i < list.length; i += CHUNK) {
        const part = list.slice(i, i + CHUNK);
        // eslint-disable-next-line no-await-in-loop -- 塊ごとに直列（1 塊 = 1 往復）
        const [recs, leds, act, eng, blk] = await runMany([
          ['MGET', ...part.map(prospectKey)],
          ['MGET', ...part.map(blockedKey)],
          ['SMISMEMBER', ACTIVE_INDEX, ...part],
          ['SMISMEMBER', ENGAGED_INDEX, ...part],
          ['SMISMEMBER', BLOCKED_INDEX, ...part],
        ]);
        for (const arr of [recs, leds, act, eng, blk]) {
          if (!Array.isArray(arr) || arr.length !== part.length) throw new ProspectStateAuditError('inspect_shape');
        }
        part.forEach((h, j) => {
          out.set(h, {
            recordRaw: recs[j] === null || recs[j] === undefined ? null : String(recs[j]),
            ledgerRaw: leds[j] === null || leds[j] === undefined ? null : String(leds[j]),
            inActive: Number(act[j]) === 1,
            inEngaged: Number(eng[j]) === 1,
            inBlocked: Number(blk[j]) === 1,
          });
        });
      }
      return out;
    },
  };
}

/**
 * 1 窓を監査する。異常は**もう一度読み直して**、同じ異常が続いているものだけを確定にする
 * （webhook が同時に書いている最中の「読んだ瞬間だけのズレ」を異常に数えない）。
 *
 * @returns {Promise<{cursor, done, seen: {records, ledgers, members},
 *   states: Array<[string,string|null]>, findings: Array, transient: number}>}
 */
export async function auditStateWindow(reader, { source, cursor, count, env = process.env } = {}) {
  const w = await reader.window({ source, cursor, count });
  const hashes = [...new Set([...w.records, ...w.ledgers, ...w.members])];
  const first = await reader.inspect(hashes);

  const states = [];
  const suspects = [];
  for (const h of hashes) {
    const c = classifyProspectConsistency(first.get(h), { env });
    states.push([h, c.state]);
    if (c.codes.length > 0) suspects.push(h);
  }

  const findings = [];
  let transient = 0;
  if (suspects.length > 0) {
    const second = await reader.inspect(suspects);
    for (const h of suspects) {
      const a = classifyProspectConsistency(first.get(h), { env });
      const b = classifyProspectConsistency(second.get(h), { env });
      const stable = a.codes.filter((x) => b.codes.includes(x));
      if (stable.length === 0) { transient += 1; continue; }
      findings.push({
        hash: h,
        codes: stable,
        severity: stable.some((x) => FINDING_SEVERITY[x] === SEVERITY.CRITICAL) ? SEVERITY.CRITICAL
          : stable.some((x) => FINDING_SEVERITY[x] === SEVERITY.INTEGRITY) ? SEVERITY.INTEGRITY : SEVERITY.INFO,
        state: b.state,
        hasRecord: b.hasRecord,
        hasLedger: b.hasLedger,
        ledgerKind: b.ledgerKind,
        record: b.record,
      });
    }
  }
  return {
    cursor: w.cursor,
    done: w.cursor === '0',
    seen: { records: w.records, ledgers: w.ledgers, members: w.members },
    states,
    findings,
    transient,
  };
}

/**
 * 窓の結果を積み上げる（手元のスクリプト用・純粋）。
 * SCAN は同じ鍵を 2 回返し得るので **hash で重ねない**。
 */
export function createStateAuditAccumulator() {
  const records = new Set();
  const ledgers = new Set();
  const members = { active: new Set(), engaged: new Set(), blocked: new Set() };
  const stateByHash = new Map();
  const findingByHash = new Map();
  let transient = 0;

  return {
    add(source, r) {
      r.seen.records.forEach((h) => records.add(h));
      r.seen.ledgers.forEach((h) => ledgers.add(h));
      if (members[source]) r.seen.members.forEach((h) => members[source].add(h));
      for (const [h, s] of r.states) if (s) stateByHash.set(h, s);
      for (const f of r.findings) {
        const prev = findingByHash.get(f.hash);
        findingByHash.set(f.hash, prev
          ? { ...f, codes: [...new Set([...prev.codes, ...f.codes])] } : f);
      }
      transient += Number(r.transient) || 0;
    },
    summary() {
      const byCode = {};
      const bySeverity = { critical: 0, integrity: 0, info: 0 };
      for (const f of findingByHash.values()) {
        for (const c of f.codes) byCode[c] = (byCode[c] || 0) + 1;
        const sev = f.codes.some((c) => FINDING_SEVERITY[c] === SEVERITY.CRITICAL) ? 'critical'
          : f.codes.some((c) => FINDING_SEVERITY[c] === SEVERITY.INTEGRITY) ? 'integrity' : 'info';
        bySeverity[sev] += 1;
      }
      const stateCounts = {};
      for (const h of records) {
        const s = stateByHash.get(h) || '(unreadable)';
        stateCounts[s] = (stateCounts[s] || 0) + 1;
      }
      const universe = new Set([
        ...records, ...ledgers, ...members.active, ...members.engaged, ...members.blocked,
      ]);
      return {
        universe: universe.size,
        records: records.size,
        ledgers: ledgers.size,
        ledgerOnly: [...ledgers].filter((h) => !records.has(h)).length,
        indexSizes: {
          active: members.active.size, engaged: members.engaged.size, blocked: members.blocked.size,
        },
        stateCounts,
        bySeverity,
        byCode,
        transient,
        findings: [...findingByHash.values()],
      };
    },
  };
}
