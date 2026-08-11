/**
 * workflowTransientContract.mjs — 「一時障害で Actions を Failure にしない」を機械検査する。
 *
 * ## 何を守るためのものか
 *
 * shared 取得の一時障害（rate limit / timeout / 5xx）は人間が直せるものではない。
 * 次回の schedule 実行で回復するので、GitHub の failed メールを出す理由がない。
 * そのために scripts 側は専用の終了コードを返すようになっている:
 *
 *   exit 2  … checker（`exitWithSharedFetchError`）が「判定不能だが一時的」
 *   exit 75 … importer（`exitDeferredOrFatal`, EX_TEMPFAIL）が「未完了だが一時的」
 *
 * ところが workflow 側が
 *
 *     if ! OUT=$(node scripts/checkSharedNankanResults.mjs ...); then exit 1; fi
 *
 * のように「非ゼロなら全部 exit 1」と書いていると、この分類は握り潰される。
 * 実際 2026-08-10 の Auto Sync Check #150 / Import Prediction (Daily Check) #196 は
 * どちらも 403 rate limit だけで failure になり、failed メールが飛んだ。
 *
 * このモジュールは scripts と workflow の**対応関係そのもの**を検査する。
 * 新しい importer / checker が増えても、対応表を手で更新しなくても検知できるよう、
 * 期待コードは「スクリプトがどちらのヘルパーを呼んでいるか」から導出する。
 *
 * ## 検査の流れ
 *
 *   1. scripts 配下を走査し、`exitWithSharedFetchError` を呼ぶ → 期待コード 2、
 *      `exitDeferredOrFatal` を呼ぶ → 期待コード 75 として基準表を作る。
 *   2. package.json の scripts で `npm run <alias>` → 実ファイルの対応を解決する。
 *   3. schedule で動く workflow の各 step の run ブロックを見て、
 *      基準表のスクリプトを呼んでいるなら、その step が期待コードを分岐しているかを確認する。
 *
 * ## 意図的に対象外にしたい場合
 *
 * run ブロックに次の行を書く（理由を必ず書く）。緑化の抜け道にしないため、理由なしは違反のまま。
 *
 *     # transient-contract: exempt — <理由>
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

/** checker 用。判定不能だが一時的。 */
export const EXIT_TRANSIENT = 2;
/** importer 用。未完了だが一時的（EX_TEMPFAIL）。 */
export const EXIT_DEFERRED = 75;

const EXEMPT_MARKER = /#\s*transient-contract:\s*exempt\s*[—-]\s*\S/;

/** 走査対象の拡張子 */
const SCRIPT_EXT = new Set(['.js', '.mjs']);

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * scripts 配下から「一時障害を専用コードで返すスクリプト」の基準表を作る。
 * @param {string} scriptsDir
 * @returns {Map<string, number>} ファイル名（basename）→ 期待 exit code
 */
