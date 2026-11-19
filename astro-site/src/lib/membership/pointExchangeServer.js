/**
 * pointExchangeServer — ポイント交換申請（POST /.netlify/functions/point-exchange）の判定と処理（2026-11-19）
 *
 * 以前の point-exchange は、リクエスト本文の userEmail / currentPoints / requiredPoints / rewardName を
 * そのまま信じて申請を保存し、入力値をそのままメールの HTML に入れて、本文の userEmail 宛てに確認メールを送っていた。
 * そのため、ログインしていない第三者が任意のアドレス宛てに support@ からメールを送れ、
 * ポイントが足りなくても申請でき、HTML を差し込めた。
 *
 * ここでは次のとおりにする。
 * - 本人はセッション（ak_session）だけで決める。メールアドレス・氏名・プラン・保有ポイントはリクエストから受けない。
 * - 保有ポイントは Customers の『ポイント』列をサーバー側で読む。
 * - 交換できる特典と必要ポイントはサーバー側の一覧（REWARDS）で決める。一覧に無い特典・必要ポイントの不一致は拒否する。
 * - 同じ会員・同じ特典の申請は同じ日（JST）に 1 件だけ（二重クリック・29 秒差の二重申請の再発防止）。
 *   重複の確認ができないときは保存しない（fail-closed）。
 * - メールの HTML に入れる値はすべてエスケープする。ログにメールアドレス・氏名を出さない。エラー本文に内部の文言を返さない。
 *
 * ポイントの減算・特典の提供は従来どおり運用側（docs/POINT_EXCHANGE_FULFILLMENT.md）。この処理は申請と通知だけ。
 */

import { corsHeaders, readSessionRecordId, isAllowedOrigin } from '../billing/stripeRuntime.js';
import { airtable as customersTable } from '../billing/stripeServer.js';
import { viewerProfile } from '../auth/viewerEntitlements.js';

/** 交換できる特典（dashboard の交換カードと同じ内容・必要ポイント） */
export const REWARDS = Object.freeze([
  Object.freeze({ name: 'AI解析による隠れ上昇馬情報', points: 1000 }),
  Object.freeze({ name: 'AI解析による急上昇 激走穴馬情報', points: 2000 }),
  Object.freeze({ name: '厩舎の発射タイミング予測による激走穴馬情報', points: 3000 }),
]);

export const REQUEST_TABLE = 'PointExchangeRequests';

