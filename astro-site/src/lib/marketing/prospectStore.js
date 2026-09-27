/**
 * prospectStore.js — 見込み客プールの保存（Upstash Redis / I/O は注入）
 *
 * ── ⚠️ この名前空間**だけ**はメールアドレスを保存する ────────────
 * AK の Redis は原則 PII を保存しない（`automationStore.js` の `assertNoPii`）。
 * しかし prospect は **送るために本人のアドレスが要る**。Airtable Customers へは
 * 「反応した人だけ」入れる方針なので、反応前のアドレスの置き場が他に無い。
 *
 * そこで **`ak:prospect:` 配下に限って**アドレスの保存を許し、代わりに:
 *   - キーは `sha256(email)`。**キー名からアドレスは復元できない**
 *   - 値の中にだけ平文アドレスを持つ（送信に必要な最小限）
 *   - **一覧 API・ログ・管理画面の集計にアドレスを出さない**（件数と状態だけ）
 *   - 抑止・打ち切りの後は **`purge()` で生アドレスごと削除できる**
 *     （復活防止は hash だけの永続台帳が担う）
 * という制約を課す。他の名前空間へアドレスを書くことは従来どおり禁止。
 *
 * ── キー ──────────────────────────────────────────────────────
 *   ak:prospect:p:<sha256(email)>    … prospect 1 件（**配信中だけ**アドレスを持つ）
 *   ak:prospect:index:active         … 送信候補の集合（member は sha256）
 *   ak:prospect:index:engaged        … 反応済み・未昇格の集合（昇格待ち行列）
 *   ak:prospect:blocked:<sha256>     … **永続抑止台帳**（除外・打ち切り。TTL なし・アドレスなし）
 *   ak:prospect:index:blocked        … 抑止済みの hash 集合（取り込み時の照合用）
 *
 * ── ⚠️ 抑止台帳は消さない ─────────────────────────────────────
 * 除外（bounce / 苦情 / 配信停止）と打ち切り（無反応 N 回）は **TTL を付けない**。
 * 消えると **CSV を再取り込みしたときに配信対象として復活してしまう**。
 * 台帳が持つのは `sha256(email)` と理由・日時だけで、**生アドレスは持たない**。
 * 生アドレスを持つのは `ak:prospect:p:` の**配信中のレコードだけ**で、
 * 抑止・打ち切りの後は `purge()` で**削除してよい**（台帳が残るので復活しない）。
 *
 * ⚠️ `ak:marketing-automation:` / `payemail:` / `customer-import:` / KMA の
 *    名前空間へは**一切触らない**（`assertKey` が構造的に拒否）。
 */

import { createHash } from 'node:crypto';
import {
  PROSPECT_STATE, normalizeEmail, buildProspect,
  applySend, applyDelivered, applyEngagement, applySuppression, applyPromotion,
} from './prospectPolicy.js';
import { PROSPECT_CUTOFF_REASON } from './prospectEngagement.js';

export const PROSPECT_ROOT = 'ak:prospect:';
export const ACTIVE_INDEX = `${PROSPECT_ROOT}index:active`;
export const ENGAGED_INDEX = `${PROSPECT_ROOT}index:engaged`;
export const STATS_KEY = `${PROSPECT_ROOT}stats`;

/** 抑止の種別（台帳に残る理由） */
export const BLOCK_KIND = Object.freeze({ SUPPRESSED: 'suppressed', EXHAUSTED: 'exhausted' });

export const emailHash = (email) =>
  createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');

export const prospectKey = (hash) => `${PROSPECT_ROOT}p:${hash}`;
export const blockedKey = (hash) => `${PROSPECT_ROOT}blocked:${hash}`;
/**
 * 昇格の取り合い防止。**`SET NX` で 1 つだけ通す**ので、
 * 自動昇格と管理画面の手動昇格が同時に走っても Customers を二重に作らない。
 */
export const promoLockKey = (hash) => `${PROSPECT_ROOT}promo-lock:${hash}`;
export const PROMO_LOCK_TTL_SEC = 300;
export const BLOCKED_INDEX = `${PROSPECT_ROOT}index:blocked`;

/**
 * 抑止台帳に保存してよい項目。**アドレスを含めない**。
 * `delivered` を持つのは、打ち切りの根拠が**送信回数ではなく配信成功数**だから
 * （後から「何通届いて切ったのか」を説明できるようにする）。
 */
export const BLOCKED_FIELDS = Object.freeze(['hash', 'kind', 'reason', 'at', 'sends', 'delivered', 'source']);

