/**
 * emailCopyStandard.test.mjs — 販促メールのコピー品質基準を固定する。
 *
 * 正本: `docs/EMAIL_COPY_STANDARD.md`（2026-09-15 MK 確定）
 *
 * ここで守ること:
 *   1. adopt した step は基準を**すべて**通る
 *   2. 対象外にした campaign には**理由が必ず書いてある**（黙って外せない）
 *   3. 対象外の一覧は**全 campaign を網羅**する（新設 campaign の素通りを防ぐ）
 *   4. 送信済み Step を adopt していない（凍結と矛盾しない）
 *   5. HTML と text で**重要情報が一致**する
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCopyStandard, isCopyStandardAdopted,
  COPY_STANDARD_ADOPTED, COPY_STANDARD_NOT_ADOPTED, COPY_STANDARD_FROZEN_STEPS,
  VAGUE_CTA_LABELS, MEMBER_ONLY_CTA_PREFIXES, PUBLIC_CTA_PATHS, ctaPathOf,
  MIN_BODY_CHARS, MIN_BENEFIT_ITEMS, VIEWPOINTS_ONLY_CTA_PATHS,
} from './emailCopyStandard.js';
import { CAMPAIGNS, getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { renderMarketingEmail } from './marketingEmailShell.js';

/** adopt 済み step を (campaignId, stepNumber, step) で列挙する */
function adoptedSteps() {
  const out = [];
  for (const campaignId of Object.keys(COPY_STANDARD_ADOPTED)) {
    const c = getCampaign(campaignId, { includeDisabled: true });
    assert.ok(c, `${campaignId}: adopt したのに campaign が無い`);
    for (const s of getSequenceSteps(c)) {
      if (!isCopyStandardAdopted(campaignId, s.stepNumber)) continue;
      out.push({ campaignId, stepNumber: s.stepNumber, step: resolveSequenceStep(c, s.stepNumber) });
    }
  }
  return out;
}

// ── 1. adopt した step は基準を通る ──────────────────────────────

test('【重要】adopt した step はコピー基準をすべて通る', () => {
  const steps = adoptedSteps();
  assert.ok(steps.length >= 13, `adopt 済み step が少なすぎる（${steps.length}）`);
  const failures = [];
  for (const { campaignId, stepNumber, step } of steps) {
    const r = evaluateCopyStandard(step, { label: `${campaignId} step${stepNumber}` });
    if (!r.ok) failures.push(...r.issues.map((i) => `[${i.code}] ${i.message}`));
  }
  assert.deepEqual(failures, [], `コピー基準に届いていない:\n${failures.join('\n')}`);
});

test('adopt 済みは 3 本・13 通（改稿した範囲と一致する）', () => {
  assert.deepEqual(Object.keys(COPY_STANDARD_ADOPTED).sort(), [
    'free-signup-onboarding', 'light-to-premium-sequence', 'sanrenpuku-upsell-sequence',
  ]);
  assert.equal(adoptedSteps().length, 13);
});

// ── 2〜3. 対象外は理由つき・網羅 ─────────────────────────────────

test('【重要】対象外の campaign には理由が必ず書いてある', () => {
  for (const [id, reason] of Object.entries(COPY_STANDARD_NOT_ADOPTED)) {
    assert.equal(typeof reason, 'string', `${id}: 理由が文字列でない`);
    assert.ok(reason.trim().length >= 10, `${id}: 理由が短すぎる（「落ちるから外す」を防ぐ）`);
  }
});

test('【重要】全 campaign が adopt か対象外のどちらかに載っている（素通り防止）', () => {
  const missing = [];
  for (const c of CAMPAIGNS) {
    const adopted = Object.prototype.hasOwnProperty.call(COPY_STANDARD_ADOPTED, c.campaignId);
    const excluded = Object.prototype.hasOwnProperty.call(COPY_STANDARD_NOT_ADOPTED, c.campaignId);
    if (!adopted && !excluded) missing.push(c.campaignId);
    assert.equal(adopted && excluded, false, `${c.campaignId}: adopt と対象外の両方に載っている`);
  }
  assert.deepEqual(missing, [],
    `コピー基準の一覧に無い campaign があります。adopt するか、理由つきで対象外に載せてください`);
});

