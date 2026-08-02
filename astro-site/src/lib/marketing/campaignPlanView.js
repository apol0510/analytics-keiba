/**
 * campaignPlanView.js — dry-run の結果を「実行前に確認する画面」の形へ整える（純粋）
 *
 * ── 判定はしない。整えるだけ ──────────────────────────────────
 * 対象になるか・除外されるかは **既存の権威 API（dry-run）が決める**。
 * このモジュールは返ってきた結果に一覧の行情報を突き合わせ、
 * 「誰が対象で、誰がなぜ除外か」を人が読める形にするだけ。
 * 契約・送信可否・suppression・頻度・DeliveryKey を**画面側で再判定しない**。
 *
 * ── fail closed ────────────────────────────────────────────
 * 除外理由に**未知のコードが 1 つでもあれば実行不可**にする（`executable=false`）。
 * 理由が読めないまま実行させると、なぜ送られなかった/送られたのかを後から説明できない。
 * 件数の辻褄（選択 = 対象 + 除外）が合わない場合も実行不可にする。
 */

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 施策の種類（メール / 特典・オファー）。確認画面の項目が変わる */
export const PLAN_KIND = Object.freeze({
  CAMPAIGN: 'campaign',
  GRANT_OFFER: 'grant_offer',
});

/**
 * 除外理由コード → 日本語。
 *
 * ⚠️ **このモジュールはブラウザで動く**ため、`campaignSend.js`（node:crypto に依存）を
 * import できない。よって表示用のラベルだけをここに持つ。
 * ただし **API が label を返した場合は必ずそちらを優先**する（サーバー側が単一源）。
 * ここの表は「API がラベルを付けなかったコード」への保険。
 * サーバー側の `MK_EXCLUSION_LABEL` との取りこぼしは
 * `campaignPlanView.test.mjs` の突き合わせテストで検知する。
 */
export const EXCLUSION_LABEL = Object.freeze({
  no_email: 'メール未登録',
  invalid_email: 'メール形式が不正',
  unsubscribed: '配信停止',
  blacklist: 'ブラックリスト（ハードバウンス・苦情）',
  suspended: '利用停止',
  test_account: 'テストアカウント',
  provider_suppressed: '配信基盤側で配信停止済み',
  soft_bounce: 'ソフトバウンス履歴あり',
  already_delivered: '送信済み（同一キャンペーン）',
  recent_marketing_contact: '最近マーケティング送信済み（24時間以内）',
  campaign_mismatch: 'キャンペーン条件外',
  duplicate: '重複アドレス',
  contract_mismatch: '契約状態が対象外',
  plan_mismatch: 'プランが対象外',
  unknown_customer: '顧客レコード不明',
  offer_missing: '有効な割引オファーが発行されていない',
  offer_ambiguous: '有効な割引オファーが複数あり特定できない',
  offer_mismatch: '発行済みオファーの内容が案内文面と一致しない',
  offer_secret_unavailable: 'オファー URL の署名鍵が未設定',
  offer_url_unresolved: '申込 URL を解決できなかった',
  // 特典・オファー側の dry-run が返す skip コード
  already_offered: '有効な割引オファーを既に保有',
  already_granted: '同じ無料特典を既に保有',
  contract_conflict: '有効な有料契約があるため対象外',
  payment_pending: '入金確認の途中（Requested* が残っている）',
  payment_confirmed: '入金確認済みのため対象外',
  account_suspended: '利用停止・テストアカウント',
  pricing_mismatch: '価格設定が一致しない',
  not_offerable: 'オファー発行の条件を満たさない',
});

/**
 * 表示ラベル。**API が付けたラベルが最優先**（サーバーが単一源）。
 * 無ければローカル表、それも無ければ未知として素のコードを出す（言い換えない）。
 */
export function labelFor(code, apiLabel) {
  const c = str(code);
  if (!c) return '理由不明';
  const fromApi = str(apiLabel);
  if (fromApi && fromApi !== c) return fromApi;
  return EXCLUSION_LABEL[c] || `未知の理由コード: ${c}`;
}

/** API がラベルを付けていれば既知として扱う（サーバー側の表が正） */
export function isKnownReason(code, apiLabel) {
  const c = str(code);
  const fromApi = str(apiLabel);
  if (fromApi && fromApi !== c) return true;
  return !!EXCLUSION_LABEL[c];
}

