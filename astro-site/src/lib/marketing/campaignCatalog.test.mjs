/**
 * campaignCatalog.test.mjs — キャンペーン定義とテンプレート描画の検証
 *   node --test src/lib/marketing/campaignCatalog.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPAIGNS,
  listCampaigns,
  getCampaign,
  renderCampaign,
  matchesCampaignAudience,
  sanitizeName,
  buildSalutation,
  isTemplateConfigured,
  isCampaignUsable,
  NAME_FALLBACK,
} from './campaignCatalog.js';
import { computeCampaignContentHash } from './campaignSend.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import { OFFER_URL_PLACEHOLDER } from '../promotions/offerCampaignLink.js';

/** 送信直前に差し替わる印（描画時点で残っているのが正しい） */
const DEFERRED = ['{{unsubscribeUrl}}', '{{grantExpiry}}', OFFER_URL_PLACEHOLDER];
const stripDeferred = (v) => DEFERRED.reduce((acc, ph) => acc.split(ph).join(''), String(v));

const REQUIRED_KEYS = [
  'campaignId', 'version', 'name', 'description', 'subject', 'body',
  'ctaLabel', 'ctaUrl', 'recommendedSegments', 'audienceRule', 'enabled',
];

/** 使用可能なキャンペーンだけを対象にしたいテスト用 */
const usable = () => CAMPAIGNS.filter(isCampaignUsable);

test('全キャンペーンが必須項目を持ち、campaignId が一意', () => {
  const ids = new Set();
  for (const c of CAMPAIGNS) {
    for (const k of REQUIRED_KEYS) {
      assert.ok(c[k] !== undefined, `${c.campaignId}: ${k} が無い`);
    }
    assert.equal(typeof c.version, 'number');
    assert.ok(c.version >= 1);
    assert.equal(ids.has(c.campaignId), false, `campaignId 重複: ${c.campaignId}`);
    ids.add(c.campaignId);
  }
  assert.ok(CAMPAIGNS.length >= 6, '初期キャンペーンが 6 本そろっていない');
});

test('要望された初期キャンペーンがすべて存在する（停止中も含む）', () => {
  for (const id of [
    'expired-comeback', 'premium-renewal', 'sanrenpuku-offer',
    'premium-plus-offer', 'dormant-reactivation', 'general-announcement',
  ]) {
    assert.ok(getCampaign(id, { includeDisabled: true }), `${id} が無い`);
  }
});

test('CTA URL は本番 URL ルールに従う（analytics.keiba.jp / netlify.app 禁止）', () => {
  for (const c of usable()) {
    // 受信者ごとの申込 URL を使うキャンペーンは、送信直前に差し替える印だけを持つ。
    // （URL 自体は台帳から生成され、生成側で SITE が固定されている）
    if (c.requiresOfferUrl === true) {
      assert.equal(c.ctaUrl, OFFER_URL_PLACEHOLDER,
        `${c.campaignId}: 受信者ごとの URL は差し込み印だけを置くこと`);
    } else {
      assert.ok(c.ctaUrl.startsWith('https://analytics.keiba.link/'), `${c.campaignId}: ${c.ctaUrl}`);
    }
    assert.equal(c.ctaUrl.includes('analytics.keiba.jp'), false);
    assert.equal(c.ctaUrl.includes('netlify.app'), false);
  }
});

test('受信者ごとの URL が要るキャンペーンは、URL 無しでは描画できない（fail closed）', () => {
  const c = getCampaign('comeback-offer');
  assert.ok(c, 'comeback-offer が送信経路から取得できない');
  assert.equal(c.requiresOfferUrl, true);
  // 本文に書いた条件（突合に使う）が揃っている
  assert.equal(c.offerId, 'premium-annual-half');
  assert.ok(Number.isInteger(c.offerPrice) && c.offerPrice > 0);
  assert.ok(Number.isInteger(c.regularPrice) && c.regularPrice > c.offerPrice);

  // キュー登録時点の描画では印が残る（dispatcher が差し替える前提）
  const queued = renderCampaign({ campaign: c, name: 'テスト' });
  assert.ok(queued, 'キュー登録用の描画に失敗');
  assert.ok(queued.html.includes(OFFER_URL_PLACEHOLDER), '差し込み印が消えている');

  // 実際の URL を渡すと解決され、印は残らない
  const real = 'https://analytics.keiba.link/offer/?t=' + 'a'.repeat(32) + '.' + 'b'.repeat(32);
  const sent = renderCampaign({ campaign: c, name: 'テスト', offerUrl: real });
  assert.ok(sent);
  assert.ok(sent.html.includes(real), '実 URL が入っていない');
  assert.equal(sent.html.includes(OFFER_URL_PLACEHOLDER), false, '印が残っている');
  assert.ok(sent.text.includes(real));

  // 印が消えたテンプレート（設定ミス）は URL 無しで描画できない
  const broken = { ...c, ctaUrl: 'https://analytics.keiba.link/pricing/' };
  assert.equal(renderCampaign({ campaign: broken, name: 'テスト' }), null,
    '汎用 URL へフォールバックして送れてしまう');

  // URL 自体に差し込みが残っていたら送らない
  assert.equal(renderCampaign({ campaign: c, name: 'テスト', offerUrl: 'https://x/{{t}}' }), null);
});

