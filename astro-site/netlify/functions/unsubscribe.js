// メール配信停止処理 Function
// お客様がメルマガ配信を停止する機能
//
// 2026-05-17 改訂:
//   旧実装は両 Base に存在しないフィールド (メール配信 / 配信停止日) に書こうとして
//   サイレント失敗していた。docs/NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md §3 で
//   新規追加された brand 別フィールドに書き込むよう全面改修:
//
//     analytics-keiba    : UnsubscribedAnalyticsKeiba / UnsubscribedAtAnalyticsKeiba
//     keiba-intelligence : UnsubscribedKeibaIntelligence / UnsubscribedAtKeibaIntelligence
//
//   - brand 必須化 (POST)、GET は brand 選択 UI を提供
//   - audience-counter の除外ロジックと配信停止判定を完全一致させる
//   - PII (email / record id / API key / Base ID) はログに出さない
//     emailTraceId() = sha256 先頭 12 chars でトレース可能性のみ確保
//   - Airtable formula の email エスケープ
//   - POST { action: 'resubscribe' } で配信再開対応

import { createHash } from 'node:crypto';

/**
 * brand → 配信停止フィールド名 + Base ID env のマッピング
 * docs/NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md §3 と一致
 */
const UNSUBSCRIBE_FIELDS = {
  'analytics-keiba': {
    flag: 'UnsubscribedAnalyticsKeiba',
    at: 'UnsubscribedAtAnalyticsKeiba',
    baseEnv: 'AIRTABLE_BASE_ID_ANALYTICS_KEIBA',
    displayName: 'KEIBA Analytics',
  },
  'keiba-intelligence': {
    flag: 'UnsubscribedKeibaIntelligence',
    at: 'UnsubscribedAtKeibaIntelligence',
    baseEnv: 'AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE',
    displayName: '競馬インテリジェンス',
  },
};

const CUSTOMERS_TABLE = 'Customers';

// ===== Pure helpers =====