// ── 4. 凍結との整合 ────────────────────────────────────────────

test('【重要】送信済み Step を adopt していない（凍結を骨抜きにしない）', () => {
  for (const [campaignId, frozen] of Object.entries(COPY_STANDARD_FROZEN_STEPS)) {
    for (const [stepNumber, reason] of Object.entries(frozen)) {
      assert.equal(isCopyStandardAdopted(campaignId, Number(stepNumber)), false,
        `${campaignId} step${stepNumber}: 送信済みなのに adopt されている`);
      assert.ok(String(reason).trim().length >= 10,
        `${campaignId} step${stepNumber}: 凍結の理由が書かれていない`);
    }
  }
  // 実際に送信済みの step1 が adopt から外れていること（具体で固定する）
  assert.equal(isCopyStandardAdopted('free-signup-onboarding', 1), false);
  assert.equal(isCopyStandardAdopted('free-signup-onboarding', 2), true);
});

test('【重要】稼働中の割引 3 本は adopt しない（送信済み Step を含む）', () => {
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    assert.equal(Object.prototype.hasOwnProperty.call(COPY_STANDARD_ADOPTED, id), false,
      `${id}: 稼働中なのに adopt されている`);
    assert.ok(COPY_STANDARD_NOT_ADOPTED[id].includes('送信済み'),
      `${id}: 対象外の理由に送信実績が書かれていない`);
  }
});

// ── 5. HTML / text の一致 ──────────────────────────────────────

test('【重要】adopt した step は HTML と text で重要情報が一致する', () => {
  for (const { campaignId, stepNumber, step } of adoptedSteps()) {
    const label = `${campaignId} step${stepNumber}`;
    const input = {
      badge: step.badge,
      headline: step.headline,
      preheader: step.preheader,
      body: step.body,
      benefit: { title: step.benefitTitle, items: step.benefitItems },
      cta: { label: step.ctaLabel, url: step.ctaUrl },
      ctaNote: step.ctaNote,
      footerNote: step.footerNote,
    };
    const rendered = renderMarketingEmail(input);
    const html = String(rendered.html || '');
    const text = String(rendered.text || '');
    assert.ok(html && text, `${label}: HTML / text のどちらかが空`);

    // 見出し・CTA・特典項目・遷移先が両方に出ている
    for (const item of step.benefitItems) {
      assert.ok(text.includes(item), `${label}: 特典「${item}」が text 版に無い`);
    }
    assert.ok(text.includes(step.ctaLabel), `${label}: CTA ラベルが text 版に無い`);
    assert.ok(text.includes(step.ctaUrl), `${label}: CTA URL が text 版に無い`);
    assert.ok(html.includes(step.ctaUrl), `${label}: CTA URL が HTML 版に無い`);
  }
});

// ── 判定そのもののテスト（基準が実際に落とすことを固定する）──────────

const OK_STEP = Object.freeze({
  subject: '【KEIBA Analytics】三連複の対象は南関東 4 会場です',
  preheader: '大井・船橋・川崎・浦和のレースごとに買い目を出しています。',
  badge: '対象',
  headline: '南関東 4 会場が対象です',
  body: [
    'Premium をご利用中の方からお問い合わせをいただくことがあるため、',
    '三連複の対象の開催をご案内します。',
    '',
    '三連複の自動絞り込みは、大井・船橋・川崎・浦和の 4 会場が対象です。',
    '',
    'レースごとに買い目を自動で判定するので、',
    'ご自身で 3 頭の組み合わせを作っていただく必要はありません。',
    '',
    '中央（JRA）を含む Premium の馬単予想は、これまでどおりご利用いただけます。',
  ].join('\n'),
  benefitTitle: '対象と使い方',
  benefitItems: ['大井・船橋・川崎・浦和', 'レースごとの買い目', '組み合わせは自動'],
  ctaLabel: '実際の買い目の例を見る',
  ctaUrl: 'https://analytics.keiba.link/sanrenpuku-demo/',
  ctaNote: '実際のレースでの買い目と結果を載せています。',
});