export function buildScriptExpectations(scriptsDir) {
  const map = new Map();
  for (const file of listFilesRecursive(scriptsDir)) {
    if (!SCRIPT_EXT.has(extname(file))) continue;
    const name = basename(file);
    if (name.endsWith('.test.mjs') || name.endsWith('.test.js')) continue;
    // ヘルパー自身の定義は対象外（呼び出し側だけを見る）
    if (name === 'sharedCheckerSupport.mjs' || name === 'workflowTransientContract.mjs') continue;

    const src = readFileSync(file, 'utf-8');

    // (a) 終端ハンドラを呼ぶもの（大半のスクリプトはこちら）
    if (/\bexitDeferredOrFatal\s*\(/.test(src)) {
      map.set(name, EXIT_DEFERRED);
      continue;
    }
    if (/\bexitWithSharedFetchError\s*\(/.test(src)) {
      map.set(name, EXIT_TRANSIENT);
      continue;
    }

    // (b) ハンドラを使わず、コードを自前で return / exit するもの
    //     （checkArchiveCoverage.mjs / checkJraResultsForImport.mjs が該当）。
    //     どちらの定数を sharedCheckerSupport から import しているかで判定する。
    //     ここを見ないと、これらの checker が契約検査の穴になる。
    const imported = /from\s+['"][^'"]*sharedCheckerSupport\.mjs['"]/.test(src)
      ? src.slice(0, src.search(/from\s+['"][^'"]*sharedCheckerSupport\.mjs['"]/))
      : '';
    const importClause = imported.slice(imported.lastIndexOf('import'));
    if (/\bEXIT_DEFERRED\b/.test(importClause)) map.set(name, EXIT_DEFERRED);
    else if (/\bEXIT_TRANSIENT\b/.test(importClause)) map.set(name, EXIT_TRANSIENT);
  }
  return map;
}

/**
 * package.json の scripts から `npm run <alias>` が実行するファイル名を解決する。
 * @param {string} packageJsonPath
 * @returns {Map<string, string[]>} alias → 実行されるファイル名（basename）の配列
 */
export function buildNpmAliasMap(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const scripts = pkg.scripts ?? {};
  const direct = new Map();
  for (const [alias, cmd] of Object.entries(scripts)) {
    const files = [...String(cmd).matchAll(/(?:^|[\s/])([\w.-]+\.m?js)\b/g)].map((m) => m[1]);
    direct.set(alias, files);
  }
  // `npm run a` が `npm run b` を呼ぶ多段を 1 段だけ展開する（本 repo の実態に十分）
  const resolved = new Map();
  for (const [alias, cmd] of Object.entries(scripts)) {
    const files = new Set(direct.get(alias) ?? []);
    for (const m of String(cmd).matchAll(/npm run ([\w:-]+)/g)) {
      for (const f of direct.get(m[1]) ?? []) files.add(f);
    }
    resolved.set(alias, [...files]);
  }
  return resolved;
}

/**
 * workflow の YAML テキストを step 単位に割る。
 * YAML パーサを持ち込まず、`- name:` のインデント位置で素朴に区切る
 * （本 repo の workflow はすべて 6 スペース + `- name:` で統一されている）。
 * @param {string} text
 * @returns {{name: string, body: string}[]}
 */
export function splitSteps(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) starts.push({ index: i, name: m[1] });
  });
  return starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : lines.length;
    return { name: s.name, body: lines.slice(s.index, end).join('\n') };
  });
}

/** schedule トリガを持つ workflow か */
export function isScheduled(text) {
  return /^\s*schedule:\s*$/m.test(text);
}

/**
 * run ブロックが指定コードを分岐しているか。
 * `-eq 2` / `-eq 75` / `== 2` のいずれか、または `exit "$RC"` のような
 * 「元のコードをそのまま返す」形を許容する（後者は run を落とすが、
 * 呼び出し元 step で分岐済みのケース向け）。
 */
function handlesCode(body, code) {
  const patterns = [
    new RegExp(`-eq\\s+${code}\\b`),
    new RegExp(`==\\s*'?${code}'?\\b`),
    new RegExp(`\\)\\s*${code}\\s*\\)`), // case 文 `2)` 形式
  ];
  return patterns.some((p) => p.test(body));
}

/**
 * コメント行だけを落とす。
 *
 * 「旧 checkSharedDailyFile.mjs は…」のような **説明文中のスクリプト名**を
 * 実行とみなすと、実際には呼んでいない step が違反として上がる（偽陽性）。
 * 逆に行内の `#` まで削ると `grep -q "#"` のようなコードを壊すため、
 * 行頭（インデントのみ先行）の `#` だけを対象にする。
 * exempt マーカーはコメントなので、この関数を通す**前**に判定すること。
 * @param {string} body
 */
export function stripCommentLines(body) {
  return body
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * 1 リポジトリぶんの検査。
 * @param {{workflowsDir: string, scriptsDir: string, packageJsonPath: string}} paths
 * @returns {{file: string, step: string, script: string, expected: number}[]} 違反一覧
 */
export function findTransientContractViolations({ workflowsDir, scriptsDir, packageJsonPath }) {
  const expectations = buildScriptExpectations(scriptsDir);
  const aliases = buildNpmAliasMap(packageJsonPath);
  const violations = [];

  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const text = readFileSync(join(workflowsDir, file), 'utf-8');
    if (!isScheduled(text)) continue;

    for (const step of splitSteps(text)) {
      if (EXEMPT_MARKER.test(step.body)) continue;
      const code = stripCommentLines(step.body);

      /** この step が実行するスクリプト名 */
      const invoked = new Set();
      for (const m of code.matchAll(/(?:^|[\s/])([\w.-]+\.m?js)\b/g)) invoked.add(m[1]);
      for (const m of code.matchAll(/npm run ([\w:-]+)/g)) {
        for (const f of aliases.get(m[1]) ?? []) invoked.add(f);
      }

      for (const script of invoked) {
        const expected = expectations.get(script);
        if (expected === undefined) continue;
        if (!handlesCode(code, expected)) {
          violations.push({ file, step: step.name, script, expected });
        }
      }
    }
  }
  return violations;
}
