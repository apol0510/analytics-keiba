/**
 * filterDefinitions.js — 絞り込みの**表示名と説明の単一源**（純粋・I/O なし・ブラウザ安全）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 画面には内部コードがそのまま出ていた（`不明（legacy）` / `有効オファーあり` /
 * `特典中` など）。書いた本人以外には意味が取れず、hover の title だけでは
 * スマホ・タブレットで読めない。
 *
 * ここで **コード値 ↔ 利用者向け表示名 ↔ 説明** を 1 か所にまとめ、
 *   ・フィルターのボタン名
 *   ・チェック項目
 *   ・チップ
 *   ・条件要約
 *   ・説明ポップオーバー
 * をすべてこの定義から作る。**画面に文言を直接書かない。**
 *
 * ⚠️ `value` は **API の許可値そのもの**。表示名を変えても value は変えない
 *    （変えると保存済みの条件・API 契約が壊れる）。
 */

/**
 * 絞り込みの種類。**違う種類を同じ意味に見える形で並べない**ための分類。
 *   STATE   … いまどうなっているか（現在状態）
 *   HISTORY … 過去に何があったか（記録）
 *   EXTRA   … 状態を絞り込む追加条件（単独では母集団を作らないもの）
 *   ACTION  … いまこの操作を実行できるか
 */
export const FILTER_CATEGORY = Object.freeze({
  STATE: 'state',
  HISTORY: 'history',
  EXTRA: 'extra',
  ACTION: 'action',
});

export const FILTER_CATEGORY_LABEL = Object.freeze({
  [FILTER_CATEGORY.STATE]: '現在状態',
  [FILTER_CATEGORY.HISTORY]: '履歴',
  [FILTER_CATEGORY.EXTRA]: '追加条件',
  [FILTER_CATEGORY.ACTION]: '操作可否',
});

import {
  OFFER_STATE_LABEL, OFFER_STATE_DESCRIPTION,
  OFFER_WINDOW_LABEL, OFFER_WINDOW_DESCRIPTION, OFFER_RELATION_NOTE,
} from './offerFilterModel.js';

/** 1 項目の定義を作る小さなヘルパ（形を揃えるためだけのもの） */
const def = (label, description, options, extra = {}) => Object.freeze({
  label, description, options: Object.freeze(options), ...extra,
});
/** `phrase` は条件要約（自然文）で使う言い回し。省略時は label をそのまま使う */
const opt = (value, label, description, phrase) => Object.freeze({ value, label, description, phrase: phrase || label });

/**
 * 絞り込み定義。キーは画面の select id（＝複数選択の識別子）。
 * `apiKey` は Function へ送るときのキー（違う場合だけ書く）。
 */