/** 保存してよい項目（**これ以外は 1 つも書かない**） */
export const PROSPECT_FIELDS = Object.freeze([
  'email', 'state', 'sends', 'delivered', 'opens', 'clicks',
  'lastSentAt', 'lastDeliveredAt', 'lastRunId',
  'engagedAt', 'engagedKind', 'promotedAt', 'promotedRecordId', 'suppressedAt', 'suppressedReason',
  'addedAt', 'batchId', 'source',
  /**
   * 反映済みの provider イベント ID（`sg_event_id`）。**レコードと同じ書き込み**で残すので、
   * 「反映した」と「反映済みの印」が片方だけになることが無い（2026-09-27 の部分書き込み対策）。
   * 上限は `APPLIED_EVENT_IDS_CAP`（古いものから落とす）。
   */
  'appliedEventIds',
]);

/** 1 レコードに残す反映済みイベント ID の上限（再送の窓より十分長く・レコードを太らせない） */
export const APPLIED_EVENT_IDS_CAP = 50;

export class ProspectStoreError extends Error {
  constructor(code, detail) {
    super(`prospect_store:${code}`);
    this.name = 'ProspectStoreError';
    this.code = code; this.detail = detail || null;
  }
}
export const STORE_FAIL = Object.freeze({
  OUT_OF_NAMESPACE: 'out_of_namespace',
  /** 読んでから書くまでに他の誰かが書いた（**上書きせず**に読み直す。上限回数を越えたらこれ） */
  CAS_CONFLICT: 'cas_conflict',
  CAS_FAILED: 'cas_failed',
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  DATA_CORRUPT: 'data_corrupt',
  INDEX_UNAVAILABLE: 'index_unavailable',
});

