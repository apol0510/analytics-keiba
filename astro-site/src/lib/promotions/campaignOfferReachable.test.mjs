/**
 * campaignOfferReachable.test.mjs — 案内した割引が**実際に買える**ことを突き合わせる
 *
 * ## なぜ要るか（2026-08-24 に本番で 2 件やった）
 *
 * 1. 三連複の申込先を `/premium-sanrenpuku/` にしたが、そこは
 *    **すでに持っている人だけが開ける会員ページ**で、Premium の方は
 *    302 → `/login/?r=not_entitled` に飛ばされた
 * 2. 三連複の価格を `/premium-sanrenpuku/` の表示（¥19,820/月）から取ったが、
 *    **実際に売っているのは買い切り ¥78,000**（`openBankModal('Premium Sanrenpuku Lifetime', 78000, 'lifetime')`）。
 *    存在しない商品の価格を案内し、PlanType も違うので割引は一生適用されない
 *
 * どちらも「自分が書いた値を自分で確認するテスト」しか無かったせいで素通りした。
 *
 * ## このテストがすること
 *
 * サイトの**実際の購入ボタン**（`openBankModal('商品名', 金額, '期間')`）を全部集めて、
 * 有効なキャンペーン割引が**そのどれかと一致する**ことを確かめる。
 * 商品名・通常価格・課金サイクルの 3 つが揃わなければ落とす。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { listCampaignOffers } from './campaignOffers.js';
import { resolveOffer } from './promotionOfferCatalog.js';

const PAGES_DIR = fileURLToPath(new URL('../../pages/', import.meta.url));

/** 申込 Function と同じ正規化（productName → RequestedPlan / RequestedPlanType）*/
function derivePlan(productName) {
  const full = String(productName).replace(/\s*\(.*\)$/, '').trim();
  let planType = 'Monthly';
  if (full.includes('Lifetime') || full.includes('買い切り')) planType = 'Lifetime';
  else if (full.includes('Annual') || full.includes('年払い')) planType = 'Annual';
  else if (full.includes('Monthly') || full.includes('30日')) planType = 'Monthly';
  let planName = full
    .replace(/\s*\(Standard Upgrade\)/, '')
    .replace(/\s*-\s*Campaign/, '')
    .replace(/\s*\(ライト\)/, '')
    .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')
    .trim();
  if (['Standard', 'standard', 'ライト', 'light'].includes(planName)) planName = 'Light';
  return { planName, planType, raw: full };
}

/** サイト中の購入ボタンを集める */
function collectPurchaseButtons() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}${e.name}`;
      if (e.isDirectory()) { walk(`${full}/`); continue; }
      if (!e.name.endsWith('.astro')) continue;
      const src = readFileSync(full, 'utf8');
      const re = /openBankModal\(\s*'([^']+)'\s*,\s*(\d+)\s*,\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(src))) {
        out.push({ productName: m[1], price: Number(m[2]), term: m[3], file: e.name });
      }
    }
  };
  walk(PAGES_DIR);
  return out;
}

const BUTTONS = collectPurchaseButtons();

test('前提: サイトに購入ボタンが見つかる（見つからなければ検査が素通りする）', () => {
  assert.ok(BUTTONS.length >= 4, `購入ボタンが ${BUTTONS.length} 件しか無い`);
});

test('案内している割引は、すべて実際に売っている商品と一致する', () => {
  const offers = listCampaignOffers();
  assert.ok(offers.length > 0, '有効なキャンペーンが 1 つも無い');

  for (const def of offers) {
    const o = resolveOffer(def.offerId).offer;
    const hit = BUTTONS.filter((b) => {
      const d = derivePlan(b.productName);
      return d.planName === o.applyPlanName && d.planType === o.applyPlanType;
    });
    assert.ok(hit.length > 0,
      `${o.offerId}: 「${o.applyPlanName} / ${o.applyPlanType}」を売っているボタンがサイトに無い。`
      + `存在しない商品を案内している`);

    // 通常価格も一致していること（違う価格を案内しない）
    const samePrice = hit.some((b) => b.price === o.regularPrice);
    assert.ok(samePrice,
      `${o.offerId}: 通常価格 ¥${o.regularPrice} で売っているボタンが無い。`
      + `サイトの価格は ${[...new Set(hit.map((b) => b.price))].map((p) => `¥${p}`).join(' / ')}`);
  }
});

test('割引後の価格は通常価格より安い（当たり前を機械で確かめる）', () => {
  for (const def of listCampaignOffers()) {
    const o = resolveOffer(def.offerId).offer;
    assert.ok(o.offerPrice < o.regularPrice, `${o.offerId}: 割引後の方が高い`);
    assert.ok(o.offerPrice > 0, `${o.offerId}: 0 円以下`);
  }
});

test('停止した割引は案内に出ない（誤った価格を出し続けない）', () => {
  // ⚠️ 三連複は「実際に売っている商品と価格が違う」ため停止中（2026-08-24）。
  //    正しい値が決まるまで、案内にも申込にも出てはいけない。
  const ids = listCampaignOffers().map((o) => o.offerId);
  assert.ok(!ids.includes('campaign-sanrenpuku-monthly-5000off'),
    '停止したはずの三連複割引が案内に出ている');
});

test('三連複の実売は買い切り（停止の前提。変わったら気づけるようにする）', () => {
  const sanrenpuku = BUTTONS.filter((b) => derivePlan(b.productName).planName === 'Premium Sanrenpuku');
  assert.ok(sanrenpuku.length > 0, '三連複の購入ボタンが見つからない');
  for (const b of sanrenpuku) {
    assert.equal(derivePlan(b.productName).planType, 'Lifetime',
      `三連複に月額が現れた（${b.productName}）。停止の前提が変わったので割引を見直すこと`);
  }
  assert.ok(sanrenpuku.some((b) => b.price === 78000),
    `三連複の価格が変わった: ${sanrenpuku.map((b) => b.price).join(',')}`);
});
