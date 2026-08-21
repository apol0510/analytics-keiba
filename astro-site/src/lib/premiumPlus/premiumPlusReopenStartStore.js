/**
 * premiumPlusReopenStartStore.js — **会員ごとの**再募集開始日時の保存先（I/O。判定は持たない）
 *
 * ## 形（1 HASH × recordId フィールド）
 *
 * ```
 * HASH  ak:pp:reopen:v1:members
 *   field = Customers の recordId（`rec…` 14 桁）
 *   value = {"startsAt":"…ISO…","actor":"MK"}
 * ```
 *
 * `premiumPlusFunnelStore.js`（実閲覧の計測）と**同じ形**にしてある。
 * 会員ごとに鍵を増やさないので、一覧の一括読み取りが **`HMGET` 1 回**で済む。
 *
 * ## なぜ Upstash Redis か（**本番 schema を増やさない**）
 *
 * | 候補 | 判定 |
 * |---|---|
 * | **Upstash Redis の HASH**（採用）| `HSETNX` が**会員ごとの原子的な first-write-wins そのもの**。<br>本番で稼働中の接続をそのまま使う（`couponOperationLock.js` / funnel / rollout と同じ）。<br>**新しい env も Airtable schema も外部サービスも増えない** |
 * | Airtable Customers に列追加 | **本番 schema 変更**（高リスク境界）。しかも Airtable に unique 制約・CAS が無く、<br>二重押下・並行要求の lost update を防げない（read → write の間に割り込める）|
 * | Netlify Blobs | eventual consistency の問題が本番で出た経緯（2026-07-16）。確定値には向かない |
 *
 * ## 上書き経路を**コードとして持たない**
 *
 * 公開するのは `readMember()` / `readMembers()` / `startMember()` だけ。
 * **`set()` / `update()` / `clear()` を作らない**のは、「一度開始したら上書きしない」を
 * 運用ルールではなく**構造**で保証するため。
 *
 * ⚠️ rollback（誤って開始した会員を戻す）は **Upstash コンソールで該当フィールドを
 *    `HDEL` する**しかない（`HDEL ak:pp:reopen:v1:members <recordId>`）。
 *    手順は `astro-site/docs/PREMIUM_PLUS_STAGED_RELEASE.md` に記載。
 *    これは意図的な設計であり、admin に「取消」ボタンを足さないこと。
 *
 * ## ⚠️ サイト全体で 1 個の開始日時は**持たない**
 *
 * 旧実装の `ak:pp:reopen:v1:start`（全体で 1 個）は **正本ではない**。
 * 本番で 1 度も書かれていない状態で廃止した（read-only 実測で 0 件を確認済み）。
 * この鍵を読む・書くコードを復活させないこと。
 *
 * ## 読めないときは「未開始」と言わない
 *
 * 読み取り失敗は `available:false` として返し、判定側（`resolveReopenStatus`）が
 * `UNKNOWN` にする。**0 件・未設定へ丸めない。**
 */

import { makeRedisCmd } from './premiumPlusFunnelServer.js';
import { REOPEN_UNAVAILABLE, normalizeReopenStartsAt, isSafeCustomerRecordId } from './premiumPlusReopenStart.js';

/** Premium Plus の鍵空間（funnel の `ak:pp:funnel:*` とは別。他用途の鍵に触れない） */
export const REOPEN_NAMESPACE = 'ak:pp:reopen:v1';

/** 会員ごとの開始日時を入れる HASH（**TTL を付けない**。消えたら「開始していない」ことになる） */
export const REOPEN_MEMBERS_KEY = `${REOPEN_NAMESPACE}:members`;

/** 顧客画面から読むときの制限時間（ページ描画を待たせない） */
export const REOPEN_READ_TIMEOUT_MS = 700;

/** 管理画面から読むときの制限時間（正確さ優先で少し長く） */
export const REOPEN_ADMIN_TIMEOUT_MS = 2500;

/** 1 コマンドが際限なく長くならないよう分割する（funnel と同じ方針） */
export const READ_CHUNK = 100;

/** 操作者名の最大長（Airtable の `PremiumPlusEligibilityUpdatedBy` と同じ扱い） */
export const ACTOR_MAX = 32;

/**
 * 操作者名の正規化。
 * ⚠️ **メールアドレスを値に入れない**（`@` を含む値は捨てる）。監査に必要なのは「誰が押したか」の短い名前だけ。
 */
