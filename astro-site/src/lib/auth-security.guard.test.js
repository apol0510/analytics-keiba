/**
 * auth-security.guard.test.js
 *
 * 認証・権限昇格の裏経路が再混入しないことを静的に固定する guard（Node標準 assert）。
 * ソースの実コード（コメント除外）を検査する。
 *
 * 固定する不変条件:
 *   1. auth-user.js は既存会員の plan を返さない（isExistingMember を返す）
 *   2. /dashboard/ のログインは send-magic-link 経由（auth-user で plan を保存しない）
 *   3. dashboard の handleTokenAuth は URL email から plan を推定しない
 *   4. free-signup は既存会員（isExistingMember）で plan を保存しない
 *   5. AccessControl は test_subscription_/demo_subscription_/nankan_user を読まない
 *   6. どのページにも window.setTestAuth 定義が存在しない
 *   7. verify-magic-link は 使用済み/期限切れ token を拒否し、Used を立てる（正規経路は維持）
 *
 * 実行: node src/lib/auth-security.guard.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const read = (rel) => readFileSync(join(process.cwd(), rel), 'utf-8');

// 行コメント/ブロックコメントを除去して「実コード」だけを検査対象にする（誤検知防止）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* ... */
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))  // // ...
    .join('\n');
}

// 1. auth-user.js は既存会員の plan を返さない
t('auth-user: 既存会員応答に plan を含めない / isExistingMember を返す', () => {
  const code = stripComments(read('netlify/functions/auth-user.js'));
  assert.ok(/isExistingMember:\s*true/.test(code), 'isExistingMember: true が見つからない');
  assert.ok(!/plan:\s*normalizedPlan/.test(code), '既存会員応答に plan: normalizedPlan が残っている（昇格経路）');
});

// 2. dashboard ログインは send-magic-link 経由
t('dashboard: magic-link-form が send-magic-link を呼ぶ', () => {
  const code = stripComments(read('src/pages/dashboard.astro'));
  assert.ok(/send-magic-link/.test(code), 'send-magic-link 呼び出しが無い');
  // ログインハンドラ内で auth-user に plan を取りに行って localStorage 保存していないこと
  assert.ok(!/localStorage\.setItem\('userPlan',\s*data\.user\.plan\)/.test(code),
    'auth-user 応答の plan を userPlan に保存する旧ログイン経路が残っている');
});

// 3. handleTokenAuth は email から plan を推定しない
t('dashboard: handleTokenAuth が email から plan を推定しない', () => {
  const code = stripComments(read('src/pages/dashboard.astro'));
  assert.ok(!/email\.includes\('premium'\)/.test(code), 'email.includes("premium") による plan 推定が残っている');
});

// 4. free-signup は既存会員で plan を保存しない
t('free-signup: isExistingMember 分岐があり paid plan を保存しない', () => {
  const code = stripComments(read('src/pages/free-signup.astro'));
  assert.ok(/isExistingMember/.test(code), 'isExistingMember 分岐が無い');
  assert.ok(!/plan:\s*data\.user\.plan/.test(code), 'data.user.plan をローカル保存している（既存会員の plan 保存）');
});

// 5. AccessControl は test backdoor キーを読まない
t('AccessControl: test_subscription_/demo_subscription_/nankan_user を読まない', () => {
  const code = stripComments(read('src/components/AccessControl.astro'));
  assert.ok(!/startsWith\('demo_subscription_'\)/.test(code), 'demo_subscription_ 読み取りが残っている');
  assert.ok(!/startsWith\('test_subscription_'\)/.test(code), 'test_subscription_ 読み取りが残っている');
  assert.ok(!/getItem\('nankan_user'\)/.test(code), 'nankan_user 読み取りが残っている');
  // 正規の user-plan 読み取りは維持されていること
  assert.ok(/getItem\('user-plan'\)/.test(code), '正規の user-plan 読み取りが消えている');
  // dev バイパスは維持（ユーザー指示で残置）
  assert.ok(/isDevelopmentMode/.test(code), 'dev バイパス isDevelopmentMode が消えている');
});

// 5b. src/pages / src/components 全体で backdoor キーの読み取りが無い
t('全ページ/コンポーネントに test_subscription_/demo_subscription_/nankan_user 読み取りが無い', () => {
  const roots = ['src/pages', 'src/components'];
  const offenders = [];
  for (const root of roots) {
    const dir = join(process.cwd(), root);
    const files = readdirSync(dir, { recursive: true })
      .filter((f) => typeof f === 'string' && (f.endsWith('.astro') || f.endsWith('.js') || f.endsWith('.ts')));
    for (const f of files) {
      const code = stripComments(read(join(root, f)));
      if (/startsWith\(['"]demo_subscription_['"]\)/.test(code)) offenders.push(`${root}/${f} (demo_subscription_)`);
      if (/startsWith\(['"]test_subscription_['"]\)/.test(code)) offenders.push(`${root}/${f} (test_subscription_)`);
      if (/getItem\(['"]nankan_user['"]\)/.test(code)) offenders.push(`${root}/${f} (nankan_user)`);
    }
  }
  assert.strictEqual(offenders.length, 0, `backdoor 読み取りが残存:\n     ${offenders.join('\n     ')}`);
});

// 6. どのページにも window.setTestAuth 定義が無い
t('全ページに window.setTestAuth 定義が存在しない', () => {
  const pagesDir = join(process.cwd(), 'src/pages');
  const files = readdirSync(pagesDir, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.astro'));
  const offenders = [];
  for (const f of files) {
    const code = stripComments(read(join('src/pages', f)));
    if (/window\.setTestAuth\s*=/.test(code)) offenders.push(f);
  }
  assert.strictEqual(offenders.length, 0, `window.setTestAuth 定義が残存: ${offenders.join(', ')}`);
});

// 7. verify-magic-link の正規経路（used/expired 拒否 + Used 更新）は維持
t('verify-magic-link: 使用済み/期限切れ token を拒否し Used を立てる', () => {
  const code = read('netlify/functions/verify-magic-link.js');
  assert.ok(/tokenData\.Used/.test(code), '使用済みチェックが無い');
  assert.ok(/Token already used/.test(code), '使用済み拒否メッセージが無い');
  assert.ok(/Token expired/.test(code), '期限切れ拒否メッセージが無い');
  assert.ok(/Used:\s*true/.test(code), 'Used=true 更新が無い（再使用防止）');
});

console.log(`\nauth-security.guard.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
