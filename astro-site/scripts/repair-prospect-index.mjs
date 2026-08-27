/**
 * repair-prospect-index.mjs — 名指しした hash の**索引だけ**を直す
 *
 *   下見（既定・**書かない**）:
 *     ADMIN_SECRET=... node scripts/repair-prospect-index.mjs <hash> [hash...]
 *   実行（**承認を得てから**）:
 *     ADMIN_SECRET=... node scripts/repair-prospect-index.mjs --apply <hash> [hash...]
 *
 * ⚠️ 直すのは `ACTIVE_INDEX` / `ENGAGED_INDEX` の**所属だけ**。
 *    レコード・Customers・送信・queue は一切触らない。
 * ⚠️ あるべき所属と違うときだけ書く（既に正しければ **0 コマンド**）。
 * ⚠️ rollback は逆向きの 1 コマンド（`SADD` したなら同じ hash の `SREM`）。
 */
const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CONFIRM = 'REPAIR PROSPECT INDEX';

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hashes = args.filter((a) => a !== '--apply');
if (hashes.length === 0) { console.error('✖ hash を渡してください'); process.exit(1); }

const body = { action: 'prospectIndexRepair', hashes };
if (apply) { body.apply = true; body.confirm = CONFIRM; }

const r = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
  body: JSON.stringify(body),
});
const j = await r.json().catch(() => null);
if (r.status !== 200 || !j) {
  console.error('✖ HTTP', r.status, JSON.stringify(j || {}).slice(0, 300));
  process.exit(1);
}
if (JSON.stringify(j).includes('@')) { console.error('✖ 応答にアドレスが混ざっている'); process.exit(1); }
console.log(JSON.stringify(j, null, 1));

if (!apply) {
  console.log('\n下見です（1 バイトも書いていません）。実行するには --apply を付けてください。');
  process.exit(0);
}
console.log(`\n✅ 索引を ${j.applied} 件直しました（レコード・Customers・送信は不変）`);
process.exit(0);
