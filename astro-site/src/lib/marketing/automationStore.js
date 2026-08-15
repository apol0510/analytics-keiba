/**
 * automationStore.js — 自動化の**永続化**（Redis / I/O は注入）
 *
 * ── AK 専用の名前空間 ─────────────────────────────────────────
 * すべて `ak:marketing-automation:` 配下。**他の用途の鍵空間へ触れない**:
 *   - KMA（別ブランド基盤）
 *   - `payemail:*`（入金確認メール v2）
 *   - `customer-import:*`（顧客取り込み）
 * prefix 外の read/write は `assertKey` が**構造的に拒否**する。
 *
 * ── PII を保存しない ──────────────────────────────────────────
 * アドレス・氏名・CSV の中身は 1 バイトも置かない。受信者は
 * **正規化メールの sha256** だけを鍵に使い、値は状態と件数のみ。
 *
 * ── 正本の範囲（重要）────────────────────────────────────────
 *   Redis が正本 … 自動化の**設定と進行**（Definition / Run / claim / lock）
 *   Airtable が正本 … **送信の事実**（ScheduledEmails / CampaignDeliveries / EmailEvents）
 * 「送ったかどうか」を Redis で判断しない。Redis が消えても
 * **送信済みの事実は Airtable に残る**ので、二重送信の最終防壁は
 * `CampaignDeliveries.DeliveryKey` の冪等 upsert 側にある。
 *
 * ── Redis が信用できないときは fail-closed ────────────────────
 * 到達不能 / 応答不明 / CAS 不一致 / lock 状態不明 は例外にして**必ず伝播**させる。
 * 握りつぶして「新規実行」に倒さない。
 */

import { createHash } from 'node:crypto';

/** AK 専用の名前空間。ここから外れた鍵は触らない */
export const AUTO_ROOT = 'ak:marketing-automation:';

/** 他用途の鍵空間（**絶対に触れない**。guard の説明用） */
export const FOREIGN_PREFIXES = Object.freeze([
  'payemail:', 'customer-import:', 'kma:', 'tenant:',
]);

export const autoKey = Object.freeze({
  def: (automationId) => `${AUTO_ROOT}def:${automationId}`,
  run: (runId) => `${AUTO_ROOT}run:${runId}`,
  /**
   * 完了した run の**最小抑止キー**（B-5）。
   * run 本体には保持期間の TTL を付けるが、TTL 切れの後に同じ runId で
   * **二重に開始されない**ようにするため、`0`/`1` だけの墓標を別に持つ。
   * `runId` は `<automationId>#<YYYY-MM-DD>` で **PII を含まない**。
   */
  runMark: (runId) => `${AUTO_ROOT}run-mark:${runId}`,
  lock: (automationId) => `${AUTO_ROOT}lock:${automationId}`,
  recipient: (runId, emailHash) => `${AUTO_ROOT}recipient:${runId}:${emailHash}`,
  activeIndex: () => `${AUTO_ROOT}index:active`,
  fence: () => `${AUTO_ROOT}fence`,
});

/** 正規化メール → sha256（**復元不能**。これ以外を鍵に使わない） */
export function emailHash(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e ? createHash('sha256').update(e, 'utf8').digest('hex') : '';
}

/**
 * lock の検証・解放は **Lua で atomic に行う**（GET してから DEL の 2 段だと、
 * その隙に TTL 切れ→別実行が取得、を消してしまう）。
 *
 * ⚠️ ここはマーケティング自動化だけの持ち物ではない。**同じ排他が要る経路**
 *    （例: 実送信 dispatcher の同一ジョブ二重起動防止）から再利用する。
 *    新しい仕組みを増やすより、既に本番で動いている 1 つを共有する。
 */
export const LOCK_RELEASE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('DEL', KEYS[1])
return 'OK'
`;

export const LOCK_VERIFY_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
return 'OK'
`;

export class AutomationStoreError extends Error {
  constructor(code, detail) {
    super(`automation_store:${code}`);
    this.name = 'AutomationStoreError';
    this.code = code;
    this.detail = detail || null;
  }
}

export const STORE_FAIL = Object.freeze({
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  OUT_OF_NAMESPACE: 'out_of_namespace',
  CAS_CONFLICT: 'cas_conflict',
  LOCK_STATE_UNKNOWN: 'lock_state_unknown',
  DATA_CORRUPT: 'data_corrupt',
  PII_DETECTED: 'pii_detected',
});

/** lock の既定 TTL（1 回の scheduler 実行 + 余裕） */
export const LOCK_TTL_SEC = 300;
/** recipient claim の TTL（配信回が終われば不要になる） */
export const CLAIM_TTL_SEC = 7 * 24 * 3600;

