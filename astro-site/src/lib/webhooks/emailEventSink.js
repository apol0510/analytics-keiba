/**
 * 配信イベントの書き込み先を決める単一源（Airtable / Blob / Redis カウンタ）。
 *
 * `EmailEvents` は Airtable の 37% を占めるうえ、`open` が重複排除されないため
 * 無制限に増える。行を Blob へ、数え上げを Redis カウンタへ分ける。
 * 段階は env 1 つで表す。
 *
 * | `MARKETING_EVENT_SINK` | Airtable 行 | Blob 生ログ | Redis カウンタ |
 * |---|---|---|---|
 * | 未設定 / `airtable` | 書く | 書かない | 書かない |
 * | `dual`              | 書く | 書く | 書く |
 * | `blob`              | **書かない** | 書く | 書く |
 *
 * ── 失敗時の扱い ────────────────────────────────────────────
 *  - `airtable` を書くモードで Airtable が失敗 → **従来どおり致命**（呼び出し側が retry）
 *  - `dual` で Blob / カウンタが失敗 → 致命にしない。Airtable が正本なので継続し、
 *    `degraded` に残す。取りこぼしは reconciliation で拾う
 *  - `blob` モードで Blob が失敗 → **致命**（記録先が無い＝監査が欠ける）。
 *    provider へ 5xx を返して**再送させる**。握り潰して 200 を返さない
 *  - カウンタは表示用なので、`blob` モードでも失敗を致命にしない
 *    （数え直しは Blob から再構成できる）
 */

export const EVENT_SINK = Object.freeze({
  AIRTABLE: 'airtable',
  DUAL: 'dual',
  BLOB: 'blob',
});

const VALID = new Set(Object.values(EVENT_SINK));

/** 未知の値は airtable へ倒す（勝手に新経路へ行かせない） */
export function resolveEventSinkMode(env = process.env) {
  const raw = String((env && env.MARKETING_EVENT_SINK) || '').trim().toLowerCase();
  return VALID.has(raw) ? raw : EVENT_SINK.AIRTABLE;
}

export function writesAirtableEvents(mode) { return mode !== EVENT_SINK.BLOB; }
export function writesBlobEvents(mode) { return mode === EVENT_SINK.DUAL || mode === EVENT_SINK.BLOB; }
export function writesCounters(mode) { return mode === EVENT_SINK.DUAL || mode === EVENT_SINK.BLOB; }

/** カウンタの hash キー。**PII を入れない**（campaign と version だけ）。 */
export const COUNTER_NAMESPACE = 'ak:mkt:events';
const SAFE_PART = /^[A-Za-z0-9_.-]{1,120}$/;

export function buildCounterKey({ campaignId, version } = {}) {
  const c = String(campaignId ?? '').trim() || 'unknown';
  const v = Number(version);
  if (!SAFE_PART.test(c)) throw new Error('event_counter:bad_campaign');
  const vv = Number.isInteger(v) && v > 0 ? `v${v}` : 'vunknown';
  return `${COUNTER_NAMESPACE}:${c}:${vv}`;
}

/** イベント配列 → `{counterKey: {eventType: 件数}}`（純粋） */
export function tallyEvents(events) {
  const out = {};
  for (const e of Array.isArray(events) ? events : []) {
    const type = String(e?.eventType || '').trim();
    if (!type) continue;
    let key;
    try {
      key = buildCounterKey({ campaignId: e?.campaignId, version: e?.campaignVersion });
    } catch {
      continue; // 壊れた campaign 名は数えない（落とさない）
    }
    out[key] = out[key] || {};
    out[key][type] = (out[key][type] || 0) + 1;
  }
  return out;
}

/**
 * 1 バッチをモードに従って書く。
 *
 * @returns {Promise<{
 *   airtable:'ok'|'skipped', blob:'ok'|'skipped'|'failed',
 *   counters:'ok'|'skipped'|'failed', blobKey: string|null, degraded: string[],
 * }>}
 */
export async function writeEventBatch({
  mode, events, receivedAtMs, writeAirtable, writeBlob, writeCounters,
} = {}) {
  const m = VALID.has(mode) ? mode : EVENT_SINK.AIRTABLE;
  const list = Array.isArray(events) ? events : [];
  const out = {
    airtable: 'skipped', blob: 'skipped', counters: 'skipped', blobKey: null, degraded: [],
  };

  if (writesAirtableEvents(m)) {
    if (typeof writeAirtable !== 'function') throw new Error('event_sink:airtable_writer_missing');
    await writeAirtable(list); // 失敗は throw のまま
    out.airtable = 'ok';
  }

  if (writesBlobEvents(m)) {
    if (typeof writeBlob !== 'function') throw new Error('event_sink:blob_writer_missing');
    try {
      const r = await writeBlob({ events: list, receivedAtMs });
      out.blob = 'ok';
      out.blobKey = (r && r.key) || null;
    } catch (e) {
      if (m === EVENT_SINK.BLOB) throw e; // 記録先が無い = 監査が欠ける。再送させる
      out.blob = 'failed';
      out.degraded.push('blob_unavailable');
    }
  }

  if (writesCounters(m)) {
    if (typeof writeCounters !== 'function') throw new Error('event_sink:counter_writer_missing');
    try {
      await writeCounters(tallyEvents(list));
      out.counters = 'ok';
    } catch {
      // 表示用。Blob から数え直せるので致命にしない
      out.counters = 'failed';
      out.degraded.push('counters_unavailable');
    }
  }

  return out;
}

/**
 * 観測用カウンタの key。**webhook 側は同じ文字列リテラルを書いている**
 * （`sendgrid-webhook.js` / `emailEventSink.test.mjs` の guard がそれを固定している）。
 * 読み取り側はここを使い、リテラルを増やさない。
 */
export const SINK_HEALTH_KEY = 'ak:mkt:events:sink';
