/**
 * authSecurity.guard.test.mjs — 認証・権限昇格の裏経路が再流入しないことを固定する guard
 *   node --test src/lib/auth/authSecurity.guard.test.mjs
 *
 * ── 経緯 ────────────────────────────────────────────────────────
 * 2026-07-07 に同種の除去作業（PR #128 / commit `3c040a9`）が行われたが、
 * **その PR は merge されず、除去は main に一度も入らなかった**。
 * つまり「再流入」ではなく「未除去のまま 1 か月以上本番に存在し続けた」。
 * guard が main 側に無かったことが、放置に気づけなかった直接の原因。
 * 本 guard は **その除去と同時に main へ入れる**ためのもの。
 *
 * ── 何を守るか ──────────────────────────────────────────────────
 *   1. 任意の plan を localStorage へ注入するテスト関数が shipped source に存在しない
 *   2. 正当な書き込み元を持たないレガシー鍵を**権限判定に読まない**
 *   3. auth-user が有料 plan 名を返さない（マジックリンク必須の現行設計を維持）
 *
 * ── 検査の原則 ──────────────────────────────────────────────────
 * **コメントと実行コードを区別する。** 経緯の説明でキーワードに触れるのは正当なので、
 * 行コメント / ブロックコメントを落としてから検査する。
 *
 * ⚠️ `localStorage.removeItem('nankan_user')` のような**掃除**は禁止しない。
 *    既存利用者のブラウザから残骸を消すのは安全側の動作で、権限付与ではない。
 * ⚠️ 無料ページのログイン状態保持（`user-plan` / `isLoggedIn` / `userEmail` 等）も
 *    権限昇格とは別問題なので、この guard の対象外。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // astro-site/

/** 行コメント / ブロックコメントを落として「実行コード」だけにする。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 配信されるソースを再帰的に集める（テスト・ビルド生成物は除く）。 */
function collect(dirs, exts) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (['node_modules', 'dist', '.netlify', '.astro'].includes(e)) continue;
        walk(p);
      } else if (exts.some((x) => e.endsWith(x)) && !/\.test\.(js|mjs)$/.test(e)) {
        out.push(p);
      }
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out;
}

const SHIPPED = collect(
  ['src/pages', 'src/components', 'src/layouts', 'public'],
  ['.astro', '.js', '.mjs', '.ts']
);
const rel = (p) => relative(ROOT, p);

test('検査対象が空でない（guard の素通り防止）', () => {
  assert.ok(SHIPPED.length > 50, `配信ソースが少なすぎる: ${SHIPPED.length} 件`);
});

// ── 1. plan 注入テスト関数を置かない ────────────────────────────
test('shipped source に setTestAuth / clearTestAuth の実定義が無い', () => {
  const hits = [];
  for (const f of SHIPPED) {
    const code = stripComments(readFileSync(f, 'utf8'));
    // `window.setTestAuth = ...` / `function setTestAuth(` / `setTestAuth = function`
    if (/(?:window\s*\.\s*)?(set|clear)TestAuth\s*=/.test(code)
      || /function\s+(set|clear)TestAuth\s*\(/.test(code)) {
      hits.push(rel(f));
    }
  }
  assert.deepEqual(hits, [], `テスト認証注入関数が復活している: ${hits.join(', ')}`);
});

test('任意 plan を localStorage へ書くデバッグ関数を window へ生やさない', () => {
  const hits = [];
  for (const f of SHIPPED) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/window\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*function/g)) {
      const name = m[1];
      if (/^(set|clear|force|grant|mock|fake|debug)?(Test|Demo|Dev)?(Auth|Plan|Subscription|Member)/i.test(name)
        && /Test|Demo|Dev|Mock|Fake|Debug/i.test(name)) {
        hits.push(`${rel(f)}: window.${name}`);
      }
    }
  }
  assert.deepEqual(hits, [], `plan 注入系のデバッグ関数が残っている: ${hits.join(', ')}`);
});

// ── 2. レガシー鍵を権限判定に読まない ───────────────────────────
/**
 * 正当な書き込み元を持たないレガシー鍵。
 * 2026-08-08 の監査時点で `setItem` するのは削除済みの setTestAuth だけだった
 * （`/auth/verify` が書くのは `user-plan` のみ）。したがって**読めば必ず注入を信じる**ことになる。
 */
