/**
 * キャンペーン送信計画のための **名指し取得** ヘルパー（純粋・Airtable 非依存）。
 *
 * ── なぜ必要か ────────────────────────────────────────────────
 * `admin-marketing.js` の送信計画は Customers を **全件走査**して
 * `recordId → 顧客判定` の Map を作っていた。走査は `MAX_PAGES=40`
 * （= 4,000 件）で **黙って打ち切られる**（`break` するだけでエラーにならない）。
 *
 * Customers が 15,967 件へ増えた結果、これが 2 つの実害を生んだ:
 *
 *   1. 4,000 件目より後ろの顧客は `byId` に載らず、送信計画で
 *      `unknown_customer` として**黙って除外**される。
 *      → 「送ったつもりで送っていない」。実際にカナリア受信者が除外された。
 *   2. 既送信突合（`CampaignDeliveries`）も同じ打ち切りに晒される。
 *      配信実績が 4,000 行を超えた時点で `deliveredKeys` が**不完全**になり、
 *      `already_delivered` を判定できない = **二重送信の防壁が静かに壊れる**。
 *
 * 全件走査は Netlify Function の実行時間（最大 26 秒）では原理的に不可能
 * （15,967 件 = 160 ページ ≈ 170 秒）。ページ上限を上げても直らない。
 * `imp-2026-08-09-001` の 504 と同じ構図で、対処も同じ **名指し取得**にする。
 *
 * ── 方針 ──────────────────────────────────────────────────
 * - 送信計画は **選ばれた recordId / その宛先メール**だけを引く。
 *   コストは対象件数に比例し、テーブル全体の大きさに依存しない。
 * - 長い formula は URL に載らないので、呼び出し側は `listRecords` (POST) を使う。
 * - 取り切れなかったら **例外**。黙って短い結果を返さない（fail closed）。
 */

/** Airtable の formula 1 本に詰める識別子の数。長すぎる formula は分割する。 */
export const TARGETED_CHUNK = 50;

/** 名指し取得 1 チャンクあたりのページ上限（100 件 × これ）。 */
export const TARGETED_MAX_PAGES = 20;

/** 配列を size ごとに区切る。空要素・重複は落とす。 */
export function chunkList(values, size = TARGETED_CHUNK) {
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : TARGETED_CHUNK;
  const seen = new Set();
  const flat = [];
  for (const v of Array.isArray(values) ? values : []) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    flat.push(s);
  }
  const out = [];
  for (let i = 0; i < flat.length; i += n) out.push(flat.slice(i, i + n));
  return out;
}

/**
 * Airtable の文字列リテラルとして安全な形へ。
 * シングルクォートを含む識別子は **採用しない**（formula injection を作らない）。
 * recordId / DeliveryKey は英数字なので、これで実害は無い。
 */
export function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
}

/** `OR(RECORD_ID()='rec1',RECORD_ID()='rec2',...)` */
export function buildRecordIdFormula(ids) {
  const safe = (Array.isArray(ids) ? ids : []).filter(isSafeIdentifier);
  if (safe.length === 0) return null;
  return `OR(${safe.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
}

/** `AND({CampaignType}='x:v1', OR({DeliveryKey}='..',...))` */
export function buildDeliveryKeyFormula({ campaignType, keys }) {
  const safeKeys = (Array.isArray(keys) ? keys : []).filter(isSafeIdentifier);
  if (safeKeys.length === 0) return null;
  const ct = typeof campaignType === 'string' ? campaignType.trim() : '';
  if (!ct || !/^[A-Za-z0-9_:.-]{1,120}$/.test(ct)) return null;
  const or = `OR(${safeKeys.map((k) => `{DeliveryKey}='${k}'`).join(',')})`;
  return `AND({CampaignType}='${ct}',${or})`;
}

/**
 * `OR({JobId}='mkt-..',...)` — **ScheduledEmails のジョブ行**を名指しで引く。
 *
 * ⚠️ `buildJobIdFormula` は **CampaignDeliveries** 用（列名が
 *    `ScheduledEmailJobId`）。取り違えると 0 件が返り、
 *    「送ったのに進んでいない」と誤読する。
 */
export function buildScheduledJobIdFormula(jobIds) {
  const safe = (Array.isArray(jobIds) ? jobIds : []).filter(isSafeIdentifier);
  if (safe.length === 0) return null;
  return `OR(${safe.map((id) => `{JobId}='${id}'`).join(',')})`;
}

/** `OR({ScheduledEmailJobId}='mkt-..',...)` — ジョブに紐づく配信行だけを引く */
export function buildJobIdFormula(jobIds) {
  const safe = (Array.isArray(jobIds) ? jobIds : []).filter(isSafeIdentifier);
  if (safe.length === 0) return null;
  return `OR(${safe.map((id) => `{ScheduledEmailJobId}='${id}'`).join(',')})`;
}

/**
 * ScheduledEmails から**マーケティングのジョブだけ**を引く formula。
 *
 * 判定は `marketingDispatchGate.js#isMarketingJob` と同じ 3 条件（どれか 1 つで該当）。
 * ⚠️ Airtable の `=` は大小を区別するので `LOWER()` を通す（JS 側も lowercase で比較している）。
 * ⚠️ 取りこぼすと共有 executor 側の扱いがズレるため、**広めに**判定する。
 */
export const MARKETING_JOB_FORMULA = "OR(LOWER({CreatedBy})='admin-marketing',"
  + "FIND('campaign:',LOWER({TargetPlan}&''))=1,"
  + "FIND('mkt-',LOWER({JobId}&''))=1)";

/**
 * 取り切れたかを検証する。取りこぼしがあれば投げる。
 *
 * 「打ち切ったので短い結果を返す」は、この経路では**必ず誤送信か二重送信になる**。
 * 呼び出し側に握り潰させないため、戻り値ではなく例外にする。
 */
export function assertFetchComplete({ table, offset, pages, maxPages }) {
  if (!offset) return true;
  throw new Error(
    `${table || 'table'}: 名指し取得が ${pages}/${maxPages} ページで打ち切られました`
    + '（結果が不完全なため中止します）',
  );
}

/**
 * 名指しで引いた結果が、要求した件数を満たしているか検証する。
 *
 * Airtable 側で削除された等で足りないことはあり得るので、**足りない事実**を
 * 呼び出し側へ返す（例外にはしない）。送信計画は「見つからない = 除外」で
 * fail closed に倒れるため、ここでは観測できる形にするのが目的。
 */
export function summarizeTargetedFetch({ requested, received }) {
  const req = Array.isArray(requested) ? requested.length : 0;
  const gotIds = new Set((Array.isArray(received) ? received : []).map((r) => r && r.id).filter(Boolean));
  const missing = (Array.isArray(requested) ? requested : []).filter((id) => !gotIds.has(id));
  return { requested: req, received: gotIds.size, missing, complete: missing.length === 0 };
}