test('通常のキャンペーンは差し込み印を持てない（誤って未解決 URL を配らない）', () => {
  for (const c of CAMPAIGNS) {
    if (c.requiresOfferUrl === true) continue;
    assert.equal(String(c.ctaUrl || '').includes(OFFER_URL_PLACEHOLDER), false,
      `${c.campaignId}: requiresOfferUrl でないのに差し込み印がある`);
  }
  // requiresOfferUrl でないキャンペーンに印を入れても描画できない
  const bad = { ...getCampaign('expired-comeback'), ctaUrl: OFFER_URL_PLACEHOLDER };
  assert.equal(renderCampaign({ campaign: bad, name: 'テスト' }), null);
});

// ── 使用可否（本番化前レビューの結論を固定）──────────────────────
test('CTA が確定していないキャンペーンは使用停止（推測 URL を作らない）', () => {
  const c = getCampaign('sanrenpuku-offer', { includeDisabled: true });
  assert.equal(c.enabled, false, '三連複案内が有効になっている');
  assert.equal(c.ctaUrl, '', '確定していない URL を入れている');
  assert.equal(isCampaignUsable(c), false);
  assert.equal(getCampaign('sanrenpuku-offer'), null, '送信経路から取得できてしまう');
  assert.ok(c.disabledReason, '停止理由が無い');
});

test('初期テンプレートのままのキャンペーンは使用停止', () => {
  const c = getCampaign('general-announcement', { includeDisabled: true });
  assert.equal(c.enabled, false);
  assert.equal(c.isPlaceholderTemplate, true);
  assert.equal(isTemplateConfigured(c).reason, 'template_not_configured');
  assert.equal(getCampaign('general-announcement'), null);
});

test('isTemplateConfigured は件名・本文・CTA の欠落を検知する', () => {
  const base = { campaignId: 'x', subject: 'S', body: 'B', ctaUrl: 'https://analytics.keiba.link/' };
  assert.equal(isTemplateConfigured(base).ok, true);
  assert.equal(isTemplateConfigured({ ...base, subject: '  ' }).reason, 'template_not_configured');
  assert.equal(isTemplateConfigured({ ...base, body: '' }).reason, 'template_not_configured');
  assert.equal(isTemplateConfigured({ ...base, ctaUrl: '' }).reason, 'cta_not_configured');
  assert.equal(isTemplateConfigured(null).ok, false);
});

test('listCampaigns は停止中も理由付きで返す（画面で理由を出せる）', () => {
  const all = listCampaigns({ includeDisabled: true });
  assert.equal(all.length, CAMPAIGNS.length);
  const off = all.filter((c) => !c.usable);
  assert.equal(off.length, 2, '停止中の本数が想定と違う');
  for (const c of off) assert.ok(c.disabledReason, `${c.campaignId} に停止理由が無い`);
  for (const c of all.filter((x) => x.usable)) assert.equal(c.disabledReason, null);
});

