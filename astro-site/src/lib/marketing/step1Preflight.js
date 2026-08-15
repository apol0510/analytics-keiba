/**
 * step1Preflight.js — 連続配信の **Step1 キュー登録の直前確認**（純粋・I/O なし）
 *
 * ── 何のためか ────────────────────────────────────────────────
 * Step1 のキュー登録は「承認が要る操作」で、**実行後に取り返しがつく範囲が狭い**。
 * ScheduledEmails / CampaignDeliveries に行が生まれ、実送信ゲートが開いた瞬間に飛ぶ。
 * そのため「いま押してよいか」を**人の記憶ではなく機械で**固定する。
 *
 * ── なぜ判定を作り直さないのか ────────────────────────────────
 * 対象人数・停止理由・関所の残件・候補の重複は **`admin-marketing` の read-only アクション**
 * （`sequence` / `duplicateCheck` / `trialGrant` / `jobs`）が既に単一源として計算している。
 * ここで Airtable を読み直して独自に数え直すと、**画面の人数と preflight の人数がズレる**
 * （それは 2026-08-13 に実際に起きた 4,000 件打ち切り事故と同じ構図）。
 * このモジュールは **サーバーの答えを検算するだけ**で、母集団を自分では作らない。
 *
 * ── 重複判定は campaign 単位ではなく cohort 単位 ──────────────────
 * 「この campaign を過去に流したか」で止めると、1 回流した時点で二度と通らない。
 * 見るのは「**いま選んでいる相手に、その通が既に出ているか**」＝ `DeliveryKey`。
 * 過去コホートの実績（`sentByStep` / 過去ジョブ）は **info** に留める。
 *
 * ── 絶対にしないこと ──────────────────────────────────────
 * - 送信・キュー登録・Airtable への write（このファイルは I/O を一切持たない）
 * - 「たぶん大丈夫」を ok にすること。**確認できない項目は fail closed**
 *
 * @see docs/CAMPAIGN_SEQUENCE.md
 */

// ⚠️ ジョブの分割単位は**送信側の単一源**から取る。ここで 100 と書き写すと、
//    送信側が変わったときに preflight の「増える行数」だけ嘘になる。
import { RECIPIENTS_PER_JOB } from './campaignSend.js';

/** 実行の段階。gate をどこまで開けたかで「成り立つべきこと」が変わる */
export const STEP1_STAGE = Object.freeze({
  /** 何も開けていない（既定。ここで全部確かめてから承認を取る） */
  PRE: 'pre',
  /** キュー登録だけ解禁した直後（MARKETING_CAMPAIGN_ENABLED=true） */
  ENQUEUE: 'enqueue',
});

export const STEP1_STAGE_LABEL = Object.freeze({
  pre: 'pre（両ゲート閉・承認前）',
  enqueue: 'enqueue（キュー登録のみ解禁）',
});

/** 判定の重み。critical が 1 つでも落ちたら **押してはいけない** */
export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  INFO: 'info',
});

/**
 * 数値に読めれば数値、読めなければ **null（不明）**。
 * ⚠️ `null` / `undefined` / `''` を 0 にしない。「不明」を「0 件」と読み替えると、
 *    応答が欠けているのに「既送信 0 件 = 安全」と判定してしまう（fail open）。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};
const str = (v) => String(v ?? '').trim();

/**
 * 表示用のステップ名。**判定には使わない**（見出しの文字列だけを整える）。
 *
 * `step` が読めないときに `Step${step}` をそのまま埋めると
 * **`Stepnull で送れる人数`** のような見出しになり、読み手が
 * 「Stepnull という何か」があるのかと迷う。値が無いことは
 * 「（不明）」と明示し、**落ちる／通るの判定は 1 ミリも変えない**。
 */
export const stepLabel = (step) => (Number.isInteger(step) && step > 0 ? `Step${step}` : 'ステップ（不明）');

/**
 * gate の状態を env から読む（**値は返さない**。ON/OFF だけ）。
 * secret ではないが、値をそのまま持ち回るとログ・画面へ漏れる経路が増えるため
 * 最初から真偽値へ潰しておく。
 */