/**
 * run 本体の保持期間（B-5）。
 *
 * ⚠️ **表示・監査に要る期間より短くしてはいけない。**
 *   - 実行履歴の表示は既定 30 日 / 最大 90 日（`RUNS_HISTORY_MAX_DAYS`）
 *   - 突合・問い合わせ対応の余裕を足して **120 日**
 * TTL 切れの後に同じ runId で二重開始されないことは、TTL の無い
 * **`run-mark`（墓標）**が保証する（run 本体の有無に依存しない）。
 */
export const RUN_TTL_SEC = 120 * 24 * 3600;
/** 墓標は消さない。**消すと TTL 切れの run が再開できてしまう** */
export const RUN_MARK_TTL_SEC = null;

/** Definition に保存してよい項目（**PII を持ち込ませない**） */
export const DEF_FIELDS = Object.freeze([
  'automationId', 'presetId', 'name', 'status', 'campaignId', 'campaignVersion',
  'schedule', 'timezone', 'quietHours', 'maxRecipients', 'trigger', 'audience',
  'createdAt', 'updatedAt', 'configVersion', 'lastRunAt', 'nextRunAt',
  // ⚠️ `enabled` は scheduler の `isDue` が見る。**保存しないと ACTIVE でも永久に動かない**
  //    （UI は ACTIVE と表示するのに scheduler は not_active、という食い違いになる）
  'enabled',
  // 保存時に固定するキャンペーンの版・本文（ACTIVE 化時の drift 検知に使う）
  'shellVersion', 'contentHash',
  // ⚠️ dry-run で確定した対象。**指紋と件数は両方保存する**。
  //    件数が無いと `detectDrift` の比較対象が 0 になり、対象が減っても snapshot_grew で常に弾かれる
  'snapshotFingerprint', 'snapshotCount', 'snapshotOccurrenceDate',
]);

/** Run に保存してよい項目 */
export const RUN_FIELDS = Object.freeze([
  'runId', 'automationId', 'operationId', 'status', 'snapshotFingerprint', 'snapshotCount',
  'queued', 'excluded', 'failed', 'startedAt', 'finishedAt', 'configurationVersion',
  'campaignVersion', 'contentHash', 'errorCode', 'reconciliation',
]);

/** PII が混ざっていないか（構造的な最後の砦） */
const PII_KEYS = ['email', 'emails', 'recipients', 'name', '氏名', 'Email', 'address', 'phone', 'Phone'];
export function assertNoPii(obj) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return true;
    if (seen.has(v)) return true;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      // `name` は自動化の表示名なので許可するが、`Email` 系は一切許可しない
      if (PII_KEYS.includes(k) && k !== 'name') return false;
      if (typeof val === 'string' && /@[a-z0-9.-]+\.[a-z]{2,}/i.test(val)) return false;
      if (!walk(val)) return false;
    }
    return true;
  };
  return walk(obj);
}

