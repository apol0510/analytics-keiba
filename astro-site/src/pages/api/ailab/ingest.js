/**
 * POST /api/ailab/ingest/ — KAP（MK の PC）から 1 日・1 market 分の全レース・全頭の AI 勝率・単勝オッズ・期待値を受け取る。
 * 正本 docs/AI_LAB.md（2026-10-07 MK 確定）
 * - 認証: x-ailab-secret の SHA-256 を、コードの INGEST_KEY_SHA256（キーそのものは PC にだけある）と timing-safe に照合
 *   🛑 env に置かない: Netlify Functions の env は AWS Lambda の 4KB 上限に近く、1 つ足しただけで
 *      全 Function の作成が失敗し本番 deploy が止まった（2026-10-05 実測）
 * - 保存するのは sanitizeIngest が残した項目だけ（買い目・選んだ馬・金額・判断は落とす）
 * - 馬名は AK の予想データ（SSR に残る直近日）から添える（表示用・無ければ馬番だけ）
 */
export const prerender = false;
import { timingSafeEqual, createHash } from 'node:crypto';
import { sanitizeIngest, attachNames } from '../../../lib/ailab/aiLab.js';
import { saveDay, INGEST_KEY_SHA256 } from '../../../lib/ailab/aiLabStore.js';
import { loadDay } from '../../../lib/acquisition/raceSource.js';
import { makeRedisCmd } from '../../../lib/premiumPlus/premiumPlusFunnelServer.js';

const MAX_BYTES = 600 * 1024;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const digest = (s) => createHash('sha256').update(String(s)).digest();

export async function POST({ request }) {
  const given = request.headers.get('x-ailab-secret') || '';
  if (given.length < 32 || !timingSafeEqual(digest(given), Buffer.from(INGEST_KEY_SHA256, 'hex'))) return json(401, { ok: false, error: 'unauthorized' });
  const redis = makeRedisCmd(process.env);
  if (!redis) return json(503, { ok: false, error: 'redis_unavailable' });
  const text = await request.text();
  if (text.length > MAX_BYTES) return json(413, { ok: false, error: 'too_large' });
  let payload;
  try { payload = JSON.parse(text); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  const s = sanitizeIngest(payload);
  if (!s.ok) return json(400, { ok: false, error: s.reason });
  let akVenues = [];
  try { akVenues = loadDay(s.day.market, s.day.date, { pastRaces: false }); } catch { akVenues = []; }
  try {
    const saved = await saveDay(redis, attachNames(s.day, akVenues));
    return json(200, { ok: true, market: saved.market, date: saved.date, races: saved.races.length,
      evaluated: saved.races.filter((r) => r.status === 'ok').length });
  } catch (e) {
    console.error('[ailab] save failed:', e?.message || 'unknown');
    return json(503, { ok: false, error: 'save_failed' });
  }
}

export function GET() { return json(405, { ok: false, error: 'method_not_allowed' }); }
