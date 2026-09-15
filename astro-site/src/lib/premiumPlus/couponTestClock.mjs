/**
 * couponTestClock.mjs — クーポン系テストの**基準時刻をひとつに固定する**
 *
 * ⚠️ これはテスト専用のヘルパー。production からは読まない
 *    （`*.test.mjs` ではないので `node --test` のグロブにも入らない）。
 *
 * ## なぜ要るか（2026-09-15 に本番 CI が落ちた）
 *
 * クーポン予約のテストは、fixture に**固定の日時**（`StartsAt: '2026-09-01…'`）を書く一方で、
 * 判定側は実時計 `Date.now()` を使っていた。両者が混ざっていたため、
 *
 *     RESERVATION_STALE_DAYS = 14
 *     2026-09-01 + 14 日 = 2026-09-15T00:00:00Z
 *
 * を**カレンダーが跨いだ瞬間**に `issued` が `waiting` → `needs_redeem` へ変わり、
 * コードを 1 行も触っていないのに main の CI が赤になった
 * （2026-09-14T23:52Z の run は success / 2026-09-15T00:00:02Z の run は failure）。
 *
 * ## 直し方の原則（production も 14 日仕様も変えない）
 *
 *   - `RESERVATION_STALE_DAYS` は**緩めない**（14 日のまま）
 *   - fixture の日付を「今日」に追従させない（それは問題を隠すだけで、
 *     境界をひとつも検査できなくなる）
 *   - **テスト側の基準時刻を固定する**。`resolveRedeemState` のように `nowMs` を
 *     受け取れる関数には明示的に渡し、受け取れない関数
 *     （`describeCouponLifecycle` / `describeCouponAdminActions` /
 *     `planRedeemAfterConfirm` は内部で `Date.now()` に落ちる）には
 *     `mock.timers` で時計そのものを固定して渡す
 *
 * これでカレンダーが何日進んでも結果が変わらない。
 */
import { mock } from 'node:test';

/**
 * クーポン系テストの「いま」。
 *
 * ⚠️ 値の選び方: 既存 fixture の `StartsAt = 2026-09-01` から **9 日後**。
 *    `RESERVATION_STALE_DAYS = 14` の**手前**なので `issued` は「確認待ち」のまま。
 *    `ExpiresAt = 2026-09-15 / 2026-09-30` のどちらより手前でもある。
 */
export const COUPON_TEST_NOW_ISO = '2026-09-10T00:00:00.000Z';
export const COUPON_TEST_NOW = Date.parse(COUPON_TEST_NOW_ISO);

/**
 * 基準時刻を固定する。**各テストファイルの先頭で 1 回だけ呼ぶ。**
 *
 * `Date` だけを差し替える（`setTimeout` などは触らない）。
 * `new Date(iso)` のパースは通常どおり動く。
 *
 * @param {number} nowMs 固定したい時刻。既定は {@link COUPON_TEST_NOW}
 */
export function useFixedCouponClock(nowMs = COUPON_TEST_NOW) {
  mock.timers.enable({ apis: ['Date'], now: nowMs });
  return nowMs;
}

export default useFixedCouponClock;