const pick = (obj, allow) => {
  const out = {};
  for (const k of allow) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/**
 * その状態なら**送信候補**か。索引（`ACTIVE_INDEX`）に居るべきかどうかの単一源。
 * ⚠️ ここと `casItem`（索引の出し分け）の判定がズレると、状態と索引が食い違う。
 */
export const isSendableState = (state) => state === PROSPECT_STATE.NEW
  || state === PROSPECT_STATE.SENDING;

/**
 * ⚠️ **prospect レコードに TTL は付けない。**
 * 以前は EXHAUSTED / SUPPRESSED を TTL で消していたが、消えると
 * **CSV 再取り込みで配信対象として復活する**。抑止は台帳（TTL なし）が担い、
 * レコード側は `purge()` で明示的に消す（そのとき生アドレスも消える）。
 */
export function ttlForState() { return null; }

/** その状態は抑止台帳へ載せるべきか */
export function blockKindForState(state) {
  if (state === PROSPECT_STATE.SUPPRESSED) return BLOCK_KIND.SUPPRESSED;
  if (state === PROSPECT_STATE.EXHAUSTED) return BLOCK_KIND.EXHAUSTED;
  return null;
}

/**
 * **比較して書く（compare-and-set）**。レコード・送信候補索引・反応済み索引・抑止台帳を
 * **1 回の Lua 実行**で書く。Redis は Lua を**原子的に**実行するので、途中で他の書き込みが
 * 割り込むことも、途中の 1 つだけ反映されることも無い。
 *
 * ## なぜ要るか（2026-09-27）
 *
 * 1. 部分書き込み: 4 つの書き込みを別往復で出していたため、Function が途中で止まると
 *    23 件が不整合になった（EXHAUSTED なのに送信候補索引に残る / どこにも居ない）。
 * 2. **後勝ち（lost update）**: 「読む → JS で計算 → 書く」の間に同じ相手へ別の書き込み
 *    （例: delivered と open を別々の webhook が同時に処理）が入ると、後から書いた方が
 *    先の更新を**黙って消す**。Upstash REST では WATCH が使えないので、
 *    **読んだ値が今も同じときだけ書く**ことで防ぐ。違えば 1 件も書かずに 0 を返し、
 *    呼び出し側が読み直して計算し直す（`updateWithCas` / `prospectEventBatch`）。
 *
 * ## 引数
 *
 * KEYS = [送信候補索引, 反応済み索引, 抑止索引, (レコード鍵, 抑止台帳鍵) × N]
 * ARGV = [N, (hash, 期待値, レコード操作, 新しい値, 送信候補, 反応済み, 抑止台帳の値) × N]
 *   - 期待値: `ABSENT`（無いこと）または `V:` ＋ 読んだ生の値（**文字列として完全一致**を比べる）
 *
 * ⚠️ 2026-09-27: 当初は SHA1（`redis.sha1hex`）で比べていたが、本番 Upstash で `redis.sha1hex` が
 *    使えることを確かめる手段が無かった（本番の Redis 認証情報は secret で手元から使えない）。
 *    **本番で既に動いている命令（GET / SET / SADD / SREM / DEL と文字列比較）だけ**で書き直した。
 *    比較に使うのは読んだ値そのもの（1 人 1〜2KB・50 人で 100KB 前後）。
 *   - レコード操作: `SET` / `KEEP`（索引だけ直す）/ `DEL`
 *   - 送信候補・反応済み: `1`（入れる）/ `0`（外す）/ `-`（触らない）
 *   - 抑止台帳の値: 空文字なら触らない
 *
 * 戻り値: 相手ごとに `0`（期待と違ったので**何も**書かなかった）/ `1`（書いた・索引の所属は不変）/
 *         `2`（書いた・索引の所属が実際に変わった＝自己修復の件数に数える）
 *
 * ⚠️ 鍵は全部 KEYS で渡す（スクリプトの中で鍵を組み立てない）。
 * ⚠️ Lua の途中でコマンドがエラーになると、それまでの書き込みは巻き戻らない（Redis の仕様）。
 *    使うのは正しい型の鍵への GET / SET / DEL / SADD / SREM だけなので実務上は起きない。
 */
export const PROSPECT_CAS_LUA = [
  'local n = tonumber(ARGV[1])',
  'local out = {}',
  'for i = 1, n do',
  '  local kp = KEYS[3 + (i - 1) * 2 + 1]',
  '  local kb = KEYS[3 + (i - 1) * 2 + 2]',
  '  local a = 1 + (i - 1) * 7',
  '  local hash = ARGV[a + 1]',
  '  local expect = ARGV[a + 2]',
  '  local recOp = ARGV[a + 3]',
  '  local newRaw = ARGV[a + 4]',
  '  local act = ARGV[a + 5]',
  '  local eng = ARGV[a + 6]',
  '  local blk = ARGV[a + 7]',
  "  local cur = redis.call('GET', kp)",
  '  local ok = false',
  "  if expect == 'ABSENT' then",
  '    ok = (not cur)',
  '  elseif cur then',
  "    ok = (expect == ('V:' .. cur))",
  '  end',
  '  if ok then',
  '    local moved = 0',
  "    if recOp == 'SET' then redis.call('SET', kp, newRaw)",
  "    elseif recOp == 'DEL' then redis.call('DEL', kp) end",
  "    if act == '1' then moved = moved + redis.call('SADD', KEYS[1], hash)",
  "    elseif act == '0' then moved = moved + redis.call('SREM', KEYS[1], hash) end",
  "    if eng == '1' then moved = moved + redis.call('SADD', KEYS[2], hash)",
  "    elseif eng == '0' then moved = moved + redis.call('SREM', KEYS[2], hash) end",
  "    if blk ~= '' then",
  "      redis.call('SET', kb, blk)",
  "      redis.call('SADD', KEYS[3], hash)",
  '    end',
  '    if moved > 0 then out[i] = 2 else out[i] = 1 end',
  '  else',
  '    out[i] = 0',
  '  end',
  'end',
  'return out',
].join('\n');

/** 読んだ値 → CAS の期待値（`V:` ＋ 生の値。Lua 側で `'V:' .. cur` と完全一致を比べる） */
export const casExpect = (raw) => (raw === null || raw === undefined ? 'ABSENT' : `V:${String(raw)}`);

/** 読み直しの上限（同じ相手へ書き込みが集中しても無限に回らない） */
export const CAS_ATTEMPTS = 8;

/** 抑止台帳に載せる中身（**アドレスなし**）。載せない state なら `null` */
export function blockEntryFor(hash, d, nowMs = Date.now()) {
  const kind = blockKindForState(d && d.state);
  if (!kind) return null;
  return {
    hash,
    kind,
    reason: d.suppressedReason || (kind === BLOCK_KIND.EXHAUSTED ? PROSPECT_CUTOFF_REASON : 'unknown'),
    at: d.suppressedAt || d.lastDeliveredAt || d.lastSentAt || new Date(Number(nowMs) || 0).toISOString(),
    sends: d.sends,
    delivered: d.delivered,
    source: 'prospect',
  };
}

/**
 * @param {{ cmd: (args: string[]) => Promise<any>, pipeline?: Function }} deps Upstash REST 相当。
 *   書き込みは**すべて** `PROSPECT_CAS_LUA`（EVAL）経由（比較して書く・原子的）。
 */
export function createProspectStore({ cmd, pipeline } = {}) {
  if (typeof cmd !== 'function') throw new Error('createProspectStore: cmd が必要です');
  const state = { commands: 0, keysTouched: new Set() };

  /** `ak:prospect:` 配下以外は拒否する */
  const assertKeyName = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(PROSPECT_ROOT)) throw new ProspectStoreError(STORE_FAIL.OUT_OF_NAMESPACE, k.slice(0, 48));
    return k;
  };
  const assertKey = assertKeyName;

  const OPS = ['GET', 'SET', 'DEL', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'MGET', 'SISMEMBER'];
  const call = async (args, failCode) => {
    const op = String(args[0] || '').toUpperCase();
    if (!OPS.includes(op)) throw new ProspectStoreError(STORE_FAIL.OUT_OF_NAMESPACE, `unsupported_op:${op}`);
    // MGET は複数キーを取るので全部見る
    if (op === 'MGET') for (const k of args.slice(1)) assertKey(k);
    else assertKey(args[1]);
    state.keysTouched.add(String(args[1] ?? ''));
    state.commands += 1;
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new ProspectStoreError(failCode || STORE_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new ProspectStoreError(STORE_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  const parse = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); }
    catch { throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'prospect'); }
  };

  /**
   * 1 人ぶんの「比較して書く」指示を作る（純粋）。
   *
   * @param {{hash: string, expectRaw: string|null, next?: object|null, del?: boolean,
   *          nowMs?: number, onlyChanges?: {active?: boolean|null, engaged?: boolean|null}}} it
   *   - `expectRaw`: 読んだ生の値（`null` なら「無いこと」を期待）
   *   - `next`: 書くレコード（無ければ**索引と台帳だけ**を今の state に合わせる）
   *   - `onlyChanges`: 索引の一部だけ動かすとき（`null` = 触らない）
   */
  const casItem = ({ hash, expectRaw, next = null, del = false, nowMs, onlyChanges = null }) => {
    const current = parse(expectRaw);
    const basis = next || current || {};
    const d = next ? pick(next, PROSPECT_FIELDS) : null;
    const flag = (v) => (v === true ? '1' : v === false ? '0' : '-');
    let active; let engaged;
    if (del) { active = false; engaged = false; }
    else if (onlyChanges) { active = onlyChanges.active ?? null; engaged = onlyChanges.engaged ?? null; }
    else { active = isSendableState(basis.state); engaged = basis.state === PROSPECT_STATE.ENGAGED; }
    const block = (!del && !onlyChanges) ? blockEntryFor(hash, basis, nowMs) : null;
    return {
      hash,
      expect: casExpect(expectRaw),
      recOp: del ? 'DEL' : (d ? 'SET' : 'KEEP'),
      newRaw: d ? JSON.stringify(d) : '',
      act: flag(active),
      eng: flag(engaged),
      blk: block ? JSON.stringify(pick(block, BLOCKED_FIELDS)) : '',
    };
  };

  /**
   * まとめて「比較して書く」（**1 回の EVAL**）。戻り値は相手ごとの
   * `{ok: 書いたか, indexChanged: 索引の所属が実際に変わったか}`（衝突なら ok=false で何も書いていない）。
   * ⚠️ 鍵は全部 `ak:prospect:` 配下であることを送る前に確かめる（1 つでも外れれば送らない）。
   */
  const casMany = async (items) => {
    const list = (items || []).filter(Boolean);
    if (list.length === 0) return [];
    const keys = [ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX];
    const argv = [String(list.length)];
    for (const it of list) {
      keys.push(prospectKey(it.hash), blockedKey(it.hash));
      argv.push(it.hash, it.expect, it.recOp, it.newRaw, it.act, it.eng, it.blk);
    }
    for (const k of keys) { assertKey(k); state.keysTouched.add(k); }
    state.commands += 1;
    let res;
    try { res = await cmd(['EVAL', PROSPECT_CAS_LUA, String(keys.length), ...keys, ...argv]); }
    catch (e) { throw new ProspectStoreError(STORE_FAIL.CAS_FAILED, e && e.message); }
    if (!Array.isArray(res) || res.length !== list.length) {
      throw new ProspectStoreError(STORE_FAIL.CAS_FAILED, 'result_shape');
    }
    return res.map((v) => ({ ok: Number(v) >= 1, indexChanged: Number(v) === 2 }));
  };

  /** 生の値のまま読む（CAS の期待値に使う） */
  const loadRaw = async (hash) => {
    const raw = await call(['GET', prospectKey(hash)], STORE_FAIL.DATA_CORRUPT);
    return raw === null || raw === undefined ? null : String(raw);
  };

  /**
   * 読んで・計算して・**比較して書く**を、衝突したら読み直して繰り返す（上限 `CAS_ATTEMPTS`）。
   *
   * @param {string} hash
   * @param {(cur: object|null) => ({next?: object|null, del?: boolean, result: object}|null)} mutate
   *   `null` を返せば何も書かない。`next` 無し・`del` 無しなら索引だけ state に合わせる。
   * @param {{nowMs?: number, allowAbsent?: boolean}} [opts]
   */
  const updateWithCas = async (hash, mutate, { nowMs, allowAbsent = false } = {}) => {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- 衝突したら読み直す
      const raw = await loadRaw(hash);
      const cur = parse(raw);
      if (!cur && !allowAbsent) return { notFound: true };
      const m = mutate(cur);
      if (!m) return { written: false };
      const item = casItem({ hash, expectRaw: raw, next: m.next || null, del: m.del === true, nowMs });
      // eslint-disable-next-line no-await-in-loop -- 同上
      const [r] = await casMany([item]);
      if (r.ok) return { written: true, indexChanged: r.indexChanged, ...m };
    }
    throw new ProspectStoreError(STORE_FAIL.CAS_CONFLICT, 'attempts_exhausted');
  };

  return {
    state, assertKey: assertKeyName,
    /** 比較して書く（`prospectEventBatch` が塊ごとに使う） */
    casItem,
    casMany,
    /** まとめ読み（**生の値のまま**・CAS の期待値に使う）。1 回の MGET で 500 件まで */
    async loadManyRaw(hashes) {
      const list = (hashes || []).slice(0, 500);
      if (list.length === 0) return [];
      const raw = await call(['MGET', ...list.map(prospectKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(raw) || raw.length !== list.length) throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'mget');
      return raw.map((r, i) => {
        const rawStr = r === null || r === undefined ? null : String(r);
        return { hash: list[i], raw: rawStr, record: parse(rawStr) };
      });
    },

    async load(email) {
      return parse(await call(['GET', prospectKey(emailHash(email))], STORE_FAIL.DATA_CORRUPT));
    },
    async loadByHash(hash) {
      return parse(await call(['GET', prospectKey(hash)], STORE_FAIL.DATA_CORRUPT));
    },
    /** まとめ読み。**1 回の MGET で 500 件まで**（超える分は呼び出し側で分ける） */
    async loadMany(hashes) {
      const list = (hashes || []).slice(0, 500);
      if (list.length === 0) return [];
      const raw = await call(['MGET', ...list.map(prospectKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'mget');
      return raw.map((r, i) => {
        const p = parse(r);
        return p ? { ...p, hash: list[i] } : null;
      }).filter(Boolean);
    },

    /**
     * **まとめて**新規追加する（移行の投入用）。
     *
     * ── なぜ要るか ────────────────────────────────────────────
     * `addIfAbsent()` は 1 件につき EXISTS → GET → SET → SADD → SREM ×2 と
     * 往復が 6 回ある。100 件で 600 往復になり、**Function の実行時間を超える**
     * （2026-08-27 に本番で 504。88 件書けたところで gateway が切った）。
     *
     * まとめ読み（MGET）とまとめ書き（pipeline）にすると **1 ページ 5 往復**で済む。
     *
     * ── 守っていること（`addIfAbsent` と同じ）──────────────────
     *   - **抑止台帳に載っている相手は復活させない**
     *   - **既にあるレコードは上書きしない**（送信回数・除外を消さない）
     *   - 書いたあと**読み戻して**確かめる（確かめられない件数を返す）
     *
     * ⚠️ この経路は **NEW / SENDING のレコードだけ**を対象にする。
     *    EXHAUSTED / SUPPRESSED は抑止台帳への追記が要るので `addIfAbsent` を使う。
     *
     * @returns {Promise<{added:number, existed:number, blocked:number,
     *                    failed:number, unverified:number}>}
     */
    async addManyIfAbsent(prospects) {
      const list = (Array.isArray(prospects) ? prospects : []).filter((p) => p && p.email);
      const out = {
        added: 0, existed: 0, blocked: 0, failed: 0, unverified: 0, reindexed: 0,
      };
      if (list.length === 0) return out;

      // ⚠️ 状態を確かめる（この経路は配信候補の投入だけを扱う）
      for (const p of list) {
        if (p.state !== PROSPECT_STATE.NEW && p.state !== PROSPECT_STATE.SENDING) {
          throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'unsupported_state_for_bulk');
        }
      }
      const hashes = list.map((p) => emailHash(p.email));

      // 1) 抑止台帳（**復活させない**）。MGET は null = 載っていない
      const blockedRaw = await call(['MGET', ...hashes.map(blockedKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(blockedRaw) || blockedRaw.length !== hashes.length) {
        throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'blocked_mget');
      }
      // 2) 既存レコード（**上書きしない**）
      const curRaw = await call(['MGET', ...hashes.map(prospectKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(curRaw) || curRaw.length !== hashes.length) {
        throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'current_mget');
      }

      /**
       * ⚠️ 2026-09-27: 書き込みは**すべて比較して書く**（`casMany`・1 回の EVAL）。
       *   - 新規: 「まだ無いこと」を条件に作る。同時に誰かが作っていれば**上書きせず** existed に数える
       *   - 既存: 読んだ値のままなら索引だけ state に合わせる（2026-08-27 の自己修復）。
       *     読んだ後に誰かが書いていれば、その書き込み自体が索引まで揃えているので何もしない
       */
      const items = [];
      const kinds = [];
      list.forEach((p, i) => {
        if (blockedRaw[i] !== null && blockedRaw[i] !== undefined) { out.blocked += 1; return; }
        if (curRaw[i] !== null && curRaw[i] !== undefined) {
          out.existed += 1;
          items.push(casItem({ hash: hashes[i], expectRaw: String(curRaw[i]) }));
          kinds.push('existing');
          return;
        }
        items.push(casItem({ hash: hashes[i], expectRaw: null, next: pick(p, PROSPECT_FIELDS) }));
        kinds.push('fresh');
      });
      if (items.length === 0) return out;
      const res = await casMany(items);
      res.forEach((r, i) => {
        if (kinds[i] === 'fresh') {
          if (r.ok) out.added += 1;
          else out.existed += 1;       // 同時に誰かが作った。**上書きしない**
        } else if (r.ok && r.indexChanged) {
          out.reindexed += 1;          // 実際に直った件数だけ（揃っていたものは数えない）
        }
      });
      return out;
    },

    /**
     * 新規追加。**既にあれば上書きしない**（送信回数・除外を消さないため）。
     * ⚠️ **抑止台帳に載っている相手は復活させない**（CSV 再取り込みでも戻らない）。
     */
    async addIfAbsent(prospect) {
      const hash = emailHash(prospect.email);
      if (await this.isBlocked(hash)) return { added: false, blocked: true, prospect: null };
      /**
       * 無ければ「無いこと」を条件に作る。あれば**上書きせず**索引だけ state に合わせる
       * （2026-08-27 の自己修復）。どちらも比較して書く。
       */
      const r = await updateWithCas(hash, (cur) => (cur
        ? { result: { added: false, prospect: cur } }
        : { next: prospect, result: { added: true, prospect: pick(prospect, PROSPECT_FIELDS) } }),
      { allowAbsent: true });
      return { ...r.result, reindexed: !r.result.added && r.indexChanged ? 1 : 0 };
    },

    /** 抑止台帳に載っているか（hash で照合。アドレスは要らない） */
    async isBlocked(hash) {
      return Number(await call(['EXISTS', blockedKey(hash)])) === 1;
    },
    async loadBlocked(hash) {
      return parse(await call(['GET', blockedKey(hash)], STORE_FAIL.DATA_CORRUPT));
    },
    /**
     * 指定した hash の**索引だけ**を、保存済みレコードの state に合わせて直す（修復用）。
     *
     * ⚠️ **必要なときしか書かない。** 先に `SISMEMBER` で今の所属を見て、
     *    あるべき状態と違うときだけ 1 コマンド出す（既に正しければ 0 コマンド）。
     * ⚠️ **レコードは触らない**（`SET` を出さない）。索引の所属だけを揃える。
     * ⚠️ 抑止台帳に載っている相手は**何もしない**（復活も削除もしない）。
     * ⚠️ レコードが無い hash も**何もしない**（「投入していない人」を作らない）。
     *
     * @param {string[]} hashes
     * @param {{apply?: boolean}} opts `apply` が true でなければ**下見**（1 バイトも書かない）
     * @returns {Promise<{checked:number, planned:Array, applied:number, skipped:Array}>}
     */
    async reindexByHash(hashes, { apply = false } = {}) {
      const list = [...new Set((hashes || []).map((h) => String(h || '').trim().toLowerCase()))]
        .filter((h) => /^[0-9a-f]{64}$/.test(h));
      const out = {
        checked: list.length, planned: [], applied: 0, skipped: [],
      };
      if (list.length === 0) return out;

      const blockedRaw = await call(['MGET', ...list.map(blockedKey)], STORE_FAIL.DATA_CORRUPT);
      const curRaw = await call(['MGET', ...list.map(prospectKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(blockedRaw) || !Array.isArray(curRaw)) {
        throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'repair_mget');
      }

      for (let i = 0; i < list.length; i += 1) {
        const hash = list[i];
        if (blockedRaw[i] !== null && blockedRaw[i] !== undefined) {
          out.skipped.push({ hash, reason: 'blocked' }); continue;
        }
        const rec = parse(curRaw[i]);
        if (!rec) { out.skipped.push({ hash, reason: 'no_record' }); continue; }

        const wantActive = isSendableState(rec.state);
        const wantEngaged = rec.state === PROSPECT_STATE.ENGAGED;
        /* eslint-disable no-await-in-loop -- 修復対象は上限つき（通常 1 件） */
        const isActive = Number(await call(['SISMEMBER', ACTIVE_INDEX, hash])) === 1;
        const isEngaged = Number(await call(['SISMEMBER', ENGAGED_INDEX, hash])) === 1;
        const changes = [];
        if (wantActive !== isActive) changes.push([wantActive ? 'SADD' : 'SREM', ACTIVE_INDEX, hash]);
        if (wantEngaged !== isEngaged) changes.push([wantEngaged ? 'SADD' : 'SREM', ENGAGED_INDEX, hash]);
        out.planned.push({
          hash, state: rec.state, isActive, isEngaged, changes: changes.map((c) => c[0]),
        });
        if (apply && changes.length > 0) {
          // 比較して書く: 読んだ値のままのときだけ索引を動かす（読んだ後に書かれていれば触らない）
          const [cr] = await casMany([casItem({
            hash,
            expectRaw: String(curRaw[i]),
            onlyChanges: {
              active: wantActive !== isActive ? wantActive : null,
              engaged: wantEngaged !== isEngaged ? wantEngaged : null,
            },
          })]);
          if (cr.ok) out.applied += changes.length;
          else out.skipped.push({ hash, reason: 'changed_concurrently' });
        }
        /* eslint-enable no-await-in-loop */
      }
      return out;
    },

    /**
     * 指定 hash が **送信候補の索引に居るか**をまとめて調べる（**読み取りのみ**）。
     *
     * ⚠️ `SMEMBERS` で 1 万件超を毎回引くと帯域を食うので、`SISMEMBER` を
     *    **pipeline で 1 往復**にまとめる。pipeline が無ければ `SMEMBERS` へ退避する。
     *
     * @returns {Promise<Map<string, boolean>>}
     */
    async activeMembership(hashes) {
      const list = [...new Set((hashes || []).map((h) => String(h || '')))].filter(Boolean);
      const out = new Map();
      if (list.length === 0) return out;
      if (typeof pipeline === 'function') {
        const cmds = list.map((h) => ['SISMEMBER', ACTIVE_INDEX, h]);
        const res = await pipeline(cmds);
        if (!Array.isArray(res) || res.length !== cmds.length) {
          throw new ProspectStoreError(STORE_FAIL.UNKNOWN_RESULT, 'active_membership');
        }
        list.forEach((h, i) => out.set(h, Number(res[i]) === 1));
        return out;
      }
      const all = new Set(await this.activeHashes());
      for (const h of list) out.set(h, all.has(h));
      return out;
    },

    async blockedHashes() {
      const raw = await call(['SMEMBERS', BLOCKED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },

    /**
     * 反応済み索引の中身（**読み取りのみ**）。
     * 「送信候補に居ない人がどこに居るのか」を突き合わせるために要る
     * （`activeHashes` / `blockedHashes` と対になる 3 つ目の索引）。
     */
    async engagedHashes() {
      const raw = await call(['SMEMBERS', ENGAGED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },

    /**
     * 抑止・打ち切り済みの prospect レコードを消す（**生アドレスを消す**）。
     * 台帳は残るので、以後の取り込みでも復活しない。
     */
    async purge(hash) {
      if (!(await this.isBlocked(hash))) return { purged: false, reason: 'not_blocked' };
      // 読んだ値のままのときだけ消す（消した直後に別の書き込みが復活させる／逆も起きない）
      const r = await updateWithCas(hash, (cur) => (cur ? { del: true, result: { purged: true } } : null));
      if (r.notFound || r.written === false) return { purged: true };
      return r.result;
    },

    /**
     * 送信を**試みた**ことを記録する。
     * ⚠️ ここでは打ち切らない（届いた保証が無い）。打ち切りは `recordDelivered`。
     */
    async recordSend({ email, nowMs, runId }) {
      const r = await updateWithCas(emailHash(email), (cur) => {
        const next = applySend({ prospect: cur, nowMs, runId });
        return { next, result: { ok: true, prospect: pick(next, PROSPECT_FIELDS) } };
      }, { nowMs });
      return r.notFound ? { ok: false, reason: 'not_found' } : r.result;
    },

    /**
     * **配信成功（delivered）**を記録する。打ち切り（EXHAUSTED）が起きるのはここだけで、
     * 打ち切ると同じ書き込みで抑止台帳へ載せる（再取り込みでも復活しない）。
     * ⚠️ 比較して書く（同じ相手への別の更新を**後勝ちで消さない**）。
     */
    async recordDelivered({ email, nowMs, env }) {
      const r = await updateWithCas(emailHash(email), (cur) => {
        const x = applyDelivered({ prospect: cur, nowMs, env });
        if (!x.changed) return null;
        return { next: x.prospect, result: { ok: true, changed: true, prospect: pick(x.prospect, PROSPECT_FIELDS) } };
      }, { nowMs });
      if (r.notFound) return { ok: false, reason: 'not_found' };
      if (r.written === false) return { ok: true, changed: false, prospect: await this.loadByHash(emailHash(email)) };
      return r.result;
    },

    async recordEngagement({ email, nowMs, kind }) {
      const r = await updateWithCas(emailHash(email), (cur) => {
        const x = applyEngagement({ prospect: cur, nowMs, kind });
        if (!x.changed) return null;
        return { next: x.prospect, result: { ok: true, changed: true, prospect: pick(x.prospect, PROSPECT_FIELDS) } };
      }, { nowMs });
      if (r.notFound) return { ok: false, reason: 'not_found' };
      if (r.written === false) return { ok: true, changed: false, prospect: await this.loadByHash(emailHash(email)) };
      return r.result;
    },

    async recordSuppression({ email, nowMs, reason }) {
      const r = await updateWithCas(emailHash(email), (cur) => {
        const x = applySuppression({ prospect: cur, nowMs, reason });
        if (!x.changed) return null;
        return { next: x.prospect, result: { ok: true, changed: true, prospect: pick(x.prospect, PROSPECT_FIELDS) } };
      }, { nowMs });
      if (r.notFound) return { ok: false, reason: 'not_found' };
      if (r.written === false) return { ok: true, changed: false, prospect: await this.loadByHash(emailHash(email)) };
      return r.result;
    },

    /**
     * ⚠️ **Airtable への作成が成功した後にだけ**呼ぶ。
     * 失敗したら ENGAGED のままにして次回に持ち越す（作られていないのに
     * PROMOTED にすると、その相手は二度と登録されない）。
     */
    async recordPromotion({ email, nowMs, recordId }) {
      const r = await updateWithCas(emailHash(email), (cur) => {
        const next = applyPromotion({ prospect: cur, nowMs });
        if (recordId) next.promotedRecordId = String(recordId);
        return { next, result: { ok: true, prospect: pick(next, PROSPECT_FIELDS) } };
      }, { nowMs });
      return r.notFound ? { ok: false, reason: 'not_found' } : r.result;
    },

    /** 昇格の権利を 1 つだけ取る（自動と手動の二重登録を防ぐ） */
    async claimPromotion(hash, ttlSec) {
      const res = await call([
        'SET', promoLockKey(hash), '1', 'NX', 'EX', String(ttlSec || PROMO_LOCK_TTL_SEC),
      ]);
      if (res === 'OK') return true;
      if (res === null) return false;
      throw new ProspectStoreError(STORE_FAIL.UNKNOWN_RESULT, 'claim_promotion');
    },
    async releasePromotionClaim(hash) { await call(['DEL', promoLockKey(hash)]); },

    /** 送信候補の hash 一覧。**応答が配列でなければ fail-closed** */
    async activeHashes() {
      const raw = await call(['SMEMBERS', ACTIVE_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },
    async engagedHashes() {
      const raw = await call(['SMEMBERS', ENGAGED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },

    /** 表示用の件数。**アドレスを返さない** */
    async counts() {
      const n = async (k) => {
        const v = Number(await call(['SCARD', k], STORE_FAIL.INDEX_UNAVAILABLE));
        return Number.isFinite(v) ? v : 0;
      };
      return {
        送信候補: await n(ACTIVE_INDEX),
        反応済み未登録: await n(ENGAGED_INDEX),
        永久除外: await n(BLOCKED_INDEX),
      };
    },

    stats: () => ({ commands: state.commands, keysTouched: state.keysTouched.size }),
  };
}

/** CSV 行から prospect を組み立てる（policy を再エクスポートせず明示的に使う） */
export { buildProspect };

export default createProspectStore;
