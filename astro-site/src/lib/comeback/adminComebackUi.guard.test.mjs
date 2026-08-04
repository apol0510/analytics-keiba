/**
 * adminComebackUi.guard.test.mjs — カムバック特典タブの UI 契約
 *   node --test src/lib/comeback/adminComebackUi.guard.test.mjs
 *
 * 画面は prerender=true の静的ページなので、配信される HTML/JS = このソースそのもの。
 * 「操作は簡単・内部は fail closed・メールとは分離」を UI 側でも壊さないよう固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));
const CB_BLOCK = SCRIPT.slice(SCRIPT.indexOf('カムバック特典（無料 entitlement の付与）'));

test('3 つのタブが並存する（既存 2 タブを壊していない）', () => {
  for (const id of ['tabSales', 'tabMkt', 'tabCb', 'paneSales', 'paneMkt', 'paneCb']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(CB_BLOCK.length > 2000, 'カムバック特典ブロックが見つからない');
});

test('専用 API を叩く（販売資格 API / マーケティング API を流用しない）', () => {
  assert.ok(CB_BLOCK.includes("CB_API = '/.netlify/functions/admin-comeback-grants'"));
  // カムバック側の呼び出しは必ず cbCall
  assert.equal(/[^b]\bcall\(\{\s*action:/.test(CB_BLOCK), false, '販売資格 API を呼んでいる');
  assert.equal(CB_BLOCK.includes('mkCall({'), false, 'マーケティング API を呼んでいる');
  assert.equal(CB_BLOCK.includes('MKT_API'), false);
});

test('特典タブから販売資格・キャンペーン送信の payload を送らない', () => {
  for (const banned of ['plusAction', "action: 'update'", "action: 'send'", 'campaignId', 'PremiumPlusEligibility:']) {
    assert.equal(CB_BLOCK.includes(banned), false, `${banned} を送っている`);
  }
});

test('特典付与とメール送信を 1 操作に結合しない', () => {
  // 実行ハンドラの中でメール送信 action を呼ばない
  assert.equal(/action:\s*'apply'[\s\S]{0,600}action:\s*'send'/.test(CB_BLOCK), false,
    '実行の直後にメール送信を呼んでいる');
  // 文面プレビューは preview action だけ（送信 action を持たない）
  assert.ok(CB_BLOCK.includes("action: 'preview'"));
  // 画面上でも「メールは送信されない」と明示する
  assert.ok(PAGE.includes('この操作でメールは送信されません'));
  assert.ok(CB_BLOCK.includes('メールは送信されません'));
});

test('Light と Premium を独立に選べる（Light は Premium の fallback ではないと明示）', () => {
  for (const id of ['cbLightOffer', 'cbPremiumOffer']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  const lead = PAGE.slice(PAGE.indexOf('id="cbLightOffer"'), PAGE.indexOf('id="cbPremiumOffer"'));
  assert.match(lead, /メイン買い目のみ閲覧できる独立プラン/);
  assert.match(lead, /Premium 終了後の代替ではありません/);
});

test('任意期限・任意価格の入力欄があり、選んだときだけ出る', () => {
  for (const id of ['cbLightDays', 'cbPremiumDays', 'cbPremiumPrice']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(CB_BLOCK, /\$\('cbLightDaysWrap'\)\.hidden = !\(lightOpt && lightOpt\.dataset\.customDays\)/);
  assert.match(CB_BLOCK, /\$\('cbPremiumPriceWrap'\)\.hidden = !\(premiumOpt && premiumOpt\.dataset\.customPrice\)/);
});

test('価格（通常 / 割引率 / 特別価格 / 無料）を画面で確認できる', () => {
  assert.ok(PAGE.includes('id="cbPriceBox"'));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '通常価格'"));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '割引率'"));
  assert.ok(CB_BLOCK.includes("kvRow(dl, '特別価格'"));
  assert.ok(CB_BLOCK.includes('無料（課金は発生しません）'));
});

test('割引は「権限を付与しない」と画面で明示する', () => {
  assert.ok(CB_BLOCK.includes('購入条件のみ（支払い完了まで権限は付与されません）'));
  assert.ok(CB_BLOCK.includes('付与しません（支払い完了後に既存の入金確認フローが昇格します）'));
  assert.ok(CB_BLOCK.includes('権限は付与されません'));
});

test('専用 URL は実行応答からだけ表示する（推測 URL を作らない）', () => {
  assert.ok(CB_BLOCK.includes('out.offerTokens'));
  assert.equal(/https:\/\/analytics\.keiba\.link\/offer/.test(CB_BLOCK), false,
    'UI 側で offer URL を組み立てている');
});

test('一覧の checkbox 一括操作がそろっている', () => {
  for (const id of ['cbSelAll', 'cbSelNone', 'cbSelCount']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(CB_BLOCK.includes('cbSelected.clear()'));
  assert.ok(CB_BLOCK.includes('cbSelected.add(r.recordId)'));
});

test('絶対除外の顧客は選択できない（UI 側でも fail closed）', () => {
  // Step 2 は**絶対除外だけ**で選択可否を決める（退会・課金停止は選べる）。
  // 特典ごとの可否は Step 3 で判定し、選択済みから外す。
  assert.match(CB_BLOCK, /cb\.disabled = !r\.selectable/);
  assert.match(CB_BLOCK, /if \(r\.selectable\) cbSelected\.add\(r\.recordId\)/, '全選択が選択不可まで拾っている');
  assert.ok(CB_BLOCK.includes('cbPruneSelectionForOffer'), 'Step 3 の再判定が無い');
});

test('実行ボタンは gate OFF / 0 件では押せない', () => {
  assert.match(CB_BLOCK, /btn\.disabled = !plan\.writeEnabled \|\| total === 0/);
  assert.match(CB_BLOCK, /btn\.disabled = !cbWriteEnabled \|\| plan\.willRevoke === 0/);
});

test('dry-run を経ずに実行できない（fingerprint と operationId を必ず渡す）', () => {
  const applyCall = CB_BLOCK.slice(CB_BLOCK.indexOf("action: 'apply'"));
  assert.ok(applyCall.includes('planFingerprint: plan.planFingerprint'), 'fingerprint を渡していない');
  // operationId は dry-run のものをそのまま使う（再実行しても二重付与しない）
  assert.ok(applyCall.includes('operationId: cbState.dryRun.operationId'), 'operationId を渡していない');
});

test('二重クリック防止がある', () => {
  const busyGuards = (CB_BLOCK.match(/dataset\.busy === '1'/g) || []).length;
  assert.ok(busyGuards >= 2, '付与・取り消しの両方に二重クリック防止が無い');
});

test('実行前に件数入りの最終確認を出す', () => {
  assert.ok(CB_BLOCK.includes('window.confirm'));
  assert.match(CB_BLOCK, /無料特典を付与: ' \+ plan\.willGrant/);
  assert.match(CB_BLOCK, /割引オファーを発行: ' \+ plan\.willOffer/);
});

test('現在 → 付与後 の before/after を表示する', () => {
  assert.ok(CB_BLOCK.includes("'現在: ' + p.before"));
  assert.ok(CB_BLOCK.includes("'付与後: ' + p.after"));
  assert.ok(CB_BLOCK.includes('顧客ごとの変更（現在 → 付与後）'));
});

test('要求されたフィルターがそろっている', () => {
  // 「現在の特典」は廃止し、**現在の無料付与**と**無料付与履歴**の 2 つへ分けた
  for (const id of ['cbContract', 'cbPlan', 'cbWithdrawn',
    'cbGrantNow', 'cbGrantHistory', 'cbGrantable', 'cbHistory']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} フィルターが無い`);
  }
  assert.equal(PAGE.includes('id="cbPromo"'), false, '曖昧な「現在の特典」が残っている');
});

test('画面文言が「権限は変えるがメール・課金は変えない」ことを明示する', () => {
  const lead = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="cbSummary"'));
  assert.ok(lead.includes('特典専用フィールドだけ'));
  assert.ok(lead.includes('Premium Plus 販売資格は一切変更しません'));
});

/* ── 発行済み割引オファーの取り消し UI（誤発行の救済） ──────────── */

