/**
 * sendgridExitReadiness.js — 「**反応したら以後の選別メールから外れる**」が
 * いまの構成で機械的に成立するかを判定する（純粋・I/O なし）
 *
 * ## 何を判定するのか（cutover の前提）
 *
 * > 反応者は反応した時点で選別完了とし、**その後の選別メールから除外して DRM へ進める**。
 * > 無反応者だけ最大 10 通まで継続する。
 *
 * Single Sends ＋ **静的 list** の構成では、次の 2 つが揃って初めて「外れる」:
 *
 *   1. **検知**: その反応が AK に届くか（Event Webhook / AK 側の計測）
 *   2. **反映**: 次の Single Send の宛先から実際に消えるか
 *      - `sendgrid_suppression`: SendGrid の suppression（unsubscribe group / bounce / 苦情）が**自動で**除外する
 *      - `ak_list_removal`: **AK が list から contact を外す**必要がある（自動化されていなければ外れない）
 *
 * ⚠️ Single Send は**送信時点の list 内容**へ送る。したがって「送信前に外す」ことさえできれば
 *    未来の号からは確実に消える。**逆に、外す処理が動いていなければ 10 通まで届き続ける**。
 */

/** 離脱の引き金（事業側の定義。ここを勝手に増やさない） */
export const EXIT_TRIGGERS = Object.freeze([
  'unsubscribe', 'bounce', 'complaint', 'open', 'click', 'site_revisit', 'purchase',
]);

/** 何が「外す」役を担うか */
export const REMOVAL_BY = Object.freeze({
  SENDGRID_SUPPRESSION: 'sendgrid_suppression',
  AK_LIST_REMOVAL: 'ak_list_removal',
  NONE: 'none',
});

const bool = (v) => v === true;

/**
 * @param {{
 *   provider: {
 *     openTracking: boolean, clickTracking: boolean,
 *     webhook: {enabled: boolean, open: boolean, click: boolean, bounce: boolean,
 *               spam_report: boolean, unsubscribe: boolean, group_unsubscribe: boolean},
 *     suppressionGroupAttached: boolean,
 *   },
 *   ak: {
 *     prospectEventsEnabled: boolean,   // webhook を prospect へ反映しているか
 *     listRemovalAutomated: boolean,    // 反応者を list から外す処理が**動いている**か
 *     perRecipientLinkId: boolean,      // リンクに受信者識別子があるか（サイト再訪の紐付け）
 *     purchaseSignalWired: boolean,     // 購入を prospect の反応として扱う配線があるか
 *   },
 * }} facts
 * @returns {{ok: boolean, triggers: object, gaps: string[], summary: object}}
 */
