/**
 * generate-filter-dictionary.mjs — 管理画面フィルター辞書を**定義から生成**する
 *
 * 画面の説明と docs がズレないよう、`filterDefinitions.js` を唯一の出所にする。
 * 手で docs を書き換えない（書き換えても次回生成で戻る）。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FILTER_DEFINITIONS, FILTER_CATEGORY_LABEL, EMAIL_SEARCH, ADVANCED_FILTERS,
} from '../src/lib/marketing/filterDefinitions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '../docs/ADMIN_FILTER_DICTIONARY.md');

const TAB_OF = (id) => (id.startsWith('mk') ? '顧客マーケティング'
  : id.startsWith('cb') ? 'カムバック特典' : 'Premium Plus 販売');

const lines = [
  '# 管理画面フィルター辞書',
  '',
  '> **このファイルは自動生成です。** 出所は `src/lib/marketing/filterDefinitions.js`。',
  '> 手で編集せず、定義を直して `node astro-site/scripts/generate-filter-dictionary.mjs` を実行してください。',
  '> 画面に出る説明とこの辞書は**同じ定義から作られる**ため、ズレません。',
  '',
  '## 読み方',
  '',
  '| 分類 | 意味 |',
  '|---|---|',
  ...Object.entries(FILTER_CATEGORY_LABEL).map(([k, v]) => `| ${v} | \`${k}\` |`),
  '',
  '- **現在状態** … いまどうなっているか（母集団を作る）',
  '- **履歴** … 過去に何があったか（現在状態とは別。混ぜない）',
  '- **追加条件** … 現在状態をさらに絞る条件（単独では母集団を作らない）',
  '- **操作可否** … いまその操作を実行できるか',
  '',
  `## Email 個別検索`,
  '',
  `- ${EMAIL_SEARCH.label}: ${EMAIL_SEARCH.description}`,
  `- 入力があるときだけ「${EMAIL_SEARCH.activeBadge}」を表示します。`,
  '',
  `## ${ADVANCED_FILTERS.summary}`,
  '',
  `${ADVANCED_FILTERS.hint}`,
  '',
];

let currentTab = '';
for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
  const tab = TAB_OF(id);
  if (tab !== currentTab) {
    lines.push('', `## ${tab}`, '');
    currentTab = tab;
  }
  lines.push(`### ${d.label}（\`${id}\`）`, '');
  lines.push(`- **分類**: ${FILTER_CATEGORY_LABEL[d.category] || d.category}`);
  lines.push(`- **説明**: ${d.description}`);
  if (d.apiKey) lines.push(`- **API キー**: \`${d.apiKey}\``);
  if (d.exclusive) lines.push('- **排他**: 1 顧客につき 1 区分だけ当たります');
  if (d.dependsOn) {
    const parent = FILTER_DEFINITIONS[d.dependsOn];
    lines.push(`- **依存**: 「${parent ? parent.label : d.dependsOn}」が`
      + `「${(parent ? parent.options : []).find((o) => o.value === d.dependsOnValue)?.label || d.dependsOnValue}」`
      + 'の顧客にだけ当てはまります（部分集合）');
  }
  if (d.relationNote) lines.push(`- **関係**: ${d.relationNote}`);
  lines.push('', '| 表示名 | コード値 | 意味 |', '|---|---|---|');
  for (const o of d.options) lines.push(`| ${o.label} | \`${o.value}\` | ${o.description} |`);
  lines.push('');
}

lines.push('## 注意', '',
  '- **コード値は API の許可値**です。表示名を変えてもコード値は変えないでください',
  '  （保存済みの条件・API 契約が壊れます）。',
  '- 定義に無い値は**言い換えません**（画面にはコード値がそのまま出ます）。',
  '  新しい値を足したら、必ずここの定義にも追加してください。',
  '');

writeFileSync(OUT, `${lines.join('\n')}\n`);
console.log(`✅ 生成: ${path.relative(process.cwd(), OUT)}（${Object.keys(FILTER_DEFINITIONS).length} 項目）`);