/**
 * 一覧の行（recordId をキーにした Map）から、確認画面に出す 1 人分を作る。
 * **メールアドレスをキーにしない**（重複アドレスで取り違えるため）。
 */
function personOf(recordId, rowsById) {
  const r = rowsById.get(str(recordId)) || {};
  return {
    recordId: str(recordId),
    name: str(r.name),
    email: str(r.email),
    contract: str(r.contract),
    plan: str(r.planGroup || r.plan),
    access: r.access || null,
    lastLoginAt: str(r.lastLoginAt) || null,
    daysSinceLogin: r.daysSinceLogin ?? null,
    sendable: r.sendable === true,
    liveOfferCount: num(r.liveOfferCount),
    promoActive: r.promoActive === true,
    promoUntil: str(r.promoUntil) || null,
    nextSendableAt: str(r.nextSendableAt) || null,
  };
}

/**
 * dry-run の結果を確認画面用に整える。
 *
 * @param {{
 *   kind: 'campaign'|'grant_offer',
 *   selectedIds: string[],
 *   rowsById: Map<string, object>,
 *   result: object,          // 権威 API（admin-marketing / admin-comeback-grants）の dry-run 応答
 *   campaign?: object|null,  // メール施策のときのカタログ定義
 *   nowMs: number,
 * }} input
 */