/** Email を 1-way hash 化（PII を残さずトレース可能性だけ確保） */
export function emailTraceId(email) {
  if (typeof email !== 'string') return 'none';
  const norm = email.trim().toLowerCase();
  if (!norm) return 'none';
  return createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

/** Email 正規化（lowercase + trim） */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * Airtable formula 文字列内で安全に使うため email をエスケープ
 * single quote をバックスラッシュで escape（Airtable 公式仕様）
 */
export function escapeAirtableFormulaString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** HTML escape（XSS 防止、確認ページに email を埋め込むため） */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** brand バリデーション、unknown は構造化エラー型を返す */
export function resolveBrandConfig(brand) {
  if (!brand || typeof brand !== 'string') {
    return { ok: false, reason: 'brand-required' };
  }
  const cfg = UNSUBSCRIBE_FIELDS[brand];
  if (!cfg) {
    return {
      ok: false,
      reason: 'unknown-brand',
      brand,
      supportedBrands: Object.keys(UNSUBSCRIBE_FIELDS),
    };
  }
  return { ok: true, brand, config: cfg };
}

/**
 * Customers の配信停止フラグを更新する。
 * - 同一 brand の 2 フィールドのみ touch、他 brand フィールドは触らない
 * - PII (email / record id / API key / Base ID) はレスポンスにも内部 throw にも含めない
 * - 戻り値は構造化オブジェクト { ok, reason?, airtableStatus?, ... }
 */
export async function updateUnsubscribeStatus(email, brand, action = 'unsubscribe') {
  const brandResult = resolveBrandConfig(brand);
  if (!brandResult.ok) return brandResult;
  const { config } = brandResult;

  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env[config.baseEnv];
  const missingEnv = [];
  if (!apiKey) missingEnv.push('AIRTABLE_API_KEY');
  if (!baseId) missingEnv.push(config.baseEnv);
  if (missingEnv.length > 0) {
    return { ok: false, reason: 'missing-env', missingEnv };
  }

  const normEmail = normalizeEmail(email);
  if (!normEmail || !normEmail.includes('@')) {
    return { ok: false, reason: 'invalid-email' };
  }

  // === Search ===
  const formula = `LOWER({Email}) = '${escapeAirtableFormulaString(normEmail)}'`;
  const searchUrl = `https://api.airtable.com/v0/${baseId}/${CUSTOMERS_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  let searchData;
  try {
    const res = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, reason: 'airtable-search-failed', airtableStatus: res.status };
    }
    searchData = await res.json();
  } catch {
    return { ok: false, reason: 'airtable-search-network-error' };
  }

  if (!Array.isArray(searchData.records) || searchData.records.length === 0) {
    return { ok: false, reason: 'email-not-found', brand };
  }
  const recordId = searchData.records[0].id;

  // === PATCH: 同一 brand の 2 フィールドのみ ===
  const fields = action === 'resubscribe'
    ? { [config.flag]: false, [config.at]: null }
    : { [config.flag]: true, [config.at]: new Date().toISOString() };

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${baseId}/${CUSTOMERS_TABLE}/${recordId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      },
    );
    if (!res.ok) {
      return { ok: false, reason: 'airtable-update-failed', airtableStatus: res.status };
    }
  } catch {
    return { ok: false, reason: 'airtable-update-network-error' };
  }

  return { ok: true, brand, action };
}

/** reason コード → ユーザー向けメッセージ */
function reasonToUserMessage(reason) {
  switch (reason) {
    case 'brand-required': return 'ブランド指定が必要です。';
    case 'unknown-brand': return 'サポートされていないブランドです。';
    case 'missing-env': return 'サーバー設定エラーが発生しました。サポートにご連絡ください。';
    case 'invalid-email': return 'メールアドレスの形式が正しくありません。';
    case 'email-not-found': return 'このメールアドレスは登録されていません。';
    case 'airtable-search-failed':
    case 'airtable-search-network-error':
    case 'airtable-update-failed':
    case 'airtable-update-network-error':
      return '処理に失敗しました。しばらく経ってから再度お試しください。';
    default: return '処理に失敗しました。';
  }
}

// ===== HTTP handler =====

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  try {
    const url = new URL(request.url);
    const email = url.searchParams.get('email');
    const brandFromQuery = url.searchParams.get('brand');

    // GET: 確認ページ
    if (request.method === 'GET') {
      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email parameter is required' }),
          { status: 400, headers },
        );
      }
      return new Response(renderConfirmationHtml({ email, brand: brandFromQuery }), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // POST: 配信停止 / 配信再開
    if (request.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return new Response(
          JSON.stringify({ success: false, error: 'invalid JSON body' }),
          { status: 400, headers },
        );
      }
      const { email: postEmail, brand, action } = body || {};
      const requestedAction = action === 'resubscribe' ? 'resubscribe' : 'unsubscribe';

      const trace = emailTraceId(postEmail);
      console.log(`📧 unsubscribe handler invoked: brand=${brand || '<none>'} action=${requestedAction} trace=${trace}`);

      const result = await updateUnsubscribeStatus(postEmail, brand, requestedAction);

      if (result.ok) {
        console.log(`✅ unsubscribe ok: brand=${result.brand} action=${result.action} trace=${trace}`);
        return new Response(
          JSON.stringify({
            success: true,
            brand: result.brand,
            action: result.action,
            message: requestedAction === 'resubscribe'
              ? '配信を再開しました'
              : '配信停止が完了しました',
          }),
          { status: 200, headers },
        );
      }

      console.log(`⚠️ unsubscribe failed: reason=${result.reason || 'unknown'} brand=${brand || '<none>'} trace=${trace}`);
      const httpStatus =
        result.reason === 'brand-required' || result.reason === 'unknown-brand' || result.reason === 'invalid-email' ? 400 :
        result.reason === 'email-not-found' ? 404 :
        result.reason === 'missing-env' ? 503 :
        502;
      return new Response(
        JSON.stringify({
          success: false,
          reason: result.reason,
          brand: result.brand,
          supportedBrands: result.supportedBrands,
          missingEnv: result.missingEnv,
          airtableStatus: result.airtableStatus,
          message: reasonToUserMessage(result.reason),
        }),
        { status: httpStatus, headers },
      );
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers },
    );
  } catch (e) {
    // 最終防衛線。PII を含まない安全な error response
    console.error('🚨 unsubscribe handler unexpected error:', e?.name || 'Error', e?.message || '');
    return new Response(
      JSON.stringify({
        success: false,
        error: 'unexpected handler error',
        name: e?.name || 'Error',
      }),
      { status: 500, headers },
    );
  }
}

// ===== HTML 確認ページレンダラ =====

function renderConfirmationHtml({ email, brand }) {
  const safeEmail = escapeHtml(email);
  const akChecked = brand === 'analytics-keiba' ? 'checked' : '';
  const kiChecked = brand === 'keiba-intelligence' ? 'checked' : '';
  // どちらも指定されていなければ AK を既定（過去 URL の互換性、AK が legacy 単一 Base）
  const fallbackAk = !akChecked && !kiChecked ? 'checked' : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>配信停止 - メルマガ</title>
<style>
body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8fafc; }
.container { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.header { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: white; padding: 20px; text-align: center; border-radius: 8px; margin-bottom: 20px; }
button { background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; margin: 10px; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.cancel-btn { background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); }
.brand-select { background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0; }
.brand-select label { display: block; margin: 8px 0; cursor: pointer; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>📧 メール配信停止</h1>
  </div>
  <h2>配信停止の確認</h2>
  <p><strong>${safeEmail}</strong> 宛のメール配信を停止しますか？</p>
  <div class="brand-select">
    <strong>停止するブランドを選択してください:</strong>
    <label><input type="radio" name="brand" value="analytics-keiba" ${akChecked || fallbackAk}> KEIBA Analytics (analytics-keiba)</label>
    <label><input type="radio" name="brand" value="keiba-intelligence" ${kiChecked}> 競馬インテリジェンス (keiba-intelligence)</label>
  </div>
  <div style="text-align: center; margin-top: 30px;">
    <button onclick="doUnsubscribe()" id="unsubscribe-btn">🚫 配信停止する</button>
    <button class="cancel-btn" onclick="window.close()">← キャンセル</button>
  </div>
  <div id="result" style="margin-top: 20px; text-align: center;"></div>
</div>
<script>
async function doUnsubscribe() {
  const btn = document.getElementById('unsubscribe-btn');
  const result = document.getElementById('result');
  const brand = document.querySelector('input[name="brand"]:checked')?.value;
  if (!brand) { result.innerHTML = '<div style="color:#dc2626;">ブランドを選択してください</div>'; return; }
  btn.disabled = true; btn.textContent = '処理中...';
  try {
    const response = await fetch('/api/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(safeEmail)}, brand: brand })
    });
    const data = await response.json();
    if (data.success) {
      result.innerHTML = '<div style="color:#10b981;font-weight:bold;">✅ ' + (data.message || '配信停止が完了しました') + '</div>';
      btn.style.display = 'none';
    } else {
      result.innerHTML = '<div style="color:#dc2626;">❌ ' + (data.message || data.reason || 'エラーが発生しました') + '</div>';
    }
  } catch {
    result.innerHTML = '<div style="color:#dc2626;">❌ 通信エラーが発生しました</div>';
  } finally {
    btn.disabled = false; btn.textContent = '🚫 配信停止する';
  }
}
</script>
</body>
</html>`;
}
