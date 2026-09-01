/**
 * confirm-email-change.js — メールアドレス変更の「確定」。
 *
 * ⚠️ **POST でしか確定しない。** メールのリンクは確認ページを開くだけで、
 *    利用者がボタンを押して初めてここへ来る。GET で確定すると、メールの
 *    リンクを自動で開くセキュリティスキャナに勝手に消費される。
 *
 * 手順:
 *   1. トークンを Redis から**取り出して消す**（単回使用）
 *   2. レコードが今も存在し、Email が申請時のままかを確認（途中で変わっていたら中止）
 *   3. 新アドレスが**まだ未使用か**を再確認（申請〜確定の間に誰かが登録した場合に備える）
 *   4. Customers の Email を書き換える（**Email 1 列だけ**。プラン・期限・特典には触れない）
 *   5. セッションを破棄する（本人性の根拠が変わったので入り直してもらう）
 */

import {
  normalizeEmail, EMAIL_CHANGE_REJECT, EMAIL_CHANGE_MESSAGE,
} from '../../src/lib/auth/emailChange.js';
import { takeRequest, EMAIL_CHANGE_STORE } from '../../src/lib/auth/emailChangeStore.js';

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

const EXPIRED = 'このリンクは無効か、有効期限が切れています。マイページからもう一度お手続きください。';

exports.handler = async (event) => {
  const headers = baseHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method Not Allowed' }) };
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) {
    return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const token = String(body.token || '').trim();
    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: EXPIRED }) };

    const taken = await takeRequest(process.env, token);
    if (!taken.ok) {
      const unavailable = taken.reason === EMAIL_CHANGE_STORE.UNAVAILABLE;
      // ⚠️ 障害を「無効なリンク」と言わない（何度も再発行させることになる）
      return {
        statusCode: unavailable ? 503 : 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: unavailable ? EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] : EXPIRED,
        }),
      };
    }

    const { recordId, currentEmail, newEmail } = taken.data || {};
    const nextEmail = normalizeEmail(newEmail);
    if (!recordId || !nextEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: EXPIRED }) };
    }

    // レコードが今も申請時のままか
    const meRes = await fetch(`https://api.airtable.com/v0/${BASE}/Customers/${encodeURIComponent(recordId)}`,
      { headers: { Authorization: `Bearer ${KEY}` } });
    if (!meRes.ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
    }
    const me = await meRes.json();
    const nowEmail = normalizeEmail(me?.fields?.Email);
    if (nowEmail !== normalizeEmail(currentEmail)) {
      console.warn(`⚠️ [confirm-email-change] 申請後にアドレスが変わっている record=${recordId}`);
      return { statusCode: 409, headers, body: JSON.stringify({ success: false, error: EXPIRED }) };
    }

    // 申請〜確定の間に誰かが同じアドレスで登録していないか
    const q = new URLSearchParams({
      filterByFormula: `LOWER(TRIM({Email})) = '${nextEmail.replace(/'/g, "\\'")}'`,
      maxRecords: '1',
      'fields[]': 'Email',
    });
    const dupRes = await fetch(`https://api.airtable.com/v0/${BASE}/Customers?${q}`,
      { headers: { Authorization: `Bearer ${KEY}` } });
    if (!dupRes.ok) {
      return { statusCode: 503, headers, body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE] }) };
    }
    const dup = await dupRes.json();
    if ((dup.records || []).length > 0) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ success: false, error: EMAIL_CHANGE_MESSAGE[EMAIL_CHANGE_REJECT.ALREADY_REGISTERED] }),
      };
    }

    // ⚠️ 書き換えるのは **Email 1 列だけ**。プラン・有効期限・特典・Requested* には触れない。
    const patchRes = await fetch(`https://api.airtable.com/v0/${BASE}/Customers/${encodeURIComponent(recordId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { Email: nextEmail } }),
    });
    if (!patchRes.ok) {
      const detail = (await patchRes.text()).slice(0, 200);
      console.error(`❌ [confirm-email-change] PATCH 失敗 ${patchRes.status} ${detail}`);
      return { statusCode: 502, headers, body: JSON.stringify({ success: false, error: '変更を保存できませんでした。時間をおいて再度お試しください。' }) };
    }

    console.log(`✅ [confirm-email-change] Email 変更完了 record=${recordId}`);

    // 本人性の根拠が変わったのでセッションは破棄し、新しいアドレスで入り直してもらう。
    let setCookie = null;
    try {
      const { buildLogoutCookie } = await import('../../src/lib/auth/index.js');
      setCookie = buildLogoutCookie();
    } catch (_) {}

    return {
      statusCode: 200,
      headers: setCookie ? { ...headers, 'Set-Cookie': setCookie } : headers,
      body: JSON.stringify({
        success: true,
        newEmail: nextEmail,
        message: 'メールアドレスを変更しました。次回からは新しいメールアドレスでログインしてください。',
      }),
    };
  } catch (e) {
    console.error('❌ [confirm-email-change]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'エラーが発生しました。' }) };
  }
};
