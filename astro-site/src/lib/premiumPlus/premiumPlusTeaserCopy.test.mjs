/**
 * premiumPlusTeaserCopy.test.mjs — 予告枠（PremiumPlusStageTeaser）の phase 別文言
 *   node --test src/lib/premiumPlus/premiumPlusTeaserCopy.test.mjs
 *
 * 事故（2026-08-07）:
 *   teaserCopyForRoute が route だけで文言を決めていたため、PHASE 4（override 等で
 *   閲覧・購入が開通済み）の会員にも「新しい予想を準備しています」が表示され続けていた。
 *   実際には 8 日間購入可能だったが、画面上は「まだ買えない」と読める状態だった。
 *
 * 恒久的な回帰条件（この 2 方向を両方固定する）:
 *   1. PHASE 2 / PHASE 3（待機中）は「準備しています」のまま。文言も導線ラベルも変えない。
 *   2. PHASE 4（開通済み）は「準備しています」を出さず、静かな導線ラベルを出す。
 *
 * トーン制約（要件）: 営業的・派手な表現は入れない。既存の枠（pp-stage-slot）と
 * スタイルは維持し、差し替わるのは文字列だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PP_PHASE,
  PP_ROUTE,
  PP_RELEASE_COPY,
  teaserCopyForRoute,
} from './premiumPlusRelease.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 「コメントで言及しているだけ」を誤検知しないようコメントを落とす（既存 guard と同じ方針）。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TEASER = read('../../components/PremiumPlusStageTeaser.astro');
const ENDPOINT = read('../../pages/api/premium-plus-stage.json.js');
/** 描画されるコードだけを見る（frontmatter の説明コメントとコード内コメントを除外）。 */
const TEASER_BODY = stripComments(TEASER.slice(TEASER.indexOf('\n---', 3) + 4));

/** 予告枠に出してはいけない営業的表現。要件で明示的に禁止されたもの。 */
const SALESY = /お申し込み受付中|今すぐ購入|今すぐお申し込み|受付中|販売中|お急ぎ|限定|残りわずか|セール|特別価格|お得/;
/** 予告枠に価格は出さない（PHASE を問わない既存ルール）。 */
const PRICEY = /68,?000|98,?000|¥|円/;

const WAITING_PHASES = [PP_PHASE.TEASER, PP_PHASE.PREVIEW];
const ROUTES_A = [PP_ROUTE.SANRENPUKU];
const ROUTES_B = [PP_ROUTE.PREMIUM_30D, PP_ROUTE.PREMIUM_ADMIN];

// ── 1. 待機中（PHASE 2 / 3）は現状維持 ─────────────────────────────
test('PHASE 2 / 3 は「準備しています」の既存文言のまま（ROUTE A）', () => {
  for (const phase of WAITING_PHASES) {
    for (const route of ROUTES_A) {
      const copy = teaserCopyForRoute(route, phase);
      assert.equal(copy, PP_RELEASE_COPY.teaser, `phase=${phase} で待機中の文言が返らない`);
      assert.match(copy.title, /準備しています/);
      assert.equal(copy.linkLabel, '内容を見る →', '待機中の導線ラベルを変えない');
    }
  }
});

test('PHASE 2 / 3 は「準備しています」の既存文言のまま（ROUTE B）', () => {
  for (const phase of WAITING_PHASES) {
    for (const route of ROUTES_B) {
      const copy = teaserCopyForRoute(route, phase);
      assert.equal(copy, PP_RELEASE_COPY.teaserPremium30d, `phase=${phase} で待機中の文言が返らない`);
      assert.match(copy.body, /準備しています/);
      assert.equal(copy.linkLabel, '内容を見る →', '待機中の導線ラベルを変えない');
    }
  }
});

test('待機中の指定文章は一字も変わっていない', () => {
  assert.equal(PP_RELEASE_COPY.teaser.title, '新しい予想を準備しています');
  assert.equal(
    PP_RELEASE_COPY.teaser.body,
    '全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ、新しい予想を準備しています。'
  );
  assert.equal(PP_RELEASE_COPY.teaserPremium30d.title, '全レース型とは異なる、もうひとつの選択肢。');
  assert.equal(
    PP_RELEASE_COPY.teaserPremium30d.body,
    '対象レースを増やすのではなく、その日の全開催から1鞍だけを選ぶ、新しい予想を準備しています。'
  );
});

// ── 2. PHASE 4 は「準備しています」を出さない ──────────────────────
test('PHASE 4 は「準備しています」を出さない（ROUTE A / B とも）', () => {
  for (const route of [...ROUTES_A, ...ROUTES_B]) {
    const copy = teaserCopyForRoute(route, PP_PHASE.SALE);
    assert.ok(copy, `route=${route} で PHASE 4 の文言が無い`);
    assert.doesNotMatch(JSON.stringify(copy), /準備しています|準備中/, `route=${route}: 開通済みなのに準備中と表示される`);
  }
});

test('PHASE 4 は待機中とは別の文言オブジェクトを返す', () => {
  assert.equal(teaserCopyForRoute(PP_ROUTE.SANRENPUKU, PP_PHASE.SALE), PP_RELEASE_COPY.teaserOpen);
  assert.equal(teaserCopyForRoute(PP_ROUTE.PREMIUM_30D, PP_PHASE.SALE), PP_RELEASE_COPY.teaserPremium30dOpen);
  assert.equal(teaserCopyForRoute(PP_ROUTE.PREMIUM_ADMIN, PP_PHASE.SALE), PP_RELEASE_COPY.teaserPremium30dOpen);
  assert.notEqual(PP_RELEASE_COPY.teaserOpen.body, PP_RELEASE_COPY.teaser.body);
  assert.notEqual(PP_RELEASE_COPY.teaserPremium30dOpen.body, PP_RELEASE_COPY.teaserPremium30d.body);
});