test('offer 取り消しは一覧 → dry-run → 最終実行の 3 段になっている', () => {
  for (const id of ['cbOfferLoad', 'cbOfferRows', 'cbOfferCount', 'cbOfferEmpty']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(CB_BLOCK.includes("action: 'offerList'"));
  assert.ok(CB_BLOCK.includes("action: 'offerRevokeDryRun'"));
  assert.ok(CB_BLOCK.includes("action: 'offerRevoke'"));
  // dry-run を経ずに実行できない（fingerprint を必ず渡す）
  assert.ok(CB_BLOCK.includes('offerFingerprint: plan.offerFingerprint'));
  // 実行前に確認ダイアログを出す
  assert.ok(/このオファーを取り消します/.test(CB_BLOCK));
  // 二重クリック防止
  const start = CB_BLOCK.indexOf('async function cbOfferRevokeStart');
  const body = CB_BLOCK.slice(start, CB_BLOCK.indexOf('前回操作の突合', start));
  assert.ok(body.includes("btn.dataset.busy === '1'"), '二重クリック防止が無い');
});

test('取り消しボタンは issued にだけ出す（誤操作防止）', () => {
  assert.ok(CB_BLOCK.includes('if (r.canRevoke)'), 'canRevoke で出し分けていない');
  // canRevoke が false の行はボタンを作らず「—」を出す
  const i = CB_BLOCK.indexOf('if (r.canRevoke)');
  const seg = CB_BLOCK.slice(i, i + 700);
  assert.ok(seg.includes("textContent = '取り消す'"));
  assert.ok(seg.includes("sp.textContent = '—'"), 'ボタン以外の代替表示が無い');
});

test('要求された項目を表示する（種別 / 対象 / 期間 / 通常価格 / offer 価格 / 状態 / 期限）', () => {
  const pane = PAGE.slice(PAGE.indexOf('発行済み割引オファー'));
  for (const th of ['オファー種別', '対象', '期間', '通常価格', 'オファー価格', '状態', '有効期限']) {
    assert.ok(pane.includes(`<th>${th}</th>`), `列 ${th} が無い`);
  }
  for (const k of ['offerId', 'targetTier', 'billingTerm', 'regularPrice', 'offerPrice', 'status', 'expiresAt']) {
    assert.ok(CB_BLOCK.includes(`o.${k}`) || CB_BLOCK.includes(`r.${k}`), `${k} を表示していない`);
  }
});

test('PII / token / TokenHash を画面に出さない', () => {
  const start = CB_BLOCK.indexOf('発行済み割引オファーの取り消し');
  const raw = CB_BLOCK.slice(start, CB_BLOCK.indexOf('前回操作の突合', start));
  // 説明コメントで誤検知しないよう、実コードだけを見る
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const leak of ['.email', '.Email', 'TokenHash', 'tokenHash', '.token', '氏名', '.name']) {
    assert.equal(body.includes(leak), false, `${leak} を表示している`);
  }
});