export function readStep1Gates(env = {}) {
  return {
    enqueue: str(env.MARKETING_CAMPAIGN_ENABLED) === 'true',
    dispatch: str(env.MARKETING_CAMPAIGN_DISPATCH_ENABLED) === 'true',
  };
}

/** gate の状態から段階を決める（明示指定があればそれを優先） */
export function resolveStep1Stage(env = {}) {
  const forced = str(env.STEP1_STAGE).toLowerCase();
  if (Object.values(STEP1_STAGE).includes(forced)) return forced;
  return readStep1Gates(env).enqueue ? STEP1_STAGE.ENQUEUE : STEP1_STAGE.PRE;
}

/**
 * Step1 を押してよいかを判定する。
 *
 * @param {object} input
 * @param {object} input.sequence   `action=sequence` の応答
 * @param {object} input.trialGrant `action=trialGrant` の応答（関所）
 * @param {object} input.jobs       `action=jobs` の応答（キュー現況・**参考**）
 * @param {object} input.duplicateCheck `action=duplicateCheck` の応答
 *   （**いま選んでいる候補の DeliveryKey だけ**を名指し確認したもの。重複判定の正）
 * @param {string} input.campaignId 期待するキャンペーン
 * @param {number|null} [input.expectRecipients] 事前に合意した人数（違えば止める）
 * @param {string} [input.stage] STEP1_STAGE
 * @returns {{ok:boolean, stage:string, checks:Array, plan:object, failures:Array}}
 */
