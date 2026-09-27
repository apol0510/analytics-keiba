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
 * | `recipient_gap` | warn | 送った数が list の人数と大きく食い違う |
 * | `exit_not_working` | warn | 反応は増えているのに list が減っていない（除外が効いていない）|
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
  RECIPIENT_GAP: 'recipient_gap',
  EXIT_NOT_WORKING: 'exit_not_working',
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
  /** 送った数と list の人数がこの比率以上ずれたら食い違い */
  recipientGapRate: 0.05,
  /**
   * 差がこの人数未満なら比率に関係なく見ない（少人数 list で 1〜2 人の差が 5% を超えるため）。
   * 2026-09-26: start-1（12 名）は 13 vs 12 で毎回 8% になっていた。
   */
  recipientGapMinCount: 10,
  /** 反応がこの人数以上増えたのに list が減っていなければ除外が効いていない */
  exitLagCount: 10,
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {{
 *   nowMs: number,
 *   sends: Array<{name:string, status:string, sendAtMs:number|null, delivered:number, requests:number, bounces:number, spam:number}>,
 *   engine: string,
 *   akActive: number, providerRejected: number, listTotal: number,
 *   previousMismatch: number|null,
 *   engagedDelta: number|null, listDelta: number|null,
 * }} input
 */
export function evaluateSelectionWatch(input = {}) {
  const {
    nowMs = Date.now(), sends = [], engine = '', akActive = 0, providerRejected = 0,
    listTotal = 0, previousMismatch = null,
    /**
     * 前回の点検時刻。`expectedRecipients` は**その時刻の list 人数**なので、
     * 比べてよいのはそれ**より後に送った通**だけ。
     */
    previousCheckedAtMs = null,
    /** 前回からの増減（**増えたのに減らない**を見るため） */
    engagedDelta = null, listDelta = null,
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

  /**
   * 送った数が list の人数と食い違っていないか。
   * Single Send は**送信時**の在籍へ配るので、直前に控えた人数と大きくずれたら
   * 宛先の取り違えか、除外が効きすぎ・効かなすぎのどちらか。
   *
   * ⚠️ 2026-09-26 是正: 旧実装は**過去すべての通**を「前日の list 人数」と比べていた。
   *    list は反応・bounce で毎日減るので、初日の通ほど差が開き**毎回必ず発火**していた
   *    （start-1 m01 = requests 318 vs 前日 list 13）。比べるのは次の 1 通だけにする:
   *    - **list ごとに最新の送信済みの 1 通**
   *    - しかも**前回の点検より後**に送った通（控えた人数と同じ時点の list へ送ったもの）
   *    - 差が `recipientGapMinCount` 人未満なら見ない（少人数 list の揺れ）
   */
  const listOf = (s) => {
    if (s && s.listName) return String(s.listName);
    const m = /\ss(\d)\s/.exec(` ${String((s && s.name) || '')} `);
    return m ? `start-${m[1]}` : null;
  };
  const latestByList = new Map();
  for (const s of sends) {
    if (!s || num(s.requests) === 0) continue;                 // まだ送っていない
    if (!Number.isFinite(s.sendAtMs)) continue;
    const key = listOf(s);
    if (!key) continue;
    const cur = latestByList.get(key);
    if (!cur || s.sendAtMs > cur.sendAtMs) latestByList.set(key, s);
  }
  for (const s of latestByList.values()) {
    if (!Number.isFinite(s.expectedRecipients) || s.expectedRecipients <= 0) continue;
    if (Number.isFinite(previousCheckedAtMs) && s.sendAtMs <= previousCheckedAtMs) continue;
    const diff = Math.abs(num(s.requests) - s.expectedRecipients);
    if (diff < WATCH_THRESHOLDS.recipientGapMinCount) continue;
    const gap = diff / s.expectedRecipients;
    if (gap > WATCH_THRESHOLDS.recipientGapRate) {
      add(WATCH_FINDING.RECIPIENT_GAP, WATCH_SEVERITY.WARN, {
        name: s.name, requests: num(s.requests), expected: s.expectedRecipients,
      });
    }
  }

  /**
   * 反応が増えているのに list が減っていない ＝ **除外が効いていない**。
   * 反応が増えること自体は正常なので、「増えたのに減らない」だけを見る。
   */
  if (Number.isFinite(engagedDelta) && Number.isFinite(listDelta)
    && engagedDelta >= WATCH_THRESHOLDS.exitLagCount && listDelta >= 0) {
    add(WATCH_FINDING.EXIT_NOT_WORKING, WATCH_SEVERITY.WARN, { engagedDelta, listDelta });
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
