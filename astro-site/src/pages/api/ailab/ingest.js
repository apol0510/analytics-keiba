/**
 * POST /api/ailab/ingest/ — KAP（MK の PC）から 1 日分の全頭期待値を受け取る。正本 docs/AI_LAB.md
 * - 認証: x-ailab-secret（env AILAB_INGEST_SECRET）。env が無ければ 503（fail closed）
 * - 受け取るのは全頭の AI 勝率・オッズだけ。KAP の買い目・金額は保存しない（sanitizeIngest が落とす）
 * - AK の上位 5 頭は取込時に AK の予想から添える（SSR に残る直近日だけ・以降は保存済みを保つ）
 */
export const prerender = false;
import { timingSafeEqual, createHash } from 'node:crypto';
import { sanitizeIngest, attachAk } from '../../../lib/ailab/aiLab.js';
import { saveDay } from '../../../lib/ailab/aiLabStore.js';
import { loadDay } from '../../../lib/acquisition/raceSource.js';
import { makeRedisCmd } from '../../../lib/premiumPlus/premiumPlusFunnelServer.js';

const MAX_BYTES = 600 * 1024;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const digest = (s) => createHash('sha256').update(String(s)).digest();

export async function POST({ request }) {
  const secret = process.env.AILAB_INGEST_SECRET;
  if (!secret || secret.length < 32) return json(503, { ok: false, error: 'not_configured' });
  if (!timingSafeEqual(digest(request.headers.get('x-ailab-secret') || ''), digest(secret))) return json(401, { ok: false, error: 'unauthorized' });
  const text = await request.text();
  if (text.length > MAX_BYTES) return json(413, { ok: false, error: 'too_large' });
  let payload;
  try { payload = JSON.parse(text); } catch { return json(400, { ok: false, error: 'bad_json' }); }
  const s = sanitizeIngest(payload);
  if (!s.ok) return json(400, { ok: false, error: s.reason });
  const redis = makeRedisCmd(process.env);
  if (!redis) return json(503, { ok: false, error: 'redis_unavailable' });
  let akVenues = [];
  try { akVenues = loadDay('jra', s.day.date, { pastRaces: false }); } catch { akVenues = []; }
  try {
    const saved = await saveDay(redis, attachAk(s.day, akVenues));
    return json(200, { ok: true, date: saved.date, races: saved.races.length, withAkTop5: saved.races.filter((r) => r.akTop5).length });
  } catch (e) {
    console.error('[ailab] save failed:', e?.message || 'unknown');
    return json(503, { ok: false, error: 'save_failed' });
  }
}

export function GET() { return json(405, { ok: false, error: 'method_not_allowed' }); }
