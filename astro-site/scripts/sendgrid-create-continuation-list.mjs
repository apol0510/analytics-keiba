#!/usr/bin/env node
/**
 * sendgrid-create-continuation-list.mjs — 継続配信の list を **1 本だけ**作る（既定は下見）
 *
 * ## なぜ 1 本だけの専用スクリプトなのか
 *
 * 反応した人を渡す先（`ak-drm-engaged`）が無いと、webhook は「何もしない」で素通りする。
 * 作るのは**この 1 本だけ**で、選別 list や KI の資産には指一本触れない。
 * だから汎用の作成経路（二重ゲートつきの管理 API）を開けずに、
 * **名前を固定した専用スクリプト**で作る。
 *
 * ## 守ること
 *
 * - 作る list 名は **`ak-drm-engaged` 固定**（引数で変えられない）
 * - **すでにあれば作らない**（名前が識別子）
 * - 触るのは `/v3/marketing/lists` の **GET と POST だけ**（更新・削除・contact 投入を持たない）
 * - 既定は下見。`--apply --confirm "CREATE AK CONTINUATION LIST"` の両方でだけ作る
 * - 作成後は GET で「**空で存在する**」ことを確かめる
 * - 既存 list の名前・件数を**変えない**（作成前後で差分が無いことを確認する）
 *
 * ```bash
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-continuation-list.mjs
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-continuation-list.mjs \
 *   --apply --confirm "CREATE AK CONTINUATION LIST"
 * ```
 */

import { CONTINUATION_LIST_NAME } from '../src/lib/marketing/sendgridContinuation.js';

const CONFIRM = 'CREATE AK CONTINUATION LIST';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = args.includes('--confirm') ? args[args.indexOf('--confirm') + 1] : null;
const KEY = process.env.SENDGRID_API_KEY;

const call = async (method, path, body) => {
  if (!path.startsWith('/v3/marketing/lists')) throw new Error(`path_not_allowed:${path}`);
  if (!['GET', 'POST'].includes(method)) throw new Error(`method_not_allowed:${method}`);
  const r = await fetch(`https://api.sendgrid.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (r.status >= 400) throw new Error(`sendgrid_${r.status}`);
  return text ? JSON.parse(text) : null;
};

const listAll = async () => ((await call('GET', '/v3/marketing/lists?page_size=100')).result || [])
  .map((l) => ({ id: String(l.id), name: String(l.name), count: Number(l.contact_count) || 0 }));

if (!KEY) { console.error('❌ SENDGRID_API_KEY がありません'); process.exit(1); }

const before = await listAll();
console.log('■ 作成前の list');
for (const l of before) console.log(`  ${l.name} : ${l.count}`);

if (before.some((l) => l.name === CONTINUATION_LIST_NAME)) {
  console.log(`✅ ${CONTINUATION_LIST_NAME} はすでにあります（作りません）`);
  process.exit(0);
}
if (!apply) {
  console.log(`（下見です。--apply --confirm "${CONFIRM}" を渡すまで作りません）`);
  process.exit(0);
}
if (confirm !== CONFIRM) {
  console.error(`❌ --confirm "${CONFIRM}" が要ります。何も作っていません。`);
  process.exit(1);
}

const created = await call('POST', '/v3/marketing/lists', { name: CONTINUATION_LIST_NAME });
console.log(`■ 作成: ${CONTINUATION_LIST_NAME} id=${created && created.id}`);

const after = await listAll();
const hit = after.find((l) => l.name === CONTINUATION_LIST_NAME);
const others = after.filter((l) => l.name !== CONTINUATION_LIST_NAME);
const sameAsBefore = before.length === others.length
  && before.every((b) => others.some((o) => o.id === b.id && o.name === b.name && o.count === b.count));

console.log('■ 作成後の確認');
console.log(`  ${CONTINUATION_LIST_NAME}: ${hit ? `存在・${hit.count} 件` : '**見つからない**'}`);
console.log(`  既存 list は不変: ${sameAsBefore ? 'はい' : '**いいえ**'}`);
const ok = !!hit && hit.count === 0 && sameAsBefore;
console.log(ok ? '✅ 空の list として作成できました（既存 list は不変）' : '❌ 期待どおりではありません');
process.exit(ok ? 0 : 1);