// ── 内容ハッシュ（version を上げずに本文を変える事故の検知）────────
test('【version ロック】本文を変えたら version を上げる', () => {
  // 本文・件名・CTA・**見た目の固定値**・**シェルの版**のどれかを変えると
  // このハッシュが変わる（＝届くメールが変わる）。
  //
  //   文面を変えた            → campaign の version を上げてから下表を更新
  //   シェル（組み立て方）を変えた → MARKETING_EMAIL_SHELL_VERSION を上げて下表を更新
  //     （全キャンペーンのハッシュが変わる。campaign の version は据え置きでよい。
  //       DeliveryKey は campaignId × version × 受信者なので、再送は増えない）
  // version を据え置いたまま本文を変えると DeliveryKey が変わらず、
  // 既送信者へ修正版が二度と届かない。
  const LOCKED = {
    // v3（2026-08-09）: 本文は不変（hash 据え置き）。dormant-reactivation v2 の
    // 14,279 件配信前に、正規経路のカナリアを再実行するための版上げ。
    'marketing-canary': { version: 3, hash: '162081596a79ea5a' },
    'expired-comeback': { version: 2, hash: 'e6077db532e76564' },
    'premium-renewal': { version: 2, hash: '1bfa299fb86a339c' },
    'sanrenpuku-offer': { version: 2, hash: '59a115bc1933cb46' },
    'premium-plus-offer': { version: 2, hash: '24d5b10d69335767' },
    'dormant-reactivation': { version: 2, hash: '8bc34393b414464b' },
    'general-announcement': { version: 1, hash: '7e6dc6ed7461489d' },
    // カムバック割引案内。本文は offer カタログから自動生成する（comebackEmailTemplate.js）。
    // CTA は受信者ごとの申込 URL なので、ここでは差し込み印がハッシュに入る。
    'comeback-offer': { version: 2, hash: '86774177e753b2d4' },
    // v1 → v2: 共通 HTML シェルへ載せ替え、件名・プリヘッダー・特典カードを追加。
    // 見た目が大きく変わるので version を上げ、DeliveryKey を v1 と分けた。
    'comeback-light-30d-granted': { version: 2, hash: '23e4b66cba221622' },
    // 無料会員 活性化（2026-08-09 新規）。無料で見られる範囲だけを案内し、
    // 価格・契約の勧誘は書かない。休眠再アプローチとは対象も入口も違う。
    'free-member-activation': { version: 1, hash: '256dfcbb6c06209c' },
    // 連続配信は **ステップごと**にロックする（ステップ単位で DeliveryKey が分かれるため、
    // 1 ステップだけ文面を変えても、そのステップは既送信者へ届かない）。
    'free-to-premium-sequence': {
      version: 1,
      steps: {
        1: 'edd2bb3378a4b0b3',
        2: 'bd1b1bcf6a5f3c56',
        3: '9480d8fa5d6a164b',
        4: '6b60efe50b9a81a5',
      },
    },
  };
  for (const c of CAMPAIGNS) {
    const lock = LOCKED[c.campaignId];
    assert.ok(lock, `${c.campaignId}: version ロックに未登録。追加してください`);
    assert.equal(c.version, lock.version,
      `${c.campaignId}: version が変わっています。LOCKED の version と hash を更新してください`);
    if (lock.steps) {
      // 連続配信: ステップごとのハッシュを固定する
      const steps = getSequenceSteps(c);
      assert.equal(steps.length, Object.keys(lock.steps).length,
        `${c.campaignId}: ステップ数が変わっています。LOCKED を更新してください`);
      for (const s of steps) {
        const effective = resolveSequenceStep(c, s.stepNumber);
        assert.equal(computeCampaignContentHash(effective), lock.steps[s.stepNumber],
          `${c.campaignId} step${s.stepNumber}: 文面が変更されています。**version を上げてから** LOCKED を更新してください`);
      }
      continue;
    }
    assert.equal(computeCampaignContentHash(c), lock.hash,
      `${c.campaignId}: 本文/件名/CTA が変更されています。**version を上げてから** LOCKED を更新してください`);
  }
});

test('内容ハッシュは本文の変更を検知する', () => {
  const c = getCampaign('expired-comeback');
  const h = computeCampaignContentHash(c);
  assert.notEqual(computeCampaignContentHash({ ...c, body: c.body + ' ' }), h);
  assert.notEqual(computeCampaignContentHash({ ...c, subject: 'x' }), h);
  assert.notEqual(computeCampaignContentHash({ ...c, ctaUrl: 'https://analytics.keiba.link/x/' }), h);
  assert.equal(computeCampaignContentHash({ ...c, description: '別の説明' }), h, '説明文は本文ではない');
});

test('本文に配信停止リンクを書かない（送信基盤が自動付与するため二重になる）', () => {
  for (const c of CAMPAIGNS) {
    assert.equal(/配信停止|unsubscribe/i.test(c.body), false, `${c.campaignId} が配信停止リンクを持っている`);
  }
});

