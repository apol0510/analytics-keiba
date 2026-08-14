// Admin panel Basic Authentication
// Protects /admin/* routes.
//
// ⚠️ 認証情報を **このファイルへ書かないこと**。
//    2026-05-19〜2026-08-13 の間、ユーザー名とパスワードがソースへ平文で置かれ、
//    git に追跡され履歴にも残ったまま本番で有効だった（repo を読める者は誰でも
//    管理画面へ入れた）。値は Netlify の env にだけ置く。
//
// 判定は `src/lib/auth/adminBasicAuth.js`（純粋・依存ゼロ）が単一源。
// ここは「env と Request を渡して結果を HTTP へ写す」だけにする。
//
// 必要な env（**両方必須**。片方でも欠けたら誰も通さない = fail closed）:
//   ADMIN_BASIC_AUTH_USER
//   ADMIN_BASIC_AUTH_PASSWORD

import { decideAdminAccess, ADMIN_AUTH } from '../../src/lib/auth/adminBasicAuth.js';

const REALM = 'Basic realm="KEIBA Admin Panel"';

function unauthorized(body: string): Response {
  return new Response(body, {
    status: 401,
    headers: {
      'WWW-Authenticate': REALM,
      'Cache-Control': 'no-store',
    },
  });
}

export default async (request: Request) => {
  const url = new URL(request.url);

  // Only protect /admin/* routes
  if (!url.pathname.startsWith('/admin')) {
    return;
  }

  // Edge Runtime の env。Netlify.env が無い環境では Deno.env へ落ちる。
  const env: Record<string, string | undefined> = {};
  for (const key of ['ADMIN_BASIC_AUTH_USER', 'ADMIN_BASIC_AUTH_PASSWORD']) {
    try {
      // @ts-ignore Netlify グローバルは型定義を持ち込まない
      env[key] = typeof Netlify !== 'undefined' && Netlify?.env?.get
        // @ts-ignore
        ? Netlify.env.get(key)
        // @ts-ignore
        : Deno?.env?.get(key);
    } catch {
      env[key] = undefined;
    }
  }

  const decision = decideAdminAccess({
    header: request.headers.get('Authorization'),
    env,
    decodeBase64: (b64: string) => atob(b64),
  });

  if (decision.allow) {
    return; // 認証成功 — 通す
  }

  // ⚠️ 設定ミス（env 未設定）でも**開けない**。ただし理由は外部へ出さない
  //    （「まだ設定されていない」と教えるのは攻撃者への情報提供になる）。
  if (decision.reason === ADMIN_AUTH.NOT_CONFIGURED) {
    console.error('[admin-auth] credentials not configured (env missing) — denying all access');
    return unauthorized('Authentication required');
  }

  return unauthorized(
    decision.reason === ADMIN_AUTH.NO_HEADER ? 'Authentication required' : 'Invalid credentials',
  );
};

export const config = {
  path: '/admin/*',
};
