/**
 * premiumPlusSalePause.test.mjs — 会員単位の「販売中 ⇔ 一時停止」を固定する
 *   node --test src/lib/premiumPlus/premiumPlusSalePause.test.mjs
 *
 * ## 守る一線
 *
 * 1. **1 人だけ止まる。** 他会員・翌日販売・通常の eligibility 判定に影響しない
 * 2. **全面が閉じる。** 予告 / 商品ページ / 価格 / 購入 CTA / 申込のすべて
 * 3. **資格を書き換えない。** 止めても eligible のまま、再開で PHASE が戻らない
 * 4. **「販売対象外(blocked)」と混同しない。** 表示も理由も別
 * 5. **fail closed。** フィールド未作成なら「停止」操作を受け付けない
 *    （画面だけ停止＝売れ続ける、が最悪）
 * 6. **rollback 可能。** 同じ場所から 1 手で元に戻る
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PP_ELIGIBILITY, PP_PHASE, PP_SALE_PAUSE_FIELDS, PP_ELIGIBILITY_FIELDS,
  normalizeSalePaused, resolvePremiumPlusRelease, describeReleaseState,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';
import {
  buildSalePauseFields, isSalePauseEnabled, assertOnlyPlusFields,
  PP_ADMIN_ACTION, PP_FORBIDDEN_FIELDS,
} from './premiumPlusEligibility.js';
import {
  resolveUpsellForCustomer, UPSELL_CHANNEL, UPSELL_REASON,
} from '../upsell/upsellTarget.js';
import { normalizeEntry, OP_KIND } from './adminOperationLog.js';

/** 本番に実在する三連複会員の項目構成（PII なし / plusCtaSurfaces.test.mjs と同じ形） */
const MEMBER = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  PlanType: 'Lifetime',
  Status: 'active',
  '有効期限': '2099-12-31',
  PaidAt: '2026-07-15T05:34:04.097Z',
  PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: '2026-07-29T16:11:51.236Z',
  PremiumPlusReleaseOverride: 'phase4',
});
const paused = (extra = {}) => ({ ...MEMBER, [PP_SALE_PAUSE_FIELDS.PAUSED]: true, ...extra });

/** 受付時間内（14:00 JST）と 16:30 以降（22:44 JST = 翌日分受付中） */
const AT_OPEN = Date.parse('2026-08-17T05:00:00Z');
const AT_NEXT_DAY = Date.parse('2026-08-17T13:44:00Z');

const view = (fields, now = AT_OPEN) => resolveUpsellForCustomer({ fields, nowMs: now });

// ══════════════════════════════════════════════════════════════
//  正規化
// ══════════════════════════════════════════════════════════════

test('未設定・未チェックは「停止していない」', () => {
  for (const v of [undefined, null, '', false, 0, 'false', 'no']) {
    assert.equal(normalizeSalePaused(v), false, `停止と誤判定: ${JSON.stringify(v)}`);
  }
});

test('チェック済みは停止（typecast 由来の表記揺れも拾う）', () => {
  for (const v of [true, 1, 'true', 'TRUE', ' 1 ', 'yes', 'checked']) {
    assert.equal(normalizeSalePaused(v), true, `停止と判定されない: ${JSON.stringify(v)}`);
  }
});

test('フィールドが無い会員は従来どおり（既存の販売を勝手に止めない）', () => {
  const m = resolvePlusMemberFromFields(MEMBER, { nowMs: AT_OPEN });
  assert.equal(m.salePaused, false);
  assert.equal(view(MEMBER).channel, UPSELL_CHANNEL.PLUS, '既存会員の販売が止まっている');
});

test('fields を読めないときも停止しない（Airtable 障害で全員止めない）', () => {
  const m = resolvePlusMemberFromFields(null, { nowMs: AT_OPEN });
  assert.equal(m.salePaused, false);
});

// ══════════════════════════════════════════════════════════════
//  全面が閉じる
// ══════════════════════════════════════════════════════════════

test('【重要】停止すると Plus の全フラグが閉じる', () => {
  const rel = view(paused()).plusRelease;
  assert.equal(rel.allowed, false);
  assert.equal(rel.showTeaser, false, '三連複ページの予告枠が残っている');
  assert.equal(rel.showProductPage, false, '商品ページが開けたままになっている');
  assert.equal(rel.showPurchaseCta, false, '価格・購入 CTA が残っている');
  assert.equal(rel.purchaseEnabled, false, '購入ボタンが押せる');
  assert.equal(rel.salePaused, true, '停止の印が立っていない');
});

