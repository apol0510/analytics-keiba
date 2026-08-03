/**
 * comebackApplyAction.js — 「確認を開く操作」と「本番付与の確定操作」の言葉と可否（純粋・I/O なし）
 *
 * ── 解決する問題（2026-08-03 監査）────────────────────────────────
 * カムバック特典タブには、本番付与に見えるボタンが 3 つ並んでいた。
 *
 *   1. Step 5 本体      「⚠️ 🎁 無料特典を付与する」（赤）
 *   2. 追従バー          「🚀 無料特典を付与」（赤）
 *   3. 確認モーダル      「実行する（付与 28 名 / オファー 0 名）」
 *
 * どれが本番データを書き換えるのか画面から判別できず、しかも実態は
 *   1 は `planFingerprint` を送らないため Function 側で 400
 *   2 はクリックハンドラが無く何も起きない
 *   3 はマーケティングタブ用のガードを参照していて ReferenceError
 * と、**3 つとも付与に到達しない**状態だった（本番で grant 未実施のため露見せず）。
 *
 * ── 決めたこと ────────────────────────────────────────────────
 *   「確認画面を開く」= Step 5 本体と追従バー。**完全に同じ文言・同じ役割・書き込みなし**
 *   「本番付与の確定」= 確認モーダルの最終ボタン **1 つだけ**
 *
 * 最終ボタンの文言は「実行する」のような抽象語を使わず、
 * **何名に何を付与するのか**をボタン自身に書く（押す直前に対象が読める）。
 *
 * ⚠️ このモジュールは判定と文言だけを持つ。API も DOM も触らない。
 *    付与の可否そのもの（対象区分・dry-run 整合性）は `comebackConsoleFlow.js` の
 *    `canApply` が単一源で、ここはその後段（gate と件数）だけを見る。
 */

/** 確認画面を開く操作の文言。**Step 5 本体と追従バーで必ず同じものを使う** */
export const OPEN_CONFIRM_LABEL = '付与内容の最終確認へ';

/** 確認画面を開くボタンのアイコン（本体と追従バーで共通） */
export const OPEN_CONFIRM_ICON = '📋';

/** Step 5 本体に出す補足。「まだ変更されない」ことを色ではなく文章で伝える */
export const OPEN_CONFIRM_HINT =
  'まだ付与されません。対象人数と変更内容を確認画面で確認します。';

/** 追従バーが別操作ではないことの明示（title / aria-label に使う） */
export const STICKY_SAME_ACTION_NOTE =
  '画面下部の補助バーです。Step 5 と同じ「付与内容の最終確認へ」を開きます（別の操作ではありません）。';

/** 確認モーダルの最終ボタン周辺に必ず出す注意（本番 write の直前） */
export const APPLY_WRITE_NOTICE = 'このボタンだけが本番データを変更します。';
export const APPLY_MAIL_NOTICE =
  'この操作ではメールを送信しません。付与成功後に案内メール作成へ進めます。';
export const APPLY_HANDOFF_NOTICE =
  '実行後は、付与に成功した顧客だけを案内メール作成工程へ引き継げます。';

/** 実行中・完了後の文言（押せない理由を色ではなく言葉で示す） */
export const APPLY_BUSY_LABEL = '付与中…';
export const APPLY_DONE_LABEL = '付与済み（この確認からは再実行できません）';

/** 押せない理由（固定コード） */
export const APPLY_BLOCK = Object.freeze({
  BUSY: 'busy',
  DONE: 'done',
  WRITE_DISABLED: 'write_disabled',
  NO_TARGET: 'no_target',
});

export const APPLY_BLOCK_LABEL = Object.freeze({
  [APPLY_BLOCK.BUSY]: '付与を実行中です。完了までお待ちください。',
  [APPLY_BLOCK.DONE]: 'この確認内容では実行済みです。もう一度送るには付与内容を確認し直してください。',
  [APPLY_BLOCK.WRITE_DISABLED]: '実行は無効です（COMEBACK_GRANT_FIELDS_READY / COMEBACK_OFFER_TABLE_READY / COMEBACK_GRANT_ENABLED 未設定）。',
  [APPLY_BLOCK.NO_TARGET]: '付与・発行の対象が 0 名です。',
});

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 特典の平文（「Light 30日無料 と Premium 永久無料」）。
 * 選択肢のラベルをそのまま並べるだけで、内容の判定はしない
 * （何を付与するかの正本は `promotionOfferCatalog.js`）。
 */
