/**
 * request-email-change.js — マイページからのメールアドレス変更「申請」。
 *
 * ⚠️ **ここでは Customers を一切書き換えない。** 新アドレス宛の確認リンクを開いて
 *    初めて `confirm-email-change.js` が書き換える。
 *
 * 手順:
 *   1. Origin 検証（CSRF）
 *   2. ak_session を検証 → recordId → Customers から現在の Email
 *   3. 新アドレスの重複を Airtable で確認（**確認できなければ fail closed**）
 *   4. 連投チェック（60 秒）
 *   5. トークンを Redis へ保存（TTL 60 分・単回使用）
 *   6. 新アドレスへ確認リンク / 旧アドレスへ通知（**リンクは新アドレスにだけ**）
 *
 * 応答は理由コードを返すが、**他人のアドレスの登録有無を推測させない**ため
 * `already_registered` も含めて画面文言は当たり障りのないものにしてある
 * （文言の単一源は src/lib/auth/emailChange.js）。
 */

import { SUPPORT_EMAIL } from './config/email-config.js';
import {
  decideEmailChange, buildEmailChangeEmails, normalizeEmail,
  EMAIL_CHANGE_REJECT, EMAIL_CHANGE_MESSAGE,
} from '../../src/lib/auth/emailChange.js';
import {
  putRequest, claimCooldown, EMAIL_CHANGE_STORE,
} from '../../src/lib/auth/emailChangeStore.js';

const SITE_BASE = (process.env.MAGIC_LINK_BASE_URL || 'https://analytics.keiba.link').replace(/\/$/, '');

const ALLOWED_ORIGINS = [
  'https://analytics.keiba.link',
  'https://nankan-analytics.keiba.link',
];

function baseHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allow = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+--analytics-keiba\.netlify\.app$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allow ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

/** 本番は Origin 必須（fail closed）。非本番のみ欠落を許容。 */
function originAllowed(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isProd = !process.env.CONTEXT || process.env.CONTEXT === 'production';
  if (!origin) return !isProd;
  return ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+--analytics-keiba\.netlify\.app$/.test(origin);
}

async function sendMail({ to, subject, html, text }) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return false;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: SUPPORT_EMAIL, name: 'KEIBA Analytics サポート' },
      reply_to: { email: SUPPORT_EMAIL },
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
    }),
  });
  return res.status === 202;
}

exports.handler = async (event) => {
  const headers = baseHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
  }
  if (!originAllowed(event)) {
    return { statusCode: 403, headers, body: JSON.stringify({ success: false, error: 'Forbidden' }) };
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!KEY || !BASE || !secret) {
    return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
  }

  try {
    const { checkSigningSecret, readSessionCookie, verifySession } = await import('../../src/lib/auth/index.js');
    if (!checkSigningSecret(secret).ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
    }

    const token = readSessionCookie(event.headers?.cookie || event.headers?.Cookie || '');
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'ログインが必要です。' }) };
    }
    const verified = await verifySession({ token, secret, now: Date.now() });
    if (!verified.ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'ログインが必要です。' }) };
    }
    const recordId = String(verified.payload?.sub || '');
    if (!recordId) {
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'ログインが必要です。' }) };
    }

    // 現在の Email（**クライアント申告は読まない**）
    const meRes = await fetch(`https://api.airtable.com/v0/${BASE}/Customers/${encodeURIComponent(recordId)}`,
      { headers: { Authorization: `Bearer ${KEY}` } });
    if (!meRes.ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
    }
    const me = await meRes.json();
    const currentEmail = normalizeEmail(me?.fields?.Email);

    const body = JSON.parse(event.body || '{}');
    const newEmail = normalizeEmail(body.newEmail);

    // 重複確認。**確認できなければ null を渡して fail closed にする**
    let newEmailTaken = null;
    if (newEmail) {
      try {
        const q = new URLSearchParams({
          filterByFormula: `LOWER(TRIM({Email})) = '${newEmail.replace(/'/g, "\\'")}'`,
          maxRecords: '1',
          'fields[]': 'Email',
        });
        const dupRes = await fetch(`https://api.airtable.com/v0/${BASE}/Customers?${q}`,
          { headers: { Authorization: `Bearer ${KEY}` } });
        if (dupRes.ok) {
          const dup = await dupRes.json();
          newEmailTaken = (dup.records || []).length > 0;
        }
      } catch (_) { newEmailTaken = null; }
    }

    const decision = decideEmailChange({ currentEmail, newEmail, newEmailTaken });
    if (!decision.ok) {
      const status = decision.reason === EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE ? 503 : 400;
      console.warn(`⚠️ [request-email-change] 拒否 reason=${decision.reason} record=${recordId}`);
      return {
        statusCode: status,
        headers,
        body: JSON.stringify({ success: false, code: decision.reason, error: EMAIL_CHANGE_MESSAGE[decision.reason] }),
      };
    }

    // 第三者のアドレスへの連投を防ぐ
    const cooldown = await claimCooldown(process.env, recordId);
    if (!cooldown.ok) {
      const isCooldown = cooldown.reason === EMAIL_CHANGE_STORE.COOLDOWN;
      return {
        statusCode: isCooldown ? 429 : 503,
        headers,
        body: JSON.stringify({
          success: false,
          error: isCooldown
            ? '確認メールを送信したばかりです。1 分ほどおいてから再度お試しください。'
            : EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE],
        }),
      };
    }

    const confirmToken = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .replace(/[^a-z0-9-]/gi, '');
    const stored = await putRequest(process.env, {
      token: confirmToken, recordId, currentEmail, newEmail: decision.newEmail, nowIso: new Date().toISOString(),
    });
    if (!stored.ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
    }

    const confirmUrl = `${SITE_BASE}/auth/change-email?token=${encodeURIComponent(confirmToken)}`;
    const { toNew, toOld } = buildEmailChangeEmails({
      currentEmail, newEmail: decision.newEmail, confirmUrl, supportEmail: SUPPORT_EMAIL,
    });

    const sentNew = await sendMail({ to: decision.newEmail, ...toNew });
    if (!sentNew) {
      console.error('❌ [request-email-change] 確認メール送信に失敗');
      return { statusCode: 502, headers, body: JSON.stringify({ success: false, error: '確認メールを送信できませんでした。時間をおいて再度お試しください。' }) };
    }
    // 旧アドレスへの通知は best-effort（失敗しても申請は成立させる）
    if (currentEmail) { try { await sendMail({ to: currentEmail, ...toOld }); } catch (_) {} }

    console.log(`📮 [request-email-change] 確認メール送信 record=${recordId}`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `${decision.newEmail} 宛に確認メールをお送りしました。メール内のリンクから変更を確定してください。`,
      }),
    };
  } catch (e) {
    console.error('❌ [request-email-change]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'エラーが発生しました。' }) };
  }
};
