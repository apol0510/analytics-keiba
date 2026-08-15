/**
 * マーケティングキャンペーンの実送信 dispatcher（AK 独自 / 既定 OFF）
 *
 * ── なぜ専用 dispatcher なのか ────────────────────────────────────────
 * 共有の `execute-scheduled-emails-background` は `NEWSLETTER_AUTOMATION_ENABLED` に
 * 依存する。これは AK の**全メール自動化のマスタースイッチ**で、実測 16 Function が参照し、
 * ON にするとメルマガ・期限通知・再送・滞留 PENDING まで同時に解禁される。
 * マーケティングのためだけにそれを ON にはできない。
 *
 * そこでキャンペーンだけを送る dispatcher を分け、ゲートも
 * **`MARKETING_CAMPAIGN_DISPATCH_ENABLED` だけ**にした（`NEWSLETTER_AUTOMATION_ENABLED` は見ない）。
 * 逆向きの漏れも塞いである: 共有 executor 側はマーケティングジョブを専用ゲート無しでは処理しない
 * （`marketingDispatchGate.canSharedExecutorSend`）。
 *
 * ── 送信直前の再検証（本 dispatcher の中核）──────────────────────────
 * キュー登録（dry-run 確定）と実送信の間には時間差がある。その間に配信停止・バウンス・退会が
 * 起きても、固定宛先リストのジョブは**そのまま送られてしまう**（共有 executor は explicit な
 * 宛先に対して再チェックをしない）。ここでは 1 通ごとに
 *   provider suppression / EmailBlacklist / 配信停止 / 退会
 * を再判定し、該当したら送らずに `skipped-*` で台帳へ記録する。
 * provider suppression を確認できない場合は **1 通も送らない**（fail closed）。
 *
 * ── 実行方法 ────────────────────────────────────────────────────
 * POST + `x-admin-secret`（admin-marketing と同じ secret）。cron からは呼ばない
 * （承認された時にだけ人が叩く）。`dryRun:true` なら送信せず対象と再検証結果だけ返す。
 *
 * ⚠️ Customers へは一切書かない。書くのは CampaignDeliveries と ScheduledEmails のみ。
 * ⚠️ 決済メール v2 のフィールドには触れない。
 */

import {
  isMarketingDispatchEnabled,
  isMarketingClickTrackingEnabled,
  isMarketingJob,
  verifyBeforeSend,
} from '../../src/lib/marketing/marketingDispatchGate.js';
import {
  fetchProviderSuppression,
  describeProviderSuppression,
} from '../../src/lib/marketing/providerSuppression.js';
import {
  fetchEmailBlacklistReadOnly,
  buildBlacklistEmailSet,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import {
  UNSUBSCRIBE_PLACEHOLDER, applyUnsubscribeUrl, applyGrantExpiry,
  describeGrantExpiry, plainTextFromMarketingHtml,
  MARKETING_EMAIL_SHELL_VERSION, readShellVersionFromNote,
} from '../../src/lib/marketing/marketingEmailShell.js';
import { evaluateExtraAudience } from '../../src/lib/marketing/campaignAudienceRules.js';
import {
  chunkList, assertFetchComplete, TARGETED_CHUNK, TARGETED_MAX_PAGES,
} from '../../src/lib/marketing/marketingTargetedLoad.js';
import {
  linkOfferForRecipient,
  requiresOfferUrl,
  OFFER_URL_PLACEHOLDER,
} from '../../src/lib/promotions/offerCampaignLink.js';
import { OFFERS_TABLE, getOfferSecret } from '../../src/lib/promotions/promotionalOffer.js';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import {
  createDispatchLock, DISPATCH_LOCK_TTL_SEC, LOCK_FAIL, DispatchLockError,
} from '../../src/lib/marketing/dispatchLock.js';
import {
  indexDeliveriesByRecipient,
  buildCampaignCustomArgs,
} from '../../src/lib/marketing/campaignCustomArgs.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
const SCHEDULED_TABLE = 'ScheduledEmails';
/** 1 回の実行で送る上限（暴走防止） */
const MAX_PER_RUN = 200;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

const authHeaders = (key) => ({ Authorization: `Bearer ${key}` });

/** ジョブの Notes に残した内容 hash（何を送るかの照合用。PII は含まない） */
function readContentHashFromNote(note) {
  const m = String(note ?? '').match(/content:([0-9a-f]{6,32})/i);
  return m ? m[1] : '';
}

async function fetchAll({ KEY, BASE, table, filterByFormula }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= 40) break;
  } while (offset);
  return out;
}

/**
 * 指定アドレスのレコードだけを `listRecords`（POST）で引く。
 *
 * 全件走査は `fetchAll` の 40 ページ打ち切りに当たり、後ろのレコードを黙って捨てる。
 * 送信直前の再検証でそれをやると、配信停止・停止アカウントの判定を通り抜ける。
 * 取り切れなければ**例外**にして、短い結果のまま送らせない。
 */
