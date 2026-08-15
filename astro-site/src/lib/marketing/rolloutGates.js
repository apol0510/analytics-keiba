/**
 * rolloutGates.js — **どの工程が、どの env で止まっているか**の単一源（純粋）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 展開は 3 工程（付与 → キュー登録 → 送信）で、**必要な env が工程ごとに違う**。
 * ここを 1 か所に書かないと、こうなる:
 *   - 説明と実装がズレる（「許可は 4 つ」と書いたが、queue には別の env が要る）
 *   - 運用者は「動かない」としか分からず、どの env を開ければよいか分からない
 *   - 手っ取り早く直そうとして、既存ゲートを**迂回する**コードが生える
 *
 * ⚠️ **既存ゲートを迂回しない。** ここは判定を**写す**だけで、緩める場所ではない。
 *    実際の拒否は従来どおり各 Function（`admin-marketing` / dispatcher / 付与）が行う。
 *    この表はその手前で「進めても弾かれる」と分かるようにするためのもの。
 *
 * ── 工程と必要な env ──────────────────────────────────────────
 *   共通   `MARKETING_ROLLOUT_ENABLED`            … 自動運転そのものの許可
 *   付与   `COMEBACK_GRANT_FIELDS_READY`          … 付与列の実在
 *          `COMEBACK_GRANT_ENABLED`               … 付与の実行許可
 *          `LIGHT_TRIAL_AUTOGRANT_ENABLED`        … 自動付与の許可
 *   queue  `MARKETING_CAMPAIGN_ENABLED`           … キュー登録（live enqueue）の許可
 *   送信   `MARKETING_CAMPAIGN_DISPATCH_ENABLED`  … 実送信の許可
 *
 * どれも**既定は閉**。閉じている工程は**実行しない**（副作用ゼロ）。
 */

/** 工程 */
export const ROLLOUT_STAGE_GATE = Object.freeze({
  ROLLOUT: 'rollout',
  GRANT: 'grant',
  QUEUE: 'queue',
  DISPATCH: 'dispatch',
});

/** 工程 → 必要な env（**この表が唯一の正**） */
export const STAGE_ENV = Object.freeze({
  [ROLLOUT_STAGE_GATE.ROLLOUT]: ['MARKETING_ROLLOUT_ENABLED'],
  [ROLLOUT_STAGE_GATE.GRANT]: [
    'COMEBACK_GRANT_FIELDS_READY',
    'COMEBACK_GRANT_ENABLED',
    'LIGHT_TRIAL_AUTOGRANT_ENABLED',
  ],
  [ROLLOUT_STAGE_GATE.QUEUE]: ['MARKETING_CAMPAIGN_ENABLED'],
  [ROLLOUT_STAGE_GATE.DISPATCH]: ['MARKETING_CAMPAIGN_DISPATCH_ENABLED'],
});

/** 画面に出す工程名 */
export const STAGE_LABEL = Object.freeze({
  [ROLLOUT_STAGE_GATE.ROLLOUT]: '自動運転',
  [ROLLOUT_STAGE_GATE.GRANT]: '無料付与',
  [ROLLOUT_STAGE_GATE.QUEUE]: 'キュー登録',
  [ROLLOUT_STAGE_GATE.DISPATCH]: '実送信',
});

/** その env が閉じていると**何が止まるか**（運用者向けの一文） */
export const STAGE_CONSEQUENCE = Object.freeze({
  [ROLLOUT_STAGE_GATE.ROLLOUT]: '自動運転そのものが動きません（付与もキュー登録も送信も起きません）',
  [ROLLOUT_STAGE_GATE.GRANT]: '新しい無料付与が進みません（既にキューにあるぶんの送信は進みます）',
  [ROLLOUT_STAGE_GATE.QUEUE]: 'キュー登録が進みません（付与はできますが、案内メールが積まれません）',
  [ROLLOUT_STAGE_GATE.DISPATCH]: 'メールが 1 通も出ません（キューには積まれ、送信だけが止まります）',
});

/**
 * `COMEBACK_GRANT_FIELDS_READY` だけは `'1'` を使う（既存の付与ゲートに合わせる）。
 * ここを `'true'` に揃えると、**既存の付与が黙って止まる**。
 */
const TRUTHY = Object.freeze({
  COMEBACK_GRANT_FIELDS_READY: '1',
});

const isOpen = (env, name) => String((env || {})[name] ?? '').trim() === (TRUTHY[name] || 'true');

/**
 * 工程ごとの開閉。**閉じている env の名前をそのまま返す**（運用者が開けられるように）。
 *
 * @param {object} env
 * @returns {{stages: object, allOpen: boolean, blocked: Array<{stage: string, label: string,
 *           missing: string[], consequence: string}>}}
 */
export function readStageGates(env) {
  const stages = {};
  const blocked = [];
  for (const stage of Object.values(ROLLOUT_STAGE_GATE)) {
    const required = STAGE_ENV[stage] || [];
    const missing = required.filter((name) => !isOpen(env, name));
    // 共通ゲート（自動運転）が閉じていれば、後続の工程も**実際には動かない**
    const blockedByRoot = stage !== ROLLOUT_STAGE_GATE.ROLLOUT
      && (STAGE_ENV[ROLLOUT_STAGE_GATE.ROLLOUT] || []).some((n) => !isOpen(env, n));
    const open = missing.length === 0;
    stages[stage] = {
      stage,
      label: STAGE_LABEL[stage],
      open,
      effective: open && !blockedByRoot,
      required,
      missing,
      consequence: STAGE_CONSEQUENCE[stage],
    };
    if (!open) {
      blocked.push({
        stage, label: STAGE_LABEL[stage], missing, consequence: STAGE_CONSEQUENCE[stage],
      });
    }
  }
  return {
    stages,
    allOpen: blocked.length === 0,
    blocked,
  };
}

/** その工程を実行してよいか（**判定を緩めない**。閉じていれば false） */
export function canRunStage(env, stage) {
  const gates = readStageGates(env);
  const s = gates.stages[stage];
  return !!(s && s.effective);
}

/**
 * 「いま何が止まっているか」を 1 行で。画面とログの両方で使う。
 * 何も閉じていなければ `null`。
 */
export function describeBlocked(env) {
  const { blocked } = readStageGates(env);
  if (blocked.length === 0) return null;
  return blocked
    .map((b) => `${b.label}: ${b.missing.join(' / ')} が閉じているため、${b.consequence}`)
    .join('。');
}

export default readStageGates;