const pick = (obj, allow) => {
  const out = {};
  for (const k of allow) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps Upstash REST 相当
 */
export function createAutomationStore(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createAutomationStore: cmd が必要です');

  /** AK 専用 prefix の外は触らない */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(AUTO_ROOT)) throw new AutomationStoreError(STORE_FAIL.OUT_OF_NAMESPACE, k.slice(0, 40));
    return k;
  };

  const call = async (args, failCode) => {
    const op = String(args[0] || '').toUpperCase();
    // キーを取るコマンドは必ず prefix 検査を通す
    if (['GET', 'SET', 'DEL', 'INCR', 'EXPIRE', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS'].includes(op)) {
      assertKey(args[1]);
    }
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new AutomationStoreError(failCode || STORE_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  /**
   * ⚠️ **B-4: 本体の更新と索引の更新を 1 つの Lua で行う。**
   *
   * 以前は `saveDefinition`（CAS）→ `markActive`（SADD）の 2 段で、
   * 後者が落ちると **`get` は ACTIVE なのに `list` に出ない**（かつ scheduler も拾わない）
   * という食い違いが起きえた。Redis の Lua は**単一のアトミック実行**なので、
   * CAS が通ったその場で索引まで揃える。
   *
   *   KEYS[1] = def キー / KEYS[2] = active 索引
   *   ARGV[1] = 保存する JSON / ARGV[2] = expectedVersion
   *   ARGV[3] = automationId  / ARGV[4] = '1'（索引に入れる）/ '0'（外す）
   *
   * **索引は status から導出**するので、呼び出し側が別途 `markActive` を呼ぶ必要はない
   * （後方互換のため `markActive` / `unmarkActive` は残すが、冪等な補助でしかない）。
   */
  const CAS_WITH_INDEX_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local v = string.match(cur, '"configVersion":(%d+)')
  if v ~= ARGV[2] then return 'CONFLICT' end
elseif ARGV[2] ~= '' then
  return 'MISSING'
end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[4] == '1' then
  redis.call('SADD', KEYS[2], ARGV[3])
else
  redis.call('SREM', KEYS[2], ARGV[3])
end
return 'OK'
`;

  /** 自分の値のときだけ書き換える CAS（Lua）。索引を伴わない用途に残す */
  const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  if ARGV[2] == '' then redis.call('SET', KEYS[1], ARGV[1]) return 'OK' end
  return 'MISSING'
end
local v = string.match(cur, '"configVersion":(%d+)')
if v ~= ARGV[2] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'
`;

  /** 自分の token のときだけ解放する */
  const parse = (raw, what) => {
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch { throw new AutomationStoreError(STORE_FAIL.DATA_CORRUPT, what); }
  };

  return {
    assertKey,

    // ── Definition（Redis が正本）──────────────────────────────
    /**
     * ⚠️ `enabled` は **`status` から導出し直す**（正本は `status`）。
     * 保存もしているが、旧レコードや手直しで両者がズレても
     * 「UI は ACTIVE / scheduler は not_active」の食い違いを起こさせない。
     */
    async loadDefinition(automationId) {
      const d = parse(await call(['GET', autoKey.def(automationId)]), 'definition');
      if (!d) return d;
      return { ...d, enabled: d.status === 'ACTIVE' };
    },

    /**
     * version 付き CAS。**取り違えたら書かない**。
     * `expectedVersion` が空文字なら「まだ無いはず」として新規作成する。
     */
    /**
     * ⚠️ **本体と索引を同時に更新する**（B-4）。索引は `status` から導出する。
     * 途中で落ちても「本体だけ ACTIVE」「索引だけ残る」は起きない。
     */
    async saveDefinition({ definition, expectedVersion }) {
      const d = pick(definition, DEF_FIELDS);
      if (!assertNoPii(d)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'definition');
      const next = { ...d, configVersion: Number(d.configVersion) || 1 };
      const shouldIndex = next.status === 'ACTIVE' ? '1' : '0';
      const res = await call([
        'EVAL', CAS_WITH_INDEX_LUA, '2',
        autoKey.def(definition.automationId), autoKey.activeIndex(),
        JSON.stringify(next), String(expectedVersion ?? ''),
        String(definition.automationId), shouldIndex,
      ], STORE_FAIL.CAS_CONFLICT);
      if (res === 'OK') return { ok: true, definition: next, indexed: shouldIndex === '1' };
      if (res === 'CONFLICT') throw new AutomationStoreError(STORE_FAIL.CAS_CONFLICT, definition.automationId);
      if (res === 'MISSING') return { ok: false, reason: 'missing' };
      throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(res));
    },

    async listActive() {
      const raw = await call(['SMEMBERS', autoKey.activeIndex()]);
      return Array.isArray(raw) ? raw : [];
    },
    /**
     * ⚠️ 後方互換のために残す**冪等な補助**。`saveDefinition` が索引まで揃えるので、
     * 通常は呼ばなくてよい（呼んでも結果は変わらない）。
     */
    async markActive(automationId) { await call(['SADD', autoKey.activeIndex(), automationId]); },
    async unmarkActive(automationId) { await call(['SREM', autoKey.activeIndex(), automationId]); },

    /**
     * 索引と `status` の食い違いを**再実行で必ず収束**させる（B-4）。
     *
     * `saveDefinition` が原子的に揃えるので新しい不整合は生まれないが、
     * **この修正より前に書かれたデータ**や、手作業で触られた場合に備える。
     * 索引に居るのに ACTIVE でないものを外す。**送る側へは倒さない**
     * （索引に足す方向はしない。ACTIVE なのに索引に無いものは、
     *   次の保存・状態遷移で自動的に入る）。
     *
     * @returns {{checked, removed, kept, missing}}
     */
    async reconcileActiveIndex() {
      const ids = await this.listActive();
      let removed = 0; let kept = 0; let missing = 0;
      for (const id of ids) {
        const d = await this.loadDefinition(id);
        if (!d) { await this.unmarkActive(id); missing += 1; continue; }
        if (d.status !== 'ACTIVE') { await this.unmarkActive(id); removed += 1; continue; }
        kept += 1;
      }
      return { checked: ids.length, removed, kept, missing };
    },

    // ── lock + fencing token（scheduler の claim）──────────────
    async nextFencingToken() {
      const n = await call(['INCR', autoKey.fence()]);
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, 'fence');
      return String(v);
    },

    /** `SET NX EX` で 1 つだけ通す。取れなければ**何もしない** */
    async claim({ automationId, ttlSec }) {
      const token = await this.nextFencingToken();
      const res = await call([
        'SET', autoKey.lock(automationId), token, 'NX', 'EX', String(ttlSec || LOCK_TTL_SEC),
      ], STORE_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, token };
      if (res === null) return { ok: false, token: null, reason: 'locked' };
      throw new AutomationStoreError(STORE_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    /** enqueue の直前に必ず通す。**失っていたら書かない** */
    async verifyClaim({ automationId, token }) {
      const res = await call(['EVAL', LOCK_VERIFY_LUA, '1', autoKey.lock(automationId), String(token)],
        STORE_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST' || res === 'STOLEN') return { ok: false, reason: String(res).toLowerCase() };
      throw new AutomationStoreError(STORE_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    async releaseClaim({ automationId, token }) {
      const res = await call(['EVAL', LOCK_RELEASE_LUA, '1', autoKey.lock(automationId), String(token)],
        STORE_FAIL.LOCK_STATE_UNKNOWN);
      return { ok: res === 'OK', reason: res === 'OK' ? null : String(res).toLowerCase() };
    },

    // ── Run（Redis が正本：進行状況）──────────────────────────
    async loadRun(runId) {
      return parse(await call(['GET', autoKey.run(runId)]), 'run');
    },

    /**
     * 同一 runId の**二重開始を atomic に拒否**する。
     *
     * ⚠️ **B-5: 二重開始の判定は run 本体ではなく墓標（`run-mark`）で行う。**
     * run 本体には保持期間（120 日）の TTL を付けるため、TTL 切れの後に
     * 本体の `SET NX` だけで判定すると**同じ runId をもう一度開始できてしまう**。
     * 墓標は TTL を付けないので、何年経っても二度目は通らない。
     * 墓標が持つのは `1` だけで、**PII を含まない**（runId は automationId + 暦日）。
     */
    async createRun(run) {
      const r = pick(run, RUN_FIELDS);
      if (!assertNoPii(r)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'run');

      // 1) 墓標を取る（**これが二重開始の唯一の判定**）
      const mark = await call(['SET', autoKey.runMark(run.runId), '1', 'NX'], STORE_FAIL.UNKNOWN_RESULT);
      if (mark === null) return { created: false, reason: 'duplicate_run' };
      if (mark !== 'OK') throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(mark));

      // 2) 本体を書く（TTL 付き）。**墓標を取れた後なので NX は不要**
      //    （TTL 切れで本体だけ消えていた場合も、ここで作り直せる）
      await call(['SET', autoKey.run(run.runId), JSON.stringify(r), 'EX', String(RUN_TTL_SEC)]);
      return { created: true, run: r };
    },

    /** 更新のたびに保持期間を張り直す（**表示期間より短くしない**） */
    async saveRun(run) {
      const r = pick(run, RUN_FIELDS);
      if (!assertNoPii(r)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'run');
      await call(['SET', autoKey.run(run.runId), JSON.stringify(r), 'EX', String(RUN_TTL_SEC)]);
      return { ok: true };
    },

    /** その runId は既に開始済みか（墓標で判定。本体の TTL に依存しない） */
    async runStarted(runId) {
      return Number(await call(['EXISTS', autoKey.runMark(runId)])) === 1;
    },

    // ── recipient claim（同一 run で 1 人 1 回）────────────────
    /**
     * `runId + 正規化メールの sha256` で一意。**アドレスは保存しない**。
     * @returns {{ won: string[], taken: string[] }} 返すのは **hash** のみ
     */
    async claimRecipients({ runId, emails, ttlSec }) {
      const won = []; const taken = [];
      for (const e of (emails || [])) {
        const h = emailHash(e);
        if (!h) { taken.push(''); continue; }
        const res = await call([
          'SET', autoKey.recipient(runId, h), '1', 'NX', 'EX', String(ttlSec || CLAIM_TTL_SEC),
        ], STORE_FAIL.UNKNOWN_RESULT);
        if (res === 'OK') won.push(h);
        else if (res === null) taken.push(h);
        else throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(res));
      }
      return { won, taken };
    },

    async isRecipientClaimed({ runId, email }) {
      const h = emailHash(email);
      if (!h) return false;
      return Number(await call(['EXISTS', autoKey.recipient(runId, h)])) === 1;
    },
  };
}

export default createAutomationStore;