export function describeBenefits({ lightLabel, premiumLabel } = {}) {
  const parts = [str(lightLabel), str(premiumLabel)].filter(Boolean);
  return parts.join(' と ');
}

/**
 * 本番付与ボタンの文言。**何名に何をするのかをボタン自身に書く**。
 *
 * 「実行する」のような抽象語は返さない（何が起きるか読めないボタンを作らない）。
 *
 * @param {{ willGrant?: number, willOffer?: number,
 *           lightLabel?: string, premiumLabel?: string }} input
 */
export function buildApplyActionLabel({ willGrant, willOffer, lightLabel, premiumLabel } = {}) {
  const grant = num(willGrant);
  const offer = num(willOffer);
  const benefits = describeBenefits({ lightLabel, premiumLabel });

  if (grant === 0 && offer === 0) return '付与できる対象がいません';

  const grantPart = grant > 0
    ? `${grant} 名に${benefits ? ` ${benefits} を` : '無料特典を'}付与する`
    : '';
  const offerPart = offer > 0 ? `${offer} 名に割引オファーを発行する` : '';

  if (grantPart && offerPart) {
    // 「〜を付与する」を「〜を付与し、」に畳んで 1 文にする
    return `${grantPart.replace(/する$/, 'し')}、${offerPart}`;
  }
  return grantPart || offerPart;
}

/**
 * 最終ボタンの aria-label。読み上げでも「何名に何をするのか」が分かるようにする。
 */
export function buildApplyActionAriaLabel(input = {}) {
  const label = buildApplyActionLabel(input);
  if (label === '付与できる対象がいません') return label;
  return `${label}。${APPLY_WRITE_NOTICE}`;
}

/**
 * 本番付与を実行できるか。**gate と件数だけ**を見る（対象の妥当性は canApply が担当）。
 *
 * @param {{ writeEnabled?: boolean, willGrant?: number, willOffer?: number,
 *           busy?: boolean, applied?: boolean }} state
 */
export function canRunApply(state = {}) {
  const no = (reason) => ({ allowed: false, reason, label: APPLY_BLOCK_LABEL[reason] || '' });
  if (state.busy === true) return no(APPLY_BLOCK.BUSY);
  if (state.applied === true) return no(APPLY_BLOCK.DONE);
  if (state.writeEnabled !== true) return no(APPLY_BLOCK.WRITE_DISABLED);
  if (num(state.willGrant) + num(state.willOffer) === 0) return no(APPLY_BLOCK.NO_TARGET);
  return { allowed: true, reason: null, label: '' };
}

/**
 * 確認モーダルに必ず並べる項目（1 画面で対象と影響が読める）。
 * 画面はこの配列の順で描画する（項目の抜けを構造的に防ぐ）。
 */
export function buildApplySummaryRows({ plan, audience, benefits, unchangedNotice } = {}) {
  const p = plan || {};
  const a = audience || {};
  const segments = Object.entries(a.bySegment || {})
    .map(([k, n]) => `${str((a.segmentLabels || {})[k]) || k} ${num(n)} 名`)
    .join(' / ');
  return [
    { key: 'selected', label: '選択人数', value: `${num(p.selected)} 名` },
    { key: 'willGrant', label: '付与予定人数', value: `${num(p.willGrant)} 名`, tone: num(p.willGrant) > 0 ? 'ok' : 'ng' },
    { key: 'skipped', label: '除外人数', value: `${num(p.skipped)} 名` },
    {
      key: 'activeMembers',
      label: '現在有効会員の混入',
      value: `${num(a.activeMembers)} 名`,
      tone: num(a.activeMembers) > 0 ? 'ng' : '',
    },
    { key: 'segments', label: '対象区分', value: segments || '—' },
    { key: 'benefits', label: '付与する特典', value: str(benefits) || '未設定' },
    { key: 'willOffer', label: '割引オファー', value: `${num(p.willOffer)} 件` },
    { key: 'unchanged', label: '変更しないもの', value: str(unchangedNotice) },
    { key: 'mail', label: 'メール送信', value: APPLY_MAIL_NOTICE },
  ];
}