export const FILTER_DEFINITIONS = Object.freeze({
  // ── 顧客マーケティング ───────────────────────────────────
  mkContract: def('契約状態', '現在の契約や有効期限の状態で顧客を絞り込みます。', [
    opt('active', '有効', '有料会員権限が現在有効です。'),
    opt('expiring_soon', '期限が近い（14日以内）', '有効期限まで 14 日以内です。更新の案内に使えます。'),
    opt('expired', '期限切れ', '有料会員の有効期限が終了しています。'),
    opt('unknown', '状態を判定できない旧データ',
      '旧形式の顧客データで、現在の契約状態を確実に判定できません。送信前に個別確認してください。'),
    opt('none', '契約なし（無料会員）', '有料契約が確認できない無料会員です。'),
  ], { category: FILTER_CATEGORY.STATE, apiKey: 'contract' }),

  mkPlan: def('プラン', '顧客に登録されている会員プランで絞り込みます。', [
    opt('premium_sanrenpuku', 'Premium 三連複', '三連複の買い切り権を持つ会員です。'),
    opt('premium', 'Premium', 'Premium プランの会員です。'),
    opt('light', 'Light', 'Light プランの会員です。'),
    opt('free', '無料会員', '有料プランの登録がありません。'),
  ], { category: FILTER_CATEGORY.STATE, apiKey: 'plan' }),

  mkSendable: def('送信可否',
    'メール配信停止・バウンス・ブラックリストなどを考慮した送信可否です。', [
      opt('sendable', 'メール送信可能', '配信停止・バウンス・除外リストのいずれにも該当しません。'),
      opt('suppressed', 'メール送信不可', '配信停止・バウンス・停止アカウントなどの理由で送信対象から外れます。'),
    ], { category: FILTER_CATEGORY.STATE, apiKey: 'marketing' }),

  mkPp: def('Premium Plus 資格',
    'Premium Plus の販売対象として扱えるかを示します。会員プランとは別判定です。'
    + 'Premium Plus資格は検索条件です。選択しても販売資格は変更されません。', [
      opt('eligible', '販売できる', 'Premium Plus を案内・販売できる状態です。'),
      opt('review', '保留（確認待ち）',
        '販売資格の確認待ちで、現在はPremium Plusを販売できません。メール送信だけでは販売対象になりません。'),
      opt('blocked', '販売対象外', '販売しないと決めた顧客です。'),
      opt('unset', '未設定', '販売資格をまだ判定していません。'),
    ], { category: FILTER_CATEGORY.STATE, apiKey: 'premiumPlus' }),

  mkHistory: def('送信履歴', '過去に対象キャンペーンを送信した記録で絞り込みます。', [
    opt('never', '送ったことがない', 'この台帳にキャンペーン送信の記録がありません。'),
    opt('recent', '最近送った（30日以内）', '30 日以内にキャンペーンを送っています。'),
    opt('sent', '送ったことがある', '時期を問わず、送信の記録があります。'),
  ], { category: FILTER_CATEGORY.HISTORY, apiKey: 'history' }),

  // ⚠️ 「残り期間」は「使えるオファーあり」の**部分集合**。並列に並べると
  //    違いが説明できないため、状態（排他）と残り期間（追加条件）へ分けた。
  mkOfferState: def('オファーの状態', '顧客に発行済みの割引・購入オファーが、いまどうなっているかで絞り込みます。', [
    opt('live', OFFER_STATE_LABEL.live, OFFER_STATE_DESCRIPTION.live),
    opt('redeemed', OFFER_STATE_LABEL.redeemed, OFFER_STATE_DESCRIPTION.redeemed),
    opt('revoked', OFFER_STATE_LABEL.revoked, OFFER_STATE_DESCRIPTION.revoked),
    opt('expired', OFFER_STATE_LABEL.expired, OFFER_STATE_DESCRIPTION.expired),
    opt('none', OFFER_STATE_LABEL.none, OFFER_STATE_DESCRIPTION.none),
    opt('unknown', OFFER_STATE_LABEL.unknown, OFFER_STATE_DESCRIPTION.unknown),
  ], { category: FILTER_CATEGORY.STATE, apiKey: 'offerState', exclusive: true, relationNote: OFFER_RELATION_NOTE }),

  mkOfferWindow: def('オファーの残り期間',
    'いま使えるオファーがある顧客を、有効期限の残りでさらに絞り込みます。', [
      opt('within7', OFFER_WINDOW_LABEL.within7, OFFER_WINDOW_DESCRIPTION.within7),
      opt('over7', OFFER_WINDOW_LABEL.over7, OFFER_WINDOW_DESCRIPTION.over7),
      opt('no_expiry', OFFER_WINDOW_LABEL.no_expiry, OFFER_WINDOW_DESCRIPTION.no_expiry),
    ], {
      category: FILTER_CATEGORY.EXTRA, apiKey: 'offerWindow',
      // 単独では母集団を作らない。必ず「使えるオファーあり」に限定される
      dependsOn: 'mkOfferState', dependsOnValue: 'live', relationNote: OFFER_RELATION_NOTE,
    }),

  mkPromoState: def('現在の無料付与',
    '現在有効な Light または Premium の無料利用権を示します。', [
      opt('active', '無料利用権が有効', 'いま無料で閲覧できる権利があります（購入とは別）。'),
      opt('ending7', '無料期間が7日以内に終了', '無料利用権の終了が 7 日以内に来ます。'),
      opt('none', '無料付与なし', '現在有効な無料利用権はありません。'),
    ], { category: FILTER_CATEGORY.STATE, apiKey: 'promoState' }),

  mkFrequency: def('送信タイミング', '最終送信日時や配信頻度制限に基づく状態です。', [
    opt('sendable-now', 'いま送れる', '送信可能で、24 時間の送信間隔制限にもかかっていません。'),
    opt('blocked', '24時間の間隔制限中', '直近 24 時間以内に送っているため、いまは送りません。'),
  ], { category: FILTER_CATEGORY.EXTRA, apiKey: 'frequency' }),

  mkLastLogin: def('最終ログイン', '顧客の最終ログインからの経過期間で絞り込みます。', [
    opt('login:30d', '30日以内', '直近 30 日以内にログインしています。'),
    opt('login:90d', '31〜90日前', '1 か月以上 3 か月以内にログインしています。'),
    opt('login:365d', '91日〜1年前', '3 か月以上 1 年以内にログインしています。'),
    opt('login:over365', '1年以上前', '1 年以上ログインしていません。'),
    opt('login:never', 'ログイン記録なし', 'ログインの記録が残っていません（記録開始前の可能性もあります）。'),
  ], { category: FILTER_CATEGORY.EXTRA, apiKey: 'lastLogin' }),

  // ── カムバック特典 ────────────────────────────────────────
  cbContract: def('対象区分', 'カムバックの宛先として、どの状態の顧客を探すかを選びます。', [
    opt('expired', '期限切れ', '有料会員の有効期限が終了しています。'),
    opt('withdrawn', '退会済み', '退会または課金停止の記録があります。'),
    opt('dormant', '休眠（長期ログインなし）', '無料のまま長期間ログインがありません。'),
    opt('none', '無料会員・契約なし', '有料契約が確認できない無料会員です。'),
    opt('unknown', '状態を判定できない', '契約状態を確定できないため、付与の対象にはできません。'),
    opt('active', '現在有効な会員（通常は選択しない）',
      'いま料金を払って使っている会員です。カムバックの本来の宛先ではありません。'),
  ], { category: FILTER_CATEGORY.STATE, apiKey: 'contract' }),

  cbPlan: def('プラン', '顧客に登録されている会員プランで絞り込みます。', [
    opt('premium_sanrenpuku', 'Premium 三連複', '三連複の買い切り権を持つ会員です。'),
    opt('premium', 'Premium', 'Premium プランの会員です。'),
    opt('light', 'Light', 'Light プランの会員です。'),
    opt('free', '無料会員', '有料プランの登録がありません。'),
  ], { category: FILTER_CATEGORY.STATE, apiKey: 'plan' }),

  cbWithdrawn: def('退会履歴', '退会（課金停止）の申し出があったかで絞り込みます。', [
    opt('yes', '退会の記録あり', '退会・課金停止の記録があります。メール配信の可否とは別です。'),
    opt('no', '退会の記録なし', '退会の申し出は記録されていません。'),
  ], { category: FILTER_CATEGORY.HISTORY, apiKey: 'withdrawn' }),

  cbGrantNow: def('現在の無料付与',
    '現在有効な Light または Premium の無料利用権を示します。', [
      opt('none', '現在は無料付与なし', 'いま有効な無料利用権はありません。'),
      opt('light_period', 'Light 無料（期間あり）', '期限つきの Light 無料利用権が有効です。'),
      opt('light_lifetime', 'Light 無料（無期限）', '期限のない Light 無料利用権が有効です。'),
      opt('premium_period', 'Premium 無料（期間あり）', '期限つきの Premium 無料利用権が有効です。'),
      opt('premium_lifetime', 'Premium 無料（無期限）', '期限のない Premium 無料利用権が有効です。'),
      opt('both', 'Light・Premium 両方が有効', '2 つの無料利用権が同時に有効です。'),
      opt('inconsistent', '⚠️ 要確認（データが矛盾）',
        '取消の記録と期限が食い違うなど、無料付与のデータが矛盾しています。自動修復はしません。'),
    ], { category: FILTER_CATEGORY.STATE, apiKey: 'currentGrant' }),

  cbGrantHistory: def('無料付与履歴',
    '過去に無料利用権を付与・終了・取消した記録を示します。', [
      opt('no_record', '付与の記録なし',
        'この台帳に記録がありません。過去に付与が無かったことの証明ではありません。'),
      opt('light', 'Light の付与歴あり', '過去に Light の無料利用権を付与した記録があります。'),
      opt('premium', 'Premium の付与歴あり', '過去に Premium の無料利用権を付与した記録があります。'),
      opt('both', 'Light・Premium 両方の付与歴あり', '両方の無料利用権を付与した記録があります。'),
      opt('ended', '無料期間が終了済み', '付与した無料期間が既に終わっています。'),
      opt('revoked', '取消・失効の記録あり', '付与した無料利用権を取り消した記録があります。'),
      opt('inconsistent', '⚠️ 要確認（記録が矛盾）', '付与と取消の記録が食い違っています。'),
      opt('unknown', '履歴を確定できない',
        '操作の痕跡はありますが、種類や時期を確定できません。個別に確認してください。'),
    ], { category: FILTER_CATEGORY.HISTORY, apiKey: 'grantHistory' }),

  cbGrantable: def('今回の無料付与',
    '現在の状態と既存の無料付与から、今回の付与操作が可能かを示します。', [
      opt('grantable', '今回付与できる', 'いまこの顧客へ無料利用権を付与できます。'),
      opt('blocked', '現在の状態では付与できない',
        '停止・退会・メール未登録、または既に無期限の権利があるため、付与しても意味がありません。'),
      opt('review', '要確認',
        '無料付与のデータが矛盾しています。内容を確認するまで付与しません。'),
    ], { category: FILTER_CATEGORY.ACTION, apiKey: 'grantable' }),

  cbHistory: def('送信履歴', '過去に対象キャンペーンを送信した記録で絞り込みます。', [
    opt('never', '送ったことがない', 'この台帳にキャンペーン送信の記録がありません。'),
    opt('recent', '最近送った（30日以内）', '30 日以内にキャンペーンを送っています。'),
    opt('sent', '送ったことがある', '時期を問わず、送信の記録があります。'),
  ], { category: FILTER_CATEGORY.HISTORY, apiKey: 'history' }),

  // ── Premium Plus 販売 ────────────────────────────────────
  fState: def('販売状態', 'Premium Plus をいまこの顧客へ販売できるかの状態です。', [
    opt('review', '保留（確認待ち）', '条件を満たすか確認が必要で、まだ販売対象にしていません。'),
    opt('eligible', '販売できる', '段階公開の対象、または販売中です。'),
    opt('immediate', 'すぐ販売できる（個別許可）', '管理者が個別に販売を許可しています。'),
    opt('blocked', '販売対象外', '販売しないと決めた顧客です。'),
  ], { category: FILTER_CATEGORY.STATE }),

  fRoute: def('資格の成立経路', 'Premium Plus の販売資格が、どの条件で成立したかを示します。', [
    opt('sanrenpuku', '三連複の購入から', '三連複の買い切り購入により資格が成立しました。'),
    opt('premium_30d', 'Premium 加入30日から', 'Premium 加入から 30 日経過して資格が成立しました。'),
  ], { category: FILTER_CATEGORY.STATE }),

  fKind: def('候補の区分', '販売資格が成立していない顧客を、その理由で分けて表示します。', [
    opt('waiting_30d', 'Premium 30日待ち', 'Premium 加入から 30 日の経過を待っています。'),
    opt('anchor_missing', '加入日が不明', '加入日のデータが無く、経過日数を数えられません。'),
  ], { category: FILTER_CATEGORY.STATE }),

  fUpsell: def('販売する商品', 'この顧客に対して、どの商品を案内するかの設定です。', [
    opt('auto', '自動で選ぶ', '資格の状態に応じて案内内容を自動で決めます。'),
    opt('sanrenpuku', '三連複を案内', '三連複の購入を案内します。'),
    opt('plus', 'Premium Plus を案内', 'Premium Plus の購入を案内します。'),
    opt('none', '案内しない', '販売の案内を表示しません。'),
  ], { category: FILTER_CATEGORY.EXTRA }),
});