test('基準を満たす step は通る', () => {
  assert.equal(evaluateCopyStandard(OK_STEP).ok, true);
});

test('冒頭で関係を作っていない本文は落ちる（いきなり期限と価格だけ）', () => {
  // ⚠️ 実際に指摘された形。冒頭 2 行が事実の列挙だけで、宛先との関係が無い
  const r = evaluateCopyStandard({
    ...OK_STEP,
    body: `9月23日までのお取り扱いです。\n10,000円引きになります。\n\n${OK_STEP.body}`,
  });
  assert.ok(r.issues.some((i) => i.code === 'no_relation_opening'),
    `落ちていない: ${JSON.stringify(r.issues)}`);
});

test('事務連絡に痩せた本文は落ちる（期限と価格だけ）', () => {
  const r = evaluateCopyStandard({ ...OK_STEP, body: 'ご登録の方へ。9月23日までです。' });
  assert.ok(r.issues.some((i) => i.code === 'body_too_thin'));
  assert.ok(r.issues.some((i) => i.code === 'body_too_few_lines'));
  assert.ok(MIN_BODY_CHARS > 100);
});

test('特典欄が無い / 少ない step は落ちる', () => {
  const a = evaluateCopyStandard({ ...OK_STEP, benefitTitle: '', benefitItems: [] });
  assert.ok(a.issues.some((i) => i.code === 'no_benefit_title'));
  assert.ok(a.issues.some((i) => i.code === 'too_few_benefit_items'));
  const b = evaluateCopyStandard({ ...OK_STEP, benefitItems: ['一つだけ'] });
  assert.ok(b.issues.some((i) => i.code === 'too_few_benefit_items'));
  assert.equal(MIN_BENEFIT_ITEMS, 2);
});

test('preheader が本文の複製なら落ちる', () => {
  const r = evaluateCopyStandard({
    ...OK_STEP, preheader: '三連複の自動絞り込みは、大井・船橋・川崎・浦和の 4 会場が対象です。',
  });
  assert.ok(r.issues.some((i) => i.code === 'preheader_duplicates_body'));
});

test('CTA が「こちら」「ログイン」だけなら落ちる', () => {
  for (const label of VAGUE_CTA_LABELS) {
    const r = evaluateCopyStandard({ ...OK_STEP, ctaLabel: label });
    assert.ok(r.issues.some((i) => i.code === 'vague_cta_label'), `「${label}」が通っている`);
  }
});

test('CTA の補足が無いと落ちる（押した先で何が起きるか）', () => {
  const r = evaluateCopyStandard({ ...OK_STEP, ctaNote: '' });
  assert.ok(r.issues.some((i) => i.code === 'no_cta_note'));
});

test('【重要】会員限定ページを CTA にすると落ちる（権限が無いと到達できない）', () => {
  for (const prefix of MEMBER_ONLY_CTA_PREFIXES) {
    const r = evaluateCopyStandard({ ...OK_STEP, ctaUrl: `https://analytics.keiba.link${prefix}nankan/` });
    assert.ok(r.issues.some((i) => i.code === 'member_only_cta'), `${prefix} が通っている`);
  }
  // 受信者が確実に権限を持つ campaign では許可できる
  const allowed = evaluateCopyStandard(
    { ...OK_STEP, ctaUrl: 'https://analytics.keiba.link/premium-prediction/nankan/' },
    { allowMemberOnlyCta: true },
  );
  assert.equal(allowed.issues.some((i) => i.code === 'member_only_cta'), false);
});

test('公開導線の一覧に無いパスは落ちる（推測で URL を作らない）', () => {
  const r = evaluateCopyStandard({ ...OK_STEP, ctaUrl: 'https://analytics.keiba.link/sanrenpuku/' });
  assert.ok(r.issues.some((i) => i.code === 'unknown_cta_path'));
  assert.ok(PUBLIC_CTA_PATHS.includes('/sanrenpuku-demo/'));
  assert.equal(ctaPathOf('https://analytics.keiba.link/pricing/'), '/pricing/');
  // 受信者ごとの差し込み URL は判定しない
  assert.equal(evaluateCopyStandard({ ...OK_STEP, ctaUrl: '{{offerUrl}}' })
    .issues.some((i) => i.code === 'unknown_cta_path'), false);
});