export function sanitizeActor(raw) {
  // 制御文字だけを落とす（表示・ログを壊さないため。**エスケープ表記で書く**）
  const s = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!s || s.includes('@')) return 'admin';
  return s.slice(0, ACTOR_MAX);
}

/**
 * 保存する形（JSON 1 行）。
 * ⚠️ 値の正本は `startsAt`。`actor` は**監査のための付随情報**で、判定には使わない。
 */
export function encodeReopenStartRecord({ startsAtIso, actor }) {
  return JSON.stringify({ startsAt: String(startsAtIso), actor: sanitizeActor(actor) });
}

/**
 * 保存値の読み取り。**素の ISO 文字列も受け付ける**（手で入れられた場合の後方互換）。
 * @returns {{ startsAtIso: string|null, actor: string }}
 */
export function decodeReopenStartRecord(raw) {
  if (raw === null || raw === undefined) return { startsAtIso: null, actor: '' };
  const s = String(raw).trim();
  if (!s) return { startsAtIso: null, actor: '' };
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return {
        startsAtIso: o && o.startsAt !== undefined ? String(o.startsAt) : null,
        actor: o && o.actor ? String(o.actor) : '',
      };
    } catch {
      // 壊れた JSON は**採用しない**（生値を返し、上位が「確認できない」と判定する）
      return { startsAtIso: s, actor: '' };
    }
  }
  return { startsAtIso: s, actor: '' };
}

/** 指定時間で諦める（例外にしない） */
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, Number(ms) || 1));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 保存先を作る。`redisCmd` は `makeRedisCmd(env)` の戻り値（未設定なら null）。
 *
 * @param {{ redisCmd: ((args: string[]) => Promise<any>)|null }} deps
 */
