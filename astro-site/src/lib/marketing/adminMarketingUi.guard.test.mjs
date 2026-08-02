/**
 * adminMarketingUi.guard.test.mjs — マーケティングタブの UI 契約
 *   node --test src/lib/marketing/adminMarketingUi.guard.test.mjs
 *
 * 画面は prerender=true の静的ページなので、配信される HTML/JS = このソースそのもの。
 * 「操作は簡単・内部は fail closed」を UI 側でも壊さないように固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url)), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script is:inline>'));

test('販売タブとマーケティングタブが分かれている', () => {
  assert.ok(PAGE.includes('id="tabSales"'));
  assert.ok(PAGE.includes('id="tabMkt"'));
  assert.ok(PAGE.includes('id="paneSales"'));
  assert.ok(PAGE.includes('id="paneMkt"'));
});

test('マーケティングは別 API を叩く（販売資格 API を流用しない）', () => {
  assert.ok(SCRIPT.includes("MKT_API = '/.netlify/functions/admin-marketing'"));
  // マーケ側の呼び出しは必ず mkCall（販売側の call を混ぜない）
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  assert.ok(mktBlock.length > 1000, 'マーケ用ブロックが見つからない');
  assert.equal(/[^k]\bcall\(\{\s*action:\s*'(update|list|preview)'/.test(mktBlock), false,
    'マーケタブから販売資格 API を呼んでいる');
});

test('マーケタブから Premium Plus の資格変更 payload を送らない', () => {
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  for (const banned of ['plusAction', "action: 'update'", 'PremiumPlusEligibility:']) {
    assert.equal(mktBlock.includes(banned), false, `${banned} を送っている`);
  }
});

test('一覧の checkbox 一括操作がそろっている', () => {
  for (const id of ['mkSelAll', 'mkSelNone', 'mkSelCount']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.ok(SCRIPT.includes('mkSelected.clear()'));
  assert.ok(SCRIPT.includes('mkSelected.add(r.recordId)'));
});

test('送信できない顧客は選択できない（UI 側でも fail closed）', () => {
  // 行の checkbox は押せない
  assert.match(SCRIPT, /cb\.disabled = !r\.sendable/);
  // 全選択も送信可能な相手だけを足す（判定は純粋モジュールへ selectableIds として渡す）
  assert.match(SCRIPT, /selectableIds: visible\.filter\(\(r\) => r\.sendable\)/,
    '全選択が除外者まで拾っている');
});

test('dry-run を経ずに送信できない（送信ボタンは確認画面の中だけ）', () => {
  // 一覧・ツールバーに送信ボタンが無い
  assert.equal(/id="mkSend"/.test(PAGE), false, '一覧に送信ボタンがある');
  // 送信は dry-run 応答（plan）から組み立てた確認画面でのみ生成される
  assert.match(SCRIPT, /function mkRenderConfirm\(campaign, plan\)/);
  assert.match(SCRIPT, /action:\s*'send',[\s\S]{0,240}?planFingerprint:\s*plan\.planFingerprint/);
});

test('確認ダイアログに 対象 / 除外 / 実送信 の件数が出る', () => {
  assert.match(SCRIPT, /送信対象: '\s*\+\s*plan\.selected/);
  assert.match(SCRIPT, /除外: '\s*\+\s*plan\.excluded/);
  assert.match(SCRIPT, /実送信: '\s*\+\s*plan\.willSend/);
  assert.ok(SCRIPT.includes('window.confirm'), '最終確認ダイアログが無い');
});

test('送信ボタンは無効時と 0 件で押せない / 二重クリックを防ぐ', () => {
  assert.match(SCRIPT, /btn\.disabled = !plan\.sendEnabled \|\| plan\.willSend === 0/);
  assert.match(SCRIPT, /if \(btn\.dataset\.busy === '1'\) return/);
});

test('送信有効/無効の状態を画面に明示する', () => {
  assert.ok(PAGE.includes('id="mkSendState"'));
  assert.ok(SCRIPT.includes('MARKETING_CAMPAIGN_ENABLED 未設定'));
  assert.ok(SCRIPT.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), '専用配信ゲートの状態を伝えていない');
  assert.ok(SCRIPT.includes('実送信されません'), '配信が無効なことを伝えていない');
  // 既存メールのマスタースイッチ名を操作条件として画面に出さない（誤って ON にさせない）
  assert.equal(SCRIPT.includes('NEWSLETTER_AUTOMATION_ENABLED'), false,
    'マーケ画面が newsletter の global gate を条件として案内している');
});

test('provider 側の配信停止と照合できたかを確認画面に出す', () => {
  assert.ok(SCRIPT.includes('plan.providerSuppression'), 'provider 照合状況を出していない');
  assert.ok(SCRIPT.includes('配信基盤の配信停止リスト'));
  assert.ok(SCRIPT.includes('この状態では送信できません'), '確認できない場合の警告が無い');
  // ⚠️ この画面には Premium Plus のプレビュー guard（stagedReleaseGuard）が効いており、
  //    ページ全体でメール送信基盤の固有名詞を禁止している。文言に製品名を書かないこと。
  assert.equal(/sendgrid/i.test(SCRIPT), false, 'ページに送信基盤の固有名詞が入っている');
});

test('本文プレビューはサンドボックス iframe で表示する（スクリプト実行なし）', () => {
  assert.match(SCRIPT, /frame\.setAttribute\('sandbox', ''\)/);
  assert.match(SCRIPT, /frame\.srcdoc/);
  assert.equal(SCRIPT.includes('innerHTML = data.html'), false, 'メール HTML を管理画面へ直接流し込んでいる');
});

test('除外理由が画面に必ず出る（黙って落とさない）', () => {
  assert.ok(SCRIPT.includes('plan.excludedDetail'));
  assert.ok(SCRIPT.includes('r.suppressionReasons'), '一覧に除外理由を出していない');
});

test('dry-run 確認画面が除外を分類して出す', () => {
  for (const label of [
    'キャンペーン条件外', '配信停止・除外リスト', '最近マーケティング送信済み', '配信基盤の配信停止', 'その他',
  ]) {
    assert.ok(SCRIPT.includes(label), `除外分類「${label}」が無い`);
  }
  for (const reason of [
    'campaign_mismatch', 'recent_marketing_contact', 'provider_suppressed', 'already_delivered',
  ]) {
    assert.ok(SCRIPT.includes(reason), `理由 ${reason} が分類に含まれていない`);
  }
  // 分類漏れが出ても件数を落とさない
  assert.ok(SCRIPT.includes('未分類'), '未分類の受け皿が無い');
});

test('使用停止中のキャンペーンは選べず、理由が画面に出る', () => {
  assert.match(SCRIPT, /o\.disabled = !c\.usable/, '停止中を選択不可にしていない');
  assert.ok(SCRIPT.includes('使用停止中'), '停止中の表示が無い');
  assert.ok(SCRIPT.includes('c.disabledReason'), '停止理由を出していない');
  // dry-run 実行時にも停止中を弾く
  assert.match(SCRIPT, /if \(!c\.usable\) \{ mkMsg\('使用停止中のキャンペーンです/);
});

test('既定選択が使用可能なキャンペーンになる', () => {
  assert.match(SCRIPT, /const firstUsable = mkCampaigns\.find\(\(c\) => c\.usable\)/);
});

test('運用テスト専用キャンペーンが顧客向けと区別して表示される', () => {
  // 選択肢・説明・確認画面の 3 箇所で testOnly を反映する
  assert.ok(SCRIPT.includes('c.testOnly'), '選択肢で運用テスト専用を示していない');
  assert.ok(SCRIPT.includes('campaign.testOnly'), '確認画面で運用テスト専用を示していない');
  assert.ok(SCRIPT.includes('運用テスト専用'), '文言が無い');
  // 対象を手動で広げられないことが分かる説明
  assert.ok(SCRIPT.includes('NEWSLETTER_TEST_RECIPIENTS'), 'ホワイトリスト正本を説明していない');
  assert.ok(SCRIPT.includes('対象を手動で広げることはできません'), '手動で広げられない旨の説明が無い');
});

test('顧客データを URL に載せない', () => {
  const mktBlock = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  assert.equal(/location\.(href|search)\s*=/.test(mktBlock), false);
  assert.equal(mktBlock.includes('URLSearchParams'), false);
});

test('マーケタブが Premium Plus 販売の説明文を書き換えていない', () => {
  assert.ok(PAGE.includes('候補は自動で「販売可」になりません'), '販売タブの注意書きが消えている');
  assert.ok(PAGE.includes('メールを送っても会員権限は復活しません'), 'マーケタブの注意書きが無い');
});

// =========================================================================
// 実配信ボタン + 顧客カルテ（2026-08-01 / 管理画面だけで完結させる）
// =========================================================================

test('実配信は「確認 → 実行」の 2 段で、いきなり配信できない', () => {
  assert.ok(PAGE.includes('mkDispatchCheck'), '配信内容の確認ボタンが無い');
  assert.ok(PAGE.includes('mkDispatchRun'), '実配信ボタンが無い');
  // 実行ボタンは既定で無効。確認に成功したときだけ開く
  assert.match(PAGE, /id="mkDispatchRun"[^>]*disabled/, '実配信ボタンが最初から押せる');
  assert.match(SCRIPT, /\$\('mkDispatchRun'\)\.disabled = !\(data\.jobs && willSend > 0\)/,
    '送る相手が 0 人でも実配信ボタンが開く');
});

test('実配信は取り消せないことを確認ダイアログで伝える', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  assert.match(block, /window\.confirm\(/, '確認ダイアログが無い');
  assert.match(block, /取り消せません/, '不可逆であることを伝えていない');
});

test('実配信の実行後は必ず再確認からやり直す（二重配信防止）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  // finally ではなく、成功・失敗どちらでも最後に無効化する
  assert.match(block, /btn\.disabled = true;\s*\}\);/, '実行後に実配信ボタンが押せるまま');
});

test('実配信は専用 dispatcher を叩く（admin-marketing に送信させない）', () => {
  assert.match(SCRIPT, /marketing-campaign-dispatch/, '専用 dispatcher を呼んでいない');
  const mkt = SCRIPT.slice(SCRIPT.indexOf('顧客マーケティング（AK 独自'));
  assert.equal(/MKT_API[\s\S]{0,200}dryRun:\s*false/.test(mkt), false,
    'admin-marketing 側に実送信をさせようとしている');
});

test('配信結果に「送らなかった理由」が出る（黙って落とさない）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkRenderDispatch'));
  assert.match(block, /skippedByReason/);
  assert.match(block, /providerSuppression/, 'suppression 照合の可否を出していない');
});

test('顧客カルテは read-only の action だけを呼ぶ', () => {
  assert.match(SCRIPT, /action: 'customerDetail'/, 'カルテ取得の action が無い');
  const block = SCRIPT.slice(SCRIPT.indexOf('async function mkOpenDossier'));
  const body = block.slice(0, block.indexOf("$('mkDossierClose')"));
  // カルテ画面から更新系を呼ばない
  for (const forbidden of ['action: \'send\'', 'action: \'apply\'', 'action: \'update\'', 'action: \'revoke\'']) {
    assert.equal(body.includes(forbidden), false, `カルテから ${forbidden} を呼んでいる`);
  }
});

test('最終ログインは出所を必ず併記する（旧記録と正規記録を混同させない）', () => {
  assert.match(SCRIPT, /出所: /, '最終ログインの出所を出していない');
  assert.match(SCRIPT, /legacy_points/, '旧ポイント履歴由来を区別していない');
  assert.ok(PAGE.includes('id="mkLastLogin"'), '最終ログインの絞り込みが無い');
});

test('カルテに「無料特典は支払いではない」区別が出る', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('async function mkOpenDossier'));
  assert.match(block, /promotional_grant/);
  assert.match(block, /無料特典（支払いではない）/);
});

// =========================================================================
// 顧客マーケティング運用画面（2026-08-01）
// =========================================================================

test('カルテに推奨アクションが出て、理由・使用データ・送信可否・最短日時を併記する', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('async function mkOpenDossier'));
  assert.match(block, /推奨アクション（提案のみ・自動実行しません）/, '自動実行しない旨が無い');
  for (const k of ['使用データ', '送信可否', '実行できる最短']) {
    assert.ok(block.includes(k), `推奨に ${k} が出ていない`);
  }
  assert.match(block, /rec\.reason/, '推奨理由を描画していない');
});

test('推奨から直接 実行系 API を呼ばない（提案のみ）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("const s0 = dossierSection"), SCRIPT.indexOf("// ① ログイン"));
  for (const forbidden of ["action: 'apply'", "action: 'send'", "action: 'revoke'", 'dryRun: false']) {
    assert.equal(block.includes(forbidden), false, `推奨欄から ${forbidden} を呼んでいる`);
  }
});

test('時系列履歴は出所を必ず併記し、取得できない情報を明示する', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("const s6 = dossierSection"));
  assert.match(block, /e\.source/, '履歴に出所を出していない');
  assert.match(block, /日時不明/, '日時が無い行の扱いが無い');
  assert.match(block, /問い合わせ履歴/, '取得できない情報を明示していない');
  assert.match(block, /台帳が無く取得できません/);
  assert.match(block, /過去の契約は最新 1 件ぶんのみ/);
});

test('開封・クリックは取得可否を明示する（0 件と断定しない）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("const s6 = dossierSection"));
  assert.match(block, /engagementSource/, '取得範囲を画面へ出していない');
  assert.match(block, /開封・クリック: /);
});

test('一覧に運用列があり、狭い画面では主要列だけになる', () => {
  for (const cls of ['c-access col-detail', 'c-promo col-detail', 'c-offer col-detail', 'c-next col-detail']) {
    assert.ok(PAGE.includes(cls), `${cls} が無い`);
  }
  assert.match(PAGE, /data-colmode/, '列表示の切替が無い');
  assert.match(PAGE, /#paneMkt\[data-colmode="?basic"?\] \.col-detail \{ display: none; \}/,
    "主要列モードで詳細列を隠す CSS が無い");
  assert.match(PAGE, /@media \(max-width: 720px\)[\s\S]{0,400}\.col-detail \{ display: none; \}/,
    '狭い画面で詳細列を隠していない');
});

test('絞り込みは AND で、適用条件と件数を画面に出す', () => {
  for (const id of ['mkOfferState', 'mkPromoState', 'mkFrequency', 'mkLastLogin']) {
    assert.ok(PAGE.includes(`id="${id}"`), `${id} が無い`);
  }
  assert.match(SCRIPT, /offerState: \$\('mkOfferState'\)\.value/);
  assert.match(SCRIPT, /promoState: \$\('mkPromoState'\)\.value/);
  assert.match(SCRIPT, /frequency: \$\('mkFrequency'\)\.value/);
  const applied = SCRIPT.slice(SCRIPT.indexOf('function renderApplied'));
  assert.match(applied, /AND/, '条件の結合が AND だと分からない');
  assert.match(applied, /該当 /, '該当件数を出していない');
});

test('施策パネルは dry-run しか実行しない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"), SCRIPT.indexOf('// ── 実配信'));
  assert.match(block, /action: 'dryRun'/, 'dry-run を呼んでいない');
  for (const forbidden of ["action: 'apply'", "action: 'send'", "action: 'revoke'", 'dryRun: false']) {
    assert.equal(block.includes(forbidden), false, `施策パネルが ${forbidden} を実行する`);
  }
  // 必要な表示項目
  for (const k of ['対象件数', '変更前 → 変更後', 'operationId', '取り消し方法', 'この操作の副作用']) {
    assert.ok(block.includes(k), `施策パネルに ${k} が無い`);
  }
});

// =========================================================================
// 複数選択と実行前確認（2026-08-01）
// =========================================================================

test('選択操作は純粋モジュールへ委譲する（画面でロジックを書かない）', () => {
  assert.match(PAGE, /window\.__planView/, '判定モジュールを画面へ渡していない');
  assert.match(PAGE, /campaignPlanView\.js/, 'campaignPlanView を読み込んでいない');
  assert.match(SCRIPT, /updateSelection\(\{[\s\S]{0,400}op: 'add-visible'/, '表示中のみ全選択が委譲されていない');
  assert.match(SCRIPT, /op: 'clear'/, '全解除が委譲されていない');
});

test('選択は 全顧客 / 表示中のみ / 全解除 の 3 つに分かれる', () => {
  for (const id of ['mkSelAllLoaded', 'mkSelAll', 'mkSelNone']) {
    assert.ok(PAGE.includes('id="' + id + '"'), id + ' が無い');
  }
  // 文言が意味を取り違えさせないこと
  assert.match(PAGE, /全顧客から選択/);
  assert.match(PAGE, /表示中のみ選択/);
  assert.match(PAGE, /全解除/);
});

test('「表示中のみ選択」は表示中かつ送信可能な相手だけを足す', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkSelAll').addEventListener"), SCRIPT.indexOf("$('mkSelNone')"));
  assert.match(block, /const visible = mkVisibleRows\(\)/, '表示中の行を使っていない');
  assert.match(block, /visibleIds: visible\.map/, '表示中以外を巻き込んでいる');
  assert.match(block, /selectableIds: visible\.filter\(\(r\) => r\.sendable\)/, '送信不可を選択対象にしている');
});

test('「全顧客から選択」は絞り込みに依存せず、件数を必ず知らせる', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkSelAllLoaded')"), SCRIPT.indexOf("$('mkSelAll').addEventListener"));
  assert.match(block, /mkData && mkData\.rows/, '読み込み済みの全件を使っていない');
  assert.equal(/mkVisibleRows\(\)/.test(block), false, '全顧客選択が表示中に依存している');
  assert.match(block, /selectableIds: all\.filter\(\(r\) => r\.sendable\)/, '送信不可を足している');
  assert.match(block, /全顧客から /, '大量選択を黙って行っている（件数表示が無い）');
  assert.match(block, /updateSelection\(/, '選択更新を委譲していない');
});

test('絞り込みで見えなくなった選択を警告する', () => {
  assert.ok(PAGE.includes('id="mkSelWarn"'), '画面外選択の警告欄が無い');
  assert.match(SCRIPT, /offscreenSelection\(/, '画面外選択を数えていない');
  assert.match(SCRIPT, /現在の絞り込みに表示されていません/);
});

test('選択中の一覧を確認できる（recordId が正本と明示）', () => {
  assert.ok(PAGE.includes('id="mkSelList"'));
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkSelList')"));
  assert.match(block, /recordId で保持/, '識別子が recordId だと画面に出ていない');
});

test('実行前確認は 対象者 / 除外者 / 除外理由 / 実行内容 / rollback を出す', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function renderPlanView'));
  for (const tab of ['対象者 ', '除外者 ', '除外理由', '実行内容', 'rollback']) {
    assert.ok(block.includes(tab), `${tab} タブが無い`);
  }
  assert.match(block, /この人に実行されます/, '対象になる理由の説明が無い');
  assert.match(block, /この人には実行されません/, '除外の説明が無い');
  assert.match(block, /view\.operationId \|\| view\.planFingerprint/, 'operationId を出していない');
  assert.match(block, /view\.rollback/, 'rollback を出していない');
  assert.match(block, /campaignId \+ ':v' \+ view\.version/, 'campaignId / version を出していない');
});

test('実行不可（未知理由・件数不一致）を画面で伝える', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"));
  assert.match(block, /view\.executable/, '実行可否を見ていない');
  assert.match(block, /この内容では実行できません/, '実行不可の表示が無い');
  const render = SCRIPT.slice(SCRIPT.indexOf('function renderPlanView'));
  assert.match(render, /pv-blocked/, '実行不可の視覚表現が無い');
  assert.match(render, /view\.blockers/, '理由を出していない');
});

test('確認画面は dry-run しか呼ばない（実行系を持たない）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"), SCRIPT.indexOf('// ── 実配信'));
  assert.match(block, /action: 'dryRun'/);
  for (const forbidden of ["action: 'apply'", "action: 'send'", "action: 'revoke'", "action: 'offerRevoke'", 'dryRun: false']) {
    assert.equal(block.includes(forbidden), false, `確認画面から ${forbidden} を呼んでいる`);
  }
  assert.match(block, /sideEffects/, '副作用の有無を出していない');
});

test('画面側で送信可否・契約条件を再判定しない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkActionDry')"), SCRIPT.indexOf('// ── 実配信'));
  // 判定は API 結果をそのまま使う
  assert.match(block, /buildPlanView\(\{ kind: planKind, selectedIds: ids, rowsById, result/);
  for (const forbidden of ['MARKETING_MIN_INTERVAL', 'suppression.has', 'isLiveOffer(', 'resolveMembership(']) {
    assert.equal(block.includes(forbidden), false, `画面で ${forbidden} を再実装している`);
  }
});

// ── 恒久台帳（EmailEvents）の表示（Phase 1d）─────────────────────
test('guard(ui): 台帳由来の反応は専用セクションで、直近ぶんと混同しない', () => {
  assert.match(SCRIPT, /⑥-2 メール反応（恒久台帳）/, '台帳由来の反応セクションが無い');
  assert.match(SCRIPT, /d\.ledgerEngagement/, 'カルテの台帳集約を読んでいない');
  assert.match(SCRIPT, /⑥ の直近ぶんとは出所が異なります/, '出所の違いを注記していない');
});

test('guard(ui): 台帳を引けないときは 0 件ではなく「取得不能」と出す', () => {
  assert.match(SCRIPT, /取得不能（反応が無かったという意味ではありません）/,
    '取得不能を 0 件として表示している');
  assert.match(SCRIPT, /!led\.available \|\| le\.available !== true/, '取得可否を判定していない');
});

test('guard(ui): 開封・クリックの回数と初回・最終日時を出す', () => {
  for (const label of ['開封', '初回開封', '最終開封', 'クリック', '初回クリック', '最終クリック']) {
    assert.ok(SCRIPT.includes(`'${label}'`), `${label} を表示していない`);
  }
});

test('guard(ui): 未確定（unresolved / conflict）を顧客の反応として出さない', () => {
  assert.match(SCRIPT, /誰のものか確定していないイベントは、この人の反応として数えていません/,
    '未確定の扱いを明示していない');
  assert.equal(/unattributed[^;]*textContent|dossierRow\(s62, '未確定'/.test(SCRIPT), false,
    '未確定の件数をこの顧客の反応として表示している');
});
