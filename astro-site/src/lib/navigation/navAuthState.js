/**
 * navAuthState.js — 「ナビの表示上、この人はログインしているか」の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-08-25 MK 指摘）
 *
 * > premium でログインしたナビにはログアウトが無いが、無料登録でログインすると出る
 *
 * 原因はナビ側の判定が**小文字のプラン名しか知らなかった**こと:
 *
 * ```js
 * if (userData.plan === 'standard' || userData.plan === 'premium')   // 旧実装
 * ```
 *
 * ところがサーバー（`verify-magic-link`）が保存するのは
 * `'Light'` / `'Premium'` / `'Premium Sanrenpuku'` / `'Premium Plus'` / `'Premium Combo'`。
 * **どれも一致しない**ため、マジックリンクで入った有料会員は「未ログイン」と判定され、
 * ログアウトが出ないどころか **「✨無料で始める」まで表示されていた**（ローカル実測）。
 *
 * 無料登録の経路は旧キー（`isLoggedIn` / `userPlan`）も書くので、そちらだけ通っていた。
 *
 * ## 判定
 *
 * プラン名で**ふるいにかけない**。ログインした事実があるかだけを見る。
 * 何を見せるか（無料/有料の出し分け）は別の仕組み（AccessControl・サーバー）の仕事。
 *
 * ⚠️ ここは**表示の都合**だけを決める。権限の判定に使ってはいけない
 *    （localStorage は利用者が書き換えられる。権威はサーバーの `ak_session`）。
 */

/** 保存されているプラン名が読めないときの既定値 */
const UNKNOWN_PLAN = 'Free';

function parseUserPlan(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch {
    return null;                       // 壊れた値は「無い」と同じ扱い
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {{ userPlanRaw?: string|null,      localStorage['user-plan']
 *           legacyIsLoggedIn?: string|null, localStorage['isLoggedIn']
 *           legacyUserPlan?: string|null    localStorage['userPlan']
 *         }} input
 * @returns {{ loggedIn: boolean, plan: string, source: string }}
 */
export function resolveNavAuthState({ userPlanRaw, legacyIsLoggedIn, legacyUserPlan } = {}) {
  const out = (loggedIn, plan, source) => ({ loggedIn, plan, source });

  const parsed = parseUserPlan(userPlanRaw);
  if (parsed) {
    // ⚠️ プラン名で絞らない。サーバーが保存した時点でログイン済み
    const plan = str(parsed.plan) || UNKNOWN_PLAN;
    if (str(parsed.email) || str(parsed.plan)) return out(true, plan, 'user-plan');
  }
  // 旧経路（無料登録・旧マイページ）。互換のため残す
  if (str(legacyIsLoggedIn) === 'true') return out(true, str(legacyUserPlan) || UNKNOWN_PLAN, 'legacy-flag');
  if (str(legacyUserPlan)) return out(true, str(legacyUserPlan), 'legacy-plan');

  return out(false, '', 'none');
}

/** ブラウザの localStorage から読んで判定する（画面から呼ぶ入口） */
export function readNavAuthState(storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return resolveNavAuthState({});
  const get = (k) => { try { return s.getItem(k); } catch { return null; } };
  return resolveNavAuthState({
    userPlanRaw: get('user-plan'),
    legacyIsLoggedIn: get('isLoggedIn'),
    legacyUserPlan: get('userPlan'),
  });
}