test('offer 取り消しは「権限・課金・メールを変えない」と画面で明示する', () => {
  const pane = PAGE.slice(PAGE.indexOf('発行済み割引オファー'));
  assert.ok(pane.includes('購入条件'));
  assert.ok(/閲覧権・課金契約・入金状態は変わりません/.test(pane));
  assert.ok(/メールも送信されません/.test(pane));
  assert.ok(/申込済み（redeemed）・期限切れ・取り消し済みは変更できません/.test(pane));
});

test('無料特典の取り消し（grant）と混同していない', () => {
  // 既存の grant revoke はそのまま残っている
  assert.ok(CB_BLOCK.includes("action: 'revokeDryRun'"));
  assert.ok(CB_BLOCK.includes("action: 'revoke', tiers"));
  // offer 取り消しは tiers を送らない
  const start = CB_BLOCK.indexOf('async function cbOfferRevokeStart');
  const body = CB_BLOCK.slice(start, CB_BLOCK.indexOf('前回操作の突合', start));
  assert.equal(body.includes('tiers'), false, 'offer 取り消しに tiers が混ざっている');
  assert.equal(body.includes('recordIds'), false, 'offer 取り消しに顧客 recordIds が混ざっている');
});

/* ── 無料付与の表示・絞り込み（「特典」という曖昧な語を使わない）───────── */