export function evaluateExitReadiness({ provider, ak } = {}) {
  const p = provider || {};
  const w = p.webhook || {};
  const a = ak || {};
  const webhookLive = bool(w.enabled) && bool(a.prospectEventsEnabled);

  const t = {};

  // ── SendGrid の suppression が自動で外すもの ──────────────────
  t.unsubscribe = {
    detected: webhookLive && bool(w.group_unsubscribe),          // AK 台帳へ残せるか
    removedFromFutureSends: bool(p.suppressionGroupAttached),     // 除外そのものは自動
    by: bool(p.suppressionGroupAttached) ? REMOVAL_BY.SENDGRID_SUPPRESSION : REMOVAL_BY.NONE,
    note: '配信停止グループを付けていれば SendGrid が自動で除外する',
  };
  t.bounce = {
    detected: webhookLive && bool(w.bounce),
    removedFromFutureSends: true,
    by: REMOVAL_BY.SENDGRID_SUPPRESSION,
    note: 'bounce は provider の suppression に入る',
  };
  t.complaint = {
    detected: webhookLive && bool(w.spam_report),
    removedFromFutureSends: true,
    by: REMOVAL_BY.SENDGRID_SUPPRESSION,
    note: '苦情も provider の suppression に入る',
  };

  // ── AK が外さないと外れないもの ────────────────────────────
  t.open = {
    detected: webhookLive && bool(p.openTracking) && bool(w.open),
    removedFromFutureSends: bool(a.listRemovalAutomated),
    by: bool(a.listRemovalAutomated) ? REMOVAL_BY.AK_LIST_REMOVAL : REMOVAL_BY.NONE,
    note: '開封は検知できても、list から外さない限り次の号が届く',
  };
  t.click = {
    detected: webhookLive && bool(p.clickTracking) && bool(w.click),
    removedFromFutureSends: bool(a.listRemovalAutomated),
    by: bool(a.listRemovalAutomated) ? REMOVAL_BY.AK_LIST_REMOVAL : REMOVAL_BY.NONE,
    note: 'click 計測が無効だとイベント自体が発生しない',
  };
  t.site_revisit = {
    detected: bool(a.perRecipientLinkId),
    removedFromFutureSends: bool(a.listRemovalAutomated),
    by: bool(a.listRemovalAutomated) ? REMOVAL_BY.AK_LIST_REMOVAL : REMOVAL_BY.NONE,
    note: 'リンクに受信者識別子が無いと、匿名の再訪をアドレスへ紐付けられない',
  };
  t.purchase = {
    detected: bool(a.purchaseSignalWired),
    removedFromFutureSends: bool(a.listRemovalAutomated),
    by: bool(a.listRemovalAutomated) ? REMOVAL_BY.AK_LIST_REMOVAL : REMOVAL_BY.NONE,
    note: '購入を prospect の反応として扱う配線が要る',
  };

  const gaps = [];
  for (const key of EXIT_TRIGGERS) {
    const x = t[key];
    if (!x.detected) gaps.push(`${key}: 検知できない`);
    if (!x.removedFromFutureSends) gaps.push(`${key}: 次の号から外れない`);
  }

  const satisfied = EXIT_TRIGGERS.filter((k) => t[k].detected && t[k].removedFromFutureSends);
  return {
    ok: gaps.length === 0,
    triggers: t,
    gaps,
    summary: {
      成立している引き金: satisfied,
      成立していない引き金: EXIT_TRIGGERS.filter((k) => !satisfied.includes(k)),
      自動で外れる経路: REMOVAL_BY.SENDGRID_SUPPRESSION,
      AKが外す必要がある経路: REMOVAL_BY.AK_LIST_REMOVAL,
    },
  };
}

/**
 * 足りないものに対する**最小の直し方**（自前の配送基盤は作らない）。
 * ⚠️ ここは「何をすれば埋まるか」を書くだけで、実行はしない。
 */
export function minimalFixes(readiness) {
  const t = (readiness && readiness.triggers) || {};
  const fixes = [];
  if (t.open && !t.open.removedFromFutureSends) {
    fixes.push({
      id: 'automate_list_removal',
      what: '反応・抑止した prospect を 3 つの list から外す処理を定期実行する',
      how: '既にある `buildExitPlan()` ＋ `removeContactsFromList()` を cron から呼ぶ（1 日 1 回・送信前）',
      newBuild: '無し（配線のみ）',
      approval: 'deploy が要る',
    });
  }
  if (t.unsubscribe && !t.unsubscribe.detected) {
    fixes.push({
      id: 'enable_group_unsubscribe_event',
      what: 'Event Webhook の `group_unsubscribe` を ON にする',
      how: 'SendGrid の画面（Mail Settings → Event Webhook）でトグル 1 つ',
      newBuild: '無し',
      approval: 'SendGrid 設定変更',
    });
  }
  if (t.click && !t.click.detected) {
    fixes.push({
      id: 'click_tracking_decision',
      what: 'click を反応として使うか決める',
      how: 'click tracking は**アカウント全体設定**で、ON にすると transactional の magic link も書き換わる。'
        + '当面は **open を主シグナル**にして click は当てにしない（既存方針どおり）',
      newBuild: '無し',
      approval: '方針判断のみ',
    });
  }
  if (t.site_revisit && !t.site_revisit.detected) {
    fixes.push({
      id: 'defer_site_revisit',
      what: 'サイト再訪の紐付けは**今回の選別では使わない**',
      how: 'リンクに受信者識別子を足す実装が要る（custom field ＋ 着地の記録）。'
        + '最小構成の範囲外なので、選別完了後に別途判断する',
      newBuild: '要（今回は見送り）',
      approval: '方針判断のみ',
    });
  }
  if (t.purchase && !t.purchase.detected) {
    fixes.push({
      id: 'purchase_via_promotion',
      what: '購入者は **Customers へ昇格した人**として list から外す',
      how: '上の定期実行の対象に `PROMOTED` と「Customers に存在するアドレス」を含める',
      newBuild: '無し（同じ cron の対象集合を広げるだけ）',
      approval: 'deploy が要る',
    });
  }
  return fixes;
}

export default evaluateExitReadiness;