export function evaluateStep1Preflight({
  sequence, trialGrant, jobs, duplicateCheck, campaignId,
  expectRecipients = null, stage = STEP1_STAGE.PRE,
}) {
  const checks = [];
  const add = (severity, ok, label, detail = '') => {
    checks.push({ severity, ok: ok === true, label, detail: str(detail) });
  };
  const critical = (ok, label, detail) => add(SEVERITY.CRITICAL, ok, label, detail);
  const info = (ok, label, detail) => add(SEVERITY.INFO, ok, label, detail);

  const seq = sequence && typeof sequence === 'object' ? sequence : null;
  const tg = trialGrant && typeof trialGrant === 'object' ? trialGrant : null;
  const jb = jobs && typeof jobs === 'object' ? jobs : null;
  const dup = duplicateCheck && typeof duplicateCheck === 'object' ? duplicateCheck : null;

  // ── 0. 応答そのものが揃っているか（欠けていたら以降は判定しない）──────
  critical(!!seq, 'sequence 応答を取得できた', seq ? '' : '取得できていない');
  critical(!!tg, 'trialGrant 応答を取得できた', tg ? '' : '取得できていない');
  critical(!!jb, 'jobs 応答を取得できた', jb ? '' : '取得できていない');
  if (!seq || !tg || !jb) {
    return finish({ checks, stage, plan: emptyPlan(campaignId) });
  }

  // ── 1. 読み取り専用の経路を使ったこと ────────────────────────
  // `sideEffects: 'none'` はサーバーの自己申告だが、**申告が無い応答を黙って通さない**
  // ための最低限の検札（別アクションを叩いてしまった取り違えを検知する）。
  critical(str(seq.sideEffects) === 'none', 'sequence は副作用なしの応答', `sideEffects=${str(seq.sideEffects) || '(無し)'}`);
  critical(str(tg.sideEffects) === 'none', 'trialGrant は副作用なしの応答', `sideEffects=${str(tg.sideEffects) || '(無し)'}`);
  critical(str(seq.mode) === 'sequence-status', 'sequence は状況確認モード', `mode=${str(seq.mode)}`);

  // ── 2. キャンペーンの同一性 ────────────────────────────────
  critical(str(seq.campaignId) === str(campaignId), '意図したキャンペーンを見ている', `campaignId=${str(seq.campaignId)}`);
  critical(seq.enabled === true, 'キャンペーンが有効', `enabled=${String(seq.enabled)}`);

  // ── 3. 次に流れるのは Step1 か ──────────────────────────────
  const next = (seq.next && typeof seq.next === 'object') ? seq.next : {};
  const step = num(next.step);
  const recipients = num(next.recipients);
  critical(step === 1, '次に流れるのは Step1', `step=${step === null ? '(無し)' : step}`);
  critical(recipients !== null && recipients > 0, '対象が 1 名以上いる', `recipients=${recipients === null ? '(不明)' : recipients}`);
  critical(next.truncated !== true, '対象が上限で切り捨てられていない', `truncated=${String(next.truncated)} / cap=${num(next.cap)}`);

  // 事前に合意した人数と一致するか（**増えていても止める**。増分は別途の承認事項）
  if (expectRecipients !== null && expectRecipients !== undefined) {
    critical(recipients === num(expectRecipients),
      `対象人数が事前合意（${num(expectRecipients)} 名）と一致`, `実際=${recipients}`);
  }

  // 画面が渡す recordIds と人数が食い違わないこと（片方だけ見て押す事故を防ぐ）
  const recordIds = Array.isArray(next.recordIds) ? next.recordIds : null;
  critical(recordIds !== null && recordIds.length === recipients,
    'recordId の数と人数が一致', `recordIds=${recordIds ? recordIds.length : '(無し)'} / recipients=${recipients}`);

  // ── 4. **いま選んでいる相手**にその通が出ていないこと（二重案内の防止）──
  //
  // ⚠️ 「この campaign を過去に流したか」で判定してはいけない。
  //    1 回でも Step1 を流したら二度と通らなくなり、次のコホートを永久に承認できない。
  //    コホートは何度も来るので、見るのは **候補ごとの DeliveryKey**
  //    （campaign × version × step × 受信者 = 不変キー）。
  const summary = (seq.summary && typeof seq.summary === 'object') ? seq.summary : {};
  const sentByStep = (summary.sentByStep && typeof summary.sentByStep === 'object') ? summary.sentByStep : {};
  const sentThisStep = num(sentByStep[String(step)] ?? sentByStep[step]);
  // 過去コホートの実績は **止める理由にならない**（母集団に前回の受信者も含まれるため）。
  // ただし黙って隠さない。
  info(true, `この campaign で ${stepLabel(step)} を受け取り済みの人数（過去コホート含む）`,
    `${sentThisStep === null ? '(不明)' : sentThisStep} 名 / 母集団 ${num(summary.total)} 名`);
  critical(summary.balanced === true, '進行の内訳が検算に合う', `balanced=${String(summary.balanced)}`);
  // 候補は「いま送れる人」だけ。母集団の due と一致していること
  const dueByStep = (summary.dueByStep && typeof summary.dueByStep === 'object') ? summary.dueByStep : {};
  const dueThisStep = num(dueByStep[String(step)] ?? dueByStep[step]);
  critical(dueThisStep === recipients,
    `${stepLabel(step)} で送れる人数と送信対象数が一致`,
    `dueByStep[${step === null ? '(不明)' : step}]=${dueThisStep === null ? '(不明)' : dueThisStep}`
    + ` / recipients=${recipients === null ? '(不明)' : recipients}`);

  // ── 4-2. 候補の DeliveryKey を名指しで確認する（campaign 全履歴は見ない）──
  critical(!!dup, '重複確認（duplicateCheck）を取得できた', dup ? '' : '取得できていない');
  if (dup) {
    critical(str(dup.sideEffects) === 'none', 'duplicateCheck は副作用なしの応答', `sideEffects=${str(dup.sideEffects) || '(無し)'}`);
    critical(str(dup.campaignId) === str(campaignId), '重複確認が同じキャンペーンを見ている', `campaignId=${str(dup.campaignId)}`);
    critical(num(dup.step) === step, '重複確認が同じステップを見ている', `step=${num(dup.step)}`);
    critical(num(dup.candidates) === recipients,
      '重複確認の対象数が送信対象数と一致', `candidates=${num(dup.candidates)} / recipients=${recipients}`);
    // 鍵を作れなかった候補（顧客が引けない / メールが無い）は**不明**として落とす
    critical(num(dup.unresolved) === 0,
      '全候補の重複を判定できた', `判定できなかった候補=${num(dup.unresolved)} 件`);
    critical(num(dup.alreadyDelivered) === 0,
      'この候補にその通はまだ出ていない',
      `既に queued/sent の候補=${num(dup.alreadyDelivered)} 名 / 内訳=${JSON.stringify(dup.byStatus || {})}`);
    // 候補が既に送信待ちのジョブへ載っていないか。
    // ⚠️ 配信行が欠けた **本当の orphan PENDING** は
    //    `CampaignDeliveries → JobId` の経路では見えない。
    //    ジョブ側の `Recipients` と突き合わせた `pendingCandidates` が正。
    const pendingCandidates = num(dup.pendingCandidates);
    critical(pendingCandidates === 0,
      '候補が送信待ちのジョブに載っていない（配信行が無い場合も含む）',
      `送信待ちジョブに載っている候補=${pendingCandidates === null ? '(不明)' : pendingCandidates} 名`
      + ` / 該当ジョブ=${num((dup.pendingOverlap || {}).jobs)} 件`
      + ` / step 一致=${num((dup.pendingOverlap || {}).sameStep)}`
      + ` 別step=${num((dup.pendingOverlap || {}).otherStep)}`
      + ` 不明=${num((dup.pendingOverlap || {}).unknownStep)}`);
    // 配信行経由でも同じことを見る（片方だけ壊れたときに気付ける）
    critical(num(dup.pendingLinkedJobs) === 0,
      '候補の配信行が送信待ちジョブを指していない',
      `候補に紐づく PENDING ジョブ=${num(dup.pendingLinkedJobs)} 件 / 内訳=${JSON.stringify(dup.linkedJobStatus || {})}`);
  }

  // 停止した人がいても止めはしない（送らないだけ）。ただし**必ず理由を表に出す**
  const stopped = num(summary.stopped) ?? 0;
  info(stopped === 0, '停止（配信不可）0 名',
    stopped === 0 ? '' : `stopped=${stopped} / 理由=${JSON.stringify(summary.byStopReason || {})}`);

  // ── 5. 関所（付与したのに案内していない人）と対象が一致すること ──────
  const barrier = (tg.barrier && typeof tg.barrier === 'object') ? tg.barrier : {};
  const outstanding = num(barrier.outstandingStep1);
  critical(outstanding === recipients,
    '関所の未処理件数と Step1 対象数が一致', `outstandingStep1=${outstanding === null ? '(不明)' : outstanding} / recipients=${recipients}`);
  info(true, '関所の内訳',
    `granted=${num(barrier.granted)} / resolved=${num(barrier.resolved)} / nextBatchAllowed=${String(barrier.nextBatchAllowed)} / abort=${str(tg.abort) || '(無し)'}`);

  // ── 6. キューが汚れていないこと ────────────────────────────
  const jobList = Array.isArray(jb.jobs) ? jb.jobs : null;
  critical(jobList !== null, 'ジョブ一覧を取得できた', jobList ? `${jobList.length} 件` : '取得できていない');
  const mine = (jobList || []).filter((j) => str(j && j.campaignId) === str(campaignId));
  const pending = (jobList || []).filter((j) => str(j && j.status).toUpperCase() === 'PENDING');
  const minePending = mine.filter((j) => str(j && j.status).toUpperCase() === 'PENDING');

  // ⚠️ `jobs` は**新しい順に一部だけ**返す（2026-08-15〜。台帳が大きく全件返せない）。
  //    見えている範囲に無いことを「無い」と読み替えてはいけない。
  //    見つかった場合の「ある」は窓に関係なく正しいが、
  //    **見つからない場合の「0 件」は、窓が全体を覆っているときしか言えない**。
  const jobsTruncated = jb.jobsTruncated === true;
  const jobsTotal = num(jb.jobsTotal);
  const jobsShown = num(jb.jobsShown) ?? (jobList ? jobList.length : null);

  // ⚠️ `jobs` は**新しい順に一部だけ**返す（2026-08-15〜）。
  //    ここから「無い」を推測しない。**候補の重複判定は 4-2 の DeliveryKey が正**で、
  //    この一覧は「実送信を開けたら何が飛ぶか」を見るための参考にとどめる。
  info(true, 'ジョブ一覧の取得範囲（参考・重複判定には使わない）',
    `${jobsShown === null ? '?' : jobsShown} / ${jobsTotal === null ? '?' : jobsTotal} 件`
    + (jobsTruncated ? '（新しい順に一部のみ）' : '（全件）'));
  info(true, `この campaign の過去ジョブ（見えている範囲）`,
    `${mine.length} 件（過去に流していること自体は止める理由にしない）`);
  info(pending.length === 0, '見えている範囲に PENDING が無い',
    (pending.length === 0
      ? (jobsTruncated ? '（見えている範囲では 0 件）' : '（全件で 0 件）')
      : `PENDING=${pending.length} 件（実送信ゲートを開けると一緒に飛ぶ）`
        + (minePending.length ? ` / うち同 campaign=${minePending.length} 件` : '')));

  // ── 7. ゲートの状態 ──────────────────────────────────────
  // **実送信は常に閉じていること**。キュー登録の可否は段階で変わる。
  critical(jb.dispatchEnabled === false, '実送信ゲートは閉じている（登録しても飛ばない）', `dispatchEnabled=${String(jb.dispatchEnabled)}`);
  if (stage === STEP1_STAGE.ENQUEUE) {
    critical(jb.sendEnabled === true, 'キュー登録ゲートが開いている', `sendEnabled=${String(jb.sendEnabled)}`);
  } else {
    critical(jb.sendEnabled === false, 'キュー登録ゲートはまだ閉じている', `sendEnabled=${String(jb.sendEnabled)}`);
  }
  const auto = (seq.auto && typeof seq.auto === 'object') ? seq.auto : {};
  critical(auto.enabled === false, '自動配信は停止している（cron が勝手に進めない）',
    `enabled=${String(auto.enabled)} / missing=${(auto.missing || []).length} 件`);

  // ── 8. 除外材料が「確認できている」こと（不明なら fail closed）──────
  const ps = (seq.providerSuppression && typeof seq.providerSuppression === 'object') ? seq.providerSuppression : {};
  critical(ps.available === true, '配信基盤の停止リストを確認できている',
    ps.available === true ? `total=${num(ps.total)}` : `error=${str(ps.error) || '(不明)'}`);
  const eng = (seq.engagement && typeof seq.engagement === 'object') ? seq.engagement : {};
  info(true, '反応なし除外の状態',
    `applied=${String(eng.applied)} / blocked=${num(eng.blocked)} / counts=${JSON.stringify(eng.counts || {})}`);

  return finish({
    checks,
    stage,
    plan: {
      campaignId: str(seq.campaignId),
      version: seq.version ?? null,
      step,
      recipients,
      maxSends: num(seq.maxSends),
      /** 押したときに増える行（件数だけ。宛先は持たない） */
      writes: describeStep1Writes({ recipients }),
    },
  });
}