test('guard(grant): 現在の無料付与と履歴が別々の絞り込みになっている', () => {
  const CB = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="mkBackdrop"'));
  assert.match(CB, /id="cbGrantNow" aria-label="現在の無料付与"/, '現在の無料付与フィルターが無い');
  assert.match(CB, /id="cbGrantHistory" aria-label="無料付与履歴"/, '無料付与履歴フィルターが無い');
  // 現在の区分（既存フィールドで表現できるものだけ）
  for (const v of ['none', 'light_period', 'light_lifetime', 'premium_period', 'premium_lifetime', 'both', 'inconsistent']) {
    assert.ok(CB.includes(`<option value="${v}">`), `現在の区分 ${v} が無い`);
  }
  // 履歴の区分
  for (const v of ['no_record', 'light', 'premium', 'ended', 'revoked', 'unknown']) {
    assert.ok(CB.includes(`<option value="${v}">`), `履歴の区分 ${v} が無い`);
  }
});

test('guard(grant): 一覧・詳細・条件から「特典」という語を外している', () => {
  const CB = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="mkBackdrop"'));
  assert.equal(/<th class="c-promo">現在の特典<\/th>/.test(CB), false, '一覧見出しが古い');
  assert.match(CB, /<th class="c-promo">無料付与（現在 \/ 履歴）<\/th>/, '一覧見出しが新しくない');
  assert.equal(SCRIPT.includes("CB_MULTI_LABELS = {\n      cbContract: '対象区分', cbPlan: 'プラン', cbWithdrawn: '退会履歴',\n      cbPromo:"), false);
  assert.match(SCRIPT, /cbGrantNow: '現在の無料付与', cbGrantHistory: '無料付与履歴'/, 'チップのラベルが古い');
});

test('guard(grant): 取得は現在・履歴を別の配列で送る', () => {
  assert.match(SCRIPT, /currentGrant: sel\.cbGrantNow/, '現在の無料付与を送っていない');
  assert.match(SCRIPT, /grantHistory: sel\.cbGrantHistory/, '履歴を送っていない');
  assert.equal(/promo: sel\.cbPromo/.test(SCRIPT), false, '廃止した条件を送り続けている');
});

test('guard(grant): 一覧は現在と履歴を文言で出す（色だけに頼らない）', () => {
  assert.match(SCRIPT, /const fg = r\.freeGrant/, '判定結果をそのまま使っていない');
  assert.match(SCRIPT, /'履歴: ' \+/, '履歴を出していない');
  assert.match(SCRIPT, /fg-why/, '不整合の理由を出していない');
  assert.match(SCRIPT, /付与元: /, '付与元を出していない');
});

test('guard(grant): 判定は単一源（画面に再実装しない）', () => {
  // 画面側で Lifetime / Until を直接読んで判定していないこと
  for (const forbidden of ['LightGrantUntil', 'PremiumGrantUntil', 'LightGrantLifetime', 'PremiumGrantLifetime']) {
    assert.equal(SCRIPT.includes(forbidden), false, `画面が ${forbidden} を直接読んでいる`);
  }
});

/* ── 通知の積み上がり防止と「今回の無料付与」（2026-08-03）───────────── */