const LEGACY_GRANT_KEYS = ['nankan_user', 'test_subscription_', 'demo_subscription_'];

/**
 * `auth_data` も書き込み元が 1 つも無い grant path だったので削除した。
 * ただし**無料ページのログイン状態判定**（`isRegisteredUser`）では今も参照しており、
 * そちらは権限昇格と無関係なので許可する。禁止するのは
 * **plan を取り出して認可に使う** `AccessControl` 側だけ。
 */
const ACCESS_CONTROL = 'src/components/AccessControl.astro';

test('レガシー鍵を権限判定に読まない（removeItem での掃除は許可）', () => {
  const hits = [];
  for (const f of SHIPPED) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const key of LEGACY_GRANT_KEYS) {
      if (!code.includes(key)) continue;
      for (const line of code.split('\n')) {
        if (!line.includes(key)) continue;
        // 掃除（removeItem / 削除対象リスト）は許可
        if (/removeItem|delete\s|クリア|掃除/.test(line)) continue;
        // 読み取り系（getItem / Object.keys(localStorage) / startsWith）は禁止
        if (/getItem|Object\.keys\s*\(\s*localStorage|startsWith/.test(line)) {
          hits.push(`${rel(f)}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(hits, [], `レガシー鍵の読み取りが復活している:\n  ${hits.join('\n  ')}`);
});

test('レガシー鍵を書き込まない（注入元を復活させない）', () => {
  const hits = [];
  for (const f of SHIPPED) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const key of LEGACY_GRANT_KEYS) {
      const re = new RegExp(`setItem\\s*\\(\\s*['"\`]${key}`, 'g');
      if (re.test(code)) hits.push(`${rel(f)}: setItem('${key}')`);
    }
  }
  assert.deepEqual(hits, [], `レガシー鍵への書き込みが復活している: ${hits.join(', ')}`);
});

test('AccessControl は auth_data から plan を取り出さない', () => {
  const code = stripComments(readFileSync(join(ROOT, ACCESS_CONTROL), 'utf8'));
  assert.doesNotMatch(code, /getItem\(\s*['"`]auth_data/, 'auth_data を読んでいる');
  assert.doesNotMatch(code, /demo_subscription_|test_subscription_|nankan_user/,
    'レガシー鍵が AccessControl に残っている');
});

test('AccessControl が plan を得る経路を把握できている（増えたら気づく）', () => {
  const code = stripComments(readFileSync(join(ROOT, ACCESS_CONTROL), 'utf8'));
  const keys = [...code.matchAll(/localStorage\.getItem\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]);
  const uniq = [...new Set(keys)].sort();
  // 現状の許容リスト。**増やすときは必ず「注入で昇格できないか」を確認すること。**
  assert.deepEqual(uniq, [
    'isExpired', 'isLoggedIn', 'isWithdrawalRequested', 'user-plan', 'userPlan', 'validUntil',
  ], `AccessControl が読む localStorage キーが変わった: ${JSON.stringify(uniq)}`);
});

// ── 3. auth-user は有料 plan 名を返さない ───────────────────────
test('auth-user: 有料会員へマジックリンクを要求し、plan 名を返さない', () => {
  const code = stripComments(readFileSync(join(ROOT, 'netlify/functions/auth-user.js'), 'utf8'));
  assert.match(code, /requiresMagicLink:\s*true/, '有料会員をマジックリンク必須にしていない');
  // 応答に載せてよい plan は 'free' のみ
  const plans = [...code.matchAll(/plan:\s*'([^']*)'/g)].map((m) => m[1]);
  const paid = plans.filter((p) => p !== 'free');
  assert.deepEqual(paid, [], `有料 plan 名を応答に載せている: ${paid.join(', ')}`);
});

// ── 4. コメントと実行コードを区別している証明 ───────────────────
test('経緯を説明するコメントは検知しない（誤検知しない）', () => {
  const sample = `
    // 過去に window.setTestAuth = function(plan) {} があった
    /* nankan_user を localStorage.getItem で読んでいた */
    const ok = true;
  `;
  const code = stripComments(sample);
  assert.doesNotMatch(code, /setTestAuth\s*=/);
  assert.doesNotMatch(code, /getItem/);
  assert.match(code, /const ok = true;/);
});

test('実行コードは確実に検知する（guard が空振りしない）', () => {
  const bad = "window.setTestAuth = function(plan) { localStorage.setItem('nankan_user', '{}'); };";
  const code = stripComments(bad);
  assert.match(code, /(?:window\s*\.\s*)?(set|clear)TestAuth\s*=/);
  assert.match(code, /setItem\s*\(\s*'nankan_user/);
});

// ── 5. client-only の有料ゲートを増やさない（2026-08-08 追加）──────
/**
 * `<AccessControl requiredPlan="...">` だけで守っている有料ページは、
 * 静的 HTML に有料本文が入るため **localStorage の書き換えだけで読める**。
 * サーバー側認可（`gatePaidPage`）へ移すまでの既知の残件をここで固定し、
 * **新しく増えたら fail** させる。減らすのは自由（このリストから消すだけ）。
 */
const CLIENT_ONLY_PAID_PAGES_KNOWN = [
  'src/pages/light-predictions-jra.astro',
  'src/pages/premium-prediction/jra.astro',
  'src/pages/premium-prediction/nankan.astro',
  'src/pages/premium-predictions-funabashi.astro',
  'src/pages/premium-predictions-urawa.astro',
];

/** 有料ゲートのあるページを分類する（生ファイルで判定。コメント除去は誤爆するため使わない）。 */
function classifyPaidPages() {
  const out = { serverAuth: [], clientOnly: [] };
  for (const f of SHIPPED) {
    if (!f.endsWith('.astro') || !f.includes(`${'/'}pages${'/'}`)) continue;
    const raw = readFileSync(f, 'utf8');
    const tags = [...raw.matchAll(/<AccessControl\s([^>]*)>/g)].map((m) => m[1]);
    const plans = [...new Set(tags.map((t) => {
      const m = t.match(/requiredPlan\s*=\s*(?:"([^"]*)"|'([^']*)'|\{['"]([^'"]*)['"]\})/);
      return m ? (m[1] || m[2] || m[3]) : null;
    }).filter(Boolean))];
    if (!plans.length || !plans.some((p) => !/^free$/i.test(p))) continue;
    const server = /verifyPlanAccess|gatePaidPage/.test(raw);
    (server ? out.serverAuth : out.clientOnly).push(rel(f));
  }
  out.serverAuth.sort(); out.clientOnly.sort();
  return out;
}

test('有料ゲートのあるページを 1 つ以上検出できている（分類の素通り防止）', () => {
  const { serverAuth, clientOnly } = classifyPaidPages();
  assert.ok(serverAuth.length + clientOnly.length >= 10,
    `有料ページの検出数が少なすぎる: ${serverAuth.length + clientOnly.length}`);
});

test('client-side gate だけの有料ページを新規に増やさない', () => {
  const { clientOnly } = classifyPaidPages();
  const added = clientOnly.filter((f) => !CLIENT_ONLY_PAID_PAGES_KNOWN.includes(f));
  assert.deepEqual(added, [],
    `サーバー側認可の無い有料ページが増えた（gatePaidPage を使うこと）: ${added.join(', ')}`);
});

test('サーバー側認可へ移したページは既知リストから消えている', () => {
  const { clientOnly, serverAuth } = classifyPaidPages();
  const stale = CLIENT_ONLY_PAID_PAGES_KNOWN.filter((f) => serverAuth.includes(f));
  assert.deepEqual(stale, [],
    `SSR 化済みなのに既知リストへ残っている: ${stale.join(', ')}`);
  // 既知リストは実態と一致していること（消し忘れ・書き間違いを検知）
  const missing = CLIENT_ONLY_PAID_PAGES_KNOWN.filter((f) => !clientOnly.includes(f));
  assert.deepEqual(missing, [], `既知リストにあるが実在しない: ${missing.join(', ')}`);
});

test('サーバー側認可のページは gatePaidPage か verifyPlanAccess を通す', () => {
  const { serverAuth } = classifyPaidPages();
  assert.ok(serverAuth.length >= 3, `サーバー側認可のページが少なすぎる: ${serverAuth.length}`);
  for (const f of serverAuth) {
    const raw = readFileSync(join(ROOT, f), 'utf8');
    assert.match(raw, /export const prerender\s*=\s*false/,
      `${f}: サーバー側認可なのに prerender=false でない`);
  }
});