export function buildPlanView(input = {}) {
  const { kind, selectedIds = [], rowsById = new Map(), result = {}, campaign = null, nowMs } = input;
  const blockers = [];

  // ── 除外（理由つき）。API の形が 2 種類あるので、ここで 1 つに揃える ──
  //   特典・オファー側は **skippedPreview が人物単位**（recordId つき）、
  //   skippedDetail は理由ごとの集計。人物単位が取れるならそちらを使う。
  //   ここを集計側だけ見ていたため、除外が 1 件でもあると常に
  //   「誰が対象か確定できません」になっていた（2026-08-03 修正）。
  const rawExcluded = kind === PLAN_KIND.CAMPAIGN
    ? (result.excludedRecords || result.excludedDetail || [])
    : ((result.skippedPreview && result.skippedPreview.length ? result.skippedPreview : null)
      || result.skippedDetail || []);

  /** recordId → reason。API が明細を返さない場合は集計だけで表示する */
  const excludedById = new Map();
  const reasonCounts = new Map();
  /** code → API が返したラベル（あれば優先して使う） */
  const apiLabels = new Map();

  for (const item of rawExcluded) {
    // 明細形式（{recordId, reason}）と集計形式（{reason, count}）の両方に対応する
    if (item && item.recordId) {
      const code = str(item.reason);
      excludedById.set(str(item.recordId), { code, label: str(item.label) });
      apiLabels.set(code, str(item.label));
      reasonCounts.set(code, (reasonCounts.get(code) || 0) + 1);
    } else if (item && item.reason && Number.isFinite(Number(item.count))) {
      const code = str(item.reason);
      apiLabels.set(code, str(item.label));
      reasonCounts.set(code, (reasonCounts.get(code) || 0) + num(item.count));
    }
  }
  // 特典側の partSkips（{ reason: count }）も集計へ入れる
  const partSkips = (result.parts && result.parts.partSkips) || {};
  for (const [code, n] of Object.entries(partSkips)) {
    reasonCounts.set(str(code), (reasonCounts.get(str(code)) || 0) + num(n));
  }

  // ── 人物単位の対応が確定できるかを先に検証する（fail closed の核）──────
  // 権威 API が recordId 付きの除外明細を返さない場合、"除外に載っていない = 対象" と
  // みなすのは **推測**になる（集計だけでは誰が落ちたのか分からない）。
  // その状態で「この人に実行されます」と出すと、実際には送られない相手を対象として
  // 見せてしまうため、人物一覧そのものを出さない。
  const apiIncluded = kind === PLAN_KIND.CAMPAIGN
    ? num(result.willSend)
    : num(result.willGrant) + num(result.willOffer);
  const apiExcluded = kind === PLAN_KIND.CAMPAIGN ? num(result.excluded) : num(result.skipped);

  const selectedSet = new Set(selectedIds.map(str).filter(Boolean));
  const detailIssues = [];

  // 明細に載った recordId の妥当性（空 / 重複 / 選択外）
  const seen = new Set();
  let emptyIds = 0;
  let dupIds = 0;
  let outsideIds = 0;
  for (const item of rawExcluded) {
    if (!item || !('recordId' in item)) continue;
    const id = str(item.recordId);
    if (!id) { emptyIds += 1; continue; }
    if (seen.has(id)) { dupIds += 1; continue; }
    seen.add(id);
    if (!selectedSet.has(id)) outsideIds += 1;
  }
  if (emptyIds > 0) detailIssues.push(`除外明細に recordId の無い行が ${emptyIds} 件あります`);
  if (dupIds > 0) detailIssues.push(`除外明細に重複した recordId が ${dupIds} 件あります`);
  if (outsideIds > 0) detailIssues.push(`選択していない recordId が除外明細に ${outsideIds} 件あります`);

  // 除外が 1 件でもあるのに、その人が特定できない場合は確定不能
  if (apiExcluded > 0 && excludedById.size !== apiExcluded) {
    detailIssues.push(
      `除外者の明細を取得できないため、誰が対象か確定できません（除外 ${apiExcluded} 件に対し明細 ${excludedById.size} 件）`,
    );
  }
  // 選択 = 対象 + 除外 が一意に割れるか
  if (selectedSet.size !== selectedIds.length) {
    detailIssues.push('選択に重複した recordId があります');
  }
  if (excludedById.size > 0 && selectedSet.size - excludedById.size !== apiIncluded) {
    detailIssues.push(
      `人物単位の内訳が API の件数と一致しません（選択 ${selectedSet.size} − 除外明細 ${excludedById.size} ≠ 対象 ${apiIncluded}）`,
    );
  }

  /** 人物単位で「誰が対象／誰が除外」を確定できたか */
  const detailComplete = detailIssues.length === 0
    && (apiExcluded === 0 || excludedById.size === apiExcluded);

  const included = [];
  const excluded = [];
  if (detailComplete) {
    for (const id of selectedIds.map(str)) {
      const person = personOf(id, rowsById);
      if (excludedById.has(id)) {
        const { code, label } = excludedById.get(id);
        excluded.push({ ...person, reasonCode: code, reasonLabel: labelFor(code, label), known: isKnownReason(code, label) });
      } else {
        included.push(person);
      }
    }
  } else {
    // ⚠️ 確定できないので **included を作らない**（推測で「対象」と言わない）。
    //    分かっている除外だけは出す（誰が落ちたかの手掛かりとして）。
    for (const [id, v] of excludedById.entries()) {
      if (!selectedSet.has(id)) continue;
      excluded.push({
        ...personOf(id, rowsById),
        reasonCode: v.code, reasonLabel: labelFor(v.code, v.label), known: isKnownReason(v.code, v.label),
      });
    }
  }

  const detailAvailable = detailComplete;

  const summary = [...reasonCounts.entries()]
    .map(([code, count]) => ({ code, label: labelFor(code, apiLabels.get(code)), count, known: isKnownReason(code, apiLabels.get(code)) }))
    .sort((a, b) => b.count - a.count);

  // ── fail closed ──────────────────────────────────────────
  // 人物単位の対応が確定できないなら実行不可（推測で対象を作らない）
  for (const issue of detailIssues) blockers.push(issue);
  const unknown = summary.filter((s) => !s.known);
  if (unknown.length > 0) {
    blockers.push(`未知の除外理由があります（${unknown.map((u) => u.code).join('・')}）。理由を確認するまで実行しないでください。`);
  }
  if (selectedIds.length !== apiIncluded + apiExcluded) {
    blockers.push(`件数が合いません（選択 ${selectedIds.length} / 対象 ${apiIncluded} + 除外 ${apiExcluded}）。`);
  }
  if (kind === PLAN_KIND.CAMPAIGN && result.error) {
    blockers.push(`計画を作れませんでした: ${str(result.error)}`);
  }
  if (apiIncluded === 0) {
    blockers.push('対象が 0 名です。実行しても何も起きません。');
  }

  return {
    kind,
    title: kind === PLAN_KIND.CAMPAIGN
      ? `${str(result.campaignName) || str(result.campaignId)}（v${num(result.version)}）`
      : str(result.selection) || '無料特典・割引オファー',

    // 実行内容（最終確認に必要な項目）
    campaignId: kind === PLAN_KIND.CAMPAIGN ? str(result.campaignId) : null,
    version: kind === PLAN_KIND.CAMPAIGN ? num(result.version) : null,
    subject: kind === PLAN_KIND.CAMPAIGN ? str(result.subject) : null,
    offer: kind === PLAN_KIND.CAMPAIGN
      ? (result.offerSummary || null)
      : (result.purchaseOffer || null),
    grants: kind === PLAN_KIND.GRANT_OFFER
      ? { light: str(result.lightOffer) || null, premium: str(result.premiumOffer) || null }
      : null,
    /** 実行の識別子。特典側は operationId、メール側は planFingerprint が同じ役割 */
    operationId: str(result.operationId) || null,
    planFingerprint: str(result.planFingerprint) || null,

    // 件数
    selectedCount: selectedIds.length,
    includedCount: apiIncluded,
    excludedCount: apiExcluded,

    /** 特典・オファーの「変更前 → 変更後」（サーバーの dry-run preview をそのまま） */
    previews: (result.preview || []).map((x) => ({
      recordId: str(x.recordId), before: str(x.before), after: str(x.after),
    })),

    // 明細
    included,
    excluded,
    /** 人物単位の対応（誰が対象・誰が除外）が確定できたか。false なら対象者一覧を出さない */
    detailComplete,
    /** 後方互換のための別名（旧: 明細が取れたか） */
    detailAvailable,
    reasonSummary: summary,

    // 実行可否（画面はこれを見てボタンを閉じる）
    executable: blockers.length === 0,
    blockers,

    sideEffects: str(result.sideEffects) || 'none',
    rollback: rollbackFor(kind, result),
    /** 本番変更を伴うか（この画面では常に「まだ変更していない」） */
    warning: 'この確認は dry-run です。まだ本番は変更されていません。',
  };
}