test('本文の差し込みは {{salutation}} だけ', () => {
  for (const c of CAMPAIGNS) {
    const placeholders = [...`${c.subject}\n${c.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    for (const p of placeholders) assert.equal(p, 'salutation', `${c.campaignId}: 未対応の差し込み {{${p}}}`);
  }
});

test('【二重敬称の防止】テンプレートで敬称を後付けしない', () => {
  for (const c of CAMPAIGNS) {
    assert.doesNotMatch(c.body, /\{\{\s*salutation\s*\}\}\s*(様|さま|さん|御中)/,
      `${c.campaignId}: 差し込みの後ろに敬称を書いている（「お客様 様」になる）`);
  }
});

test('listCampaigns は本文を返さない（管理画面のセレクト用メタのみ）', () => {
  for (const c of listCampaigns()) {
    assert.equal(c.body, undefined);
    assert.ok(c.campaignId && c.subject && c.name);
  }
});

test('getCampaign は未知 / 無効を null にする（fail closed）', () => {
  assert.equal(getCampaign('does-not-exist'), null);
  assert.equal(getCampaign(''), null);
  assert.equal(getCampaign(null), null);
  assert.equal(getCampaign(undefined), null);
});

// ── 描画 ──────────────────────────────────────────────────────
test('【二重敬称の防止】宛名は render 側で完成させる', () => {
  assert.equal(buildSalutation('山田'), '山田 様');
  assert.equal(buildSalutation(''), 'お客様', '「お客様 様」になっている');
  assert.equal(buildSalutation(null), 'お客様');
  assert.equal(buildSalutation(undefined), 'お客様');
  assert.equal(buildSalutation('お客様'), 'お客様', '既定値に敬称を足している');
  assert.equal(buildSalutation('  山田 太郎 '), '山田 太郎 様');
});

test('全キャンペーンの HTML / text 双方で宛名が正しい', () => {
  for (const c of CAMPAIGNS) {
    const named = renderCampaign({ campaign: c, name: '山田' });
    const anon = renderCampaign({ campaign: c, name: '' });
    for (const [label, r, expected] of [['氏名あり', named, '山田 様'], ['氏名なし', anon, NAME_FALLBACK]]) {
      assert.ok(r, `${c.campaignId} の描画に失敗`);
      assert.ok(r.text.startsWith(expected), `${c.campaignId} text(${label}): ${r.text.slice(0, 20)}`);
      assert.ok(r.html.includes(`>${expected}`), `${c.campaignId} html(${label}) に宛名が無い`);
      // どちらの経路にも二重敬称を出さない
      assert.equal(r.text.includes('お客様 様'), false, `${c.campaignId} text(${label}) が二重敬称`);
      assert.equal(r.html.includes('お客様 様'), false, `${c.campaignId} html(${label}) が二重敬称`);
    }
  }
});

test('氏名由来の HTML / プレースホルダ注入が起きない', () => {
  const c = getCampaign('expired-comeback');
  // 山括弧を含む名前は名前として採用しない（HTML も差し込みも成立しない）
  const r = renderCampaign({ campaign: c, name: '<script>alert(1)</script>' });
  assert.equal(r.html.includes('<script>'), false);
  assert.ok(r.text.startsWith(NAME_FALLBACK));
  // 差し込み記号を含む名前も採用しない
  const r2 = renderCampaign({ campaign: c, name: '{{salutation}}' });
  assert.ok(r2.text.startsWith(NAME_FALLBACK));
  // 送信直前に差し替わる印（配信停止・無料期限・専用 URL）だけは残ってよい。
  // それ以外の `{{ }}` が残っていたら「解決されない差し込み」なので不可。
  assert.equal(stripDeferred(r2.html).includes('{{'), false);
});

test('未解決の差し込みが残る本文は描画しない（fail closed）', () => {
  const broken = { campaignId: 'x', version: 1, subject: 'S', body: 'hello {{unknown}}' };
  assert.equal(renderCampaign({ campaign: broken }), null);
  assert.equal(renderCampaign({}), null);
  assert.equal(renderCampaign({ campaign: null }), null);
});

test('描画結果は subject / html / text をそろえて返す', () => {
  const REAL_OFFER_URL = 'https://analytics.keiba.link/offer/?t=' + 'a'.repeat(32) + '.' + 'b'.repeat(32);
  for (const c of CAMPAIGNS) {
    // 受信者ごとの URL が要るものは、実 URL を与えた状態が「送信される形」
    const offerUrl = c.requiresOfferUrl === true ? REAL_OFFER_URL : undefined;
    const r = renderCampaign({ campaign: c, name: 'テスト', offerUrl });
    assert.ok(r, `${c.campaignId} の描画に失敗`);
    assert.equal(r.subject, c.subject);
    const expectedCta = offerUrl || c.ctaUrl;
    assert.ok(r.html.includes(expectedCta), 'HTML に CTA が無い');
    assert.ok(r.text.includes(expectedCta), 'テキストに CTA が無い');
    // 送信直前の差し替え印を除けば、未解決の差し込みは 1 つも残らない
    assert.equal(stripDeferred(r.html).includes('{{'), false);
    assert.equal(stripDeferred(r.text).includes('{{'), false);
  }
});

test('sanitizeName は改行を畳み、疑わしい記号はフォールバックへ倒す', () => {
  assert.equal(sanitizeName('山\n田'), '山 田', '改行は空白 1 つに畳む');
  assert.equal(sanitizeName(' 山田  太郎 '), '山田 太郎');
  assert.equal(sanitizeName('a'.repeat(100)).length, 40);
  assert.equal(sanitizeName('   '), NAME_FALLBACK);
  assert.equal(sanitizeName(123), NAME_FALLBACK);
  assert.equal(sanitizeName('{{name}}'), NAME_FALLBACK);
  assert.equal(sanitizeName('<b>x</b>'), NAME_FALLBACK);
});

// ── 想定対象（誤爆防止）────────────────────────────────────────
test('カムバック系は期限切れ限定で enforce される', () => {
  const c = getCampaign('expired-comeback');
  assert.equal(c.audienceRule.enforce, true);
  assert.deepEqual(c.audienceRule.contracts, [MK_CONTRACT.EXPIRED]);
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.EXPIRED, plan: MK_PLAN.PREMIUM }).ok, true);
  const active = matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM });
  assert.equal(active.ok, false);
  assert.equal(active.enforced, true);
  assert.equal(active.reason, 'contract_mismatch');
});

test('Premium Plus 案内は三連複保有者限定', () => {
  const c = getCampaign('premium-plus-offer');
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM }).reason, 'plan_mismatch');
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM_SANRENPUKU }).ok, true);
});

test('汎用キャンペーンは制限しないが enforce もしない（停止中でも定義は保つ）', () => {
  const c = getCampaign('general-announcement', { includeDisabled: true });
  assert.equal(c.audienceRule.enforce, false);
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.NONE, plan: MK_PLAN.FREE }).ok, true);
});

test('休眠・無料会員 再アプローチは課金継続中を機械的に除外する', () => {
  const c = getCampaign('dormant-reactivation');
  assert.equal(c.audienceRule.enforce, true, '誰にでも送れる状態のままになっている');
  assert.deepEqual(c.audienceRule.contracts, [MK_CONTRACT.NONE, MK_CONTRACT.EXPIRED]);
  for (const contract of [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON]) {
    const r = matchesCampaignAudience(c, { contract, plan: MK_PLAN.PREMIUM });
    assert.equal(r.ok, false, `${contract} に「ご無沙汰しております」が届く`);
    assert.equal(r.enforced, true);
  }
  assert.equal(matchesCampaignAudience(c, { contract: MK_CONTRACT.NONE, plan: MK_PLAN.FREE }).ok, true);
  // 「長期」を名乗るには根拠フィールドが要るため、名称から外している
  assert.equal(c.name.includes('長期'), false, '長期を判定できる根拠が無いのに名乗っている');
});

test('Premium 再契約は期限切れ / 期限間近のどちらにも成立する中立文面', () => {
  const c = getCampaign('premium-renewal');
  // 「期限が切れています」と断定しない
  assert.equal(/期限切れとなって|失効しました/.test(c.body), false, '期限間近の会員に不自然な断定表現');
  assert.ok(/ご利用状況と継続/.test(c.subject) || /ご利用状況と継続/.test(c.body));
  // 三連複の買い切り権が失効したと読まれない注記がある
  assert.ok(c.body.includes('買い切り'), '買い切り三連複への言及が無い');
  assert.ok(/別に|とは別/.test(c.body), '買い切り分と Premium 期限の区別が書かれていない');
});

test('顧客不明は対象にしない', () => {
  assert.equal(matchesCampaignAudience(getCampaign('general-announcement'), null).ok, false);
});

test('カタログは Premium Plus 販売資格を参照しない（販売と販促を混ぜない）', () => {
  const serialized = JSON.stringify(CAMPAIGNS);
  for (const banned of ['PremiumPlusEligibility', 'eligible', 'blocked', 'LifetimeSanrenpuku', 'PaidAt']) {
    assert.equal(serialized.includes(banned), false, `定義に ${banned} が現れている`);
  }
});
