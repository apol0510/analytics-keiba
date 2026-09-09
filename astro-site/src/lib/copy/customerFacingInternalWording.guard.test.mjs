/**
 * customerFacingInternalWording.guard.test.mjs
 *   顧客向け画面に**内部運用の事情・内部用語・管理画面への導線**を出さない
 *
 * ## なぜ必要か（2026-09-09 MK 報告）
 *
 * > 内部情報が堂々とユーザーに公開されてしまってます
 *
 * `/premium-plus-v2/` の注記に、こう書かれていた:
 *
 *   「当時は不的中の日の控えを保存していなかったため」
 *   「（画像の「集計外」表記が該当分です）」
 *   「記録を開始した以降の実データのみで自動集計しています」
 *
 * どれも**社内の事情と社内の言葉**で、お客様には関係がないどころか、
 * 「控えを保存していなかった」は運用の不備をこちらから明かしている。
 * 横断で調べると、同種の露出が他にもあった（内部ルール名がそのまま画面に出ている /
 * 有料会員のエラー画面に管理画面へのボタンが置かれている 等）。
 *
 * ## 何を禁止するか
 *
 * **画面に出る文字だけ**を見る（コメント・style・script・frontmatter は対象外）。
 * `{...}` の中は変数の値が出るので、識別子名として数えない。
 *
 * | 種類 | 例 |
 * |---|---|
 * | 管理画面への導線 | `href="/admin...` |
 * | 内部の集計用語 | 集計外 / 旧集計基準 / 現在基準集計 / 内部ルール |
 * | 内部処理の語 | 取込 |
 * | 内部の識別子 | `AI_SANRENPUKU_AXIS_V1` のような SCREAMING_SNAKE をそのまま表示 |
 * | インフラ名 | Airtable / SendGrid / Redis / localStorage |
 * | 運用不備の告白 | 保存していなかった / 暫定 / 仮実装 / 未対応 |
 *
 * ## 誤検知させないための注意（消さないこと）
 *
 * 競馬の言葉と社内用語は**別物**。以下は正常なので禁止語に入れない:
 *   ゲート（発馬機）・フルゲート・ゲート練習 / 資金運用・運用 / 投票控え
 *   不具合を報告したい（お問い合わせの選択肢）
 *
 * ## 例外（allowlist）
 *
 * 意図的に出しているもの・この監査の対象外のものは下の ALLOW に理由付きで置く。
 * **黙って足さないこと。** 増やすときは理由を書く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname; // src/

/**
 * 例外。**理由を必ず書く。**
 * ⚠️ ここに足すのは「お客様に見せてよいと判断済み」のものだけ。
 *    直すべきものを黙らせる場所ではない。
 */
const ALLOW = new Map([
  // 技術スタックの紹介として意図的に社名を出している（MK 判断待ち・2026-09-09 時点は現状維持）
  ['pages/about.astro', ['Airtable', 'Netlify']],
  ['pages/service-description.astro', ['Netlify']],
  // 商品デモとして「管理画面」の画面例を見せているページ（MK 判断待ち）
  ['pages/pro-demo.astro', ['管理画面']],
]);

/** 管理用ページはこの監査の対象外（顧客向けではない） */
const isAdminFile = (rel) => rel.includes('/admin/') || /(^|\/)admin[-.]/.test(rel);

function listAstro(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listAstro(p));
    else if (name.endsWith('.astro')) out.push(p);
  }
  return out;
}

/** 画面に出る文字だけを残す */
function renderedText(src) {
  let s = src.replace(/^---[\s\S]*?^---/m, ' ');      // frontmatter
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');             // HTML コメント
  s = s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');        // JSX コメント
  s = s.replace(/<style[\s\S]*?<\/style>/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/g, ' ');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/^\s*\/\/.*$/gm, ' ');
  return s;
}
/**
 * 識別子検査用: `{...}` の中は**変数の値**が出るので、名前として数えない。
 * ⚠️ 入れ子・複数行の式があるので、正規表現ではなく括弧の対応を数えて消す。
 *    （`{HOW_TO_USE.steps.map((s, i) => (...))}` を消し損ねて誤検知した）
 */
function withoutExpressions(src) {
  let out = '';
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { if (depth > 0) depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

const BANNED = [
  { re: /href="\/admin/, what: '管理画面へのリンク', why: 'お客様に社内ツールの入口を見せている' },
  { re: /集計外/, what: '「集計外」', why: '社内の集計用語。お客様には意味が伝わらない' },
  { re: /旧集計基準|現在基準集計/, what: '「旧集計基準 / 現在基準集計」', why: '社内の集計基準の話' },
  { re: /内部ルール/, what: '「内部ルール」', why: '内部を明示している' },
  { re: /取込/, what: '「取込」', why: 'データ取り込みという社内処理の語' },
  { re: /Airtable|SendGrid|Redis|localStorage/, what: 'インフラ・サービス名', why: '内部構成の露出' },
  { re: /保存していなかった|暫定|仮実装|未対応/, what: '運用不備の告白', why: 'こちらから不備を明かしている' },
];

const files = listAstro(join(ROOT, 'pages')).concat(
  listAstro(join(ROOT, 'components')), listAstro(join(ROOT, 'layouts')),
).map((p) => ({ abs: p, rel: relative(ROOT, p) })).filter(({ rel }) => !isAdminFile(rel));

test('対象ファイルが 0 件にならない（監査が素通りしない）', () => {
  assert.ok(files.length > 50, `顧客向けページが ${files.length} 件しか見つからない`);
});

test('【重要】顧客向け画面に内部運用の文言・管理画面への導線を出さない', () => {
  const found = [];
  for (const { abs, rel } of files) {
    const text = renderedText(readFileSync(abs, 'utf8'));
    const allowed = ALLOW.get(rel) || [];
    for (const b of BANNED) {
      const m = text.match(b.re);
      if (!m) continue;
      if (allowed.some((a) => m[0].includes(a) || a.includes(m[0]))) continue;
      found.push(`${rel}: ${b.what} → ${b.why}（該当: "${m[0]}"）`);
    }
  }
  assert.deepEqual(found, [], `顧客向け画面に内部情報が出ている:\n  ${found.join('\n  ')}`);
});

test('【重要】内部の識別子（SCREAMING_SNAKE）をそのまま画面に出さない', () => {
  const found = [];
  for (const { abs, rel } of files) {
    const text = withoutExpressions(renderedText(readFileSync(abs, 'utf8')));
    // 2 語以上の大文字＋アンダースコア（例: AI_SANRENPUKU_AXIS_V1）
    const m = text.match(/\b[A-Z][A-Z0-9]{1,}_[A-Z0-9_]{2,}\b/);
    if (m && !(ALLOW.get(rel) || []).includes(m[0])) found.push(`${rel}: "${m[0]}"`);
  }
  assert.deepEqual(found, [], `内部の識別子が画面に出ている:\n  ${found.join('\n  ')}`);
});

test('競馬の言葉を誤って禁止していない（ゲート・資金運用・投票控え）', () => {
  for (const word of ['ゲート', 'フルゲート', '資金運用', '投票控え', '不具合']) {
    assert.ok(!BANNED.some((b) => b.re.test(word)), `"${word}" を誤検知する禁止語がある`);
  }
});