test('【重要】dashboard / 三連複 / 商品ページの 3 サーフェスがすべて閉じる', () => {
  const v = view(paused());
  // B: dashboard は channel だけで出し分ける
  assert.notEqual(v.channel, UPSELL_CHANNEL.PLUS, 'dashboard のボタンが出る');
  // A: 三連複ページの予告枠は channel=plus かつ showTeaser が要る
  assert.equal(v.plusRelease.showTeaser, false);
  // C: 商品ページは channel=plus かつ showProductPage が要る（どちらも false → 404）
  assert.equal(v.plusRelease.showProductPage, false);
});

test('【重要】16:30 以降の翌日分販売でも停止が優先される', () => {
  const v = view(paused(), AT_NEXT_DAY);
  assert.equal(v.plusRelease.purchaseEnabled, false, '翌日分として買えてしまう');
  assert.equal(v.plusRelease.intake, null);
  // 停止していない会員は同じ時刻で翌日分を買える（翌日販売そのものを壊していない）
  const ok = view(MEMBER, AT_NEXT_DAY);
  assert.equal(ok.plusRelease.purchaseEnabled, true, '翌日分販売を巻き添えで止めている');
});

test('【重要】管理者が UpsellTarget=plus を指定していても停止が勝つ', () => {
  const v = view(paused({ UpsellTarget: 'plus' }));
  assert.notEqual(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.reason, UPSELL_REASON.PLUS_SALE_PAUSED);
});

// ══════════════════════════════════════════════════════════════
//  資格を書き換えない / blocked と混同しない
// ══════════════════════════════════════════════════════════════

test('【重要】停止しても販売資格は eligible のまま', () => {
  const rel = view(paused()).plusRelease;
  assert.equal(rel.eligibility, PP_ELIGIBILITY.ELIGIBLE, '停止で資格が書き換わっている');
});

test('【重要】再開すれば元の状態がそのまま戻る（PHASE が Day 0 に戻らない）', () => {
  const before = view(MEMBER);
  const during = view(paused());
  const after = view({ ...MEMBER, [PP_SALE_PAUSE_FIELDS.PAUSED]: false });

  assert.equal(during.plusRelease.purchaseEnabled, false);
  assert.deepEqual(
    [after.channel, after.plusRelease.phase, after.plusRelease.showPurchaseCta, after.plusRelease.anchorMs],
    [before.channel, before.plusRelease.phase, before.plusRelease.showPurchaseCta, before.plusRelease.anchorMs],
    '再開したのに元の状態へ戻っていない',
  );
  assert.equal(after.plusRelease.phase, PP_PHASE.SALE);
});

test('【重要】表示は「販売対象外」と別文言', () => {
  const pausedState = describeReleaseState(view(paused()).plusRelease);
  const blockedState = describeReleaseState(
    view({ ...MEMBER, PremiumPlusEligibility: 'blocked' }).plusRelease,
  );
  assert.equal(blockedState, '販売対象外');
  assert.notEqual(pausedState, blockedState, '一時停止と販売対象外が同じ表示になっている');
  assert.match(pausedState, /一時停止/);
});

test('【重要】販売対象外(blocked)は停止しても「販売対象外」のまま見せる', () => {
  const rel = view(paused({ PremiumPlusEligibility: 'blocked' })).plusRelease;
  assert.equal(describeReleaseState(rel), '販売対象外', '恒久判断が一時停止に上書きされた');
});

test('【重要】理由が「対象外」「保有済み」に丸められない', () => {
  // 三連複保有者は停止しないと SANRENPUKU_OWNED / NOTHING_TO_SELL に落ちるところ
  assert.equal(view(paused()).reason, UPSELL_REASON.PLUS_SALE_PAUSED);
});

// ══════════════════════════════════════════════════════════════
//  他会員へ波及しない
// ══════════════════════════════════════════════════════════════

