/**
 * stagedReleaseGuard.test.mjs — Premium Plus 段階公開の配線を source レベルで固定する guard
 *   node --test src/lib/premiumPlus/stagedReleaseGuard.test.mjs
 *
 * 検知したい事故:
 *   - phase 判定が実績（的中 / 不的中）に連動してしまう
 *   - PHASE 1/2 で商品ページが 404 されなくなる（段階公開の迂回）
 *   - 購入 CTA が phase 判定を外れて常時表示に戻る
 *   - 受付 CLOSED でも購入操作ができてしまう
 *   - 商品ページの本文コピーが段階公開の実装ついでに書き換わる
 *   - 三連複会員ページ（静的 HTML）に Premium Plus の文言・価格・リンクが載る（存在秘匿の破れ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 「コメントで言及しているだけ」を誤検知しないようコメントを落とす。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RELEASE_LIB = read('./premiumPlusRelease.js');
const LOOKUP_LIB = read('./purchaseAnchorLookup.js');
const ENDPOINT = read('../../pages/api/premium-plus-stage.json.js');
const TEASER = read('../../components/PremiumPlusStageTeaser.astro');
const PRODUCT_PAGES = {
  'premium-plus.astro': read('../../pages/premium-plus.astro'),
  'premium-plus-v2.astro': read('../../pages/premium-plus-v2.astro'),
};
const SANRENPUKU_PAGES = {
  'premium-sanrenpuku.astro': read('../../pages/premium-sanrenpuku.astro'),
  'premium-sanrenpuku-jra.astro': read('../../pages/premium-sanrenpuku-jra.astro'),
};

// ── 実績と販売タイミングを連動させない ────────────────────────────────
test('phase 判定モジュールは実績台帳を読まない（的中/不的中で phase が動かない）', () => {
  const code = stripComments(RELEASE_LIB);
  assert.doesNotMatch(code, /premiumPlusResults/);
  assert.doesNotMatch(code, /archiveResults/);
  assert.doesNotMatch(code, /isHit|payout/);
  // import は 1 つも持たない純粋モジュール
  assert.doesNotMatch(code, /^\s*import\s/m);
});

test('取得層は Airtable を読むだけ（書き込み系メソッドを持たない）', () => {
  assert.doesNotMatch(LOOKUP_LIB, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i);
  assert.match(LOOKUP_LIB, /Customers/);
});

// ── ページ配線 ────────────────────────────────────────────────────────
for (const [name, src] of Object.entries(PRODUCT_PAGES)) {
  const fm = src.slice(0, src.indexOf('\n---', 3) + 4);

  test(`${name}: 段階公開の単一源を通す`, () => {
    // 2026-07-31: 販売導線（UpsellTarget）と合成するため resolveUpsellForCustomer 経由になった。
    // 内部で resolvePlusMemberFromFields → resolvePremiumPlusRelease を呼ぶ単一源であることは
    // upsellTarget.js 側で固定している（ページが phase を再計算しないことがここでの要点）。
    assert.match(fm, /resolveUpsellForCustomer\s*\(/);
    assert.match(fm, /lookupCustomerFields\s*\(/);
    assert.match(fm, /const ppRelease = ppUpsell\.plusRelease;/);
    // ページ側で phase / route を組み立て直さない
    assert.doesNotMatch(fm, /computePhase\s*\(/);
    assert.doesNotMatch(fm, /resolvePlusRoute\s*\(/);
  });

  test(`${name}: ROUTE B（通常 Premium）も入口に通し、可否は資格 + phase が決める`, () => {
    assert.match(fm, /allowedPlans:\s*PREMIUM_PLUS_CANDIDATE_PLANS/);
    // 入口を広げても eligibility/phase ゲートが後段にあること
    const iAccess = fm.indexOf('PREMIUM_PLUS_CANDIDATE_PLANS');
    const iGate = fm.indexOf('!ppRelease.showProductPage');
    assert.ok(iAccess >= 0 && iGate > iAccess, '入口だけ広げて phase ゲートが無い');
  });

  test(`${name}: 会員判定を Plus 側で再実装していない`, () => {
    // プラン文字列・期限・Status の直接判定をページに書かない（正本は resolveEntitlements）
    assert.doesNotMatch(fm, /LifetimeSanrenpuku/);
    assert.doesNotMatch(fm, /有効期限/);
    assert.doesNotMatch(fm, /canViewSanrenpuku/);
  });

  test(`${name}: PHASE 3 未満は 404（段階公開を迂回できない）`, () => {
    // 販売導線が plus でない会員も同じ 404（2 商品を並べない・存在秘匿）
    assert.match(fm, /if\s*\(ppUpsell\.channel !== UPSELL_CHANNEL\.PLUS \|\| !ppRelease\.showProductPage\)/);
    const gate = fm.slice(fm.indexOf('!ppRelease.showProductPage'));
    // ゲート内で 404 以外に抜けられるのは**受付休止ページ 1 つだけ**。
    // その分岐を含めても、最後は必ず 404 で閉じている。
    const head = gate.slice(0, 2000);
    assert.match(head, /status:\s*404/);
    // 認可ゲートと同じく 401/403 は使わない（存在を漏らさない）
    assert.doesNotMatch(fm, /status:\s*40[13]/);
  });

  test(`${name}: 停止中の会員だけ 404 ではなく受付休止ページ（200）`, () => {
    const gate = fm.slice(fm.indexOf('!ppRelease.showProductPage'));
    const head = gate.slice(0, 2000);
    // 判定はライブラリ側の単一源。ページで停止条件を書き直さない
    assert.match(head, /ppUpsell\.pauseNotice\?\.showPauseNotice === true/, '休止案内の判定を単一源から読んでいない');
    assert.doesNotMatch(head, /SalePaused/, 'ページ側で停止フラグを直接読んでいる');
    // 休止ページは専用レンダラで組む（商品ページの本文を流用しない）
    assert.match(head, /renderPauseNoticeHtml\(/);
    assert.match(head, /status:\s*200/);
    // 休止ページに購入導線を持ち込まない
    const branch = head.slice(0, head.indexOf('status: 404') >= 0 ? head.indexOf('status: 404') : head.length);
    assert.doesNotMatch(branch, /openBankModal|purchaseEnabled|showPurchaseCta|68,?000|98,?000/,
      '受付休止ページの分岐に購入導線・価格が入っている');
  });

  test(`${name}: 購入 CTA は showPurchaseCta でのみ描画される`, () => {
    // 価格表示・購入ボタン・固定 CTA がすべて phase 判定の下にある
    assert.match(src, /ppRelease\.showPurchaseCta\s*\?/);
    assert.match(src, /\{ppRelease\.showPurchaseCta\s*&&/);
    assert.equal(
      (src.match(/onclick="openBankModal\(\)"/g) || []).length,
      (src.match(/onclick="openBankModal\(\)"\s+disabled=\{!ppRelease\.purchaseEnabled\}/g) || []).length,
      '購入ボタンに purchaseEnabled の disabled が付いていないものがある'
    );
  });

  test(`${name}: CLOSED で申込モーダルを開けない（JS 側の二重防御）`, () => {
    assert.match(src, /data-pp-purchase=\{ppRelease\.purchaseEnabled \? '1' : '0'\}/);
    assert.match(src, /PP_PURCHASE_ENABLED\s*=\s*document\.documentElement\.dataset\.ppPurchase === '1'/);
    assert.match(src, /function openBankModal\(\)\s*\{\s*\n?\s*if \(!PP_PURCHASE_ENABLED\) return;/);
  });

  test(`${name}: 受付準備中の文言は単一源から取る（ページに直書きしない）`, () => {
    assert.match(src, /PP_RELEASE_COPY\.preparing\.title/);
    assert.match(src, /PP_RELEASE_COPY\.preparing\.body/);
    assert.doesNotMatch(src, /受付準備中です<|>受付準備中/);
  });

  // 16:30 以降、ティザーが「本日（今日の日付）」のままだと購入ブロックの
  // 「翌日分」と食い違い、どちらを買うのか分からなくなる。単一源 ppSale に寄せる。
  test(`${name}: ティザーの見出し・日付・区分・ボタンは販売対象日（ppSale）から作る`, () => {
    assert.match(src, /const ppTeaser = \(\(\) => \{/);
    assert.match(src, /isToday: ppSale\.date === ppTodayStr/);
    assert.match(src, /\{ppTeaserEyebrow\}/);
    assert.match(src, /\{ppTeaserCta\}/);
    assert.match(src, /\{ppTeaser\.y\}\/\{ppTeaser\.m\}\/\{ppTeaser\.d\}/);
    assert.match(src, /\{ppTeaser\.circuitLabel\}/);
    // 今日基準の値を直接描画に戻さない（16:30 以降にズレる）
    assert.doesNotMatch(src, /\{ppToday\.y\}\/\{ppToday\.m\}\/\{ppToday\.d\}/);
    assert.doesNotMatch(src, /\{ppToday\.isChuo \? '基本：中央' : '基本：南関'\}/);
  });

  test(`${name}: 本文コピーと価格定数が変更されていない`, () => {
    for (const phrase of [
      'const PRICE = 68000;',
      'const LIST_PRICE = 98000;',
      '◆ Premium Sanrenpuku 会員 特別価格',
      '単品購入（サブスクリプションではありません）',
      '入金確認後、AI が厳選した 1 鞍の買い目をお届けします。',
      '🏦 銀行振込で購入する',
      '🔓 本日の1鞍を抽出する',
      '買い切り・追加課金なし',
      // ⚠️ 「基本：」を外して言い切ると、その日の実際の開催場を断定したことになる
      '基本：平日は南関、土日は中央（JRA）。',
      '掲載している画像は、実際に投票した投票内容照会のスクリーンショットです。',
    ]) {
      assert.ok(src.includes(phrase), `本文が失われている: ${phrase}`);
    }
  });
}

// ── エンドポイント（存在秘匿）──────────────────────────────────────
test('stage エンドポイント: 認可 NG と PHASE 1 はどちらも 404', () => {
  assert.match(ENDPOINT, /export const prerender = false/);
  assert.match(ENDPOINT, /verifyPlanAccess\s*\(/);
  assert.match(ENDPOINT, /if \(!access\.ok\) return notFound\(\);/);
  assert.match(ENDPOINT, /if \(!release\.showTeaser\) return notFound\(\);/);
  assert.match(ENDPOINT, /status:\s*404/);
  assert.doesNotMatch(ENDPOINT, /status:\s*40[13]/);
  assert.match(ENDPOINT, /private, no-store/);
});

test('stage エンドポイント: 価格・口座情報を返さない', () => {
  assert.doesNotMatch(stripComments(ENDPOINT), /68,?000|98,?000|PRICE|振込|口座/);
});

test('stage エンドポイント: 商品ページ URL は PHASE 3 以降だけ返す', () => {
  assert.match(ENDPOINT, /release\.phase >= PP_PHASE\.PREVIEW \? PRODUCT_HREF : null/);
});

// ── PHASE 4 受付時間（2026-07-30 確定仕様）────────────────────────
test('受付時間は単一源のみ。ページ・API に時刻分岐を重複実装しない', () => {
  for (const [name, src] of [...Object.entries(PRODUCT_PAGES), ['stage API', ENDPOINT]]) {
    const code = stripComments(src);
    assert.doesNotMatch(code, /12:30|16:30|14:59|16:29/, `${name}: 時刻がベタ書きされている`);
    assert.doesNotMatch(code, /computeIntakeStatus/, `${name}: 受付判定を自前で呼んでいる`);
    assert.doesNotMatch(code, /PP_INTAKE_SCHEDULE/, `${name}: スケジュール定数を直接参照している`);
    assert.doesNotMatch(code, /残りわずか|まもなく受付終了|本日分 受付中/, `${name}: 受付文言がベタ書きされている`);
  }
});

test('受付判定は開催区分に依存しない（サーキット分岐の復活を禁止）', () => {
  const code = stripComments(RELEASE_LIB);
  const fn = code.slice(code.indexOf('export function computeIntakeStatus'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.doesNotMatch(body, /circuit|CHUO|NANKAN/, '受付判定にサーキット分岐が残っている');
  assert.doesNotMatch(code, /PP_INTAKE_WINDOW/, '旧サーキット別スケジュールが残っている');
});

test('「残りわずか」を件数・在庫・販売上限と連動させない', () => {
  const code = stripComments(RELEASE_LIB);
  assert.doesNotMatch(code, /soldCount|remainingSlots|stock|inventory|capacity|quota|salesLimit|maxSales/i);
  // limited の判定は時刻のみ（スケジュール定数以外の入力を持たない）
  const fn = code.slice(code.indexOf('export function computeIntakeStatus'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /PP_INTAKE_SCHEDULE\.limitedFromMin/);
});

test('purchaseEnabled は CLOSED のときだけ false（翌日分は NEXT_DAY_OPEN が担う）', () => {
  // 2026-08-13〜: 受付締切で「売らない」のではなく、対象日が翌日へ切り替わる。
  // 買えない時間帯を作らないため、CLOSED を購入不可の条件に戻さないこと。
  // CLOSED は「売らない」状態のまま。翌日分は専用状態 NEXT_DAY_OPEN が担う。
  // CLOSED を購入可に読み替えると fail closed の判定が消えるので禁止。
  const code = stripComments(RELEASE_LIB);
  assert.match(code, /purchaseEnabled:\s*isSale && intake !== PP_INTAKE\.CLOSED/);
  assert.match(code, /NEXT_DAY_OPEN/, '翌日分の専用状態が無い');
});

// ── 管理者プレビュー（read-only・会員セッションを作らない）────────
const PREVIEW_LIB = read('./premiumPlusPreview.js');

test('プレビュー: 会員セッション / ログインリンク / メールを扱わない', () => {
  for (const [name, src] of [['preview lib', PREVIEW_LIB], ['admin fn', ADMIN_FN], ['admin page', ADMIN_PAGE]]) {
    const code = stripComments(src);
    assert.doesNotMatch(code, /ak_session|issuePaidSessionCookie|serializeSessionCookie|createSession/i, `${name}: セッション発行`);
    assert.doesNotMatch(code, /Set-Cookie|document\.cookie/i, `${name}: Cookie 操作`);
    assert.doesNotMatch(code, /magic|send-magic-link|sendgrid|mail\/send/i, `${name}: ログインリンク/メール`);
  }
});

test('プレビュー: 書き込み用フィールドを組み立てない（完全 read-only）', () => {
  const code = stripComments(PREVIEW_LIB);
  assert.doesNotMatch(code, /buildEligibilityUpdateFields|buildAdminActionFields|buildSanrenpukuPlusInitFields/);
  assert.doesNotMatch(code, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i);
  // 判定は単一源に委譲する
  assert.match(code, /resolvePremiumPlusRelease/);
  assert.match(code, /resolvePlusMemberFromFields/);
  assert.match(code, /describeReleaseState/);
  assert.match(code, /intakeCopy/);
});

test('プレビュー: phase / intake 判定を複製していない', () => {
  const code = stripComments(PREVIEW_LIB);
  assert.doesNotMatch(code, /PP_PHASE_START_DAY\.\w+\s*<=|minutesOfDay/, 'phase/intake を自前計算している');
  assert.doesNotMatch(code, /12\s*\*\s*60\s*\+\s*30|closedFromMin\s*=/, '受付境界を再定義している');
});

test('プレビュー: preview action は Airtable を GET しかしない', () => {
  const fn = stripComments(ADMIN_FN);
  const seg = fn.slice(fn.indexOf('async function handlePreview'));
  assert.ok(seg.length > 0, 'handlePreview が無い');
  assert.doesNotMatch(seg, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i);
  assert.match(seg, /buildPreviewSnapshot\(/);
});

test('プレビュー: 管理者認証（x-admin-secret）を必須にする', () => {
  const fn = stripComments(ADMIN_FN);
  const iAuth = fn.indexOf('provided !== SECRET');
  const iPreview = fn.indexOf("action === 'preview'");
  assert.ok(iAuth >= 0 && iPreview > iAuth, '認可チェックより前に preview 分岐がある');
});

test('プレビューの時刻 override が会員向け経路へ漏れていない', () => {
  for (const [name, src] of [...Object.entries(PRODUCT_PAGES), ['stage API', ENDPOINT]]) {
    const code = stripComments(src);
    assert.doesNotMatch(code, /atMin|phaseDaysAgo|buildPreviewSnapshot|resolvePreviewNowMs/, `${name}: プレビュー用の入力を受け付けている`);
    assert.match(code, /nowMs:\s*(ppNow|now)\b/, `${name}: 現在時刻以外で解決している`);
  }
});

test('管理画面に「管理者プレビュー / 実顧客には影響しません」の明示がある', () => {
  assert.match(ADMIN_PAGE, /管理者プレビュー \/ 実顧客には影響しません/);
  assert.match(ADMIN_PAGE, /表示プレビュー/);
});

// ── 静的な三連複会員ページに Premium Plus を載せない ────────────────
test('予告コンポーネント: 静的マークアップに商品名・価格・リンクを持たない', () => {
  const body = TEASER.slice(TEASER.indexOf('\n---', 3) + 4); // frontmatter の説明コメントを除く
  assert.doesNotMatch(body, /68,?000|98,?000|¥/);
  assert.doesNotMatch(body, /Premium Plus/);
  assert.doesNotMatch(body, /href="\/premium-plus/);
  // 文言は SSR から取得する
  assert.match(body, /fetch\('\/api\/premium-plus-stage\.json'/);
});

// ── 決済 confirm（Plus 初期化が既存フローを壊さない）──────────────
const CONFIRM_FN = read('../../../netlify/functions/confirm-bank-payment.js');
const ADMIN_FN = read('../../../netlify/functions/premium-plus-eligibility.js');

test('confirm: Plus 初期化は昇格 PATCH の成功後に、独立した PATCH で行う', () => {
  const iPromote = CONFIRM_FN.indexOf('fields: confirmation.fields');
  const iPlus = CONFIRM_FN.indexOf('buildSanrenpukuPlusInitFields({'); // import 行ではなく呼び出し
  assert.ok(iPromote >= 0, '昇格 PATCH が見つからない');
  assert.ok(iPlus > iPromote, 'Plus 初期化が昇格 PATCH より前にある');
  // 同一 PATCH に混ぜない（混ぜると Plus フィールド起因で昇格ごと落ちる）
  assert.doesNotMatch(CONFIRM_FN, /\.\.\.confirmation\.fields[\s\S]{0,80}PremiumPlusEligibility/);
});

test('confirm: Plus 初期化の失敗で昇格・メールを巻き戻さない', () => {
  const seg = CONFIRM_FN.slice(CONFIRM_FN.indexOf('Step 4.5'), CONFIRM_FN.indexOf('Step 5'));
  assert.match(seg, /try\s*\{/);
  assert.match(seg, /catch/);
  // 例外を再送出したり 500 を返したりしない
  assert.doesNotMatch(seg, /throw\s/);
  assert.doesNotMatch(seg, /return\s+jsonResponse\(/);
});

test('confirm: Plus 初期化は三連複昇格時のみ・env gate 付き', () => {
  assert.match(CONFIRM_FN, /isSanrenpukuPromotion\s*&&\s*isPlusFieldsEnabled\(process\.env\)/);
  assert.match(CONFIRM_FN, /confirmation\.fields\['LifetimeSanrenpuku'\] === true/);
});

test('confirm: 自動で eligible にしない（review 初期化のみ）', () => {
  assert.doesNotMatch(stripComments(CONFIRM_FN), /['"]eligible['"]/);
});

// ── 管理 Function（販売資格だけを変える）──────────────────────────
test('管理 Function: Plus 専用フィールド以外を書かない', () => {
  const code = stripComments(ADMIN_FN);
  assert.match(code, /assertOnlyPlusFields\s*\(/);
  for (const f of ['プラン', '有効期限', 'LifetimeSanrenpuku', 'PaymentEmailSent', 'PaymentEmailStatus']) {
    assert.doesNotMatch(code, new RegExp(`['"\`]${f}['"\`]\\s*:`), `${f} を書いている`);
  }
});

test('管理 Function: 変更前の資格を Airtable から読んでから PATCH する（anchor 判定に必須）', () => {
  const code = stripComments(ADMIN_FN);
  assert.match(code, /current:\s*currentFields\[PP_ELIGIBILITY_FIELDS\.STATUS\]/);
  const iGet = code.indexOf('currentFields');
  const iPatch = code.indexOf("method: 'PATCH'");
  assert.ok(iGet >= 0 && iGet < iPatch, '変更前の値を読まずに PATCH している');
  // クライアント申告の current を信用しない
  assert.doesNotMatch(code, /current:\s*req\./);
});

const MEMBER_LIB = read('./premiumPlusMember.js');

test('anchor は EligibleAt のみ。監査用 UpdatedAt を phase に使わない', () => {
  const code = stripComments(MEMBER_LIB);
  assert.match(code, /eligibleAtMs:\s*toPaidAtMs\(f\[PP_ELIGIBILITY_FIELDS\.ELIGIBLE_AT\]\)/);
  assert.doesNotMatch(code, /PP_ELIGIBILITY_FIELDS\.UPDATED_AT/);
});

test('EligibleAt は eligible への実遷移でだけ書く（再保存・メモ編集で phase を戻さない）', () => {
  const code = stripComments(read('./premiumPlusEligibility.js'));
  assert.match(code, /nextStatus === PP_ELIGIBILITY\.ELIGIBLE\s*&&\s*currentStatus !== PP_ELIGIBILITY\.ELIGIBLE/);
  assert.match(code, /if \(isTransitionToEligible\)/);
  // 初期化（review）で anchor を作らない
  const init = code.slice(code.indexOf('buildSanrenpukuPlusInitFields'), code.indexOf('buildEligibilityUpdateFields'));
  assert.doesNotMatch(init, /ELIGIBLE_AT/);
});

test('管理 Function: 資格変更でメール・LINE・通知を送らない', () => {
  assert.doesNotMatch(ADMIN_FN, /sendgrid|sendMail|mail\/send|line\/|notify/i);
});

test('管理 Function: 認可（x-admin-secret）と書き込み gate がある', () => {
  assert.match(ADMIN_FN, /PREMIUM_PLUS_ADMIN_SECRET/);
  assert.match(ADMIN_FN, /provided !== SECRET/);
  assert.match(ADMIN_FN, /isPlusFieldsEnabled\(process\.env\)/);
});

test('管理 Function: 自動で eligible にする分岐が無い（管理者の明示操作のみ）', () => {
  const code = stripComments(ADMIN_FN);
  // 代入（= PP_ELIGIBILITY.ELIGIBLE）は禁止。比較（=== ...）は集計に使うので許可する
  assert.doesNotMatch(code, /(?<![=!])=\s*PP_ELIGIBILITY\.ELIGIBLE/);
  assert.match(code, /buildAdminActionFields\(/);
});

// ── 「今すぐ販売可」（override）の配線 ────────────────────────────
const ADMIN_PAGE = read('../../pages/admin/premium-plus-eligibility.astro');

test('override: 3 面（premium-plus / premium-plus-v2 / stage API）が同じ単一源で判定する', () => {
  // 3 面とも resolveUpsellForCustomer を通す。この中で member アダプタ →
  // resolvePremiumPlusRelease({ ...member }) を呼ぶので override も自動的に同じ扱いになる。
  for (const src of [...Object.values(PRODUCT_PAGES), ENDPOINT]) {
    assert.match(src, /resolveUpsellForCustomer\s*\(/, '単一源を経由していない');
    assert.doesNotMatch(src, /resolvePremiumPlusRelease\s*\(/, 'ページ/API 側で release を組み立て直している');
  }
  // 単一源の中身: member をそのまま渡している（override が落ちない）
  const upsellLib = readFileSync(fileURLToPath(new URL('../upsell/upsellTarget.js', import.meta.url)), 'utf8');
  assert.match(upsellLib, /resolvePremiumPlusRelease\(\{\s*\n?\s*\.\.\.member/, 'member をそのまま渡していない（override が落ちる）');
  // ページ側に override の独自解釈を書かない
  for (const src of Object.values(PRODUCT_PAGES)) {
    assert.doesNotMatch(src, /phase4/);
    assert.doesNotMatch(src, /ReleaseOverride/);
  }
});

test('override: eligibility を迂回できない優先順位になっている', () => {
  const code = stripComments(RELEASE_LIB);
  // blocked は最優先で打ち切る（override でも管理者の明示指定でも免除しない）
  const iBlocked = code.indexOf('normalizedEligibility === PP_ELIGIBILITY.BLOCKED');
  const iElig = code.indexOf('normalizedEligibility !== PP_ELIGIBILITY.ELIGIBLE');
  const iOverride = code.indexOf('overrideApplied =');
  assert.ok(iBlocked >= 0, 'blocked の打ち切りが無い');
  assert.ok(iElig > iBlocked, 'blocked より先に eligible 判定をしている');
  assert.ok(iOverride > iElig, 'override 判定が eligibility ゲートより前にある');
  // review / 未設定を免除できるのは **管理者の明示指定（UpsellTarget=plus）だけ**。
  // override（今すぐ販売可）では免除しない＝ auto の意味を変えない。
  assert.match(code, /const adminSaleDirective = adminPlusAuthorized === true;/);
  assert.match(code, /!adminSaleDirective && normalizedEligibility !== PP_ELIGIBILITY\.ELIGIBLE/);
  assert.doesNotMatch(code, /overrideApplied[^\n]*\|\|[^\n]*normalizedEligibility/,
    'override が eligibility を迂回している');
  // phase の即時化は override か明示指定のときだけ
  assert.match(code, /\(overrideApplied \|\| adminSaleDirective\)\s*\n?\s*\? PP_PHASE\.SALE\s*\n?\s*: computePhase/);
});

test('明示指定（UpsellTarget=plus）は Airtable の eligibility 値を書き換えない', () => {
  // resolver は判定上そう扱うだけ。フィールドへ書く経路はこのモジュールに存在しない。
  const code = stripComments(RELEASE_LIB);
  assert.doesNotMatch(code, /method:\s*['"]PATCH['"]/i);
  assert.doesNotMatch(code, /api\.airtable\.com/);
  // 管理 Function 側も eligibility を書かない（setUpsell は UpsellTarget 1 列のみ）
  const fn = stripComments(ADMIN_FN);
  const start = fn.indexOf('async function handleSetUpsell');
  const end = fn.indexOf('async function handlePreview');
  assert.ok(start > 0 && end > start);
  const body = fn.slice(start, end);
  assert.doesNotMatch(body, /PP_ELIGIBILITY_FIELDS/, 'setUpsell が販売資格フィールドを触っている');
});

test('override: 日時の偽装で実現していない（EligibleAt / SanrenpukuPaidAt を書き換えない）', () => {
  const code = stripComments(read('./premiumPlusEligibility.js'));
  // ⚠️ **その関数だけ**を切り出す。ファイル末尾まで見ると、後ろに足された別の関数
  //    （buildSalePauseFields 等）の記述まで拾って誤検知する。
  const start = code.indexOf('export function buildAdminActionFields');
  assert.ok(start > 0, 'buildAdminActionFields が無い');
  const rest = code.slice(start + 'export function'.length);
  const nextExport = rest.indexOf('\nexport ');
  const fn = nextExport < 0 ? rest : rest.slice(0, nextExport);
  assert.doesNotMatch(fn, /SANRENPUKU_PAID_AT_FIELD/);
  assert.doesNotMatch(fn, /ELIGIBLE_AT/);
});

test('override: 管理 Function は 4 操作のみ受け付け、未有効なら 503', () => {
  const code = stripComments(ADMIN_FN);
  assert.match(code, /isReleaseOverrideEnabled\(process\.env\)/);
  assert.match(code, /PP_ADMIN_ACTION\.IMMEDIATE\s*&&\s*!overrideFieldEnabled/);
  assert.match(code, /return json\(503/);
  assert.match(code, /buildAdminActionFields\(/);
  // 変更前 override も Airtable から読む（クライアント申告を信用しない）
  assert.match(code, /currentOverride:\s*currentFields\[PP_ELIGIBILITY_FIELDS\.OVERRIDE\]/);
  assert.doesNotMatch(code, /currentOverride:\s*req\./);
});

test('override: 管理画面に確認ダイアログと二重送信対策がある', () => {
  assert.match(ADMIN_PAGE, /window\.confirm\(/);
  assert.match(ADMIN_PAGE, /この会員は即時PHASE 4となり、価格と購入CTAが表示されます。/);
  assert.match(ADMIN_PAGE, /dataset\.busy === '1'\) return/);
  assert.match(ADMIN_PAGE, /buttons\.forEach\(\(x\) => \{ x\.disabled = true; \}\)/);
});

test('override: 管理画面に 4 ボタンと日本語の状態表示がある', () => {
  for (const label of ['段階公開で販売可', '今すぐ販売可', '保留', '販売対象外']) {
    assert.ok(ADMIN_PAGE.includes(label), `ボタンが無い: ${label}`);
  }
  assert.match(ADMIN_PAGE, /r\.state/);
  // 状態文言の単一源（describeReleaseState）を Function 側で使う
  assert.match(ADMIN_FN, /describeReleaseState\(/);
});

for (const [name, src] of Object.entries(SANRENPUKU_PAGES)) {
  test(`${name}: 静的 HTML に Premium Plus の価格・商品リンクを出さない`, () => {
    // frontmatter（過去の経緯コメントに 68000 の記述がある）を除いたテンプレート本体を検査する
    const body = src.slice(src.indexOf('\n---', 3) + 4);
    assert.doesNotMatch(body, /68,?000|98,?000/);
    assert.doesNotMatch(body, /href="\/premium-plus/);
    assert.match(body, /<PremiumPlusStageTeaser \/>/);
  });
}
