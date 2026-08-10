/**
 * 移行スクリプト共通の IO（Airtable / Redis / Blobs / checkpoint ファイル）。
 *
 * ロジックは `src/lib/migration/*` にあり、ここは**外界との接続だけ**。
 * リハーサル（テスト）は同じロジックへ偽の IO を注入して通している。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    // 値は出さない。名前だけ
    console.error(`❌ 必要な環境変数が未設定です: ${missing.join(', ')}`);
    process.exit(3);
  }
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (n, d) => {
    const hit = args.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
  };
  return { get, has: (n) => args.includes(`--${n}`), raw: args };
}

// ── checkpoint（ローカルファイル。production store を汚さない）──────
export function checkpointPath(job, dir) {
  const base = dir || process.env.MIGRATION_STATE_DIR || path.join(process.cwd(), '.migration-state');
  return path.join(base, `${job}.json`);
}

export function loadCheckpoint(job, dir) {
  const p = checkpointPath(job, dir);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCheckpoint(job, cp, dir) {
  const p = checkpointPath(job, dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cp, null, 1));
  return p;
}

// ── Airtable ────────────────────────────────────────────────────
/**
 * 1 ページ取得する関数を作る。**429 と一時失敗だけ再試行**し、
 * それ以外は上位（`readAllPages`）が例外にできるよう null を返さない。
 */
export function makeAirtablePager({ table, fields = [], filterByFormula = null, pageSize = 100 }) {
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  return async (offset) => {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', String(pageSize));
    if (filterByFormula) u.searchParams.set('filterByFormula', filterByFormula);
    for (const f of fields) u.searchParams.append('fields[]', f);
    if (offset) u.searchParams.set('offset', offset);

    let last = null;
    for (let a = 0; a < 8; a += 1) {
      const res = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
      if (res.status === 429) { await sleep(2000); continue; }
      const j = await res.json().catch(() => null);
      if (j && Array.isArray(j.records)) {
        await sleep(210); // Airtable 5 req/s
        return { records: j.records, offset: j.offset || null };
      }
      last = j && j.error ? (j.error.type || 'error') : `http_${res.status}`;
      await sleep(1200);
    }
    // 壊れた応答をそのまま返し、上位で IncompleteReadError にさせる
    throw new Error(`airtable_page_failed:${table}:${last}`);
  };
}

// ── Redis ───────────────────────────────────────────────────────
export function makeRedisCmdFromEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('upstash_not_configured');
  return async (args) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`upstash_${res.status}`); // 値は載せない
    const j = await res.json();
    return j.result;
  };
}

// ── Netlify Blobs ───────────────────────────────────────────────
/**
 * スクリプトから Blobs を使うには siteID と token が要る。
 * **未設定なら throw**（黙って書かない経路を作らない）。
 */
export async function makeBlobSetter(storeName) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new Error('netlify_blobs_not_configured');
  const store = getStore({ name: storeName, siteID, token });
  return (key, body) => store.set(key, body);
}

/** 進捗表示（件数だけ。鍵・アドレスは出さない） */
export function progressLogger(label, every = 2000) {
  let last = 0;
  return (cp) => {
    if (cp.recordsRead - last < every) return;
    last = cp.recordsRead;
    process.stderr.write(
      `   ${label}: read=${cp.recordsRead} written=${cp.recordsWritten} skipped=${cp.recordsSkipped}\n`,
    );
  };
}