test('guard(notice): 同じ種類の通知はキーで 1 件に保つ', () => {
  assert.match(SCRIPT, /function cbNotify\(kind, text, detail, key\)/, '通知にキーが無い');
  assert.match(SCRIPT, /data-notice-key/, 'キーで既存通知を探していない');
  assert.match(SCRIPT, /const existing = id \? box\.querySelector/, '同じキーを更新していない');
  assert.match(SCRIPT, /function cbClearNotice\(/, '通知を消す手段が無い');
  assert.match(SCRIPT, /CB_NOTICE = \{ STALE: 'filter-stale'/, '固定キーが無い');
});

test('guard(notice): 条件変更の案内は短文・オレンジ・1 件だけ', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function cbMarkFilterChanged'), SCRIPT.indexOf('function cbMarkFilterChanged') + 900);
  assert.match(block, /cbNotify\('caution', '検索条件が変わりました。', '対象候補を再表示してください。', CB_NOTICE\.STALE\)/,
    '文言またはキーが違う');
  assert.equal(block.includes("'条件が変更されています'"), false, '古い長い文言が残っている');
  // × で閉じても、さらに条件を変えたら出し直す（未反映のまま実行させないため）
  assert.match(block, /cbDismissed\.delete\(CB_NOTICE\.STALE\)/, '閉じた後に二度と出なくなっている');
});

test('guard(notice): 再取得で案内が消え、成功・失敗の通知も 1 件だけ', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('async function cbLoad'), SCRIPT.indexOf('function cbVisibleRows'));
  assert.match(block, /cbNotify\('info', '対象候補を更新しています…', '', CB_NOTICE\.LOADING\)/, '更新中の表示が無い');
  assert.match(block, /cbClearNotice\(CB_NOTICE\.STALE\)/, '再取得で案内を消していない');
  assert.match(block, /CB_NOTICE\.ERROR/, '失敗時のエラー通知が無い');
  assert.match(block, /setTimeout\(\(\) => cbClearNotice\(CB_NOTICE\.LOADED\)/, '成功通知が残り続ける');
});

test('guard(notice): 追従バーは長文の警告を繰り返さない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("const cond = $('cbSbCond')"), SCRIPT.indexOf("const cond = $('cbSbCond')") + 700);
  assert.match(block, /'未反映の条件変更あり'/, '短い表現になっていない');
  assert.equal(block.includes('対象候補を再表示してください'), false, '上部通知と同じ長文を繰り返している');
  assert.match(SCRIPT, /next\.textContent = '🔍 対象候補を再表示'/, '次の操作が「再表示」になっていない');
});

test('guard(grant): 「今回の無料付与」の名称と選択肢', () => {
  const CB = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="mkBackdrop"'));
  assert.match(CB, /id="cbGrantable" aria-label="今回の無料付与"/, 'フィルター名が古い');
  assert.match(CB, /<option value="grantable">今回付与できる<\/option>/);
  assert.match(CB, /<option value="blocked">現在の状態では付与できない<\/option>/);
  assert.match(CB, /<option value="review">要確認<\/option>/);
  assert.equal(/<option value="grantable">付与できる<\/option>/.test(CB), false, '曖昧な文言が残っている');
  assert.equal(/<option value="blocked">付与できない<\/option>/.test(CB), false, '曖昧な文言が残っている');
  assert.match(CB, /<th class="c-grantable">今回の無料付与<\/th>/, '一覧見出しが古い');
});

test('guard(grant): 付与不可の理由を一覧に出し、判定は API と同じ値を使う', () => {
  assert.match(SCRIPT, /const el = r\.eligibility/, 'API の判定結果を使っていない');
  assert.match(SCRIPT, /el\.status === 'review'/, '要確認を別扱いにしていない');
  assert.match(SCRIPT, /GRANT_ELIGIBILITY_NOTE/, '3 つの違いを説明していない');
  assert.match(PAGE, /id="cbGrantNote"/, '説明の置き場所が無い');
});