async function fetchByEmailsReadOnly({ KEY, BASE, table, emails, extraCondition = null }) {
  const out = [];
  for (const group of chunkList(emails, TARGETED_CHUNK)) {
    const safe = group.filter((e) => !e.includes("'"));
    if (safe.length === 0) continue;
    const or = `OR(${safe.map((e) => `LOWER({Email})='${e}'`).join(',')})`;
    const formula = extraCondition ? `AND(${extraCondition},${or})` : or;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/listRecords`,
        {
          method: 'POST',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`${table} targeted fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      if (offset && pages >= TARGETED_MAX_PAGES) {
        assertFetchComplete({ table, offset, pages, maxPages: TARGETED_MAX_PAGES });
      }
    } while (offset);
  }
  return out;
}

/** 宛先ぶんの Customers だけを引く。 */
function fetchCustomersByEmails({ KEY, BASE, emails }) {
  return fetchByEmailsReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE, emails });
}

/** 宛先ぶんのキャンペーン配信履歴だけを引く（24h 横断ガードの入力）。 */
async function fetchCampaignDeliveriesForEmails({ KEY, BASE, emails }) {
  const out = [];
  for (const group of chunkList(emails, TARGETED_CHUNK)) {
    const safe = group.filter((e) => !e.includes("'"));
    if (safe.length === 0) continue;
    const formula = `AND({EmailType}='campaign',OR(${safe
      .map((e) => `LOWER({RecipientEmail})='${e}'`).join(',')}))`;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
        {
          method: 'POST',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`${DELIVERIES_TABLE} targeted fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      if (offset && pages >= TARGETED_MAX_PAGES) {
        assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: TARGETED_MAX_PAGES });
      }
    } while (offset);
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  const SG = process.env.SENDGRID_API_KEY;

  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const dryRun = req.dryRun !== false; // 既定 true（明示的に false のときだけ実送信）

  // 🛡️ 実送信はマーケティング専用ゲートが true のときだけ。既定 OFF。
  if (!dryRun && !isMarketingDispatchEnabled(process.env)) {
    return json(503, {
      error: 'キャンペーン送信は無効です（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）',
      flag: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
      note: 'このゲートは NEWSLETTER_AUTOMATION_ENABLED とは独立です（既存メール経路を解禁しません）',
      sideEffects: 'none',
    });
  }
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });
  if (!dryRun && !SG) return json(503, { error: 'SENDGRID_API_KEY 未設定', sideEffects: 'none' });

  // ── 実送信は「どのジョブを・何名へ」を明示したときだけ ──────────────
  // jobId を省いた live 実行は、送信待ちのジョブを**全部**送ってしまう。
  // 画面は必ずジョブを 1 件指定するので、指定が無い live は受け付けない。
  const jobIdFilter = req.jobId ? String(req.jobId) : null;
  if (!dryRun) {
    if (!jobIdFilter) {
      return json(400, { error: '送信するジョブ（jobId）を指定してください', sideEffects: 'none' });
    }
    if (!Number.isFinite(Number(req.expectedWillSend))) {
      return json(400, {
        error: '確認した送信予定人数（expectedWillSend）が必要です。先に配信内容を確認してください。',
        sideEffects: 'none',
      });
    }
  }

  // ── 同一ジョブの live を 1 本だけ通す（原子的排他）─────────────────
  //
  // ⚠️ `alreadySent` は「読んだ時点の事実」でしかない。読んでから記録するまでの
  //    間に**同じ jobId の live がもう 1 本**走ると、両方が「まだ誰も送っていない」
  //    を読み、両方が `expectedWillSend` を通り、**同じ相手へ 2 通**送れる
  //    （二重クリック / HTTP retry / Function の並行起動）。
  //    逐次再実行の冪等性だけでは塞げないので、送信の前に鍵を取る。
  //
  // dryRun は書かないので鍵を取らない（確認は何本走ってもよい）。
  let lock = null;
  let lockToken = null;
  if (!dryRun) {
    try {
      lock = createDispatchLock({ cmd: makeRedisCmd(process.env) });
    } catch (e) {
      // Redis が無い / 設定されていない = **排他できない**。送らない。
      return json(503, {
        error: '二重送信を防ぐ排他を利用できないため中止しました（送信していません）。',
        code: LOCK_FAIL.UNAVAILABLE, sideEffects: 'none',
      });
    }
    try {
      const got = await lock.acquire({ jobId: jobIdFilter, ttlSec: DISPATCH_LOCK_TTL_SEC });
      if (!got.ok) {
        return json(409, {
          error: 'このジョブは別の実行が処理中です（二重送信を避けるため中止しました）。',
          code: LOCK_FAIL.BUSY, jobId: jobIdFilter, sideEffects: 'none',
        });
      }
      lockToken = got.token;
    } catch (e) {
      // 取れたかどうか**分からない**ときも送らない（fail closed）
      return json(503, {
        error: '排他の状態を確認できないため中止しました（送信していません）。',
        code: (e instanceof DispatchLockError && e.code) || LOCK_FAIL.UNAVAILABLE,
        sideEffects: 'none',
      });
    }
  }

  // ── 実行 → 解放 → 応答（この順序に意味がある）────────────────────
  //
  // ⚠️ **解放の失敗を「送信の失敗」にしてはいけない。**
  //    メールは既に出ている。`sent` を 0 へ巻き戻すと、運用者は
  //    「送れていない」と読んで**もう一度送る**。事実（送信結果）はそのまま返し、
  //    解放の可否は `lockRelease` として**別の欄**に載せる。
  //
  // ⚠️ 同時に「解放できなかった」を黙って握り潰すのも駄目。
  //    鍵が残っている間、同じジョブの再実行は `busy` で弾かれる。
  //    **TTL が切れるまで再実行しないこと**を運用者へ明示する。
  let result;
  try {
    result = await dispatch({
      KEY, BASE, SG, dryRun, jobIdFilter,
      expectedWillSend: dryRun ? null : Number(req.expectedWillSend),
      lock, lockToken,
    });
  } catch (e) {
    console.error('❌ [marketing-dispatch]', e.message);
    result = json(500, { error: 'internal error' });
  }

  if (!lock || !lockToken) return result;

  // 解放そのものが例外でも**送信結果を失わない**
  let rel;
  try {
    rel = await lock.release({ jobId: jobIdFilter, token: lockToken });
  } catch (e) {
    // ⚠️ 例外の中身（URL・token を含みうる）は載せない。理由コードだけ
    rel = { ok: false, reason: (e && e.code) || LOCK_FAIL.UNAVAILABLE };
  }
  return withLockRelease(result, { rel, jobId: jobIdFilter });
};

/**
 * 応答へ `lockRelease` を足す（**送信結果は 1 バイトも書き換えない**）。
 *
 * 解放できなかったときは、鍵が TTL で開くまで同じジョブを再実行してはいけない。
 * 自動再実行の材料にならないよう `retryAfterSec` は**目安として**返し、
 * 「自動で再実行しない」ことを文言でも明示する。
 */
function withLockRelease(res, { rel, jobId }) {
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch { return res; }

  body.lockRelease = { ok: rel.ok === true, reason: rel.ok === true ? null : String(rel.reason || 'unknown') };

  if (!rel.ok) {
    body.lockRelease.retryAfterSec = DISPATCH_LOCK_TTL_SEC;
    // ⚠️ **文言は事実に合わせる。**
    //    dispatch は送信前に 409（人数不一致・鍵の奪取）や 503 で止まることがある。
    //    その場合 `sent` は 0 なのに「送信は完了しています」と書くと、
    //    運用者は「送れたのに解放だけ失敗した」と誤解する（逆方向の事故）。
    const sent = Number(body.sent);
    const sentKnown = Number.isFinite(sent);
    body.warning = (sentKnown && sent > 0
      ? `${sent} 通の送信処理は完了していますが、実行ロックを解放できませんでした。`
      : 'メール送信は行われていません。実行ロックを解放できませんでした。')
      + `同じジョブの再実行は約 ${DISPATCH_LOCK_TTL_SEC} 秒（ロックの期限）待ってください。`
      + '**自動で再実行しないでください**'
      + (sentKnown ? '（送信件数はこの応答のとおりです）。' : '（送信件数はこの応答から確認できません）。');
    // ログにも理由コードだけを残す（アドレス・URL・token は出さない）
    console.warn('⚠️ [marketing-dispatch] lock release 失敗:', {
      jobId, reason: body.lockRelease.reason, sent: sentKnown ? sent : null,
    });
  }
  return { ...res, body: JSON.stringify(body) };
}

async function dispatch({ KEY, BASE, SG, dryRun, jobIdFilter, expectedWillSend = null, lock = null, lockToken = null }) {
  const now = Date.now();
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const fromName = getBrandConfig(BRAND).defaultFromName;
  // 返信先。brand-config が正本。未設定のブランドでは付けない（勝手に窓口を作らない）
  const replyToCfg = getBrandConfig(BRAND);
  const replyTo = replyToCfg.replyToEmail
    ? { email: replyToCfg.replyToEmail, name: replyToCfg.replyToName || replyToCfg.defaultFromName }
    : null;
  validateBrandFromEmail(BRAND, fromEmail);

  // 1) 対象ジョブ = PENDING かつ マーケティングのタグを持つものだけ
  const scheduled = await fetchAll({ KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{Status}='PENDING'` });
  const jobs = scheduled
    .filter((r) => isMarketingJob(r.fields))
    .filter((r) => !jobIdFilter || String(r.fields.JobId || '') === jobIdFilter);

  if (jobs.length === 0) {
    return json(200, { mode: dryRun ? 'dry-run' : 'live', jobs: 0, sent: 0, skipped: 0, sideEffects: 'none', notice: '送信待ちのキャンペーンジョブはありません。' });
  }

  // 2) 送信直前の再検証に使う集合をまとめて読む
  const provider = await fetchProviderSuppression({ apiKey: SG, now });
  if (!provider.ok) {
    return json(503, {
      error: 'SendGrid の配信停止リストを確認できないため中止しました（確認できないまま送信しません）',
      detail: describeProviderSuppression(provider),
      sideEffects: 'none',
    });
  }
  const blRecords = await fetchEmailBlacklistReadOnly(BASE, KEY).catch(() => null);
  if (blRecords === null) {
    return json(503, { error: 'EmailBlacklist を読めないため中止しました', sideEffects: 'none' });
  }
  const hardBlocked = buildBlacklistEmailSet(blRecords);
  const blocked = new Set(hardBlocked);
  for (const r of blRecords) {
    const e = String(r?.fields?.Email || '').trim().toLowerCase();
    if (e) blocked.add(e); // 販促メールは SOFT_BOUNCE も送らない
  }

  // 🛡️ 再検証に要る顧客・履歴は、**このジョブの宛先ぶんだけ**名指しで引く。
  //
  //    以前は Customers / CampaignDeliveries を全件走査していたが、`fetchAll` は
  //    40 ページ（4,000 件）で **黙って打ち切る**。Customers が 15,967 件へ増えた結果:
  //      - 4,000 件目より後ろの宛先が `fieldsByEmail` に載らず、キャンペーン固有条件が
  //        `campaign_mismatch` で落ちる（実際にカナリアが送れなかった）
  //      - `unsubscribed` / `suspended` も打ち切られた範囲でしか作られない
  //        = **配信停止した人を送信対象から外し損ねる**
  //    宛先ぶんだけなら件数に比例し、テーブルの大きさに依存しない。
  const jobEmails = [...new Set(
    jobs.flatMap((r) => String(r.fields?.Recipients || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  )];

  // キャンペーン横断の最終送信日時（**このジョブ自身の記録は除く**。
  // 自分の queued レコードを見て自分を止めてしまわないようにする）
  const campaignDeliveries = await fetchCampaignDeliveriesForEmails({ KEY, BASE, emails: jobEmails })
    .catch(() => []);

  const customers = await fetchCustomersByEmails({ KEY, BASE, emails: jobEmails });
  const unsubscribed = new Set();
  /**
   * AK 側が意図的に止めたアカウント（suspended / banned 等）。
   * ⚠️ **退会（withdrawn / WithdrawalRequested）は含めない**。退会は課金停止の契約状態であって
   *    メール拒否ではない（退会受付メールでも「メルマガは引き続き配信されます」と案内している）。
   *    メールを止める意思表示は `UnsubscribedAnalyticsKeiba` と provider suppression が担う。
   */
  const suspended = new Set();
  /** 送信直前にキャンペーン固有条件を再判定するための email → fields */
  const fieldsByEmail = new Map();
  /** 割引オファーの突合に使う email → Customers recordId */
  const recordIdByEmail = new Map();
  for (const r of customers) {
    const f = r.fields || {};
    const e = String(f.Email || '').trim().toLowerCase();
    if (!e) continue;
    fieldsByEmail.set(e, f);
    recordIdByEmail.set(e, r.id);
    if (f.UnsubscribedAnalyticsKeiba === true) unsubscribed.add(e);
    const status = String(f.Status || '').trim().toLowerCase();
    if (['suspended', 'inactive', 'banned', 'disabled'].includes(status)) suspended.add(e);
  }

  // env 由来の値（テスト受信者ホワイトリスト）。判定モジュールは純粋なのでここで読む。
  const audienceContext = { testRecipients: new Set(parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients) };

  // 割引オファー案内のジョブが 1 つでもあれば台帳を読む（read-only・1 回だけ）。
  // 生トークンは保存されていないが `signOfferToken` は決定的なので、鍵があれば再生成できる。
  const anyOfferJob = jobs.some((j) => {
    const id = String(j.fields?.TargetPlan || '').replace(/^campaign:/, '').trim();
    return id ? requiresOfferUrl(getCampaign(id)) : false;
  });
  const offerSecret = getOfferSecret(process.env);
  let offerRecords = null;
  if (anyOfferJob) {
    offerRecords = await fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => null);
  }

  // 3) ジョブごとに 1 通ずつ再検証 → 送信
  const summary = {
    jobs: 0, verified: 0, sent: 0, failed: 0, skipped: 0, skippedByReason: {},
    // 組み立て方の版が合わずに送らなかったジョブ数
    blockedJobs: 0,
  };
  const jobResults = [];

  for (const job of jobs) {
    const f = job.fields || {};
    const jobId = String(f.JobId || '');
    const recipients = String(f.Recipients || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (recipients.length === 0) continue;

    // ── 保存されている HTML は「積んだ時点の組み立て方」で作られている ──────
    // その後 deploy でシェルが変わっていると、
    //   ・差し替え印の名前が変わって配信停止を入れられない
    //   ・text/plain の組み立てが保存済みマークアップと噛み合わない
    // といったズレが起きる。**版が違うジョブは送らない**（fail closed）。
    // 送りたい場合は dry-run からやり直して積み直す。
    const jobShellVersion = readShellVersionFromNote(f.Notes);
    if (jobShellVersion !== MARKETING_EMAIL_SHELL_VERSION) {
      jobResults.push({
        jobId, total: recipients.length, willSend: 0, willSkip: recipients.length,
        blocked: 'shell_version_mismatch',
        expectedShellVersion: MARKETING_EMAIL_SHELL_VERSION,
        jobShellVersion,
        note: 'このジョブは別の組み立て方で作られています。dry-run からやり直して積み直してください（送信していません）。',
      });
      summary.blockedJobs = (summary.blockedJobs || 0) + 1;
      continue;
    }
    summary.jobs += 1;

    // このジョブ以外のキャンペーン配信から、受信者ごとの最終送信日時を作る
    const recentContactAtMs = buildRecentContactMap(campaignDeliveries, jobId);

    // ジョブが属するキャンペーン（TargetPlan='campaign:<id>'）。
    // キュー登録後に条件が変わっている可能性があるため、送信直前にも固有条件を再判定する。
    const campaignId = String(f.TargetPlan || '').replace(/^campaign:/, '').trim();
    const jobCampaign = campaignId ? getCampaign(campaignId) : null;

    // 受信者ごとの申込 URL（割引オファー案内のみ）。台帳から**送信直前に再生成**する。
    //   ・キューにもメールログにも生トークンを残さない
    //   ・キュー登録後に redeemed / revoked / 期限切れになっていたら、その人には送らない
    const needsOffer = requiresOfferUrl(jobCampaign);
    const offerUrlByEmail = new Map();

    /**
     * 受信者 → この 1 通の配信レコード（enqueue 時に作られた CampaignDeliveries）。
     * custom_args はここからしか読まない（**DeliveryKey を送信側で作り直さない**）。
     * 行が無い＝配信台帳を作れていないので、その相手には**送らない**（fail closed）。
     */
    const deliveryByEmail = indexDeliveriesByRecipient(campaignDeliveries, jobId);
    /** 受信者 → 刻む custom_args（解決できた相手だけ） */
    const customArgsByEmail = new Map();

    // ── job 単位の冪等性 ─────────────────────────────────────────
    // 通信 retry・二重クリック・途中で落ちた再実行で**同じ人へ二度送らない**。
    // この ジョブ の配信行が既に `sent` なら、その相手はもう送り終えている。
    const alreadySent = new Set(
      (campaignDeliveries || [])
        .filter((r) => String(r.fields?.ScheduledEmailJobId || '') === jobId
          && String(r.fields?.Status || '') === 'sent')
        .map((r) => String(r.fields?.RecipientEmail || '').trim().toLowerCase())
        .filter(Boolean),
    );

    const toSend = [];
    const toSkip = [];
    for (const email of recipients.slice(0, MAX_PER_RUN)) {
      if (alreadySent.has(email)) {
        // 既に送った相手。台帳を書き換える必要も無いので数えるだけ
        summary.skipped += 1;
        summary.skippedByReason.already_sent_in_job = (summary.skippedByReason.already_sent_in_job || 0) + 1;
        summary.verified += 1;
        continue;
      }
      // 🛡️ 顧客レコードを引けない相手には送らない（fail closed）。
      //    `unsubscribed` / `suspended` は Customers から作るため、レコードが無いと
      //    「配信停止していない」ではなく「確認できていない」になる。
      //    取得の打ち切りは `assertFetchComplete` が例外にするので、ここへ来るのは
      //    enqueue 後にレコードが消えた場合。バッチ全体は止めず、この 1 件だけ落とす。
      if (!fieldsByEmail.has(email)) {
        toSkip.push({ email, status: 'skipped-duplicate', reason: 'customer_record_missing' });
        summary.skipped += 1;
        summary.skippedByReason.customer_record_missing =
          (summary.skippedByReason.customer_record_missing || 0) + 1;
        summary.verified += 1;
        continue;
      }
      const v = verifyBeforeSend({
        email, providerSuppressed: provider.emails, blocked, unsubscribed, suspended,
        recentContactAtMs, nowMs: now,
      });
      // キャンペーン固有条件（カナリアのテスト受信者・Premium Plus の PHASE 等）の再確認。
      // キャンペーンが使用停止化・env 変更などで条件を失っていたら送らない（fail closed）。
      if (v.send) {
        if (!jobCampaign) {
          toSkip.push({ email, status: 'skipped-duplicate', reason: 'campaign_unavailable' });
          summary.skipped += 1;
          summary.skippedByReason.campaign_unavailable = (summary.skippedByReason.campaign_unavailable || 0) + 1;
          summary.verified += 1;
          continue;
        }
        const extra = evaluateExtraAudience({
          campaign: jobCampaign, fields: fieldsByEmail.get(email) || null, nowMs: now, context: audienceContext,
        });
        if (!extra.ok) {
          toSkip.push({ email, status: 'skipped-duplicate', reason: 'campaign_mismatch' });
          summary.skipped += 1;
          summary.skippedByReason.campaign_mismatch = (summary.skippedByReason.campaign_mismatch || 0) + 1;
          summary.verified += 1;
          continue;
        }
        // 専用 URL が要るキャンペーンは、有効なオファーが無い相手には**送らない**。
        // 汎用 URL へフォールバックしない（誰も使えない URL を配らないため）。
        if (needsOffer) {
          const link = linkOfferForRecipient({
            records: offerRecords || [],
            customerRecordId: recordIdByEmail.get(email) || '',
            email,
            campaign: jobCampaign,
            secret: offerSecret,
            nowMs: now,
          });
          if (!link.ok) {
            toSkip.push({ email, status: 'skipped-duplicate', reason: link.reason });
            summary.skipped += 1;
            summary.skippedByReason[link.reason] = (summary.skippedByReason[link.reason] || 0) + 1;
            summary.verified += 1;
            continue;
          }
          offerUrlByEmail.set(email, link.url);
        }

        // 配信 1 通を一意に指す識別子を刻む（Phase 1c）。
        // 解決できない相手には**送らない**。紐付けできない配信を増やすと、
        // 台帳に unresolved が積み上がり「反応が無かった」と区別できなくなる。
        const ca = buildCampaignCustomArgs({
          delivery: deliveryByEmail.get(email) || null,
          customerRecordId: recordIdByEmail.get(email) || '',
          campaignId: jobCampaign.campaignId,
          campaignVersion: String(jobCampaign.version),
        });
        if (!ca.ok) {
          toSkip.push({ email, status: 'skipped-duplicate', reason: ca.reason });
          summary.skipped += 1;
          summary.skippedByReason[ca.reason] = (summary.skippedByReason[ca.reason] || 0) + 1;
          summary.verified += 1;
          continue;
        }
        customArgsByEmail.set(email, ca.customArgs);
      }
      summary.verified += 1;
      if (v.send) toSend.push(email);
      else {
        toSkip.push({ email, status: v.status, reason: v.reason });
        summary.skipped += 1;
        summary.skippedByReason[v.reason] = (summary.skippedByReason[v.reason] || 0) + 1;
      }
    }

    // 除外理由はジョブ単位でも数える（画面はこのジョブの内訳だけを出す）
    const skipByReason = {};
    for (const e of toSkip) {
      const r = String(e.reason || 'unknown');
      skipByReason[r] = (skipByReason[r] || 0) + 1;
    }
    jobResults.push({
      jobId,
      campaignId: campaignId || '',
      version: jobCampaign ? String(jobCampaign.version) : '',
      shellVersion: jobShellVersion,
      contentHash: readContentHashFromNote(f.Notes),
      status: String(f.Status || ''),
      // queued = まだ送っていない配信行。既に sent の分は対象から外している
      queued: alreadySent.size > 0 ? recipients.length - alreadySent.size : recipients.length,
      total: recipients.length,
      willSend: toSend.length,
      willSkip: toSkip.length,
      alreadySent: alreadySent.size,
      skipByReason,
    });

    if (dryRun) continue;

    // ── 実送信の直前ガード（確認した内容と食い違ったら送らない）──────
    if (Number.isFinite(expectedWillSend) && toSend.length !== expectedWillSend) {
      return json(409, {
        error: '確認したときと送信対象の人数が変わりました。もう一度配信内容を確認してください。',
        jobId, expected: expectedWillSend, got: toSend.length,
        sideEffects: 'none',
      });
    }

    // 3-a) 送らない相手を台帳へ記録（送信前に確定させる）
    if (toSkip.length > 0) {
      await patchDeliveriesByEmail({ KEY, BASE, jobId, entries: toSkip, now });
    }

    // 🛡️ **SendGrid を叩く直前に鍵がまだ自分のものか確かめる。**
    //    奪われている / 消えている＝別実行が同じジョブを進めた可能性がある。
    //    その場合は 1 通も送らない（確認できない状態で送らない）。
    if (lock && lockToken) {
      let held;
      try {
        held = await lock.verify({ jobId, token: lockToken });
      } catch (e) {
        return json(503, {
          error: '排他の状態を確認できないため送信を中止しました（送信していません）。',
          code: (e instanceof DispatchLockError && e.code) || LOCK_FAIL.UNAVAILABLE,
          jobId, sideEffects: 'none',
        });
      }
      if (!held.ok) {
        return json(409, {
          error: '別の実行がこのジョブを処理したため中止しました（送信していません）。',
          code: held.reason, jobId, sideEffects: 'none',
        });
      }
    }

    // 3-b) 1 通ずつ送る（個別送信。他受信者のアドレスが漏れない）
    for (const email of toSend) {
      let html = String(f.Content || '');
      if (needsOffer) {
        const url = offerUrlByEmail.get(email);
        // ここまで来て URL が無い / 差し込みが残るのは実装不整合。**送らずに記録する**。
        html = url ? html.split(OFFER_URL_PLACEHOLDER).join(url) : html;
        if (!url || html.includes(OFFER_URL_PLACEHOLDER)) {
          await patchDeliveriesByEmail({
            KEY, BASE, jobId, now,
            entries: [{ email, status: 'skipped-duplicate', reason: 'offer_url_unresolved' }],
          });
          summary.skipped += 1;
          summary.skippedByReason.offer_url_unresolved = (summary.skippedByReason.offer_url_unresolved || 0) + 1;
          continue;
        }
      }
      // ここまで来て custom_args が無いのは実装不整合。**送らずに記録する**（fail closed）
      const customArgs = customArgsByEmail.get(email);
      if (!customArgs) {
        await patchDeliveriesByEmail({
          KEY, BASE, jobId, now,
          entries: [{ email, status: 'skipped-duplicate', reason: 'custom_args_unresolved' }],
        });
        summary.skipped += 1;
        summary.skippedByReason.custom_args_unresolved = (summary.skippedByReason.custom_args_unresolved || 0) + 1;
        continue;
      }
      // 無料期間の終了日は**実際の権限状態**から取る（本文の固定値で断定しない）
      const cf = fieldsByEmail.get(email) || {};
      const expiryNote = describeGrantExpiry({
        expiresAt: cf.LightGrantUntil || cf.PremiumGrantUntil || '',
        durationDays: jobCampaign && jobCampaign.grantDurationDays,
      });
      const ok = await sendOne({
        SG, fromEmail, fromName, replyTo, to: email, subject: f.Subject, html, customArgs, expiryNote,
        // クリック計測は**この経路だけ**・env で明示的に有効化したときだけ（既定 OFF）。
        // 配信基盤のアカウント設定は触らない（ログインリンクまで書き換わるため）。
        clickTracking: isMarketingClickTrackingEnabled(process.env),
      });
      if (ok) summary.sent += 1; else summary.failed += 1;
      await patchDeliveriesByEmail({
        KEY, BASE, jobId, now,
        entries: [{ email, status: ok ? 'sent' : 'failed', reason: ok ? null : 'send_failed' }],
      });
    }

    // 3-c) ジョブを終了状態にする
    await patchRecord({
      KEY, BASE, table: SCHEDULED_TABLE, recordId: job.id,
      fields: {
        Status: summary.failed > 0 ? 'FAILED' : 'SENT',
        SentCount: summary.sent,
        FailedCount: summary.failed,
        CompletedAt: new Date(now).toISOString(),
      },
    });
  }

  console.log('📣 [marketing-dispatch]', {
    mode: dryRun ? 'dry-run' : 'live', jobs: summary.jobs,
    verified: summary.verified, sent: summary.sent, skipped: summary.skipped, failed: summary.failed,
  });

  return json(200, {
    mode: dryRun ? 'dry-run' : 'live',
    sideEffects: dryRun ? 'none' : 'CampaignDeliveries / ScheduledEmails のみ',
    ...summary,
    // 画面が「自分が指定したジョブの結果か」を確かめられるように返す
    requestedJobId: jobIdFilter,
    jobResults,
    providerSuppression: describeProviderSuppression(provider),
    notice: dryRun
      ? '再検証のみ。送信も書き込みもしていません。'
      : '送信直前に配信停止・バウンス・退会を再判定したうえで送信しました。',
  });
}

/**
 * 受信者 → 「このジョブ以外の」キャンペーン最終送信日時。
 * 自ジョブの queued レコードを含めると、自分自身を頻度ガードで止めてしまう。
 */
function buildRecentContactMap(deliveries, excludeJobId) {
  const map = new Map();
  for (const rec of deliveries || []) {
    const f = rec.fields || {};
    // 取引メール（step / race_main）は横断頻度に含めない。
    // 取得クエリでも絞っているが、クエリ変更で崩れないようここでも判定する。
    if (f.EmailType !== 'campaign') continue;
    if (String(f.ScheduledEmailJobId || '') === excludeJobId) continue;
    const status = String(f.Status || '');
    if (status !== 'sent' && status !== 'queued') continue;
    const email = String(f.RecipientEmail || '').trim().toLowerCase();
    if (!email) continue;
    const t = Date.parse(f.SentAt || f.QueuedAt || '');
    if (!Number.isFinite(t)) continue;
    const cur = map.get(email);
    if (cur === undefined || t > cur) map.set(email, t);
  }
  return map;
}

/**
 * SendGrid へ 1 通送る。成功なら true。本文・宛先はログへ出さない。
 *
 * `customArgs` は**この 1 通を後から特定するための識別子だけ**（`campaignCustomArgs.js` が単一源）。
 * Event Webhook がそのまま返してくるので、生アドレス・氏名・token・URL は絶対に入れない。
 * 呼び出し側が解決できなかった相手はここへ来ない（fail closed）。
 */
/**
 * 1 通送る。**HTML と text/plain の 2 パート**を必ず送る。
 *
 * ── 配信停止は fail closed ────────────────────────────────────
 * 本文シェルには `{{unsubscribeUrl}}` の印が必ず入っている。印が無い＝古い形式か
 * 壊れた本文なので、**その 1 通は送らない**（配信停止できないメールを出さない）。
 */
async function sendOne({
  SG, fromEmail, fromName, replyTo, to, subject, html, customArgs, expiryNote, clickTracking,
}) {
  const unsubscribeLink = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(to)}&brand=analytics-keiba`;

  // 受信者ごとの無料期間（読めなければ印ごと消える。嘘の期限を書かない）
  const withExpiry = applyGrantExpiry(html, expiryNote);
  // 配信停止 URL を差し込む。印が無ければ null → 送らない
  const body = applyUnsubscribeUrl(withExpiry, unsubscribeLink);
  if (!body) return false;

  // 同じ内容の text/plain。自前マークアップからの変換なので取りこぼしが無い
  const textBody = plainTextFromMarketingHtml(body);

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SG}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        // ⚠️ From は `DeliveryKey` の構成要素なので**変えない**（変えると既送分と鍵が
        //    変わり二重送信になる）。返信を受けるのは Reply-To の仕事。
        //    Reply-To は鍵に入らないので、変えても冪等性に影響しない。
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        // text/plain を先に置く（RFC 2046: 後ろほど優先度が高い）
        content: [
          { type: 'text/plain', value: textBody },
          { type: 'text/html', value: body },
        ],
        // 配信 1 通の識別子（Phase 1c）。受信側 `emailEventLedger.js` が同じ綴りで読む
        custom_args: customArgs,
        // 計測は**この 1 通の設定として**指定する（アカウント設定より per-message が優先）。
        // click は既定 OFF。ON にすると本文リンクが配信基盤のリダイレクタへ書き換わるため、
        // 有効化は env（MARKETING_CLICK_TRACKING_ENABLED）による明示操作だけに限る。
        // ⚠️ ここを `true` 固定にしないこと。固定するとトランザクション経路と同じ
        //    「アカウント全体で ON」と実質同じ危険（ログインリンク書き換え）に近づく。
        tracking_settings: {
          click_tracking: { enable: clickTracking === true, enable_text: clickTracking === true },
          open_tracking: { enable: true },
        },
        headers: {
          'List-Unsubscribe': `<${unsubscribeLink}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** CampaignDeliveries を JobId × RecipientEmail で引いて状態だけ更新する（Customers は触らない） */
async function patchDeliveriesByEmail({ KEY, BASE, jobId, entries, now }) {
  const iso = new Date(now).toISOString();
  for (const entry of entries) {
    const formula = `AND({ScheduledEmailJobId}='${jobId}', LOWER({RecipientEmail})='${entry.email}')`;
    let recs = [];
    try {
      recs = await fetchAll({ KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula });
    } catch { continue; }
    for (const rec of recs) {
      const fields = { Status: entry.status };
      if (entry.status === 'sent') fields.SentAt = iso;
      else if (entry.status === 'failed') { fields.FailedAt = iso; fields.ErrorMessage = String(entry.reason || 'send_failed'); }
      else { fields.SkippedAt = iso; fields.ErrorMessage = String(entry.reason || 'skipped'); }
      await patchRecord({ KEY, BASE, table: DELIVERIES_TABLE, recordId: rec.id, fields });
    }
  }
}

async function patchRecord({ KEY, BASE, table, recordId, fields }) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) console.error(`❌ [marketing-dispatch] ${table} PATCH failed: HTTP ${res.status}`);
  return res.ok;
}
