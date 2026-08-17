/**
 * rolloutPauseGuard.js — 「止めた」と言うからには**本当に止まっている**ことを保証する
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 運転手（`cron-marketing-rollout`）は異常を見つけると `stage: 'paused'` を書いて
 * 「自動停止した」と返す。ところが保存は **CAS**（`expectedVersion`）で、競合すると
 * **false が返るだけ**だった。呼び出し側はそれを見ずに `autoStopped: true` と報告する。
 * つまり「止めたと報告したのに、実際は止まっていない」が起こり得た。
 *
 * ── ここでやること ────────────────────────────────────────────
 * 1. **毎回読み直してから**停止を書く（古い state で新しい state を上書きしない）
 * 2. CAS で競合したら、読み直して**上限つき**でやり直す（無限には粘らない）
 * 3. すでに停止（`paused` / `killed`）ならそれで完了とする（**二重に書かない**）
 * 4. 確定できなければ **`state_write_conflict` で fail closed**
 *    （呼び出し側は「止めた」と言ってはいけない）
 *
 * ⚠️ ここは展開状態（Redis）しか触らない。**Customers・配信台帳・送信には一切触れない。**
 * ⚠️ 停止の中身（何を消して何を残すか）は `rolloutControl.js` の `planRolloutPause` が単一源。
 */

import { planRolloutPause } from './rolloutControl.js';
import { normalizeRolloutState, ROLLOUT_STAGE } from './rolloutPlan.js';

/** やり直しの上限（**無限に粘らない**。粘るより止まらないことを報告する方が安全） */
export const PAUSE_MAX_ATTEMPTS = 3;

/** 停止を確定できなかったときの理由（固定コード） */
export const PAUSE_CONFLICT = 'state_write_conflict';

/**
 * 停止を**確定するまで**やり直す（上限つき）。
 *
 * @param {object} input
 * @param {{load: Function, save: Function}} input.store `rolloutStore` と同じ形
 * @param {string} input.campaignId
 * @param {number} input.nowMs
 * @param {string} [input.note] 停止理由（**PII を入れない**）
 * @param {number} [input.maxAttempts]
 * @returns {Promise<{ok: boolean, code?: string, attempts: number,
 *                    alreadyPaused?: boolean, version?: number|null}>}
 */
export async function pauseWithRetry({
  store, campaignId, nowMs, note = '', maxAttempts = PAUSE_MAX_ATTEMPTS,
} = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    return { ok: false, code: PAUSE_CONFLICT, attempts: 0 };
  }
  let attempts = 0;
  let lastCode = PAUSE_CONFLICT;
  while (attempts < Math.max(1, maxAttempts)) {
    attempts += 1;
    let loaded;
    try {
      // eslint-disable-next-line no-await-in-loop -- CAS はやり直すたびに読み直す
      loaded = await store.load(campaignId);
    } catch (e) {
      lastCode = (e && e.code) || 'state_unreadable';
      continue;
    }
    const cur = normalizeRolloutState(loaded && loaded.state);

    // すでに止まっているなら**書かない**（他の経路が先に止めた場合も「止まっている」）
    if (cur.killed === true || cur.stage === ROLLOUT_STAGE.PAUSED) {
      return { ok: true, alreadyPaused: true, attempts, version: cur.version };
    }

    // ⚠️ **読み直した state の上に**停止を重ねる（新しい変更を古い値で潰さない）
    const planned = planRolloutPause({ current: cur, nowMs });
    const next = { ...planned.state, note: String(note || planned.state.note || '') };
    try {
      // eslint-disable-next-line no-await-in-loop
      await store.save({
        campaignId,
        state: next,
        expectedVersion: loaded && loaded.exists ? cur.version : null,
      });
      return { ok: true, alreadyPaused: false, attempts, version: cur.version };
    } catch (e) {
      lastCode = (e && e.code) || PAUSE_CONFLICT;
      // 競合以外（接続不能など）でも、読み直してもう一度だけ試す価値はある
    }
  }
  return { ok: false, code: lastCode || PAUSE_CONFLICT, attempts };
}

/** 画面・ログ用（**件数と理由だけ**） */
export function describePauseResult(r) {
  const v = r || {};
  return {
    paused: v.ok === true,
    alreadyPaused: v.alreadyPaused === true,
    attempts: Number(v.attempts) || 0,
    code: v.ok === true ? null : (v.code || PAUSE_CONFLICT),
  };
}

export default pauseWithRetry;
