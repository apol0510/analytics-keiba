/**
 * premiumPlusReopenStartStore.js — 再募集開始日時の**保存先**（I/O。判定は持たない）
 *
 * ## なぜ Upstash Redis か（新しい基盤を足していない）
 *
 * 保存したいのは **サイト全体で 1 個の値**（`reopenStartsAt`）で、必要な性質は
 * 「**最初の 1 回だけ書ける**（first-write-wins）」「並行要求でも 1 つに確定する」の 2 点。
 *
 * | 候補 | 判定 |
 * |---|---|
 * | **Upstash Redis**（採用）| `SET key value NX` が**原子的な first-write-wins そのもの**。<br>本番で稼働中（`couponOperationLock.js` / `premiumPlusFunnelStore.js` / rollout が同じ接続を使用）。<br>**新しい env も schema も外部サービスも増えない**（`UPSTASH_REDIS_REST_URL` / `_TOKEN` は既存）|
 * | Airtable に列・テーブル追加 | **本番 schema 変更**（高リスク境界）。しかも Customers は会員 1 行 1 会員で、<br>「サイト全体で 1 個の設定」を置く場所ではない。unique 制約も無く二重作成を防げない |
 * | Netlify Blobs | 既存の実績はあるが **eventual consistency** が本番で問題になった経緯があり<br>（`docs/progress.md` 2026-07-16）、「一度きりの確定値」には向かない |
 * | 環境変数に直書き | 変更に **deploy が必要**。ボタンで確定できない（今回の要件と矛盾する）|
 *
 * ## 上書き経路を**コードとして持たない**
 *
 * このモジュールは `read()` と `start()` しか公開しない。
 * **`set()` / `update()` / `clear()` を作らない**のは、
 * 「一度開始したら上書きしない」を運用ルールではなく**構造**で保証するため。
 *
 * ⚠️ rollback（誤って開始した場合）は **Upstash コンソールで該当キーを削除する**しかない。
 *    手順は `astro-site/docs/PREMIUM_PLUS_STAGED_RELEASE.md` に記載。
 *    これは意図的な設計であり、admin に「取消」ボタンを足さないこと。
 *
 * ## 読めないときは「未開始」と言わない
 *
 * 読み取り失敗は `available:false` として返し、判定側（`resolveReopenStatus`）が
 * `UNKNOWN` にする。**0 件・未設定へ丸めない。**
 */

import { makeRedisCmd } from './premiumPlusFunnelServer.js';
import { REOPEN_UNAVAILABLE, normalizeReopenStartsAt } from './premiumPlusReopenStart.js';

/** Premium Plus の鍵空間（funnel の `ak:pp:funnel:*` とは別。他用途の鍵に触れない） */
export const REOPEN_NAMESPACE = 'ak:pp:reopen:v1';

/** 開始日時 1 個だけを置く鍵（**TTL を付けない**。消えたら「開始していない」ことになる） */
export const REOPEN_START_KEY = `${REOPEN_NAMESPACE}:start`;

/** 顧客画面から読むときの制限時間（ページ描画を待たせない） */
export const REOPEN_READ_TIMEOUT_MS = 700;

/** 管理画面から読むときの制限時間（正確さ優先で少し長く） */
export const REOPEN_ADMIN_TIMEOUT_MS = 2500;

/** 操作者名の最大長（Airtable の `PremiumPlusEligibilityUpdatedBy` と同じ扱い） */
export const ACTOR_MAX = 32;

/**
 * 操作者名の正規化。
 * ⚠️ **メールアドレスを鍵・値に入れない**（`@` を含む値は捨てる）。監査に必要なのは「誰が押したか」の短い名前だけ。
 */
export function sanitizeActor(raw) {
  // 制御文字だけを落とす（表示・ログを壊さないため。**エスケープ表記で書く**）
  const s = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!s || s.includes('@')) return 'admin';
  return s.slice(0, ACTOR_MAX);
}

/**
 * 保存する形（JSON 1 行）。
 * ⚠️ 値の正本は `startsAt`。`actor` / `recordedAt` は**監査のための付随情報**で、判定には使わない。
 */
export function encodeReopenStartRecord({ startsAtIso, actor }) {
  return JSON.stringify({
    startsAt: String(startsAtIso),
    actor: sanitizeActor(actor),
    recordedAt: String(startsAtIso),
  });
}