export function createReopenStartStore({ redisCmd } = {}) {
  const available = typeof redisCmd === 'function';

  const call = async (args) => {
    if (!available) return { ok: false, result: null };
    try {
      return { ok: true, result: await redisCmd(args) };
    } catch {
      return { ok: false, result: null };
    }
  };

  const unavailable = (reason) => ({
    available: false, startsAtIso: null, actor: '', reason,
  });

  // ⚠️ `this` を使わない（分解代入されても壊れないため）
  const readMember = async ({ recordId, timeoutMs = REOPEN_READ_TIMEOUT_MS } = {}) => {
    if (!isSafeCustomerRecordId(recordId)) return unavailable(REOPEN_UNAVAILABLE.INVALID_MEMBER);
    if (!available) return unavailable(REOPEN_UNAVAILABLE.NOT_CONFIGURED);
    const res = await withTimeout(call(['HGET', REOPEN_MEMBERS_KEY, recordId]), timeoutMs);
    if (res && res.timedOut === true) return unavailable(REOPEN_UNAVAILABLE.TIMEOUT);
    if (!res || res.ok !== true) return unavailable(REOPEN_UNAVAILABLE.READ_FAILED);
    const decoded = decodeReopenStartRecord(res.result);
    return {
      available: true, startsAtIso: decoded.startsAtIso, actor: decoded.actor, reason: '',
    };
  };

  return {
    available,

    /**
     * **1 会員ぶん**の開始日時を読む。**読めなかったことを「未設定」に丸めない**。
     * @returns {Promise<{ available: boolean, startsAtIso: string|null, actor: string, reason: string }>}
     */
    read: readMember,

    /**
     * **複数会員ぶん**をまとめて読む（一覧用。会員ごとに 1 回ずつ引かない）。
     *
     * ⚠️ 読めなかったときは `available:false` を返し、**空の Map を「全員未開始」と誤読させない**。
     *
     * @param {{ recordIds: string[], timeoutMs?: number }} input
     * @returns {Promise<{ available: boolean, reason: string,
     *                     rows: Map<string, { startsAtIso: string|null, actor: string }> }>}
     */
    async readMany({ recordIds, timeoutMs = REOPEN_ADMIN_TIMEOUT_MS } = {}) {
      const ids = [...new Set((recordIds || []).map((x) => String(x || '')))]
        .filter((id) => isSafeCustomerRecordId(id));
      if (ids.length === 0) return { available: true, reason: '', rows: new Map() };
      if (!available) {
        return { available: false, reason: REOPEN_UNAVAILABLE.NOT_CONFIGURED, rows: new Map() };
      }
      const rows = new Map();
      for (let i = 0; i < ids.length; i += READ_CHUNK) {
        const chunk = ids.slice(i, i + READ_CHUNK);
        const res = await withTimeout(call(['HMGET', REOPEN_MEMBERS_KEY, ...chunk]), timeoutMs);
        if (res && res.timedOut === true) {
          return { available: false, reason: REOPEN_UNAVAILABLE.TIMEOUT, rows: new Map() };
        }
        if (!res || res.ok !== true) {
          return { available: false, reason: REOPEN_UNAVAILABLE.READ_FAILED, rows: new Map() };
        }
        const arr = Array.isArray(res.result) ? res.result : [];
        chunk.forEach((id, k) => rows.set(id, decodeReopenStartRecord(arr[k])));
      }
      return { available: true, reason: '', rows };
    },

    /**
     * **その会員の**再募集を開始する（**最初の 1 回だけ書ける**）。
     *
     * - `nowMs` は**呼び出し側のサーバー時刻**。client から受け取った値を渡してはいけない。
     * - `HSETNX` に負けた場合は**上書きしない**で、既存値を読み直して返す（冪等）。
     * - Redis が使えない / 応答不明なら**書かない**（fail closed）。
     * - **他会員のフィールドには触れない**（書くのは指定 recordId のフィールド 1 つだけ）。
     *
     * @param {{ recordId: string, nowMs: number, actor?: unknown }} input
     * @returns {Promise<{ ok: boolean, created: boolean, alreadyStarted: boolean,
     *                     startsAtIso: string|null, actor: string, reason: string }>}
     */
    async start({ recordId, nowMs, actor } = {}) {
      const fail = (reason) => ({
        ok: false, created: false, alreadyStarted: false, startsAtIso: null, actor: '', reason,
      });
      if (!isSafeCustomerRecordId(recordId)) return fail(REOPEN_UNAVAILABLE.INVALID_MEMBER);
      if (!available) return fail(REOPEN_UNAVAILABLE.NOT_CONFIGURED);

      const ms = Number(nowMs);
      if (!Number.isFinite(ms)) return fail('invalid_now');
      const iso = normalizeReopenStartsAt(new Date(ms).toISOString());
      if (!iso) return fail('invalid_now');

      const who = sanitizeActor(actor);
      const res = await call([
        'HSETNX', REOPEN_MEMBERS_KEY, recordId,
        encodeReopenStartRecord({ startsAtIso: iso, actor: who }),
      ]);
      // 応答が分からない = 書けたとみなさない（**成功と言わない**）
      if (!res.ok) return fail(REOPEN_UNAVAILABLE.READ_FAILED);

      if (Number(res.result) === 1) {
        return {
          ok: true, created: true, alreadyStarted: false, startsAtIso: iso, actor: who, reason: '',
        };
      }
      if (Number(res.result) !== 0) return fail(REOPEN_UNAVAILABLE.READ_FAILED);

      // 0 = 先に誰か（別タブ・別要求）が開始している。**上書きしない**
      const cur = await readMember({ recordId, timeoutMs: REOPEN_ADMIN_TIMEOUT_MS });
      if (cur.available !== true || !cur.startsAtIso) {
        // 「開始済みなのは確実だが、値を読めない」— 作成したとは絶対に言わない
        return {
          ok: true,
          created: false,
          alreadyStarted: true,
          startsAtIso: null,
          actor: '',
          reason: cur.reason || REOPEN_UNAVAILABLE.READ_FAILED,
        };
      }
      return {
        ok: true,
        created: false,
        alreadyStarted: true,
        startsAtIso: cur.startsAtIso,
        actor: cur.actor,
        reason: '',
      };
    },
  };
}

/**
 * **全ての面から呼ぶ入口（会員 1 人ぶん）**。顧客画面 / 申込 / admin が同じものを使う。
 *
 * 例外を投げない。読めなければ `available:false` を返し、呼び出し側は
 * 従来どおりの「期限未確定」表示のまま進む（＝ fail closed）。
 *
 * @param {{ recordId: unknown, env?: object, redisCmd?: Function|null, timeoutMs?: number }} input
 */
export async function loadReopenStart({
  recordId, env, redisCmd, timeoutMs = REOPEN_READ_TIMEOUT_MS,
} = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env || {});
  const store = createReopenStartStore({ redisCmd: cmd });
  try {
    return await store.read({ recordId, timeoutMs });
  } catch {
    return {
      available: false, startsAtIso: null, actor: '', reason: REOPEN_UNAVAILABLE.READ_FAILED,
    };
  }
}