test('guard(grant): 現在状態・履歴・今回の可否が別項目として並ぶ', () => {
  const CB = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="mkBackdrop"'));
  for (const id of ['cbGrantNow', 'cbGrantHistory', 'cbGrantable']) {
    assert.ok(CB.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(SCRIPT, /cbGrantNow: '現在の無料付与', cbGrantHistory: '無料付与履歴'/);
  assert.match(SCRIPT, /cbGrantable: '今回の無料付与'/);
});

// ═══ 退会・課金停止の扱い（2026-08-04）════════════════════════════════
// 実際に起きた不整合: 対象区分「退会」で全行が付与不可・全選択 0 名なのに手動チェックは通る。

test('guard(withdrawn): 区分名は「退会・課金停止」で、配信停止と別だと画面に書く', () => {
  assert.ok(PAGE.includes('退会・課金停止'), '区分名が更新されていない');
  assert.equal(PAGE.includes('<option value="withdrawn">退会済み</option>'), false, '旧ラベルが残っている');
  assert.ok(PAGE.includes('cbSegNote'), '区分の説明ブロックが無い');
  assert.match(PAGE, /メール配信停止とは別の判定/, '配信停止と別だと説明していない');
});

test('guard(withdrawn): 選んだ特典が退会者へ配れるかを画面に出す', () => {
  assert.ok(PAGE.includes('cbWithdrawnAvail'), '可否の表示先が無い');
  assert.ok(CB_BLOCK.includes('cbRenderWithdrawnAvailability'), '可否を描画していない');
  // 判定はサーバー（単一源）の結果を読むだけ。画面で条件を再実装しない
  assert.ok(CB_BLOCK.includes('withdrawnAllowed'), 'サーバー判定を読んでいない');
  assert.equal(/WithdrawalRequested\s*===\s*true/.test(CB_BLOCK), false, '画面で退会判定を再実装している');
  assert.equal(CB_BLOCK.includes('allowWithdrawn:'), false, '画面で許可条件を組み立てている');
});

test('guard(withdrawn): 特典を選び直したら一覧の付与可否を取り直す', () => {
  // 取り直さないと 一覧・全選択 と dry-run の判定がズレる
  assert.match(CB_BLOCK, /for \(const id of \['cbLightOffer', 'cbPremiumOffer'\]\)[\s\S]{0,400}cbLoad\(\)/,
    '特典を変えても一覧を取り直していない');
  assert.ok(CB_BLOCK.includes('grantOfferIds'), '選択中の特典をサーバーへ渡していない');
});

test('guard(withdrawn): 「今回付与できる」が何を基準にした数字か明示する', () => {
  assert.ok(CB_BLOCK.includes('cbGrantBasisText'), '基準の表示が無い');
  assert.match(CB_BLOCK, /特典 未選択（退会・課金停止の方は付与不可として集計しています）/);
});

test('guard(step2): 選択可否と付与可否を分け、Step 3 で再判定する', () => {
  // ❌ 旧実装は Step 2 でも grantable（＝まだ選んでいない特典が基準）で判定し、
  //    退会・課金停止が全員選べず Step 3 へ進めなかった
  assert.ok(CB_BLOCK.includes('cb.disabled = !r.selectable'), '絶対除外以外まで選択不可にしている');
  assert.match(CB_BLOCK, /for \(const r of cbVisibleRows\(\)\) if \(r\.selectable\) cbSelected\.add/,
    '全選択が選択可能者だけになっていない');
  // Step 3 で特典を決めたら、選択済みを施策条件で再判定して理由付きで外す
  assert.ok(CB_BLOCK.includes('function cbPruneSelectionForOffer'), 'Step 3 の再判定が無い');
  assert.match(CB_BLOCK, /この特典では対象外の .* 名を選択から外しました/, '外した件数を伝えていない');
  assert.ok(CB_BLOCK.includes('grantEvaluated'), '特典 未選択と判定済みを区別していない');
});

test('guard(step2): 既定で特典を選ばない（暗黙の判定基準を作らない）', () => {
  assert.equal(/\$\('cbLightOffer'\)\.value = 'light-lifetime-free'/.test(CB_BLOCK), false,
    'Light 永久無料が既定で選ばれている');
  assert.match(CB_BLOCK, /\$\('cbLightOffer'\)\.value = 'none'/);
  assert.match(CB_BLOCK, /\$\('cbPremiumOffer'\)\.value = 'none'/);
  // 未選択のときは「未選択」と言う（既定値の名前を出さない）
  assert.match(CB_BLOCK, /if \(!l && !p\) return '未選択'/);
  assert.ok(PAGE.includes('特典: 未選択'));
});

test('guard(counts): 対象人数・付与予定人数・送信予定人数を分けて出す', () => {
  for (const label of ['対象人数（選択）', '付与予定人数', '送信予定人数（付与成功者のみ）']) {
    assert.ok(CB_BLOCK.includes(label), `${label} が無い`);
  }
  // 除外理由は件数付きで出す
  assert.ok(CB_BLOCK.includes('skippedDetail'), '除外理由の内訳を使っていない');
});

test('guard(withdrawn): 画面に見える区分名がすべて「退会・課金停止」で揃っている', async () => {
  // ⚠️ 対象区分の**見えるラベル**は `<select>` ではなく複数選択ウィジェットが作る。
  //    本番で「退会済み」のまま残っていた事故があるので、生成元を全部固定する。
  const { CB_SEGMENT_LABELS, CB_SEGMENT_PRESETS } = await import('../marketing/adminMultiFilter.js');
  const { CB_CONTRACT_OPTIONS, describeContractFilter } = await import('../entitlements/comebackConsoleFlow.js');
  const { FILTER_DEFINITIONS } = await import('../marketing/filterDefinitions.js');

  assert.equal(CB_SEGMENT_LABELS.withdrawn, '退会・課金停止');
  assert.match(CB_SEGMENT_PRESETS.withdrawn.label, /退会・課金停止/);
  assert.equal(CB_CONTRACT_OPTIONS.find((o) => o.value === 'withdrawn').label, '退会・課金停止');
  assert.match(describeContractFilter([]), /退会・課金停止/);

  const def = JSON.stringify(FILTER_DEFINITIONS);
  assert.ok(def.includes('退会・課金停止'), 'フィルター定義の区分名が古い');
  assert.ok(def.includes('メール配信停止とは別'), '配信停止と別だと説明していない');
});

// ═══ 付与 → 案内メールの自動引き継ぎ（2026-08-04）══════════════════════

test('guard(handoff): 付与成功後は自動で引き継ぐ（operationId を手入力させない）', () => {
  // 付与応答の引き継ぎ票をそのまま渡し、マーケティングタブへ自動遷移する
  assert.match(CB_BLOCK, /if \(out\.handoff && out\.handoff\.canHandoff\)[\s\S]{0,120}window\.__mkHandoff\.adopt\(out\.handoff\)/,
    '付与後に自動で引き継いでいない');
  // 完了メッセージ（人数 + 次に何をするか）
  assert.match(CB_BLOCK, /名の付与が完了しました。案内メール作成へ進みます/);
});

test('guard(handoff): 引き継ぎ直後に「何を・何名」を伝える', () => {
  assert.match(PAGE, /の付与成功者.*名を引き継ぎました/, '引き継ぎ後の案内が無い');
  assert.ok(PAGE.includes('mkHandoffGrantLabel'), '付与内容の表示名を出していない');
});

test('guard(handoff): 直近の付与成功者を 1 クリックで復元できる', () => {
  assert.ok(PAGE.includes('mkRecoverBtn'), '復旧ボタンが無い');
  assert.ok(PAGE.includes('直近の付与成功者を引き継ぐ'));
  assert.match(PAGE, /action: 'handoffLatest'/, 'サーバーに直近操作を特定させていない');
  // 通常フローでは出さない（引き継ぎ中でも選択中でもないときだけ）
  assert.match(PAGE, /const idle = !mkState\.handoff && mkSelected\.size === 0/);
});

test('guard(handoff): operationId を画面・URL へ出さない', () => {
  // 復旧口の応答からは operationId を表示に使わない
  assert.equal(/mkRecoverState\.textContent\s*=\s*[^;]*operationId/.test(PAGE), false,
    '復旧メッセージに operationId を出している');
  // URL へ載せない（history 操作で対象や ID を渡していない）
  assert.equal(/history\.(pushState|replaceState)[\s\S]{0,200}(operationId|recordIds)/.test(PAGE), false,
    'URL に内部 ID を載せている');
  // localStorage には保存しない（sessionStorage のみ）
  assert.equal(/localStorage\.setItem\([^)]*[Hh]andoff/.test(PAGE), false,
    'localStorage に引き継ぎを保存している');
});

test('guard(handoff): 対象の正本はサーバー側の再導出（recordId を送らない）', () => {
  assert.match(PAGE, /return mkState\.handoff\s*\n?\s*\? \{ grantOperationId: mkState\.handoff\.operationId \}/,
    '引き継ぎ中に recordId を送っている');
});

test('guard(handoff): 手動 operationId は復旧用に格下げする', () => {
  assert.match(PAGE, /うまくいかないとき: 操作 ID を指定して引き継ぎ直す/, '手動導線が通常フローのまま');
  assert.match(PAGE, /2 つ以上前の付与操作/, 'いつ使うのかを書いていない');
});

test('guard(handoff): キュー登録したら引き継ぎを使い切る', () => {
  assert.match(PAGE, /markHandoffQueued\(sessionStorage, \(out\.jobs \|\| \[\]\)\.map/,
    'キュー登録後に使い切りの印を付けていない');
});

// ═══ script の実行順（本番で初期化が止まった事故）════════════════════
// この画面は `<script>`（ES module・defer）が `window.__*` を張り、
// `<script is:inline>`（classic・解析時に即実行）が UI 本体を動かす。
// inline の初期化から bridge を**同期で**触ると必ず undefined になる。

test('guard(init): 初期化は bridge が揃ってから走らせる', () => {
  // 初期化の入口が DOMContentLoaded 待ちになっていること
  assert.ok(PAGE.includes('function mkAfterBridgesReady'), 'bridge 待ちの入口が無い');
  assert.match(PAGE, /document\.addEventListener\('DOMContentLoaded', fn, \{ once: true \}\)/);
  assert.match(PAGE, /mkAfterBridgesReady\(\(\) => \{[\s\S]{0,200}mkHandoffRestore\(\);/,
    '引き継ぎ復元が bridge 待ちになっていない');
});

test('guard(init): 初期化の末尾で bridge を同期に触らない', () => {
  // inline script の最後の 1 ブロック（即時実行関数の閉じ際）を見る
  const tail = SCRIPT.slice(-1800);
  for (const bridge of ['__cbHandoff', '__cbCampaign', '__cbApply', '__mkFlow', '__planView']) {
    assert.equal(new RegExp(`window\\.${bridge}\\s*\\.`).test(tail), false,
      `初期化末尾で window.${bridge} を同期参照している`);
  }
  // 復元の呼び出しは 1 か所だけで、必ず bridge 待ちの中にあること
  const calls = [...SCRIPT.matchAll(/mkHandoffRestore\(\);/g)];
  assert.equal(calls.length, 1, 'mkHandoffRestore() の呼び出しが複数ある');
  const before = SCRIPT.slice(Math.max(0, calls[0].index - 200), calls[0].index);
  assert.match(before, /mkAfterBridgesReady\(\(\) => \{/, 'bridge 待ちの外で復元を呼んでいる');
});

test('guard(init): bridge が無くても例外で画面を止めない', () => {
  assert.match(PAGE, /const handoffApi = \(\) => window\.__cbHandoff \|\| null;/,
    'bridge 未定義で例外になる書き方のまま');
  // 復元・描画・採用のいずれも null チェックを持つ
  assert.match(PAGE, /function mkHandoffRestore\(\) \{\s*\n\s*const api = handoffApi\(\);\s*\n\s*if \(!api\)/);
  assert.match(PAGE, /function mkHandoffAdopt\(ticket\) \{\s*\n\s*const api = handoffApi\(\);\s*\n\s*if \(!api\)/);
  assert.match(PAGE, /handoffApi\(\) \? handoffApi\(\)\.describeHandoff/);
});
