/**
 * drmEntryDispatch.js — **入口の重い処理を Background へ渡すだけ**（判定は 1 つも持たない）
 *
 * ── なぜ Background へ渡すのか（2026-09-14 本番実測）──────────────
 * 入口の live 実行を同期 Function で走らせたら **HTTP 504（gateway timeout）**。
 * 書き込みは 1 件も起きなかった（queue 0 / 送信 0）が、完走できなかった。
 * 入口の live は
 *   候補（Customers・14 日窓）→ 配信行 → provider suppression → blacklist →
 *   台帳走査 → 顧客取得 → 名指しの `DeliveryKey` 突き合わせ → キュー登録 → 読み戻し確認
 * を通るので、**同期 Function の実行時間に収まらない**。
 * さらに scheduled Function は 30 秒で切られるため、日次経路も同じ問題を持つ。
 *
 * そこで **手動 live も日次自動も、同じ Background Function へ委譲**する。
 * Background は最大 15 分動ける。呼び出し側は **202 を受け取って終わり**で、
 * 結果は**既存の台帳・ログ**（`CampaignDeliveries` / `ScheduledEmails` / 関数ログ）で確認する。
 *
 * ⚠️ **判定をここに置かない。** ゲート・許可リスト・`expectedCount`・
 *    購入/停止/既送信/`DeliveryKey` の確認は**すべて Background 側で**
 *    既存の単一源（`runDrmEntry` → `runSequenceTick`）が行う。
 *    ここは「起動した / できなかった」だけを返す。
 * ⚠️ **payload に人を入れない。** アドレスも recordId も渡さない
 *    （渡すと「誰に送るか」の決定が呼び出し側へ漏れ、送信直前の再検証が骨抜きになる）。
 */

/** Background へ渡してよい項目（**これ以外は渡さない**） */
export const DRM_ENTRY_PAYLOAD_KEYS = Object.freeze([
  'campaignId', 'expectedCount', 'manual', 'runId',
]);

/** Background Function の名前（`-background` 接尾辞が非同期実行の条件） */
export const DRM_ENTRY_BACKGROUND = 'drm-entry-background';

export const DISPATCH_FAIL = Object.freeze({
  NO_SECRET: 'admin_secret_missing',
  TRIGGER_FAILED: 'background_trigger_failed',
});

const str = (v) => String(v ?? '').trim();

/** 実行を後から追うための識別子（**PII を含めない**） */
export function buildRunId({ nowMs, suffix }) {
  const iso = new Date(Number(nowMs) || 0).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tail = str(suffix) || Math.random().toString(36).slice(2, 8);
  return `drm-${iso}-${tail}`;
}

/**
 * Background へ渡す payload を作る。**許可した項目だけ**を通す。
 *
 * ⚠️ アドレス・recordId・件名・本文は**入れない**。
 */
export function buildDrmEntryPayload({ campaignId, expectedCount, manual, runId }) {
  const payload = {
    campaignId: str(campaignId),
    expectedCount: expectedCount === undefined || expectedCount === null
      ? null : Number(expectedCount),
    manual: manual === true,
    runId: str(runId),
  };
  // 宣言した鍵だけであることを構造的に保証する
  for (const k of Object.keys(payload)) {
    if (!DRM_ENTRY_PAYLOAD_KEYS.includes(k)) delete payload[k];
  }
  return payload;
}

/**
 * Background を起動する（**202 を受け取って終わり**）。
 *
 * @param {{env: object, payload: object, fetchImpl?: Function}} input
 * @returns {Promise<{ok:boolean, status:number|null, reason:string|null, runId:string}>}
 */
export async function triggerDrmEntryBackground({ env, payload, fetchImpl }) {
  const secret = str(env.MARKETING_ADMIN_SECRET) || str(env.PREMIUM_PLUS_ADMIN_SECRET);
  if (!secret) {
    return { ok: false, status: null, reason: DISPATCH_FAIL.NO_SECRET, runId: payload.runId };
  }
  const base = str(env.URL) || 'https://analytics.keiba.link';
  const url = `${base}/.netlify/functions/${DRM_ENTRY_BACKGROUND}`;
  const doFetch = fetchImpl || fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify(payload),
    });
    const status = res ? res.status : null;
    // ⚠️ Background は **202 即返し**。body は返らないので読まない
    const ok = Boolean(res && (res.ok || status === 202));
    return {
      ok, status,
      reason: ok ? null : DISPATCH_FAIL.TRIGGER_FAILED,
      runId: payload.runId,
    };
  } catch {
    return { ok: false, status: null, reason: DISPATCH_FAIL.TRIGGER_FAILED, runId: payload.runId };
  }
}

export default triggerDrmEntryBackground;
