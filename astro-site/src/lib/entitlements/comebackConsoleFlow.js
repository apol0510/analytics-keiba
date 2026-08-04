/**
 * comebackConsoleFlow.js — カムバック特典タブの**操作順**（純粋・DOM 非依存）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 画面にはフィルター・顧客選択・特典設定が同時に並んでおり、
 * **どこから触ればよいか分からない**。しかも契約状態の選択肢に「有効」があるため、
 * 現在お金を払って使っている会員が**カムバックの対象に見えてしまう**。
 *
 * 「誰に配るか」を間違えた付与は、あとから取り消すと不信を招く。
 * だから順序（探す → 選ぶ → 決める → 確認する → 付与する）を仕組みで固定し、
 * **現有効会員は既定で対象にしない**ことを判定として持つ。
 */

import { SEGMENT, SEGMENT_LABEL } from './comebackAudience.js';

/** 画面の段階 */
export const CB_STEP = Object.freeze({
  FIND: 1,      // 対象者を探す
  SELECT: 2,    // 対象者を選ぶ
  OFFER: 3,     // 付与する特典を決める
  REVIEW: 4,    // 変更内容を確認する
  APPLY: 5,     // 特典を付与する
});

export const CB_STEP_LABEL = Object.freeze({
  [CB_STEP.FIND]: '対象条件',
  [CB_STEP.SELECT]: '顧客選択',
  [CB_STEP.OFFER]: '特典設定',
  [CB_STEP.REVIEW]: '内容確認',
  [CB_STEP.APPLY]: '実行',
});

/** 契約状態の選択肢（**カムバックの言葉**で出す） */
export const CB_CONTRACT_OPTIONS = Object.freeze([
  { value: 'candidates', label: 'カムバック候補すべて', danger: false },
  { value: 'expired', label: '期限切れ', danger: false },
  { value: 'withdrawn', label: '退会・課金停止', danger: false },
  { value: 'dormant', label: '休眠・長期未ログイン', danger: false },
  { value: 'none', label: '無料会員・契約なし', danger: false },
  { value: 'unknown', label: '状態不明', danger: false },
  { value: 'active', label: '現在有効な会員（通常は選択しない）', danger: true },
]);

/** 「カムバック候補すべて」に含める区分（**現有効会員を含めない**） */
export const CANDIDATE_SEGMENTS = Object.freeze([
  SEGMENT.EXPIRED, SEGMENT.WITHDRAWN, SEGMENT.DORMANT,
]);

/** 現在有効な会員を選んだときの警告 */
export const ACTIVE_FILTER_WARNING =
  '現在も有効な会員です。通常のカムバック施策の対象ではありません。特別な理由がある場合のみ使用してください。';

/** 条件の要約（取得ボタンの直前に出す） */
export function describeContractFilter(value) {
  switch (String(value || 'candidates')) {
    case 'active':
      return '現在有効な会員を検索します。通常のカムバック施策では使用しません。';
    case 'expired': return '有効期限が切れた顧客を検索します。現有効会員は除外します。';
    case 'withdrawn': return '退会した顧客を検索します。現有効会員は除外します。';
    case 'dormant': return '長期間ログインのない顧客を検索します。現有効会員は除外します。';
    case 'none': return '無料会員・契約のない顧客を検索します。現有効会員は除外します。';
    case 'unknown': return '契約状態を確定できない顧客を検索します。付与の対象にはできません。';
    default:
      return '期限切れ・退会・課金停止・現在権限なしの顧客を検索します。現有効会員は除外します。';
  }
}

/** 行を選択できるか。**現有効会員と状態不明は既定で選べない** */
export function canSelectRow({ segment, grantable = true, includeActiveMembers = false } = {}) {
  if (segment === SEGMENT.ACTIVE_MEMBER && includeActiveMembers !== true) {
    return { selectable: false, reason: '現在有効な会員のため通常対象外' };
  }
  if (segment === SEGMENT.UNKNOWN) {
    return { selectable: false, reason: '契約状態を確定できないため対象外' };
  }
  if (grantable === false) return { selectable: false, reason: '特典を付与できない状態' };
  return { selectable: true, reason: null };
}

/** 特典設定が決まっているか（どちらも「付与しない」なら未設定） */
export function hasOfferSelection({ lightOffer, premiumOffer } = {}) {
  const light = String(lightOffer || 'none');
  const premium = String(premiumOffer || 'none');
  return light !== 'none' || premium !== 'none';
}

/** 特典設定を**平文**で要約する（内部用語を使わない） */
export function describeOfferSelection({ count = 0, lightLabel = '', premiumLabel = '' } = {}) {
  const light = String(lightLabel || '').trim();
  const premium = String(premiumLabel || '').trim();
  const head = `選択した ${count} 名へ、`;
  if (!light && !premium) return '付与する特典が選ばれていません。';
  const parts = [];
  parts.push(light ? `${light}を付与します。` : 'Light 特典は付与しません。');
  parts.push(premium ? `${premium}を付与します。` : 'Premium 特典は付与しません。');
  return head + parts.join('');
}

