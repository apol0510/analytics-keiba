/**
 * Premium Plus 結果台帳への書き込み（管理画面専用・GitHub コミット方式）
 *
 * 管理画面 `/admin/premium-plus-results` から POST された 1 鞍の結果を、
 * git コミットで `astro-site/src/data/premiumPlusResults.json` に追記/更新する。
 * → Netlify 自動ビルド → `/premium-plus/` に反映。
 *
 * Netlify Blobs は使わない（同一キー last-write-wins で lost-update が起きるため）。
 * git contents API は sha による楽観ロックがあり、1 日 1 件・単一入力なら競合しない。
 *
 * 認可: x-admin-secret == PREMIUM_PLUS_ADMIN_SECRET（未設定なら 503 で無効）。
 * env: GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME / GITHUB_BRANCH /
 *      PREMIUM_PLUS_ADMIN_SECRET
 *
 * action:
 *   upsert … 1 件追記。未来日は 400、同日が既にあれば overwrite:true が無い限り 409、
 *            replaceDate があれば元の日付を消して保存（日付の修正・1 コミット）
 *   remove … 指定日を削除（台帳に無い日付は 404・空コミットしない）
 *   list   … 台帳を読むだけ（コミットしない）。管理画面の「保存済み一覧」用
 *
 * 判定の単一源: src/lib/premiumPlusResults.js（normalize / upsert / remove）
 */

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'premium-plus-results' });
import { normalizeResult, planUpsert, removeResult, sortResults } from '../../src/lib/premiumPlusResults.js';

const FILE_PATH = 'astro-site/src/data/premiumPlusResults.json';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ak-premium-plus-results',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const TOKEN = process.env.GITHUB_TOKEN;
  const OWNER = process.env.GITHUB_REPO_OWNER;
  const REPO = process.env.GITHUB_REPO_NAME;
  const BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!SECRET) return json(503, { error: 'PREMIUM_PLUS_ADMIN_SECRET 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!TOKEN || !OWNER || !REPO) return json(500, { error: 'GitHub 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'upsert';

  // 追記前に入力を検証（fail closed）
  if (action === 'upsert') {
    const norm = normalizeResult(req.entry);
    if (!norm) return json(400, { error: '入力が不正です（日付 / 1着1頭 / 2着・3着 が必要）' });
  } else if (action === 'remove') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date || ''))) return json(400, { error: 'date が必要です（YYYY-MM-DD）' });
  } else if (action !== 'list') {
    return json(400, { error: `未知の action: ${action}` });
  }

  const contentsUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

  try {
    // 現在のファイル取得（sha 取得）
    const getRes = await fetch(`${contentsUrl}?ref=${encodeURIComponent(BRANCH)}`, { headers: ghHeaders(TOKEN) });
    let arr = [];
    let sha = undefined;
    if (getRes.status === 200) {
      const body = await getRes.json();
      sha = body.sha;
      try {
        arr = JSON.parse(Buffer.from(body.content || '', 'base64').toString('utf-8')) || [];
        if (!Array.isArray(arr)) arr = [];
      } catch { arr = []; }
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      return json(502, { error: `GitHub 取得失敗: ${getRes.status}`, detail: t.slice(0, 300) });
    }

    if (action === 'list') {
      return json(200, { success: true, action, count: arr.length, entries: sortResults(arr) });
    }
    if (action === 'remove' && !arr.some((e) => e && e.date === req.date)) {
      return json(404, { error: `${req.date} は台帳にありません` });
    }

    // 更新（保存可否の規則は planUpsert が単一源）
    let next, summary;
    if (action === 'upsert') {
      const plan = planUpsert(arr, {
        entry: req.entry,
        overwrite: req.overwrite === true,
        replaceDate: typeof req.replaceDate === 'string' ? req.replaceDate : null,
        uploadedAt: new Date().toISOString(),
      });
      if (!plan.ok) return json(plan.status, { error: plan.error, ...(plan.existing ? { existing: plan.existing } : {}) });
      ({ next, summary } = plan);
    } else {
      next = removeResult(arr, req.date);
      summary = `${req.date} 削除`;
    }

    const newContent = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf-8').toString('base64');
    const putBody = {
      message: `Premium Plus 結果: ${summary} [admin]`,
      content: newContent,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    };

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...ghHeaders(TOKEN), 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      return json(502, { error: `GitHub コミット失敗: ${putRes.status}`, detail: t.slice(0, 300) });
    }
    const putJson = await putRes.json();
    return json(200, {
      success: true,
      action,
      summary,
      count: next.length,
      commit: putJson.commit?.sha || null,
    });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