test('【重要】顧客向けの文面に内部運用の語を出すと落ちる', () => {
  const r = evaluateCopyStandard({
    ...OK_STEP,
    body: `${OK_STEP.body}\n内容と料金はプランのページが正本です。メールには書いていません。`,
  });
  assert.ok(r.issues.some((i) => i.code === 'internal_affairs'));
});

test('件名の実語が短すぎると落ちる', () => {
  const r = evaluateCopyStandard({ ...OK_STEP, subject: '【KEIBA Analytics】ご案内' });
  assert.ok(r.issues.some((i) => i.code === 'subject_too_vague'));
});

// ── ファネル上の役割（1 通ごとに目的がある）──────────────────────

test('【重要】改稿した 3 本は件名・CTA が 1 通ずつ違う（使い回しの禁止）', () => {
  for (const campaignId of Object.keys(COPY_STANDARD_ADOPTED)) {
    const c = getCampaign(campaignId, { includeDisabled: true });
    const steps = getSequenceSteps(c).map((s) => resolveSequenceStep(c, s.stepNumber));
    const subjects = steps.map((s) => s.subject);
    const labels = steps.map((s) => s.ctaLabel);
    assert.equal(new Set(subjects).size, subjects.length, `${campaignId}: 件名が重複している`);
    assert.equal(new Set(labels).size, labels.length, `${campaignId}: CTA ラベルが重複している`);
  }
});

// ── `/free/` と `/free-prediction/` の取り違え防止 ─────────────────
//
// 2026-09-15 レビューで「`/free-prediction/` は旧 URL で canonical は `/free/`」という
// 指摘があったが、**事実ではない**。両方とも現役の別ページで、
// `/free/` は買い目 / pt / AI総合指数 / 役割 / 特徴量を**出さない**（当の `/free/` 自身が
// `/free-prediction/` を「有料版プレビュー」として案内している）。
// 取り違えると「約束したものが無いページ」に着地するので、両方向で固定する。

test('【重要】/free/ と /free-prediction/ はどちらも公開導線として認める（片方を旧 URL 扱いしない）', () => {
  for (const p of ['/free-prediction/nankan/', '/free-prediction/jra/', '/free/nankan/', '/free/jra/']) {
    assert.ok(PUBLIC_CTA_PATHS.includes(p), `${p} が公開導線の一覧から外れている`);
  }
});