/** いまどの段階か */
export function resolveCbStep(state = {}) {
  const s = normalize(state);
  // 前の段階が終わっていなければ、その段階に留まる（先の段階へ飛ばさない）
  if (!s.loaded) return CB_STEP.FIND;
  if (s.selectedCount === 0) return CB_STEP.SELECT;
  if (!s.offerReady) return CB_STEP.OFFER;
  if (!s.dryOk && !s.applied) return CB_STEP.REVIEW;
  return CB_STEP.APPLY;
}

function normalize(state) {
  return {
    loaded: !!state.loaded,
    selectedCount: Number(state.selectedCount) || 0,
    offerReady: hasOfferSelection(state.offer || {}),
    dryOk: !!state.dryRun && state.dryStale !== true && (Number(state.dryRun.willGrant) || 0) > 0
      && (Number(state.dryRun.activeMembers) || 0) === 0,
    applied: !!state.applied,
    busy: !!state.busy,
  };
}

const ok = () => ({ allowed: true, reason: null });
const no = (reason) => ({ allowed: false, reason });

/** Step 2 を操作できるか（**Step 1 の取得前は触れない**） */
export function canSelectCustomers(state = {}) {
  if (state.busy) return no('実行中です');
  if (!state.loaded) return no('先に「対象候補を表示」を押してください');
  return ok();
}

/** Step 3 を操作できるか（1 名以上の選択が要る） */
export function canConfigureOffer(state = {}) {
  const base = canSelectCustomers(state);
  if (!base.allowed) return base;
  if ((Number(state.selectedCount) || 0) === 0) return no('対象者を 1 名以上選んでください');
  return ok();
}

/** Step 4（付与内容の確認）を実行できるか */
export function canReview(state = {}) {
  const base = canConfigureOffer(state);
  if (!base.allowed) return base;
  if (!hasOfferSelection(state.offer || {})) return no('付与する特典を選んでください');
  return ok();
}

/**
 * Step 5（付与の実行）へ進めるか。
 * **現有効会員が 1 名でも混ざっていれば進めない**。
 */
export function canApply(state = {}) {
  const base = canReview(state);
  if (!base.allowed) return base;
  if (!state.dryRun) return no('先に「付与内容を確認」を押してください');
  if (state.dryStale === true) return no('条件または特典内容が変更されたため、もう一度確認してください');
  if ((Number(state.dryRun.activeMembers) || 0) > 0) return no('現在有効な会員が含まれています。対象から外してください');
  if ((Number(state.dryRun.willGrant) || 0) === 0) return no('付与される顧客がいません');
  return ok();
}

/** 確認結果の指紋（条件・選択・特典が変われば別物になる） */
export function computeCbFingerprint({ filters = {}, selectedIds = [], offer = {} } = {}) {
  const f = Object.keys(filters).sort().map((k) => `${k}=${String(filters[k] ?? '')}`).join('&');
  const ids = [...selectedIds].map(String).sort().join(',');
  const o = ['lightOffer', 'lightDays', 'premiumOffer', 'premiumDays', 'premiumPrice']
    .map((k) => `${k}=${String(offer[k] ?? '')}`).join('&');
  return `${f}|${o}|${ids}`;
}

/** 確認結果が古くなっていないか */
export function isCbDryStale({ dryRun, current } = {}) {
  if (!dryRun || !dryRun.fingerprint) return true;
  return dryRun.fingerprint !== computeCbFingerprint(current || {});
}

/** 変更しないものの明示（画面に必ず出す） */
export const UNCHANGED_NOTICE =
  'プラン・課金状態・入金状態・Premium Plus 販売資格・メール設定は変更しません。';

/** 実行時に伝えること */
export const APPLY_EFFECT_NOTICE =
  '実行すると対象顧客の閲覧権限が変わります。メールは送信されません（案内は顧客マーケティングタブから別途送ります）。';

/** 追従バーの表示内容（次の操作は 1 つだけ） */
export function buildCbStickyView(state = {}) {
  const s = normalize(state);
  const step = resolveCbStep(state);
  const nextByStep = {
    [CB_STEP.FIND]: '対象候補を表示',
    [CB_STEP.SELECT]: '顧客を選択',
    [CB_STEP.OFFER]: '特典を設定',
    [CB_STEP.REVIEW]: '付与内容を確認',
    // 追従バーは**確認画面を開くだけ**。Step 5 本体と同じ文言にして、
    // 「本番付与に見えるボタンが画面に複数ある」状態を作らない。
    [CB_STEP.APPLY]: s.applied ? '付与結果を見る' : '付与内容の最終確認へ',
  };
  return {
    step,
    left: `候補 ${Number(state.candidateCount) || 0} 名 / 選択 ${s.selectedCount} 名`,
    offer: `特典: ${String(state.offerSummaryShort || '未設定')}`,
    review: state.applied ? '確認: 実行済み'
      : !state.dryRun ? '確認: 未確認'
        : state.dryStale === true ? '確認: 失効' : '確認: 確認済み',
    next: nextByStep[step],
  };
}

/** 区分の表示名（一覧の列に出す） */
export function segmentLabel(segment) {
  return SEGMENT_LABEL[segment] || SEGMENT_LABEL[SEGMENT.UNKNOWN];
}