test('【重要】止めた会員以外は何も変わらない', () => {
  const other = view(MEMBER);
  assert.equal(other.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(other.plusRelease.purchaseEnabled, true);
  assert.equal(other.plusRelease.salePaused, false);
});

test('三連複の販売導線は巻き添えで止まらない', () => {
  // Plus を止めた「三連複 未保有の有料 Premium 会員」は三連複 CTA を出し続ける
  const premium = {
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2099-12-31',
    PaidAt: '2026-01-01T00:00:00.000Z',
    [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
  };
  const v = view(premium);
  assert.equal(v.channel, UPSELL_CHANNEL.SANRENPUKU, 'Plus の停止で三連複の導線まで消えた');
  assert.equal(v.sanrenpuku.allowed, true);
});

// ══════════════════════════════════════════════════════════════
//  書き込み（fail closed / 冪等 / allow-list）
// ══════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-17T07:00:00.000Z');

test('【重要】フィールド未作成なら停止操作を受け付けない（fail closed）', () => {
  assert.equal(buildSalePauseFields({ paused: true, actor: 'MK', now: NOW, enabled: false }), null);
  assert.equal(isSalePauseEnabled({}), false);
  assert.equal(isSalePauseEnabled({ PREMIUM_PLUS_FIELDS_READY: '1' }), false, 'override と同じ gate を要求していない');
  assert.equal(
    isSalePauseEnabled({ PREMIUM_PLUS_FIELDS_READY: '1', PREMIUM_PLUS_SALE_PAUSE_READY: '1' }), true,
  );
});

test('停止で書くのは停止系フィールドだけ（資格・課金に触れない）', () => {
  const built = buildSalePauseFields({
    paused: true, current: false, reason: '本人希望', actor: 'MK', now: NOW, enabled: true,
  });
  assert.ok(built && built.changed);
  assert.deepEqual(Object.keys(built.fields).sort(), [
    PP_SALE_PAUSE_FIELDS.PAUSED, PP_SALE_PAUSE_FIELDS.REASON,
    PP_SALE_PAUSE_FIELDS.UPDATED_AT, PP_SALE_PAUSE_FIELDS.UPDATED_BY,
  ].sort());
  assert.equal(built.fields[PP_SALE_PAUSE_FIELDS.PAUSED], true);
  assert.ok(assertOnlyPlusFields(built.fields));
  for (const forbidden of PP_FORBIDDEN_FIELDS) {
    assert.ok(!(forbidden in built.fields), `禁止フィールドを書いている: ${forbidden}`);
  }
});

test('【重要】資格・段階公開 anchor を書かない', () => {
  const built = buildSalePauseFields({ paused: true, actor: 'MK', now: NOW, enabled: true });
  for (const k of [
    PP_ELIGIBILITY_FIELDS.STATUS, PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT, PP_ELIGIBILITY_FIELDS.OVERRIDE,
  ]) {
    assert.ok(!(k in built.fields), `停止操作が ${k} を書き換えている`);
  }
});

test('再開は 1 手で戻り、停止理由をクリアする', () => {
  const built = buildSalePauseFields({
    paused: false, current: true, actor: 'MK', now: NOW, enabled: true,
  });
  assert.equal(built.paused, false);
  assert.equal(built.changed, true);
  assert.equal(built.fields[PP_SALE_PAUSE_FIELDS.PAUSED], false);
  assert.equal(built.fields[PP_SALE_PAUSE_FIELDS.REASON], '', '前回の停止理由が残っている');
});

test('同じ状態への操作は PATCH しない（監査日時を無駄に動かさない）', () => {
  const same = buildSalePauseFields({ paused: true, current: true, actor: 'MK', now: NOW, enabled: true });
  assert.equal(same.changed, false);
  assert.deepEqual(same.fields, {});
});

test('paused が boolean でなければ拒否（曖昧な値で止めない）', () => {
  for (const v of ['true', 1, null, undefined, 'pause']) {
    assert.equal(
      buildSalePauseFields({ paused: v, actor: 'MK', now: NOW, enabled: true }), null,
      `boolean 以外を受け付けた: ${JSON.stringify(v)}`,
    );
  }
});

test('操作者は記録され、長すぎる値は切り詰める', () => {
  const built = buildSalePauseFields({
    paused: true, actor: 'x'.repeat(200), now: NOW, enabled: true,
  });
  assert.equal(built.fields[PP_SALE_PAUSE_FIELDS.UPDATED_BY].length, 64);
});

test('停止/再開は変更履歴の種別として記録できる', () => {
  const e = normalizeEntry({
    kind: OP_KIND.SALE_PAUSE, result: 'ok', actor: 'MK', recordId: 'recX',
    from: '販売中', to: '一時停止中', at: Date.now(),
  });
  assert.ok(e, '販売の一時停止が履歴から捨てられている');
  assert.equal(e.kind, 'salePause');
});

test('管理操作の名前が資格操作と衝突しない', () => {
  assert.equal(PP_ADMIN_ACTION.PAUSE_SALE, 'pauseSale');
  assert.equal(PP_ADMIN_ACTION.RESUME_SALE, 'resumeSale');
  for (const a of ['staged', 'immediate', 'review', 'blocked']) {
    assert.notEqual(PP_ADMIN_ACTION.PAUSE_SALE, a);
  }
});

// ══════════════════════════════════════════════════════════════
//  配線ガード — URL 直打ちを止めるのはサーバーだけ
// ══════════════════════════════════════════════════════════════

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const APPLY = read('../../../netlify/functions/bank-transfer-application.js');
const ADMIN_FN = read('../../../netlify/functions/premium-plus-eligibility.js');

test('【重要】申込 Function が停止を確認して拒否する（URL 直打ち対策）', () => {
  // 判定は 2 系統（Airtable + deny-marker）の単一源へ委譲する。
  // 詳細な fail closed の性質は salePauseGuard.test.mjs で固定。
  assert.match(APPLY, /resolveSalePauseGate\(/, '申込側で停止を判定していない');
  assert.match(APPLY, /code: 'sale_paused'/);
  assert.match(APPLY, /statusCode: 403/);
});

test('【重要】拒否はメール送信より前（副作用ゼロで止める）', () => {
  const iPause = APPLY.indexOf("code: 'sale_paused'");
  const iAdminMail = APPLY.indexOf('SendGrid user email error');
  assert.ok(iPause > 0 && iAdminMail > 0);
  assert.ok(iPause < iAdminMail, '停止判定がメール送信より後にある（送ってから断っている）');
});

test('拒否時に副作用なしを明示する', () => {
  const seg = APPLY.slice(APPLY.indexOf("code: 'sale_paused'") - 400, APPLY.indexOf("code: 'sale_paused'") + 200);
  assert.match(seg, /sideEffects: 'none'/);
});

test('【重要】Airtable を読めないだけでは通さない（fail open を作らない）', () => {
  const seg = APPLY.slice(
    APPLY.indexOf('会員単位の販売 一時停止を'), APPLY.indexOf("code: 'sale_paused'"),
  );
  // 旧実装は catch の中で「読めなければ通す」と倒しており、停止済み会員が
  // 一時障害の窓で申込を迂回できた。判定は 2 系統の gate へ委ねる。
  assert.match(seg, /catch/, '読み取り失敗を握り潰していない（申込が 500 になる）');
  assert.ok(!/読めなかったときは\*\*止めない\*\*/.test(seg), 'fail open の実装が戻っている');
  assert.match(seg, /resolveSalePauseGate\(/, '停止判定を gate に委ねていない');
  // Airtable が落ちて recordId が引けなくても marker を引けるように email を渡す
  assert.match(seg, /email,/, 'email 経路が無いと Airtable 障害中に marker を引けない');
});

test('【重要】管理 API の停止操作は gate off で 503（画面だけ停止させない）', () => {
  assert.match(ADMIN_FN, /action === 'setSalePause'/);
  const seg = ADMIN_FN.slice(ADMIN_FN.indexOf('async function handleSetSalePause'));
  assert.match(seg, /isSalePauseEnabled\(process\.env\)/);
  assert.match(seg, /sale_pause_not_ready/);
  // 資格の更新経路を巻き込んでいない
  assert.ok(!/buildAdminActionFields\(/.test(seg.slice(0, 3000)), '停止操作が資格更新を呼んでいる');
});

test('管理 API は PATCH 前に allow-list を再確認する', () => {
  const seg = ADMIN_FN.slice(ADMIN_FN.indexOf('async function handleSetSalePause'));
  const iAssert = seg.indexOf('assertOnlyPlusFields(built.fields)');
  const iPatch = seg.indexOf("method: 'PATCH'");
  assert.ok(iAssert > 0 && iPatch > iAssert, 'allow-list 検査より先に PATCH している');
});

test('一覧・詳細が現在状態を返す（一目で分かる）', () => {
  assert.match(ADMIN_FN, /salePaused: member\.salePaused === true/);
  assert.match(ADMIN_FN, /salePausedLabel/);
  assert.match(ADMIN_FN, /salePauseWritable/);
});

test('管理画面が停止と販売対象外を別バッジで出す', () => {
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  assert.match(page, /badge: 'paused'/);
  assert.match(page, /\.badge\.paused/, '専用の見た目が無い（blocked と同じに見える）');
  assert.match(page, /action: 'setSalePause'/);
  assert.match(page, /販売を再開する/, '再開が同じ場所から 1 クリックでできない');
});