/** HTML へ差し込む文字列を無害化する。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 件名など 1 行に入れる値から改行・制御文字を除く */
function oneLine(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** Airtable の式に入れる文字列（' と \ をエスケープ） */
function formulaString(value) {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 特典名（と任意の必要ポイント）から一覧の特典を返す。無ければ null */
export function resolveReward(rewardName, requiredPoints) {
  const name = typeof rewardName === 'string' ? rewardName.trim() : '';
  const reward = REWARDS.find((r) => r.name === name);
  if (!reward) return null;
  if (requiredPoints !== undefined && requiredPoints !== null && requiredPoints !== '') {
    if (Number(requiredPoints) !== reward.points) return null;
  }
  return reward;
}

/** Plan 値の正規化（free→Free 等・従来どおり） */
export function normalizePlan(plan) {
  const p = String(plan ?? '').trim();
  if (!p) return 'Free';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

export function jstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** PointExchangeRequests の最小クライアント（fetch・差し替え可能） */
export function requestTable(env, fetchImpl) {
  const key = env.AIRTABLE_API_KEY;
  const base = env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('airtable_env_missing');
  const f = fetchImpl || fetch;
  const root = `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(REQUEST_TABLE)}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  async function call(url, init) {
    const res = await f(url, { headers, ...init });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw new Error(`airtable_${res.status}`);
    return json;
  }
  return {
    async select(formula, maxRecords = 1) {
      const q = new URLSearchParams({ filterByFormula: formula, maxRecords: String(maxRecords) });
      const j = await call(`${root}?${q}`, { method: 'GET' });
      return j?.records || [];
    },
    async create(fields) {
      const j = await call(root, { method: 'POST', body: JSON.stringify({ records: [{ fields }] }) });
      return j?.records?.[0] || null;
    },
  };
}

/** 同じ会員・同じ特典・同じ日の申請を探す式 */
export function duplicateFormula({ email, rewardName, date }) {
  return `AND(LOWER({Email})=${formulaString(String(email).toLowerCase())},{RewardName}=${formulaString(rewardName)},DATETIME_FORMAT({RequestDate},'YYYY-MM-DD')=${formulaString(date)})`;
}

/** 管理者向け・申請者向けメール（値はすべてエスケープ済み） */
export function buildExchangeEmails({ requestId, email, name, plan, reward, currentPoints, requestedAt, adminEmail, fromEmail }) {
  const e = escapeHtml;
  const tracking = {
    click_tracking: { enable: false, enable_text: false },
    open_tracking: { enable: false },
    subscription_tracking: { enable: false },
    ganalytics: { enable: false },
  };
  const admin = {
    to: adminEmail,
    from: fromEmail,
    subject: oneLine(`【ポイント交換申請】${email} - ${reward.name}`),
    html: `
            <h2>ポイント交換申請を受け付けました</h2>
            <p><strong>申請ID:</strong> ${e(requestId)}</p>
            <hr>
            <h3>申請者情報</h3>
            <ul>
              <li><strong>メールアドレス:</strong> ${e(email)}</li>
              <li><strong>お名前:</strong> ${e(name || '未登録')}</li>
              <li><strong>会員プラン:</strong> ${e(plan)}</li>
              <li><strong>申請日時:</strong> ${e(requestedAt)}</li>
            </ul>
            <hr>
            <h3>交換内容</h3>
            <ul>
              <li><strong>交換特典:</strong> ${e(reward.name)}</li>
              <li><strong>必要ポイント:</strong> ${e(reward.points)}pt</li>
              <li><strong>現在の保有ポイント:</strong> ${e(currentPoints)}pt</li>
              <li><strong>交換後残高:</strong> ${e(currentPoints - reward.points)}pt</li>
            </ul>
            <hr>
            <p><strong>対応が必要です:</strong></p>
            <ol>
              <li>Airtableで申請内容を確認</li>
              <li>特典メールを${e(email)}宛に送信</li>
              <li>Airtableのステータスを「処理済み」に更新</li>
            </ol>
          `,
    tracking_settings: tracking,
  };
  const user = {
    to: email,
    from: fromEmail,
    subject: '【ポイント交換申請受付】KEIBA Analytics',
    html: `
            <h2>ポイント交換申請を受け付けました</h2>
            <p>${e(name || 'お客様')}、この度はポイント交換をお申し込みいただき、ありがとうございます。</p>
            <hr>
            <h3>申請内容</h3>
            <ul>
              <li><strong>申請ID:</strong> ${e(requestId)}</li>
              <li><strong>交換特典:</strong> ${e(reward.name)}</li>
              <li><strong>必要ポイント:</strong> ${e(reward.points)}pt</li>
              <li><strong>申請日時:</strong> ${e(requestedAt)}</li>
            </ul>
            <hr>
            <h3>今後の流れ</h3>
            <ol>
              <li>管理者が申請内容を確認いたします</li>
              <li>1営業日以内に、特典をメールでお送りいたします</li>
              <li>特典メール送信後、交換が完了となります</li>
            </ol>
            <p>ご不明な点がございましたら、お気軽にお問い合わせください。</p>
            <hr>
            <p>KEIBA Analytics<br>
            <a href="https://analytics.keiba.link">https://analytics.keiba.link</a></p>
          `,
    tracking_settings: tracking,
  };
  return { admin, user };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {object} event Netlify v1 event
 * @param {object} env process.env
 * @param {{ deps?: object }} [opts]
 *   deps.readSession(event) → recordId | null
 *   deps.readCustomer(recordId) → { fields } | null
 *   deps.requests → { select, create }
 *   deps.sendMail(msg)
 *   deps.adminEmail / deps.fromEmail / deps.now
 */
export async function handlePointExchangeRequest(event, env, { deps = {} } = {}) {
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method Not Allowed' });

  // 他サイトからの送信を受けない
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (!isAllowedOrigin(reqOrigin, event.headers?.host || event.headers?.Host || '')) {
    return reply(403, { error: 'forbidden_origin' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch { body = {}; }
  const reward = resolveReward(body.rewardName, body.requiredPoints);
  if (!reward) return reply(400, { error: '交換できない特典です' });

  if (!deps.readCustomer && (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID)) {
    return reply(503, { error: '現在申請を受け付けられません' });
  }

  // 本人はセッションだけで決める
  const readSession = deps.readSession || ((ev) => readSessionRecordId(ev.headers?.cookie || ev.headers?.Cookie || '', env));
  const recordId = await readSession(event);
  if (!recordId) return reply(401, { error: 'ログインが必要です', code: 'login_required' });

  let record = null;
  try {
    record = deps.readCustomer ? await deps.readCustomer(recordId) : await customersTable(env, deps.fetchImpl).get(recordId);
  } catch (err) {
    if (!/airtable_404/.test(String(err?.message || ''))) {
      console.error(JSON.stringify({ event: 'point_exchange_read_failed', message: String(err?.message || err).slice(0, 120) }));
      return reply(502, { error: '申請処理中にエラーが発生しました' });
    }
  }
  if (!record) return reply(401, { error: 'ログインが必要です', code: 'login_required' });

  const profile = viewerProfile(record.fields || {});
  const email = String(profile.email || '').trim();
  if (!EMAIL_RE.test(email)) return reply(409, { error: '会員情報にメールアドレスがありません' });
  const currentPoints = profile.points ?? 0;
  if (currentPoints < reward.points) {
    return reply(400, {
      error: 'ポイント不足',
      message: `交換には${reward.points}pt必要です（現在: ${currentPoints}pt）`,
    });
  }

  const now = deps.now || new Date();
  const today = jstDate(now);
  const plan = normalizePlan(profile.plan);
  const name = typeof profile.name === 'string' ? oneLine(profile.name, 100) : '';
  const requests = deps.requests || requestTable(env, deps.fetchImpl);

  // 同じ日・同じ特典の二重申請を止める（確認できなければ保存しない）
  try {
    const existing = await requests.select(duplicateFormula({ email, rewardName: reward.name, date: today }), 1);
    if (existing.length > 0) {
      return reply(409, { error: '本日すでに同じ特典を申請済みです', code: 'already_requested', requestId: existing[0].id });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'point_exchange_dedupe_failed', message: String(err?.message || err).slice(0, 120) }));
    return reply(503, { error: '現在申請を受け付けられません。時間をおいてお試しください' });
  }

  let created = null;
  try {
    created = await requests.create({
      Email: email,
      Name: name,
      Plan: plan,
      CurrentPoints: currentPoints,
      RequiredPoints: reward.points,
      RewardName: reward.name,
      Status: 'Pending',
      RequestDate: today,
      Notes: '',
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'point_exchange_save_failed', message: String(err?.message || err).slice(0, 120) }));
    return reply(500, { error: '申請データの保存に失敗しました' });
  }
  const requestId = created?.id || '';
  console.log(JSON.stringify({ event: 'point_exchange_requested', requestId, rewardPoints: reward.points }));

  const requestedAt = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const { admin, user } = buildExchangeEmails({
    requestId, email, name, plan, reward, currentPoints, requestedAt,
    adminEmail: deps.adminEmail, fromEmail: deps.fromEmail,
  });
  if (deps.sendMail) {
    // メール送信に失敗しても申請は保存済みなのでエラーにしない（従来どおり）
    try { await deps.sendMail(admin); } catch (err) {
      console.error(JSON.stringify({ event: 'point_exchange_admin_mail_failed', message: String(err?.message || err).slice(0, 120) }));
    }
    try { await deps.sendMail(user); } catch (err) {
      console.error(JSON.stringify({ event: 'point_exchange_user_mail_failed', message: String(err?.message || err).slice(0, 120) }));
    }
  }

  return reply(200, {
    success: true,
    message: 'ポイント交換申請を受け付けました。管理者が確認後、1営業日以内にメールで特典をお送りします。',
    requestId,
  });
}
