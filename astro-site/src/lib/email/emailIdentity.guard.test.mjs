/**
 * emailIdentity.guard.test.mjs — メールアドレスの単一源ガード。
 *
 * 恒久ルール（2026-08-31 固定）:
 * - 問い合わせ・返信先 = `support@keiba.link`（SUPPORT_EMAIL / ADMIN_EMAIL）
 * - システム送信元     = `noreply@keiba.link`（FROM_EMAIL）
 * - 旧サイト名残のアドレス（`nankan.analytics@gmail.com` / `nankan-analytics@keiba.link` /
 *   `nankan.analytics@keiba.link`）は **現役コードに 1 箇所も存在しない**。
 *
 * revert / コピペ / テンプレート同期で旧アドレスが復活すると、
 * 「返信が旧 Gmail に飛ぶ」「未 verify の from で SendGrid が無音失敗する」事故に戻る。
 * それを CI で機械的に止めるためのガード。
 *
 * 検査対象外（意図的）:
 * - コメント（過去経緯の記録は残す）
 * - テストファイル（本ファイル / senderIdentity.test.mjs の「拒否されるべき値」等）
 * - `docs/`（履歴台帳）
 * - `nankan-stripe-integration/`（本 Netlify サイトの build 対象外＝旧実装）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASTRO_SITE = path.resolve(here, '../../..');

/** 撤去済みの旧アドレス（現役コードに出現してはいけない）。 */
const LEGACY_ADDRESSES = [
  'nankan.analytics@gmail.com',
  'nankan-analytics@keiba.link',
  'nankan.analytics@keiba.link',
];

/** 走査対象（現役経路）。 */
const SCAN_ROOTS = ['netlify/functions', 'src', 'scripts'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.astro']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.netlify', '.astro']);

function isTestFile(file) {
  return /\.test\.(mjs|js|cjs|ts)$/.test(file);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(name)) && !isTestFile(name)) out.push(full);
  }
  return out;
}

/**
 * コメントを除去する（旧アドレスの「過去経緯メモ」を誤検知しないため）。
 * URL の `https://` を壊さないよう、`//` の直前が `:` の場合は行コメント扱いしない。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FILES = SCAN_ROOTS.flatMap((r) => walk(path.join(ASTRO_SITE, r)));

test('走査対象が 0 件でない（素通り防止）', () => {
  assert.ok(FILES.length > 100, `走査対象が少なすぎる: ${FILES.length} 件`);
});

test('現役コードに旧メールアドレスが存在しない', () => {
  const hits = [];
  for (const file of FILES) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const legacy of LEGACY_ADDRESSES) {
      if (code.includes(legacy)) {
        hits.push(`${path.relative(ASTRO_SITE, file)} → ${legacy}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    '旧メールアドレスが再混入しています。' +
      ' netlify/functions/config/email-config.js の SUPPORT_EMAIL / ADMIN_EMAIL / FROM_EMAIL を使ってください:\n' +
      hits.join('\n')
  );
});

test('email-config.js の契約値が固定されている', async () => {
  const cfg = await import('../../../netlify/functions/config/email-config.js');
  assert.equal(cfg.SUPPORT_EMAIL, 'support@keiba.link', '問い合わせ・返信先は support@keiba.link');
  assert.equal(cfg.ADMIN_EMAIL, 'support@keiba.link', '管理者宛通知の宛先は support@keiba.link');
  assert.equal(cfg.FROM_EMAIL, 'noreply@keiba.link', 'システム送信元は noreply@keiba.link');
  assert.equal(cfg.DISPLAY_SUPPORT_EMAIL, 'support@keiba.link');
  assert.equal(cfg.ALT_EMAIL, undefined, '旧アドレスの別名定数 ALT_EMAIL は復活させない');
});

test('メール送信する現役 Function は email-config.js を参照している', () => {
  const REQUIRED = [
    'contact-form.js',
    'process-withdrawal.js',
    'premium-plus-contact.js',
    'point-exchange.js',
    'expiry-notification.js',
    'expiry-warning-notification.js',
  ];
  for (const name of REQUIRED) {
    const src = readFileSync(path.join(ASTRO_SITE, 'netlify/functions', name), 'utf8');
    assert.match(
      src,
      /from '\.\/config\/email-config\.js'/,
      `${name} が email-config.js を import していない（アドレス直書きの疑い）`
    );
  }
});

test('決済メールの送信元は senderIdentity.js のまま（noreply へ寄せ替えない）', () => {
  // 決済メール v2 は support@keiba.link を正式送信元とし、env 不一致は fail closed。
  // email-config.js の FROM_EMAIL（noreply）へ fallback させてはいけない。
  const src = readFileSync(path.join(ASTRO_SITE, 'src/lib/payments/senderIdentity.js'), 'utf8');
  assert.match(src, /OFFICIAL_FROM_EMAIL = 'support@keiba\.link'/);
});

test('メルマガの From は noreply のまま（DeliveryKey 構成要素なので変更禁止）', () => {
  const src = readFileSync(path.join(ASTRO_SITE, 'src/lib/newsletter/brand-config.js'), 'utf8');
  assert.match(src, /defaultFromEmail: 'noreply@keiba\.link'/);
  assert.match(src, /replyToEmail: 'support@keiba\.link'/);
});