test('PHASE 4 の導線ラベルは静かな表現（売り込み語を使わない）', () => {
  for (const route of [...ROUTES_A, ...ROUTES_B]) {
    const { linkLabel } = teaserCopyForRoute(route, PP_PHASE.SALE);
    assert.equal(typeof linkLabel, 'string');
    assert.ok(linkLabel.length > 0, 'ラベルが空だとリンクが出ない');
    assert.doesNotMatch(linkLabel, SALESY, `route=${route}: 営業的なラベル`);
    assert.doesNotMatch(linkLabel, /[!！]/, '感嘆符で強調しない');
  }
});

// ── 3. トーン制約（PHASE を問わず） ───────────────────────────────
test('予告文言に営業的表現・価格・在庫の示唆を入れない（全 phase / 全 route）', () => {
  for (const phase of [...WAITING_PHASES, PP_PHASE.SALE]) {
    for (const route of [...ROUTES_A, ...ROUTES_B]) {
      const json = JSON.stringify(teaserCopyForRoute(route, phase));
      assert.doesNotMatch(json, SALESY, `phase=${phase} route=${route}: 営業的表現`);
      assert.doesNotMatch(json, PRICEY, `phase=${phase} route=${route}: 価格`);
      assert.doesNotMatch(json, /[!！]/, `phase=${phase} route=${route}: 感嘆符`);
    }
  }
});

test('ROUTE B は PHASE 4 でも三連複購入者向けの文脈を持ち込まない', () => {
  assert.doesNotMatch(JSON.stringify(PP_RELEASE_COPY.teaserPremium30dOpen), /三連複/);
});

// ── 4. 対象外 route / 後方互換 ────────────────────────────────────
test('対象外 route はどの phase でも null（存在秘匿を維持）', () => {
  for (const phase of [PP_PHASE.LOCKED, ...WAITING_PHASES, PP_PHASE.SALE, undefined]) {
    assert.equal(teaserCopyForRoute(PP_ROUTE.NONE, phase), null);
    assert.equal(teaserCopyForRoute(null, phase), null);
    assert.equal(teaserCopyForRoute('sanrenpuku2', phase), null);
  }
});

test('phase 未指定・不正値は待機中の文言（fail closed）', () => {
  for (const phase of [undefined, null, 0, PP_PHASE.LOCKED, '4', 'sale', NaN, 99]) {
    assert.equal(
      teaserCopyForRoute(PP_ROUTE.SANRENPUKU, phase),
      PP_RELEASE_COPY.teaser,
      `phase=${String(phase)} で開通済み文言に倒れている`
    );
  }
});

// ── 5. 配線（source guard）──────────────────────────────────────
test('stage API は route と phase の両方を渡している', () => {
  assert.match(ENDPOINT, /teaserCopyForRoute\(release\.route,\s*release\.phase\)/);
});

test('コンポーネントは導線ラベルを SSR から受け取る（ベタ書きしない）', () => {
  assert.match(TEASER_BODY, /data\.teaser\.linkLabel/);
  // ラベルが無ければリンクごと出さない（空リンクを作らない）
  assert.match(TEASER_BODY, /if \(data\.productHref && linkLabel\)/);
});

/**
 * `<script is:inline>` は **コメントごと**静的 HTML に載り、未ログイン者にも見える
 * （premium-sanrenpuku.astro は prerender=true）。2026-08-07 に「PHASE 3 = 内容を見る /
 * PHASE 4 = 詳細を見る」という説明コメントがそのまま本番 HTML へ出た。
 * よって**コメントを落とさない生のテンプレート本体**で文言の混入を検査する。
 */
test('テンプレート本体（コメント含む）に予告文言が一切現れない', () => {
  const raw = TEASER.slice(TEASER.indexOf('\n---', 3) + 4);
  for (const key of ['teaser', 'teaserPremium30d', 'teaserOpen', 'teaserPremium30dOpen']) {
    for (const [field, value] of Object.entries(PP_RELEASE_COPY[key])) {
      assert.ok(
        !raw.includes(value),
        `${key}.${field} の文言がテンプレートに載っている（未ログイン者に見える）: ${value}`
      );
    }
  }
  // 部分一致でも拾う（コメント内での言及を含む）
  assert.doesNotMatch(raw, /内容を見る|詳細を見る|ページへ移動|準備しています|ご用意しました/);
});

test('コンポーネントは phase 別の分岐を自前で持たない（判定は単一源のみ）', () => {
  const body = TEASER_BODY;
  assert.doesNotMatch(body, /data\.phase\s*(===|>=|>|<)/, 'コンポーネントが phase を再判定している');
});

test('PHASE 4 でも予告枠のスタイル・構造を変えない（クラス名が同一）', () => {
  for (const cls of ['pp-stage-card', 'pp-stage-eyebrow', 'pp-stage-title', 'pp-stage-body', 'pp-stage-link']) {
    assert.ok(TEASER.includes(cls), `クラスが失われている: ${cls}`);
  }
  // phase 別のクラス付与・強調スタイルを追加していない
  assert.doesNotMatch(TEASER, /pp-stage-(sale|open|urgent|highlight)/);
});
