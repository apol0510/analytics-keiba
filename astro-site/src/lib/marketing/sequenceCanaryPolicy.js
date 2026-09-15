/**
 * sequenceCanaryPolicy.js — prospect canary の**判定の単一源**
 *
 * ## なぜ独立したファイルなのか（2026-09-15）
 *
 * canary は 2 か所を通る。
 *
 *   ① `admin-marketing` の `sequenceCanaryRun` … 人が叩く入口。**受け付けるかどうか**を決める
 *   ② `sequence-canary-background`             … 実際に走る側。**もう一度ぜんぶ確かめる**
 *
 * ②は公開 URL なので、①を通らずに直接叩かれ得る。だから②は①を信用してはいけない。
 * 同じ判定を 2 か所へ書き写すとズレるので、**判定はここ 1 か所**に置く。
 *
 * ⚠️ ここには「誰に送るか」は一切入らない。対象は毎回 `runSequenceTick` が読み直す。
 */

/** 誤操作で走らないための合言葉 */
export const CANARY_CONFIRM = 'RUN PROSPECT CANARY';

/**
 * canary を回してよい campaign の**許可リスト**。
 *
 * ⚠️ **既定値を持たせない。** `campaignId` 未指定は不合格。
 *    ここに無い campaign（とくに DRM の `free-signup-onboarding`）は絶対に走らない。
 */
export const CANARY_CAMPAIGNS = Object.freeze(['campaign-discount-free']);

/** 1 回あたりの上限（これ以上は受け付けない） */
export const CANARY_MAX_PER_TICK = 50;

/** 断る理由（画面にもログにも同じ語を出す） */
export const CANARY_REFUSE = Object.freeze({
  CAMPAIGN_NOT_ALLOWED: 'campaign_not_allowed',
  FILTER_NOT_PROSPECT: 'filter_not_prospect',
  BAD_MAX_PER_TICK: 'bad_max_per_tick',
  BAD_EXPECTED_COUNT: 'bad_expected_count',
  NOT_CONFIRMED: 'not_confirmed',
  NOT_APPLIED: 'not_applied',
});

const str = (v) => String(v ?? '').trim();

/**
 * canary の要求を検査する。**合格したものだけ**が走ってよい。
 *
 * @param {{campaignId, sourceFilter, maxPerTick, expectedCount, confirm, apply}} req
 * @returns {{ok:true, campaignId, sourceFilter, maxPerTick, expectedCount}
 *          |{ok:false, refuse:string, detail?:string}}
 */
export function checkCanaryRequest(req = {}) {
  const campaignId = str(req.campaignId);
  if (!CANARY_CAMPAIGNS.includes(campaignId)) {
    return { ok: false, refuse: CANARY_REFUSE.CAMPAIGN_NOT_ALLOWED };
  }
  // 出所は prospect のみ（canary の目的が prospect 経路の実証なので固定する）
  if (str(req.sourceFilter).toLowerCase() !== 'prospect') {
    return { ok: false, refuse: CANARY_REFUSE.FILTER_NOT_PROSPECT };
  }
  const maxPerTick = Number(req.maxPerTick);
  if (!Number.isInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > CANARY_MAX_PER_TICK) {
    return { ok: false, refuse: CANARY_REFUSE.BAD_MAX_PER_TICK };
  }
  // 下見で数えた人数と一致しなければ 1 件も積まない（`runSequenceTick` 側で突き合わせる）
  const expectedCount = Number(req.expectedCount);
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > maxPerTick) {
    return { ok: false, refuse: CANARY_REFUSE.BAD_EXPECTED_COUNT };
  }
  if (str(req.confirm) !== CANARY_CONFIRM) {
    return { ok: false, refuse: CANARY_REFUSE.NOT_CONFIRMED };
  }
  if (req.apply !== true) {
    return { ok: false, refuse: CANARY_REFUSE.NOT_APPLIED };
  }
  return { ok: true, campaignId, sourceFilter: 'prospect', maxPerTick, expectedCount };
}

/** Background へ渡してよい鍵（**アドレスも recordId も入らない**） */
export const CANARY_PAYLOAD_KEYS = Object.freeze([
  'campaignId', 'sourceFilter', 'maxPerTick', 'expectedCount', 'confirm', 'apply', 'runId',
]);

/** Background 用の payload を組む。宣言した鍵以外は落とす */
export function buildCanaryPayload(checked, runId) {
  const payload = {
    campaignId: checked.campaignId,
    sourceFilter: checked.sourceFilter,
    maxPerTick: checked.maxPerTick,
    expectedCount: checked.expectedCount,
    confirm: CANARY_CONFIRM,
    apply: true,
    runId: str(runId),
  };
  for (const k of Object.keys(payload)) {
    if (!CANARY_PAYLOAD_KEYS.includes(k)) delete payload[k];
  }
  return payload;
}

export default checkCanaryRequest;