/** Email 個別検索の説明（通常のセグメント検索と混同させない） */
export const EMAIL_SEARCH = Object.freeze({
  label: '🔎 Email で個別検索',
  description: '特定の顧客をメールアドレスで探す場合だけ使用します。',
  activeBadge: 'Email 条件あり',
});

/** 詳細条件アコーディオンの見出し */
export const ADVANCED_FILTERS = Object.freeze({
  summary: '詳細な絞り込み条件',
  hint: '送信履歴・オファー・無料付与・最終ログインなど',
});

const str = (v) => String(v ?? '').trim();

/** 定義を引く（未定義なら null。画面は null のとき説明ボタンを出さない） */
export function getFilterDefinition(filterId) {
  return FILTER_DEFINITIONS[str(filterId)] || null;
}

/** 選択肢 1 件の定義を引く */
export function getOptionDefinition(filterId, value) {
  const d = getFilterDefinition(filterId);
  if (!d) return null;
  return d.options.find((o) => o.value === str(value)) || null;
}

/** 表示名（定義が無ければコード値をそのまま返す＝勝手に言い換えない） */
export function optionLabel(filterId, value) {
  const o = getOptionDefinition(filterId, value);
  return o ? o.label : str(value);
}

/** チップ・条件要約に使うラベル表（{value: label}） */
export function optionLabelMap(filterId) {
  const d = getFilterDefinition(filterId);
  if (!d) return {};
  return Object.fromEntries(d.options.map((o) => [o.value, o.label]));
}