/** 空の計画（応答が欠けたとき用） */
function emptyPlan(campaignId) {
  return {
    campaignId: str(campaignId), version: null, step: null,
    recipients: null, maxSends: null, writes: describeStep1Writes({ recipients: null }),
  };
}

/**
 * キュー登録で**何が増えるか**を件数で説明する（承認を取るための材料）。
 *
 * `admin-marketing` の live 経路が書くのは次の 2 テーブルだけ。
 * **Customers は 1 バイトも書かない**（会員・課金・特典・期限は動かない）。
 */
export function describeStep1Writes({ recipients, recipientsPerJob = RECIPIENTS_PER_JOB }) {
  const n = num(recipients);
  const jobs = n === null ? null : Math.ceil(n / recipientsPerJob) || 0;
  return {
    scheduledEmails: {
      table: 'ScheduledEmails',
      rows: jobs,
      status: 'PENDING',
      note: '1 ジョブ最大 100 宛先。実送信は dispatcher が担当（閉じていれば PENDING のまま）',
    },
    campaignDeliveries: {
      table: 'CampaignDeliveries',
      rows: n,
      status: 'queued',
      note: 'DeliveryKey で upsert（同じ人に 2 行作らない）',
    },
    customers: { table: 'Customers', rows: 0, note: '送信側は Customers を書かない' },
  };
}

/** 判定を締める（critical が 1 つでも落ちていれば ok=false） */
function finish({ checks, stage, plan }) {
  const failures = checks.filter((c) => c.severity === SEVERITY.CRITICAL && !c.ok);
  return { ok: failures.length === 0, stage, checks, failures, plan };
}

export default evaluateStep1Preflight;