/**
 * 保存値の読み取り。**素の ISO 文字列も受け付ける**（将来手で入れられた場合の後方互換）。
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
      // 壊れた JSON は**採用しない**（null ではなく「読めたが不正」を上位で判別させるため生値を返す）
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

  // ⚠️ `this` を使わない（`const { start } = store` と分解されても壊れないため）
  const readState = async ({ timeoutMs = REOPEN_READ_TIMEOUT_MS } = {}) => {
    if (!available) {
      return {
        available: false, startsAtIso: null, actor: '', reason: REOPEN_UNAVAILABLE.NOT_CONFIGURED,
      };
    }
    const res = await withTimeout(call(['GET', REOPEN_START_KEY]), timeoutMs);
    if (res && res.timedOut === true) {
      return { available: false, startsAtIso: null, actor: '', reason: REOPEN_UNAVAILABLE.TIMEOUT };
    }
    if (!res || res.ok !== true) {
      return { available: false, startsAtIso: null, actor: '', reason: REOPEN_UNAVAILABLE.READ_FAILED };
    }
    const decoded = decodeReopenStartRecord(res.result);
    return {
      available: true, startsAtIso: decoded.startsAtIso, actor: decoded.actor, reason: '',
    };
  };

  return {
    available,

    /**
     * 現在の開始日時を読む。**読めなかったことを「未設定」に丸めない**。
     * @returns {Promise<{ available: boolean, startsAtIso: string|null, actor: string, reason: string }>}
     */
    read: readState,

    /**
     * 再募集を開始する（**最初の 1 回だけ書ける**）。
     *
     * - `nowMs` は**呼び出し側のサーバー時刻**。client から受け取った値を渡してはいけない。
     * - `SET ... NX` に負けた場合は**上書きしない**で、既存値を読み直して返す（冪等）。
     * - Redis が使えない / 応答不明なら**書かない**（fail closed）。
     *
     * @param {{ nowMs: number, actor?: unknown }} input
     * @returns {Promise<{ ok: boolean, created: boolean, alreadyStarted: boolean,
     *                     startsAtIso: string|null, actor: string, reason: string }>}
     */
    async start({ nowMs, actor } = {}) {
      const fail = (reason) => ({
        ok: false, created: false, alreadyStarted: false, startsAtIso: null, actor: '', reason,
      });
      if (!available) return fail(REOPEN_UNAVAILABLE.NOT_CONFIGURED);

      const ms = Number(nowMs);
      if (!Number.isFinite(ms)) return fail('invalid_now');
      const iso = normalizeReopenStartsAt(new Date(ms).toISOString());
      if (!iso) return fail('invalid_now');

      const who = sanitizeActor(actor);
      const res = await call([
        'SET', REOPEN_START_KEY, encodeReopenStartRecord({ startsAtIso: iso, actor: who }), 'NX',
      ]);
      // 応答が分からない = 書けたとみなさない（**成功と言わない**）
      if (!res.ok) return fail(REOPEN_UNAVAILABLE.READ_FAILED);

      if (res.result === 'OK') {
        return {
          ok: true, created: true, alreadyStarted: false, startsAtIso: iso, actor: who, reason: '',
        };
      }

      // NX に負けた = 先に誰か（別タブ・別要求）が開始している。**上書きしない**
      const cur = await readState({ timeoutMs: REOPEN_ADMIN_TIMEOUT_MS });
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
 * **全ての面から呼ぶ入口**（顧客画面 / 取得 API / 申込 / admin）。
 *
 * 例外を投げない。読めなければ `available:false` を返し、呼び出し側は
 * 従来どおりの「期限未確定」表示のまま進む（＝ fail closed）。
 *
 * @param {{ env?: object, redisCmd?: Function|null, timeoutMs?: number }} input
 */
export async function loadReopenStart({ env, redisCmd, timeoutMs = REOPEN_READ_TIMEOUT_MS } = {}) {
  const cmd = redisCmd !== undefined ? redisCmd : makeRedisCmd(env || {});
  const store = createReopenStartStore({ redisCmd: cmd });
  try {
    return await store.read({ timeoutMs });
  } catch {
    return {
      available: false, startsAtIso: null, actor: '', reason: REOPEN_UNAVAILABLE.READ_FAILED,
    };
  }
}
