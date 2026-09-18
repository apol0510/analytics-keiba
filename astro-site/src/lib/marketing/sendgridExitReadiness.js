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

/**
 * ── V2 Segment で「開封したら外れる」を作れるか（2026-09-18 本番実測）──────────
 *
 * **作れない。** Segment V2 の SGQL は本番アカウントで次のように検証される
 * （`POST /v3/marketing/segments/2.0` のバリデータが返した実メッセージ）:
 *
 * | 試した式 | 返答 |
 * |---|---|
 * | `CONTAINS(list_ids, '…')` | `unsupported SQL function: 'CONTAINS'` |
 * | `last_opened is null` | `illegal column name … 'last_opened' referenced for table: 'contact_data'` |
 * | `last_clicked` / `last_emailed` / `singlesend_id` / `automation_id` | 同上（**contact_data の列として存在しない**）|
 * | `… in (select contact_id from singlesend_data …)` | `illegal table name: 'singlesend_data'` |
 * | `automation_data` / `engagement_data` / `email_activity` / `message_data` / `singlesends` / `events` / `campaign_data` | すべて `illegal table name` |
 * | `list_ids` / `email` / `created_at` | **201 Created**（＝使える）|
 *
 * ⚠️ `GET /v3/marketing/field_definitions` の `reserved_fields` には `last_opened` などが
 *    載っているが、**Segment のクエリでは使えない**（載っていることと使えることは別）。
 * ⚠️ 検証で作った一時 segment は**すべて削除済み**（残っているのは `keiba-intelligence` のみ）。
 * ⚠️ 確かめたのは **API のバリデータ**。画面の segment builder で engagement 条件が
 *    出るかどうかは**未確認**（出るなら、その segment を Single Send から参照する案は成立しうる）。
 */
export const SEGMENT_CAPABILITY = Object.freeze({
  測定日: '2026-09-18',
  使えるテーブル: Object.freeze(['contact_data']),
  使える列: Object.freeze(['list_ids', 'email', 'created_at']),
  使えない列: Object.freeze(['last_opened', 'last_clicked', 'last_emailed', 'singlesend_id', 'automation_id']),
  使えないテーブル: Object.freeze([
    'singlesend_data', 'automation_data', 'engagement_data', 'email_activity',
    'message_data', 'singlesends', 'events', 'campaign_data',
  ]),
  使えない関数: Object.freeze(['CONTAINS']),
  画面のsegment_builder: '未確認',
});

/**
 * 「SendGrid の segment だけで開封離脱を作れるか」。
 * **作れないときは理由を返す**（黙って false にしない）。
 */
export function canUseNativeSegmentExit(capability = SEGMENT_CAPABILITY) {
  const cap = capability || {};
  const cols = new Set(cap['使える列'] || []);
  const tables = new Set(cap['使えるテーブル'] || []);
  const engagementColumn = ['last_opened', 'last_clicked'].some((c) => cols.has(c));
  const engagementTable = ['singlesend_data', 'engagement_data', 'engagement_events']
    .some((t) => tables.has(t));
  if (engagementColumn || engagementTable) return { ok: true, reason: null };
  return {
    ok: false,
    reason: 'segment_has_no_engagement_fields',
    detail: '開封・クリックを表す列もテーブルも Segment V2 のクエリで使えない（本番のバリデータが拒否）',
  };
}

/**
 * segment が使えないときの**代わりの外し方**。
 *
 * ⚠️ **新しい日次 cron を作らない**のが目的なので、**既にある webhook の中で外す**。
 *    `sendgrid-webhook.js` は既に open / bounce / 苦情 / 配信停止を受けて
 *    prospect の状態を更新している。**その同じ処理の中で list から外す**のが最小。
 */
export const EXIT_MECHANISM = Object.freeze({
  NATIVE_SEGMENT: 'native_segment',
  WEBHOOK_LIST_REMOVAL: 'webhook_list_removal',
  DAILY_CRON: 'daily_cron',
});

export function chooseExitMechanism(capability = SEGMENT_CAPABILITY) {
  const native = canUseNativeSegmentExit(capability);
  if (native.ok) {
    return {
      mechanism: EXIT_MECHANISM.NATIVE_SEGMENT,
      newCron: false,
      why: 'segment が engagement を条件にできるなら、宛先を segment にするだけで自動的に外れる',
    };
  }
  return {
    mechanism: EXIT_MECHANISM.WEBHOOK_LIST_REMOVAL,
    newCron: false,
    why: `${native.detail}。既存の Event Webhook の処理内で list から外せば、`
      + '新しい日次 cron を作らずに次の号の前に外せる',
    fallback: EXIT_MECHANISM.DAILY_CRON,
  };
}

/**
 * ⚠️ **open は「人が読んだ」と同義ではない**（正本に残す）。
 *
 * - Apple Mail Privacy Protection は**受信者が開いていなくても**画像を先読みして open を立てる
 * - 画像をブロックする環境では**開いていても** open が立たない
 * - したがって open を離脱シグナルにすると、**誤って外す**／**外し損ねる**の両方が起きる
 *
 * 本件では「反応があれば選別を打ち切って DRM へ」なので、**誤って外す方向に倒れる**のは
 * 「送りすぎない」側であり、選別の目的（無反応者の除外）とは矛盾しない。
 * 逆に open が立たない人は最大 10 通まで届くだけで、こちらも設計どおり。
 */
export const OPEN_SIGNAL_LIMITS = Object.freeze({
  誤検知: 'Apple MPP などの先読みで、開いていない人にも open が立つ',
  検知漏れ: '画像ブロック環境では、開いた人でも open が立たない',
  方針: 'open は「反応の可能性」であって「人の意思」ではない。打ち切り（EXHAUSTED）は delivered 10 通を分母にする既存判定のまま変えない',
});

export default evaluateExitReadiness;
