/**
 * selectionWatch.js — 選別配信が**予定どおり進んでいるか**を判定する（I/O なし）
 *
 * ## なぜ要るか
 *
 * 27 通は SendGrid が予定どおり送る。だが「送れているか」「反応で外れているか」
 * 「同じ号が二度出ていないか」を**人が毎日見に行く運用にはしない**。
 * 定期実行から**読み取りだけ**で回して、おかしいときにだけ人へ知らせる。
 *
 * ## 判定（重い順）
 *
 * | id | 重さ | 何を見るか |
 * |---|---|---|
 * | `duplicate_send` | critical | 同じ通が 2 回以上送られた |
 * | `send_missing` | critical | 予定時刻を過ぎたのに送られていない |
 * | `engine_conflict` | critical | 旧 AK が prospect を送る設定に戻っている |
 * | `exit_stalled` | warn | 反応者が list に残り続けている（除外が効いていない）|
 * | `list_drift` | warn | AK と list の人数差が**広がっている** |
 * | `bounce_spike` | warn | bounce / 苦情の比率が高い |
 *
 * ⚠️ **反応が増えること自体は異常ではない**（旧メールへの反応は遅れて届く）。
 *    見るのは「差が広がっているか」だけ（`SENDGRID_MC_MIGRATION.md` §15）。
 * ⚠️ ここは判定だけ。通知も停止もしない（呼び出し側の仕事）。
 */

export const WATCH_SEVERITY = Object.freeze({ CRITICAL: 'critical', WARN: 'warn' });

export const WATCH_FINDING = Object.freeze({
  DUPLICATE_SEND: 'duplicate_send',
  SEND_MISSING: 'send_missing',
  ENGINE_CONFLICT: 'engine_conflict',
  EXIT_STALLED: 'exit_stalled',
  LIST_DRIFT: 'list_drift',
  BOUNCE_SPIKE: 'bounce_spike',
});

/** 判定のしきい値（**コードに散らさない**） */
export const WATCH_THRESHOLDS = Object.freeze({
  /** 予定時刻からこの分数を過ぎても送られていなければ「送られていない」 */
  sendGraceMinutes: 60,
  /** 前回より不整合がこれ以上増えたら drift */
  driftIncrease: 20,
  /** bounce + 苦情がこの比率を超えたら spike */
  bounceRate: 0.05,
  /** 反応者がこの人数以上 list に残っていたら除外が止まっている */
  stalledExits: 5,
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {{
 *   nowMs: number,
 *   sends: Array<{name:string, status:string, sendAtMs:number|null, delivered:number, requests:number, bounces:number, spam:number}>,
 *   engine: string,
 *   akActive: number, providerRejected: number, listTotal: number,
 *   previousMismatch: number|null,
 *   engagedInSelectionLists: number|null,
 * }} input
 */
export function evaluateSelectionWatch(input = {}) {
  const {
    nowMs = Date.now(), sends = [], engine = '', akActive = 0, providerRejected = 0,
    listTotal = 0, previousMismatch = null, engagedInSelectionLists = null,
  } = input;

  const findings = [];
  const add = (id, severity, detail) => findings.push({ id, severity, detail });

  // 旧 AK が prospect を送る設定に戻っていないか
  if (engine && engine !== 'sendgrid') {
    add(WATCH_FINDING.ENGINE_CONFLICT, WATCH_SEVERITY.CRITICAL, { engine });
  }

  // 同じ通が 2 回以上送られていないか
  const byName = new Map();
  for (const s of sends) {
    const n = String((s && s.name) || '');
    byName.set(n, (byName.get(n) || 0) + 1);
  }
  for (const [name, count] of byName.entries()) {
    if (count > 1) add(WATCH_FINDING.DUPLICATE_SEND, WATCH_SEVERITY.CRITICAL, { name, count });
  }

  // 予定を過ぎたのに送られていない通
  const grace = WATCH_THRESHOLDS.sendGraceMinutes * 60 * 1000;
  for (const s of sends) {
    if (!s || !Number.isFinite(s.sendAtMs)) continue;
    const due = s.sendAtMs + grace < nowMs;
    const sent = String(s.status || '') === 'triggered' || num(s.requests) > 0;
    if (due && !sent) add(WATCH_FINDING.SEND_MISSING, WATCH_SEVERITY.CRITICAL, { name: s.name });
  }

  // 反応者が list に残り続けている
  if (Number.isFinite(engagedInSelectionLists)
    && engagedInSelectionLists >= WATCH_THRESHOLDS.stalledExits) {
    add(WATCH_FINDING.EXIT_STALLED, WATCH_SEVERITY.WARN, { count: engagedInSelectionLists });
  }

  // AK と list の不整合が**広がっている**か（増えていなければ異常としない）
  const mismatch = Math.abs((akActive - providerRejected) - listTotal);
  if (Number.isFinite(previousMismatch)
    && mismatch - previousMismatch >= WATCH_THRESHOLDS.driftIncrease) {
    add(WATCH_FINDING.LIST_DRIFT, WATCH_SEVERITY.WARN, { mismatch, previousMismatch });
  }

  // bounce / 苦情の比率
  const delivered = sends.reduce((a, s) => a + num(s && s.delivered), 0);
  const bad = sends.reduce((a, s) => a + num(s && s.bounces) + num(s && s.spam), 0);
  const denom = delivered + bad;
  const rate = denom > 0 ? bad / denom : 0;
  if (denom >= 100 && rate > WATCH_THRESHOLDS.bounceRate) {
    add(WATCH_FINDING.BOUNCE_SPIKE, WATCH_SEVERITY.WARN, { rate: Math.round(rate * 1000) / 1000 });
  }

  const critical = findings.filter((f) => f.severity === WATCH_SEVERITY.CRITICAL);
  return {
    ok: findings.length === 0,
    halt: critical.length > 0,
    findings,
    mismatch,
    counts: {
      予定: sends.length,
      送信済み: sends.filter((s) => String(s.status || '') === 'triggered').length,
      delivered,
      bounce_苦情: bad,
    },
  };
}

/** 人に出す文面（**アドレスを含めない**） */
export function describeWatch(result) {
  if (!result) return '判定できませんでした';
  if (result.ok) return '異常なし';
  return result.findings
    .map((f) => `[${f.severity}] ${f.id} ${JSON.stringify(f.detail)}`)
    .join('\n');
}

/**
 * 同じ知らせを毎日送らない（**1 日 1 回・種類ごと**）。
 * 送ってよいかだけを返す（保存は呼び出し側）。
 */
export function shouldNotify({ result, lastNotifiedAtMs, nowMs = Date.now(), minIntervalMs = 12 * 60 * 60 * 1000 } = {}) {
  if (!result || result.ok) return { notify: false, reason: 'no_finding' };
  if (Number.isFinite(lastNotifiedAtMs) && nowMs - lastNotifiedAtMs < minIntervalMs) {
    return { notify: false, reason: 'too_soon' };
  }
  return { notify: true, reason: result.halt ? 'critical' : 'warn' };
}

export default evaluateSelectionWatch;