/** その項目の全 value（API 許可値との突き合わせに使う） */
export function optionValues(filterId) {
  const d = getFilterDefinition(filterId);
  return d ? d.options.map((o) => o.value) : [];
}

/**
 * 定義と API 許可値のズレを検出する。
 * **説明の無い選択肢**や、**定義に無い許可値**を CI で落とすために使う。
 *
 * @param {string} filterId
 * @param {string[]} allowed API 側の許可値
 */
export function diffAgainstAllowed(filterId, allowed = []) {
  const values = optionValues(filterId);
  const a = new Set(allowed.map(str));
  const v = new Set(values);
  return {
    missingInDefinition: [...a].filter((x) => !v.has(x)),
    missingInApi: [...v].filter((x) => !a.has(x)),
  };
}

/** すべての定義が「表示名 + 説明」を持っているか（テスト用） */
export function auditDefinitions() {
  const problems = [];
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    if (!d.label) problems.push(`${id}: 表示名が無い`);
    if (!d.description) problems.push(`${id}: 説明が無い`);
    for (const o of d.options) {
      if (!o.label) problems.push(`${id}.${o.value}: 表示名が無い`);
      if (!o.description) problems.push(`${id}.${o.value}: 説明が無い`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 利用者向けに出してはいけない語（内部コードそのまま・意味の取れない表記） */
export const FORBIDDEN_DISPLAY_WORDS = Object.freeze([
  '不明（legacy）', '有効オファーあり', '期限 7 日以内', '特典中',
  'legacy', 'eligible', 'blocked', 'review', 'sendable', 'frequency',
  'currentGrant', 'grantHistory', 'promo', 'stale', 'inconsistent',
]);

/** 表示文字列に内部語が混ざっていないか（テスト用） */
export function findForbiddenWords(text) {
  const t = str(text);
  return FORBIDDEN_DISPLAY_WORDS.filter((w) => t.includes(w));
}

/**
 * 条件を**自然文**で要約する（チップの羅列にしない）。
 * 種類ごとにまとめ、包含関係を誤解させない語順で並べる。
 */
export function describeConditionsNatural(selections = {}) {
  const bucket = { state: [], history: [], extra: [], action: [] };
  for (const [id, values] of Object.entries(selections)) {
    const d = getFilterDefinition(id);
    const list = (Array.isArray(values) ? values : [values])
      .map((v) => str(v)).filter((v) => v && v !== 'all');
    if (!d || list.length === 0) continue;
    const names = list.map((v) => {
      const o = getOptionDefinition(id, v);
      return o ? (o.phrase || o.label) : v;
    });
    bucket[d.category || 'state'].push(names.join('または'));
  }
  const parts = [];
  if (bucket.state.length) parts.push(bucket.state.join('で、'));
  if (bucket.history.length) parts.push(`${bucket.history.join('で、')}の記録がある`);
  if (bucket.extra.length) parts.push(bucket.extra.join('で、'));
  if (bucket.action.length) parts.push(bucket.action.join('で、'));
  if (parts.length === 0) return '条件を指定していません（すべての顧客が対象です）。';
  // 「〜で、〜、かつ〜」の後は必ず「の顧客を検索します。」で閉じる（読み下せる文にする）
  return `${parts.join('、かつ')}の顧客を検索します。`;
}

/**
 * 選んだ条件が両立しないかを**取得前**に判定する。
 * `dependsOn` を持つ項目は、依存先の値を選ばない限り母集団が空になる。
 */
export function detectImpossibleCombination(selections = {}) {
  const problems = [];
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    if (!d.dependsOn) continue;
    const mine = (Array.isArray(selections[id]) ? selections[id] : [selections[id]])
      .map((v) => str(v)).filter((v) => v && v !== 'all');
    if (mine.length === 0) continue;
    const parent = (Array.isArray(selections[d.dependsOn]) ? selections[d.dependsOn] : [selections[d.dependsOn]])
      .map((v) => str(v)).filter((v) => v && v !== 'all');
    if (parent.length > 0 && !parent.includes(d.dependsOnValue)) {
      const parentDef = getFilterDefinition(d.dependsOn);
      problems.push({
        filterId: id,
        message: `この条件の組合せでは対象が存在しません：「${d.label}」は`
          + `「${optionLabel(d.dependsOn, d.dependsOnValue)}」の顧客にだけ当てはまります。`
          + `「${parentDef ? parentDef.label : d.dependsOn}」の指定を見直してください。`,
      });
    }
  }
  return problems;
}

/** 項目の分類（画面の見出し脇に出す短い語） */
export function categoryLabel(filterId) {
  const d = getFilterDefinition(filterId);
  return d ? (FILTER_CATEGORY_LABEL[d.category] || '') : '';
}

/** 依存関係のある項目（画面で親を選ぶまで注意を出す） */
export function dependencyOf(filterId) {
  const d = getFilterDefinition(filterId);
  if (!d || !d.dependsOn) return null;
  return { filterId: d.dependsOn, value: d.dependsOnValue, note: d.relationNote || '' };
}

/**
 * 通常運用の初期値。**「指定なし」＝送信できない顧客も候補に入る**ため、
 * 送信可否だけは既定で「メール送信可能」に絞る（毎回選び直させない）。
 * 「条件をクリア」も完全な未指定ではなく、ここへ戻す。
 */
export const FILTER_DEFAULTS = Object.freeze({
  mkSendable: Object.freeze(['sendable']),
});

/** 通常運用の説明（絞り込み欄の先頭に出す） */
export const ROUTINE_FILTER_NOTE =
  '通常はメール送信可能な顧客を表示します。さらに絞り込む場合だけ追加条件を選択してください。';

/** その項目の初期値（無ければ空＝指定なし） */
export function defaultSelection(filterId) {
  return [...(FILTER_DEFAULTS[str(filterId)] || [])];
}

export const FILTER_IDS = Object.freeze(Object.keys(FILTER_DEFINITIONS));
