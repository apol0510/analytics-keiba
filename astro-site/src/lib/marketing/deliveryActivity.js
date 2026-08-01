/**
 * deliveryActivity.js — 配信基盤の配信結果を **GET だけ**で読む（送信はしない）
 *
 * `providerSuppression.js` と同じ役割分担で、provider のエンドポイントを触るのは
 * このモジュールだけにする（Function 側に URL を組み立てさせない）。
 *
 * ── 取得できる範囲は狭い。埋めない ────────────────────────────────
 *   - 配信基盤の履歴は **保持期間が短い**（実測 3 日）。それ以前は取得できない
 *   - 一覧 API は「最後のイベント」しか返さないため、開封・クリックは
 *     **1 通ずつ詳細を引いたぶんだけ**分かる（全通引くと管理画面が待たされる）
 *   - したがって戻り値の `available` は「**開封・クリックを判断してよいか**」を表す。
 *     false のときに 0 件として表示してはいけない（「不明」であって「反応なし」ではない）
 *
 * AK 側にイベントを保存していないのが根本原因。恒久的に追跡するなら
 * Event Webhook を受けて AK の台帳へ書く設計が必要（別タスク）。
 */

const API_BASE = 'https://api.sendgrid.com/v3/messages';

/** 詳細（開封・クリック）を引く通数の上限。増やすと管理画面が遅くなる */
export const DETAIL_LIMIT = 5;

const str = (v) => String(v ?? '').trim();
const parse = (v) => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};

/** provider のイベント名 → タイムラインの種別（未知の名前は無視する） */
export function classifyEvent(name) {
  const n = str(name).toLowerCase();
  if (n === 'click') return 'click';
  if (n === 'open') return 'open';
  if (n === 'bounce' || n === 'dropped' || n === 'blocked') return 'bounce';
  if (n === 'delivered') return 'delivered';
  return null;
}

/**
 * 1 宛先の配信結果を読む。**送信 API は呼ばない**（GET のみ）。
 *
 * @param {{ email: string, apiKey: string, fetchImpl?: Function, detailLimit?: number }} input
 * @returns {Promise<{ available: boolean, events: Array<{atMs:number,kind:string,detail:string}>,
 *                     reason: string|null, coveredMessages: number, totalMessages: number, note: string }>}
 */
export async function fetchDeliveryActivity({ email, apiKey, fetchImpl, detailLimit = DETAIL_LIMIT } = {}) {
  const target = str(email).toLowerCase();
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch : null);
  const unavailable = (reason) => ({
    available: false, events: [], reason, coveredMessages: 0, totalMessages: 0,
    note: '配信結果を取得できませんでした（反応が無かったという意味ではありません）',
  });
  if (!apiKey || !target || !doFetch) return unavailable('no_credentials');

  let msgs = [];
  try {
    const q = encodeURIComponent(`to_email="${target.replace(/"/g, '')}"`);
    const res = await doFetch(`${API_BASE}?limit=50&query=${q}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res || !res.ok) return unavailable(`http_${res ? res.status : 'error'}`);
    msgs = (await res.json()).messages || [];
  } catch {
    return unavailable('fetch_failed');
  }

  const events = [];
  let covered = 0;
  for (const m of msgs) {
    const at = parse(m.last_event_time);
    if (at == null) continue;
    const subject = str(m.subject).slice(0, 60);

    if (covered < detailLimit && m.msg_id) {
      try {
        const dr = await doFetch(`${API_BASE}/${m.msg_id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (dr && dr.ok) {
          const detail = await dr.json();
          covered += 1;
          for (const e of (detail.events || [])) {
            const kind = classifyEvent(e.event_name);
            if (!kind) continue;
            events.push({ atMs: parse(e.processed) ?? parse(e.created) ?? at, kind, detail: subject });
          }
          continue;
        }
      } catch { /* 詳細が取れなければ一覧の情報だけ使う */ }
    }
    events.push({ atMs: at, kind: str(m.status) === 'not_delivered' ? 'bounce' : 'delivered', detail: subject });
  }

  return {
    // 開封・クリックを判断してよいのは詳細を取れた通だけ
    available: covered > 0,
    events,
    reason: null,
    coveredMessages: covered,
    totalMessages: msgs.length,
    note: covered > 0
      ? `直近 ${covered} 通ぶんのみ（配信基盤の保持期間が短く、それ以前は取得できません）`
      : '開封・クリックは取得できませんでした（不明であり、反応が無かったという意味ではありません）',
  };
}