/** 施策ごとの取り消し方法（実行後に何をすれば戻せるか） */
export function rollbackFor(kind, result = {}) {
  if (kind === PLAN_KIND.CAMPAIGN) {
    return [
      'キュー登録前: 操作は不要（まだ何も作られていません）',
      // ⚠️ キューを取り消す API は存在しない（2026-08-01 実測）。
      //    「配信しなければよい」は取り消しではないので、そう書かない。
      'キュー登録後・配信前: **キューを取り消す機能は未実装**。ScheduledEmails に PENDING が残るため、'
        + '実配信を行わない運用で止めるか、Airtable でジョブ行を手動で処理する必要があります',
      '配信後: **取り消し不能**（送信済みメールは戻せません）。'
        + '同一 campaign×version の重複送信は DeliveryKey が防ぎます',
    ];
  }
  const lines = [
    '無料特典: カムバック特典タブの「取り消し」から取り消せます（Customers の契約・課金は不変）',
    '割引オファー: 「発行済み割引オファー」から 1 件ずつ取り消せます',
  ];
  if (str(result.operationId)) lines.push(`operationId: ${str(result.operationId)}（取り消し時の照合に使います）`);
  return lines;
}

/**
 * 選択集合の更新（recordId が正本）。
 * **絞り込みやページングで表示が変わっても、選択が勝手に増えない**ことを保証する。
 *
 * @param {{ current: Set<string>|string[], visibleIds: string[], op: 'add-visible'|'clear'|'toggle', id?: string, selectableIds?: string[] }} input
 * @returns {Set<string>}
 */
export function updateSelection({ current = new Set(), visibleIds = [], op, id, selectableIds = null } = {}) {
  const next = new Set([...current].map(str).filter(Boolean));
  const visible = visibleIds.map(str).filter(Boolean);
  const allowed = selectableIds ? new Set(selectableIds.map(str)) : null;

  if (op === 'clear') return new Set();
  if (op === 'toggle') {
    const key = str(id);
    if (!key) return next;
    if (next.has(key)) next.delete(key);
    else if (!allowed || allowed.has(key)) next.add(key);
    return next;
  }
  if (op === 'add-visible') {
    // **表示中のものだけ**追加する（絞り込み前の顧客を巻き込まない）
    for (const v of visible) {
      if (!allowed || allowed.has(v)) next.add(v);
    }
    return next;
  }
  return next;
}

/**
 * 選択のうち、いま画面に出ていないものを数える。
 * 「見えていないのに対象になっている」状態を管理者へ知らせるために使う。
 */
export function offscreenSelection({ current = new Set(), visibleIds = [] } = {}) {
  const visible = new Set(visibleIds.map(str));
  return [...current].map(str).filter((id) => !visible.has(id));
}