test('【重要】着地先に無いものを CTA 周りで約束すると落ちる', () => {
  // 特典欄で「買い目・AI総合指数・全頭の役割」を約束 → /free/ にも /free-prediction/ にも無い
  const promising = {
    ...OK_STEP,
    benefitTitle: '無料でご覧いただけるもの',
    benefitItems: ['メインレースの買い目', 'AI総合指数', '全頭の役割'],
    ctaLabel: '今日の買い目と指数を見る',
    ctaNote: 'ログインは不要です。そのままご覧いただけます。',
  };
  for (const path of ['/free/nankan/', '/free-prediction/nankan/']) {
    const r = evaluateCopyStandard({ ...promising, ctaUrl: `https://analytics.keiba.link${path}` });
    assert.ok(r.issues.some((i) => i.code === 'promise_not_on_landing_page'),
      `${path} で落ちていない: ${JSON.stringify(r.issues)}`);
  }

  // 買い目が**実際に公開されている** results-showcase なら通る
  const ok = evaluateCopyStandard({
    ...OK_STEP,
    benefitTitle: '前日の買い目と結果で分かること',
    benefitItems: ['有料版でお届けしたメインレースの買い目', '的中・不的中', '払戻（的中時）'],
    ctaLabel: '前日の買い目と結果を見る',
    ctaNote: '有料会員へ配信した買い目を、毎日そのまま公開しています。',
    ctaUrl: 'https://analytics.keiba.link/results-showcase/nankan/',
  });
  assert.equal(ok.issues.some((i) => i.code === 'promise_not_on_landing_page'), false,
    `results-showcase が落ちている: ${JSON.stringify(ok.issues)}`);

  // アーカイブは買い目を出さない（意図的に非公開）
  const archive = evaluateCopyStandard({
    ...OK_STEP,
    benefitTitle: 'アーカイブで確認できること',
    benefitItems: ['月別・年別の的中実績', '年間の的中率', '買い目'],
    ctaLabel: '直近 1 か月の実績を確認する',
    ctaNote: '数字はページのものが最新です。',
    ctaUrl: 'https://analytics.keiba.link/archive/nankan/',
  });
  assert.ok(archive.issues.some((i) => i.code === 'promise_not_on_landing_page'));

  // 買い目を約束していない「見どころ」案内なら /free/ でも通る
  // ⚠️ preheader / CTA ラベル / 特典欄も判定対象なので、すべて見どころ側の語に揃える
  const viewpoints = evaluateCopyStandard({
    ...OK_STEP,
    subject: '【KEIBA Analytics】今日のレースの見どころを無料で公開しています',
    preheader: '出走馬の近走から、条件の替わり方を読み解いてご案内します。',
    headline: '今日のレースの見どころ',
    body: 'ご登録ありがとうございます。\n\n出走馬の近走から、レースごとの条件の替わり方を\n'
      + '無料で公開しています。\n\n評価の数値は含みません。近走の比べやすさを\n'
      + 'そのままご覧いただける作りにしています。\n\n本日のレースでご覧いただけます。',
    benefitTitle: '見どころで分かること',
    benefitItems: ['条件の替わり方', '近走の比べやすさ', '当日の注目点'],
    ctaLabel: '今日のレースの見どころを見る',
    ctaNote: 'ログインは不要です。そのままご覧いただけます。',
    ctaUrl: 'https://analytics.keiba.link/free/nankan/',
  });
  assert.equal(viewpoints.issues.some((i) => i.code === 'promise_not_on_landing_page'), false,
    `見どころ案内が落ちている: ${JSON.stringify(viewpoints.issues)}`);
});

test('【重要】改稿済み step の CTA が、約束した中身のある着地先を指している', () => {
  const c = getCampaign('free-signup-onboarding', { includeDisabled: true });

  // step2 は「出走馬の公開事実 + 上位 4 頭の印」の案内 → 有料版プレビュー
  const s2 = resolveSequenceStep(c, 2);
  assert.equal(ctaPathOf(s2.ctaUrl), '/free-prediction/nankan/');
  assert.equal(/買い目|AI総合指数|全頭の役割/.test(
    [s2.ctaLabel, s2.ctaNote, s2.benefitTitle, (s2.benefitItems || []).join(' ')].join(' '),
  ), false, 'step2 が伏せてあるものを無料で見られるものとして案内している');

  // step4 は「買い目そのもの」の案内 → 買い目を実際に公開している results-showcase
  const s4 = resolveSequenceStep(c, 4);
  assert.equal(ctaPathOf(s4.ctaUrl), '/results-showcase/nankan/',
    'step4: 買い目は /free-prediction/ では伏せてあるので、公開している側を指すこと');
});

test('【重要】無料会員向けの本文に Premium Plus（三連単の個別配信）を書かない', () => {
  // Premium Plus は Premium Sanrenpuku 会員にのみ表示し、それ以外には存在も知らせない
  const c = getCampaign('free-signup-onboarding', { includeDisabled: true });
  for (const s of getSequenceSteps(c)) {
    const step = resolveSequenceStep(c, s.stepNumber);
    const text = [step.subject, step.preheader, step.body, step.headline,
      (step.benefitItems || []).join(' '), step.ctaLabel, step.ctaNote].join('\n');
    for (const ng of ['三連単', 'Premium Plus', 'プレミアムプラス', 'premium-plus']) {
      assert.equal(text.includes(ng), false,
        `free-signup-onboarding step${s.stepNumber} に「${ng}」がある（無料会員へ知らせない）`);
    }
  }
});
