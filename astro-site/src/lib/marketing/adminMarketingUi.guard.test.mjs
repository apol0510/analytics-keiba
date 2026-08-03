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
  assert.match(SCRIPT, /!c\.usable[\s\S]{0,120}使用停止中のキャンペーンです/, '使用停止中の理由を出していない');
});

test('既定選択が使用可能なキャンペーンになる（運用テスト専用は既定にしない）', () => {
  // 既定の決め方は単一源へ委譲する（画面で find を書かない）
  assert.match(SCRIPT, /pickInitialCampaign\(\{/, '既定選択を単一源で決めていない');
  assert.equal(/const firstUsable = mkCampaigns\.find\(\(c\) => c\.usable\)/.test(SCRIPT), false,
    '「最初に使えるもの」を既定にしている（運用テスト専用が選ばれうる）');
  assert.match(PAGE, /comebackGrantCampaign\.js/, '判定モジュールを読み込んでいない');
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
  // 可否は単一源（marketingConsoleFlow）が決める。確認結果を状態へ入れてから同期する
  assert.match(SCRIPT, /canDispatchSend\(/, '実配信の可否を単一源で判定していない');
  assert.match(SCRIPT, /check: \{ willSend, jobs: data\.jobs \}/,
    '確認結果を状態へ保存していない（送る相手が 0 人でも押せてしまう）');
});

test('実配信は取り消せないことを確認ダイアログで伝える', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  assert.match(block, /window\.confirm\(/, '確認ダイアログが無い');
  assert.match(block, /取り消せません/, '不可逆であることを伝えていない');
});

test('実配信の実行後は必ず再確認からやり直す（二重配信防止）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  // 送信後は直前確認を捨てる → もう一度確認しない限り canDispatchSend が false になる
  assert.match(block, /mkState\.dispatch = \{ sent: true, result: data, summary: res, check: null, preflight: null \}/,
    '実行後に直前確認を無効化していない（もう一度押せてしまう）');
  assert.match(block, /btn\.dataset\.busy = '1'/, '二重クリック防止が無い');
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
  // 複数選択は配列で送る（同じ項目内は OR / 項目間は AND）
  assert.match(SCRIPT, /offerState: sel\.mkOfferState/);
  assert.match(SCRIPT, /promoState: sel\.mkPromoState/);
  assert.match(SCRIPT, /frequency: sel\.mkFrequency/);
  assert.match(SCRIPT, /const sel = multiValues\(MK_MULTI_IDS\)/, '複数選択の値を読んでいない');
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
  const at = SCRIPT.indexOf("$('mkSelAll').addEventListener");
  const block = SCRIPT.slice(at, at + 900);
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
  assert.match(block, /buildPlanView\(\{ kind: planKind, selectedIds: resolvedIds, rowsById, result/);
  // 引き継ぎ中も対象の確定はサーバー（画面は recordId を送らない）
  assert.match(block, /grantOperationId: handoffOp/, '引き継ぎの対象指定をサーバーへ委ねていない');
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

// ── 送信状況・取消 UI（運用機能 / 2026-08-02）──────────────────────
test('guard(ui): 送信状況を開くボタンと描画がある', () => {
  assert.match(PAGE, /id="mkJobsBtn"/, '送信状況を開く導線が無い');
  assert.match(SCRIPT, /action: 'jobs'/, 'ジョブ一覧を取得していない');
  assert.match(SCRIPT, /送信待ち|送信済み|失敗|取消済み/, 'ジョブの状態を表示していない');
});

test('guard(ui): gate の状態と「自動送信されない」ことを明示する', () => {
  assert.match(SCRIPT, /MARKETING_CAMPAIGN_ENABLED 未設定/, 'キュー登録 gate の理由を出していない');
  assert.match(SCRIPT, /MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定/, '実送信 gate の理由を出していない');
  assert.match(SCRIPT, /自動送信はされません/, '自動送信されないことを明示していない');
});

test('guard(ui): 取消は二段階確認（確認ダイアログ + 文字入力）', () => {
  const from = SCRIPT.indexOf('送信予定を取り消す');
  const seg = SCRIPT.slice(from, from + 1600);
  assert.match(seg, /window\.confirm\(/, '確認ダイアログが無い');
  assert.match(seg, /window\.prompt\(/, '文字入力による確認が無い');
  assert.match(seg, /CANCEL/, '確認文字列が無い');
  assert.match(seg, /operationId/, '操作 ID を送っていない（再実行で二重に書ける）');
});

test('guard(ui): 送信済みは取消しないことを画面で明示する', () => {
  assert.match(SCRIPT, /送信済みのため取消不可/, '取消不可の理由を出していない');
  assert.match(SCRIPT, /取り消しません/, '送信済みを取り消さないと明示していない');
});

test('guard(ui): provider 受理と実配信を混同させない注記がある', () => {
  assert.match(SCRIPT, /実際に届いたか（delivered）とは別/, '受理と配信の違いを説明していない');
});

test('guard(ui): 送信ボタンは gate 閉鎖時に無効化される（既存契約の維持）', () => {
  assert.match(SCRIPT, /btn\.disabled = !plan\.sendEnabled \|\| plan\.willSend === 0/,
    'gate 閉鎖時に送信ボタンを無効化していない');
});

test('guard(ui): カルテに未確定イベントの件数を出す（0 件と取得不能を区別）', () => {
  assert.match(SCRIPT, /未確定イベント（全体・顧客未紐付）/, '未確定件数を出していない');
  assert.match(SCRIPT, /led\.unattributedAvailable/, '取得可否を見ていない');
});

// ── 操作順が分かる画面（2026-08-02 / UX 改善）─────────────────────
test('guard(ui): Step 1〜6 の見出しと進行表示がある', () => {
  assert.match(PAGE, /id="mkSteps"/, 'ステップ表示が無い');
  for (const [n, label] of [[1, '対象顧客を絞り込む'], [2, '顧客を選択する'], [3, 'キャンペーンを選ぶ'],
    [4, '送信対象を確認'], [5, 'キュー登録・最終送信'], [6, '送信状況・取消・結果確認']]) {
    assert.ok(PAGE.includes(label), `Step ${n} の見出しが無い: ${label}`);
    assert.ok(PAGE.includes(`data-step="${n}"`), `Step ${n} の節が無い`);
  }
  assert.match(SCRIPT, /resolveStep\(/, '現在地を単一源で判定していない');
});

test('guard(ui): 押せる／押せないの判定を画面側に再実装しない', () => {
  for (const fn of ['canDryRun(', 'canEnqueue(', 'canDispatchCheck(', 'canDispatchSend(']) {
    assert.ok(SCRIPT.includes(fn), `${fn} を使っていない`);
  }
  assert.match(SCRIPT, /window\.__mkFlow/, '判定の単一源を橋渡ししていない');
  assert.match(SCRIPT, /BLOCK_LABEL\[/, '押せない理由を文言化していない');
});

test('guard(ui): 選択・条件・キャンペーンの変更で dry-run が失効する', () => {
  assert.match(SCRIPT, /mkInvalidateDryRun\('選択した顧客が変わりました。'\)/, '選択変更で失効させていない');
  assert.match(SCRIPT, /mkInvalidateDryRun\('顧客一覧を取得し直しました。'\)/, '一覧の取り直しで失効させていない');
  assert.match(SCRIPT, /mkInvalidateDryRun\('キャンペーンが変わりました。'\)/, 'キャンペーン変更で失効させていない');
  assert.match(SCRIPT, /isDryRunStale\(/, '失効判定を単一源で行っていない');
});

test('guard(ui): フィルターは常時表示と詳細条件に分かれ、件数とクリアがある', () => {
  assert.match(PAGE, /<details class="filter-more"/, '詳細条件が折りたためない');
  assert.match(PAGE, /id="mkFilterClear"/, '条件クリアが無い');
  assert.match(PAGE, /id="mkFilterCount"/, '適用中の条件数が無い');
  // 数え方はチップと同じ単一源（adminMultiFilter.countApplied）にそろえる。
  // 「項目数」と「値の数」が同じ画面に並ぶと混乱するため summarizeFilters は使わない。
  assert.match(SCRIPT, /filterApi\(\)\.countApplied\(multiValues\(MK_MULTI_IDS\)\)/, '適用中フィルターを単一源で数えていない');
  // 常時表示は 4 つ（Email / 契約 / プラン / 送信可否）だけ
  const head = PAGE.slice(PAGE.indexOf('id="mkStep1H"'), PAGE.indexOf('filter-more'));
  for (const id of ['mkQ', 'mkContract', 'mkPlan', 'mkSendable']) {
    assert.ok(head.includes(id), `${id} が常時表示にない`);
  }
});

test('guard(ui): 「表示中を全選択」を主要操作にし、全顧客選択は目立たせない', () => {
  assert.match(PAGE, /id="mkSelAll" class="btn-warning btn-md">👥 表示中を全選択/, '主要操作になっていない');
  assert.match(PAGE, /id="mkSelAllLoaded"[^>]*btn-quiet/, '全顧客選択が目立つままになっている');
});

test('guard(ui): 追従バーに現在地と次の操作を出す', () => {
  assert.match(PAGE, /id="mkStickyBar"/, '追従バーが無い');
  for (const id of ['sbSel', 'sbCamp', 'sbDry', 'sbGate', 'sbNext']) {
    assert.ok(PAGE.includes(`id="${id}"`), `追従バーに ${id} が無い`);
  }
  assert.match(SCRIPT, /function mkNextAction\(/, '次の操作を示していない');
});

test('guard(ui): dry-run 結果を主要パネルにまとめて出す', () => {
  assert.match(PAGE, /id="mkDryPanel"/, 'dry-run パネルが無い');
  assert.match(SCRIPT, /function mkRenderDryPanel\(/, 'パネル描画が無い');
  for (const label of ['選択人数', '送信対象', '除外', 'gate', '二重送信防止', '実行すると']) {
    assert.ok(SCRIPT.includes(`'${label}'`) || SCRIPT.includes(`row('${label}`), `パネルに ${label} が無い`);
  }
  assert.match(SCRIPT, /除外理由（送信できない理由。失敗ではありません）/, '除外理由と失敗理由を区別していない');
});

test('guard(ui): 最終送信は必須項目つき二段階確認', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  assert.match(block, /buildSendNowConfirmation\(/, '確認内容を単一源で組み立てていない');
  assert.match(block, /window\.confirm\(/, '確認ダイアログが無い');
  assert.match(block, /window\.prompt\(/, '二段階目の確認が無い');
  assert.match(block, /実送信予定人数/, '人数入力による誤操作防止が無い');
  assert.match(block, /conf\.effect/, '実メールが届くことを伝えていない');
});

test('guard(ui): 通知は内容別に出し、internal error を素通しにしない', () => {
  assert.match(PAGE, /id="mkNotices"/, '通知領域が無い');
  assert.match(SCRIPT, /function mkNotify\(kind, text, detail\)/, '通知が内容別になっていない');
  assert.match(SCRIPT, /送信に失敗しました[\s\S]{0,120}必ず確認してください/, 'エラー時に次の行動を示していない');
});

test('guard(ui): ジョブ状態はバッジで示し、部分失敗を成功と読ませない', () => {
  assert.match(SCRIPT, /resolveJobBadge\(/, 'バッジ判定を単一源で行っていない');
  assert.match(SCRIPT, /badge b-/, 'バッジを描画していない');
});

// ── 「今すぐ送信」（2026-08-02 / 管理画面だけで完結）────────────────
test('guard(ui): 最終送信ボタンは「今すぐ送信」で、既定は押せない', () => {
  assert.match(PAGE, /id="mkDispatchRun"[^>]*>[^<]*今すぐ送信/, '「今すぐ送信」が無い');
  assert.match(PAGE, /id="mkDispatchRun"[^>]*disabled/, '最初から押せる状態になっている');
});

test('guard(ui): 送信可否は marketingSendNow の判定に従う', () => {
  assert.match(SCRIPT, /window\.__mkSend/, '送信判定の単一源を橋渡ししていない');
  assert.match(SCRIPT, /canSendNow\(/, '送信可否を単一源で判定していない');
  assert.match(SCRIPT, /SEND_BLOCK_LABEL\[/, '送れない理由を文言化していない');
});

test('guard(ui): 送信直前に jobId・内容の一致を再確認する', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  assert.match(block, /buildDispatchPreflight\(|mkState\.dispatch\.preflight/, '確認したジョブを保持していない');
  assert.match(block, /await mkDispatchCall\(true, mkState\.dispatch\.preflight\.jobId\)/,
    '送信直前に同じジョブで再確認していない');
  assert.match(block, /verifySendPrecondition\(/, 'jobId・内容の一致を検証していない');
  assert.match(block, /await mkDispatchCall\(false, pre\.jobId\)/, '実送信を確認済みジョブに限定していない');
});

test('guard(ui): 実送信は確認を通過した後にしか呼ばれない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  const verifyIdx = block.indexOf('verifySendPrecondition(');
  const liveIdx = block.indexOf('mkDispatchCall(false');
  assert.ok(verifyIdx > -1 && liveIdx > verifyIdx, '検証より前に実送信を呼んでいる');
  const guardIdx = block.indexOf('if (!pre.ok)');
  assert.ok(guardIdx > -1 && guardIdx < liveIdx, '検証失敗時に止めていない');
});

test('guard(ui): 二重クリックで live dispatcher が 2 回走らない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('mkDispatchRun').addEventListener"));
  assert.match(block, /if \(btn\.dataset\.busy === '1'\) return;/, '二重クリック防止が無い');
  assert.match(block, /mkState\.busy = true/, '応答待ち中に他の送信操作を無効化していない');
});

test('guard(ui): 送信結果に sent / skipped / failed と取消不可を出す', () => {
  assert.match(SCRIPT, /function mkRenderSendResult\(/, '結果表示が無い');
  for (const label of ['送信（provider 受理）', 'スキップ', '失敗', '完了時刻', '取消']) {
    assert.ok(SCRIPT.includes(`'${label}'`), `結果に ${label} が無い`);
  }
  assert.match(SCRIPT, /summarizeSendResult\(/, '結果の要約を単一源で作っていない');
});

test('guard(ui): 部分失敗を成功と読ませず、再送ボタンを自動表示しない', () => {
  assert.match(SCRIPT, /res\.outcome\.key === 'PARTIAL' \|\| res\.outcome\.key === 'FAILED'/, '部分失敗を区別していない');
  assert.equal(/再送する|自動再送/.test(SCRIPT), false, '再送ボタンを自動で出している');
});

// ── 一覧のコンパクト化とページング（2026-08-02）─────────────────
test('guard(ui): 42 名でもページングで短く出す（25 / 50 / 100）', () => {
  assert.match(PAGE, /id="mkPageSize"/, '表示件数の切替が無い');
  for (const n of [25, 50, 100]) assert.ok(PAGE.includes(`value="${n}"`), `${n} 件が選べない`);
  assert.match(PAGE, /id="mkPrevPage"|id="mkNextPage"/, 'ページ送りが無い');
  assert.match(SCRIPT, /件中 .* 件|' 件中 '/, '「42 件中 1〜25 件」を出していない');
  assert.match(SCRIPT, /function mkPageInfo\(/, 'ページ範囲の計算が無い');
});

test('guard(ui): 一覧は絞り込み → 検索 → 現在ページの順で切り出す（再帰しない）', () => {
  assert.match(SCRIPT, /function mkScopedRows\(/, '絞り込みの母集合が無い');
  assert.match(SCRIPT, /function mkSearchedRows\(/, '検索適用が無い');
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkVisibleRows('), SCRIPT.indexOf('function mkVisibleRows(') + 400);
  assert.equal(/mkVisibleRows\(\)/.test(block.replace('function mkVisibleRows(', '')), false,
    'mkVisibleRows が自分自身を呼んでいる（無限再帰）');
});

test('guard(ui): 選択者のみ / 送信可能のみで絞り込める', () => {
  assert.match(PAGE, /id="mkViewMode"/, '絞り込み切替が無い');
  for (const v of ['sendable', 'selected']) assert.ok(PAGE.includes(`value="${v}"`), `${v} が無い`);
  assert.match(SCRIPT, /mkList\.view === 'selected'/, '選択者のみを実装していない');
});

test('guard(ui): 一覧の表示が変わったら dry-run を失効させる', () => {
  assert.match(SCRIPT, /function mkChangeList\(/, '表示変更の入口が無い');
  assert.match(SCRIPT, /mkInvalidateDryRun\('一覧の表示が変わりました。'\)/, 'ページ変更で失効させていない');
});

test('guard(ui): 一覧は行を詰めて表示し、選択列と顧客列を固定する', () => {
  assert.match(PAGE, /\.ppe \.tbl\.is-compact td/, 'コンパクト表示の指定が無い');
  assert.match(PAGE, /\.ppe \.tbl\.is-compact thead th\.c-chk[\s\S]{0,140}position: sticky/, '選択列が固定されていない');
  assert.match(SCRIPT, /classList\.add\('is-compact'\)/, 'コンパクト表示を適用していない');
});

test('guard(ui): 取得結果の要約（該当 / 送信可能 / 送信不可 / 選択）を出す', () => {
  assert.match(PAGE, /id="mkListSummary"/, '要約表示が無い');
  assert.match(SCRIPT, /該当 ' \+ rows\.length \+ ' 名（送信可能/, '要約の内訳が無い');
});

// ── カムバックの対象区分（2026-08-02）───────────────────────────
test('guard(ui): 「現有効会員を含める」は既定 OFF で警告つき', () => {
  assert.match(PAGE, /id="cbIncludeActive"/, '危険操作のトグルが無い');
  assert.equal(/id="cbIncludeActive"[^>]*checked/.test(PAGE), false, '既定で ON になっている');
  assert.match(PAGE, /通常のカムバック施策では使用しません/, '警告文が無い');
  assert.match(PAGE, /chk-danger/, '危険操作として見せていない');
});

test('guard(ui): カムバックの対象区分を表示する場所がある', () => {
  assert.match(PAGE, /id="cbAudience"/, '対象区分の表示領域が無い');
});

// ── カムバック特典タブの Step UI（2026-08-02）───────────────────
test('guard(cb): Step 1〜5 のカードとナビがある', () => {
  assert.match(PAGE, /id="cbSteps"/, 'Step ナビが無い');
  for (const [n, label] of [[1, '対象者を探す'], [2, '対象者を選ぶ'], [3, '付与する特典を決める'],
    [4, '変更内容を確認する'], [5, '特典を付与する']]) {
    assert.ok(PAGE.includes(label), `Step ${n} の見出しが無い: ${label}`);
    assert.ok(PAGE.includes(`data-cbcard="${n}"`), `Step ${n} のカードが無い`);
  }
  assert.match(SCRIPT, /resolveCbStep\(/, '現在地を単一源で判定していない');
  assert.match(SCRIPT, /classList\.toggle\('is-locked'/, '未到達 Step を操作不可にしていない');
});

test('guard(cb): 契約状態を「有効」ではなくカムバックの言葉で出す', () => {
  // 検査対象はカムバックタブだけ（顧客マーケティングタブは有効会員も正当な対象）
  const CB = PAGE.slice(PAGE.indexOf('id="paneCb"'), PAGE.indexOf('id="mkBackdrop"'));
  assert.match(CB, /カムバック候補すべて/, '既定の選択肢が無い');
  assert.match(CB, /現在有効な会員（通常は選択しない）/, '注意書きつきの表現になっていない');
  assert.equal(/<option value="active">有効<\/option>/.test(CB), false, '「有効」のままの選択肢が残っている');
  assert.match(CB, /value="active" class="opt-danger"/, '警告色になっていない');
  assert.match(CB, /<optgroup/, '区切り線の下に置いていない');
});

test('guard(cb): 現有効会員を選んだら警告を出す', () => {
  assert.match(SCRIPT, /ACTIVE_FILTER_WARNING/, '警告文を使っていない');
  assert.match(SCRIPT, /isActiveMemberIncluded\(selections\.cbContract\)/, '現有効会員の選択を検知していない');
});

test('guard(cb): 取得ボタンは「対象候補を表示」、確認は「付与内容を確認」', () => {
  assert.match(PAGE, /id="cbLoad"[^>]*>[^<]*対象候補を表示/, '取得ボタンの文言が古い');
  assert.match(PAGE, /id="cbDryRun"[^>]*>[^<]*付与内容を確認/, '確認ボタンの文言が古い');
  assert.match(PAGE, /この時点では顧客データを変更しません/, '補足が無い');
});

test('guard(cb): 確認結果は条件・選択・特典の変更で失効する', () => {
  assert.match(SCRIPT, /cbInvalidate\('対象条件が変わりました。'\)/, '条件変更で失効しない');
  assert.match(SCRIPT, /cbInvalidate\('選択した顧客が変わりました。'\)/, '選択変更で失効しない');
  assert.match(SCRIPT, /cbInvalidate\('特典の内容が変わりました。'\)/, '特典変更で失効しない');
  assert.match(SCRIPT, /isCbDryStale\(/, '失効判定を単一源で行っていない');
});

test('guard(cb): 現有効会員の混入時は実行できない', () => {
  assert.match(SCRIPT, /canApply\(cbState\)/, '実行可否を単一源で判定していない');
  assert.match(SCRIPT, /現在有効な会員が含まれています/, '混入時の警告が無い');
});

test('guard(cb): 実行は人数入力つきの二段階確認', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf("$('cbApplyBtn')"));
  assert.match(block, /window\.confirm\(/, '確認ダイアログが無い');
  assert.match(block, /window\.prompt\(/, '人数入力が無い');
  assert.match(block, /付与予定人数/, '人数確認の文言が無い');
  assert.match(block, /operationId: cbState\.dryRun\.operationId/, 'dry-run と同じ operationId を使っていない（冪等性）');
});

test('guard(cb): 変更しないもの・メール送信しないことを必ず出す', () => {
  assert.match(SCRIPT, /UNCHANGED_NOTICE/, '変更しない項目の明示が無い');
  assert.match(SCRIPT, /APPLY_EFFECT_NOTICE/, '実行の影響の明示が無い');
  assert.match(PAGE, /この操作だけでは<b>メールを送信しません<\/b>/, '安全事項が無い');
});

test('guard(cb): 専用の追従バーに次の操作を 1 つだけ出す', () => {
  assert.match(PAGE, /id="cbStickyBar"/, '追従バーが無い');
  for (const id of ['cbSbLeft', 'cbSbOffer', 'cbSbReview', 'cbSbNext']) {
    assert.ok(PAGE.includes(`id="${id}"`), `追従バーに ${id} が無い`);
  }
  assert.match(SCRIPT, /buildCbStickyView\(/, '表示内容を単一源で作っていない');
});

test('guard(cb): 特典は平文で要約し、内部用語を使わない', () => {
  assert.match(SCRIPT, /describeOfferSelection\(/, '平文の要約が無い');
  assert.equal(/Light 特典（ベース）/.test(PAGE), false, '内部用語（ベース）が残っている');
  assert.equal(/Premium 特典（上位・任意）/.test(PAGE), false, '内部用語（上位・任意）が残っている');
});

test('guard(cb): 実行結果に人数・operationId・実行日時を出す', () => {
  assert.match(SCRIPT, /function cbRenderApplyResult\(/, '結果表示が無い');
  for (const label of ['付与できた人数', '除外', '失敗', '操作 ID', '実行日時']) {
    assert.ok(SCRIPT.includes(`'${label}'`), `結果に ${label} が無い`);
  }
});

// ── 配色とボタンの視認性（2026-08-02）─────────────────────────
test('guard(design): 色の役割を CSS 変数で固定する（直書きを増やさない）', () => {
  for (const token of ['--action-blue', '--action-green', '--action-yellow', '--action-orange',
    '--action-red', '--action-purple', '--surface-raised', '--surface-active',
    '--text-main', '--text-muted', '--border-soft', '--focus-ring']) {
    assert.ok(PAGE.includes(`${token}:`), `デザイントークン ${token} が無い`);
  }
});

test('guard(design): ボタンの階層（主要 / 補助 / 危険）が定義されている', () => {
  for (const cls of ['.btn-lg', '.btn-md', '.btn-primary', '.btn-success', '.btn-warning',
    '.btn-caution', '.btn-danger', '.btn-secondary', '.btn-purple']) {
    assert.ok(PAGE.includes(`.ppe ${cls}`), `ボタン種別 ${cls} が無い`);
  }
  assert.match(PAGE, /\.ppe \.btn-lg \{[^}]*min-height: 50px/, '主要ボタンが大きくない');
  assert.match(PAGE, /\.ppe \.btn-lg \{[^}]*font-size: 16px/, '主要ボタンの文字が小さい');
});

test('guard(design): 主要操作は大きく、意味の色とアイコンを持つ', () => {
  for (const [id, cls, icon] of [
    ['cbLoad', 'btn-lg', '🔍'], ['cbDryRun', 'btn-success', '✅'], ['cbApplyBtn', 'btn-primary', '📋'],
    ['mkLoad', 'btn-lg', '🔍'], ['mkDryRun', 'btn-success', '✅'], ['mkDispatchRun', 'btn-danger', '📩'],
  ]) {
    const m = PAGE.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"[^>]*>([^<]*)`));
    assert.ok(m, `${id} が見つからない`);
    assert.ok(m[1].includes(cls), `${id} に ${cls} が無い: ${m[1]}`);
    assert.ok(m[2].includes(icon), `${id} にアイコン ${icon} が無い: ${m[2]}`);
  }
});

test('guard(design): 危険操作は赤系 + 警告アイコン + 無効時に aria-disabled', () => {
  for (const id of ['mkDispatchRun']) {
    const m = PAGE.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `${id} が無い`);
    assert.match(m[0], /btn-danger/, `${id} が危険操作の色でない`);
    assert.match(m[0], /aria-disabled="true"/, `${id} に aria-disabled が無い`);
  }
  // カムバックの Step 5 は**確認画面を開くだけ**なので危険色にしない
  const cbApply = PAGE.match(/<button[^>]*id="cbApplyBtn"[^>]*>/);
  assert.ok(cbApply, 'cbApplyBtn が無い');
  assert.equal(/btn-danger/.test(cbApply[0]), false, 'Step 5 が危険色のままになっている');
  assert.match(cbApply[0], /aria-disabled="true"/, 'cbApplyBtn に aria-disabled が無い');
});

test('guard(design): Step ナビは丸番号 + アイコン + 補足を持つ', () => {
  assert.match(PAGE, /class="stp-n"/, '番号が強調されていない');
  assert.match(PAGE, /class="stp-sub"/, '補足が無い');
  assert.match(PAGE, /\.ppe \.stepbar \.stp \{[^}]*min-height: 72px/, 'Step カードの高さが足りない');
  assert.match(PAGE, /\.ppe \.stepbar \.stp \.stp-n \{[^}]*font-size: 30px/, '番号が大きくない');
});

test('guard(design): 現在 / 完了 / 未到達を色と文言の両方で区別する', () => {
  assert.match(PAGE, /\.ppe \.stepbar \.stp\.is-now[\s\S]{0,200}--action-yellow/, '現在の段階が黄系でない');
  assert.match(PAGE, /\.ppe \.stepbar \.stp\.is-done[\s\S]{0,200}--action-green/, '完了が緑系でない');
  assert.match(SCRIPT, /ここを操作してください/, '現在地の文言が無い');
  assert.match(SCRIPT, /前の Step を完了してください/, '未到達の説明が無い');
  assert.match(SCRIPT, /'✅ 完了'/, '完了の文言が無い');
});

test('guard(design): 本番データ変更の赤い警告は確認モーダルにだけ置く', () => {
  // Step 5 は「まだ変更されない」ことを文章で伝える（赤にしない）
  assert.match(PAGE, /まだ付与されません/, 'Step 5 に「まだ変更されない」旨が無い');
  assert.equal(/\.ppe \.cb-step\[data-cbcard="5"\]\.is-now[\s\S]{0,120}--action-red/.test(PAGE), false,
    'Step 5 が赤系のまま（本番 write ではないので赤にしない）');
  // 本番 write の警告は確認モーダルの中に置く
  assert.match(SCRIPT, /APPLY_WRITE_NOTICE/, '本番変更の明示が確認モーダルに無い');
  assert.match(SCRIPT, /sec3\.className = 'dt-sec danger'/, '確認モーダルの実行区画が danger でない');
});

test('guard(design): 追従バーの次操作は状態ごとに色が変わる', () => {
  assert.match(SCRIPT, /\{ 1: 'btn-primary', 2: 'btn-warning', 3: 'btn-purple', 4: 'btn-success', 5: 'btn-danger'/,
    '状態別の色分けが無い');
  assert.match(PAGE, /\.ppe \.stickybar[\s\S]{0,200}border-top: 3px solid var\(--action-yellow\)/, '追従バーの上辺ラインが無い');
  assert.match(PAGE, /#cbSbNext[\s\S]{0,120}min-height: 52px/, '次操作ボタンが大きくない');
});

test('guard(design): 通知は 5 種類を色 + アイコン + 左ボーダーで分ける', () => {
  for (const cls of ['.notice-ok', '.notice-info', '.notice-warn', '.notice-caution', '.notice-err']) {
    assert.ok(PAGE.includes(`.ppe ${cls}`), `通知 ${cls} が無い`);
  }
  assert.match(PAGE, /\.ppe \.notice \{[^}]*border-left-width: 5px/, '左ボーダーが無い');
});

test('guard(design): 危険設定はオレンジ枠で「通常は変更しません」と書く', () => {
  assert.match(PAGE, /\.ppe \.danger-setting/, '危険設定のカードが無い');
  assert.match(PAGE, /通常は変更しません/, '注意書きが無い');
});

test('guard(design): focus-visible が定義され、無効ボタンはカーソルでも分かる', () => {
  assert.match(PAGE, /button:focus-visible[\s\S]{0,200}outline: 3px solid var\(--focus-ring\)/, 'focus 表示が弱い');
  assert.match(PAGE, /button\[disabled\] \{[^}]*cursor: not-allowed/, '無効ボタンのカーソル指定が無い');
});

test('guard(design): 状態は色だけでなく文言でも分かる（区分バッジ）', () => {
  assert.match(SCRIPT, /function cbSegmentBadge\(/, '区分バッジが無い');
  assert.match(SCRIPT, /segmentLabel\(segment\)/, 'バッジに文言が無い（色だけになっている）');
});

// ── 送信ジョブ一覧のレイアウト（2026-08-03 の縦組み不具合）──────────────

test('guard(ui): ジョブ一覧は時系列のグリッドを流用しない（縦組み防止）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('async function mkRenderJobs'));
  const body = block.slice(0, block.indexOf('async function ', 10) + 1 || 6000);
  // .tl-row は顧客カルテ用の 4 カラムグリッド。ここで使うと「取り消す」ボタンの
  // 列が幅を奪い、件数の列が潰れて 1 文字ずつ縦に折り返す
  assert.equal(/className = 'tl-row'/.test(body), false, 'ジョブ一覧が .tl-row を流用している');
  assert.match(body, /className = 'job-row'/, '専用クラスを使っていない');
  assert.match(PAGE, /\.ppe \.job-row \{[^}]*display: block/, 'ジョブ行が縦積みになっていない');
});

test('guard(ui): 件数は項目ごとの要素に分ける（語の途中で折り返さない）', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('async function mkRenderJobs'));
  assert.match(block.slice(0, 6000), /className = 'job-counts'/, '件数のまとまりが無い');
  assert.match(block.slice(0, 6000), /className = 'job-count'/, '件数を項目ごとに分けていない');
  // 1 つの長い文字列を作っていない（それが縦組みの原因だった）
  assert.equal(/counts\.textContent = '対象 '/.test(block.slice(0, 6000)), false,
    '件数を 1 つの文字列にまとめている');
  assert.match(PAGE, /\.ppe \.job-count \{[^}]*white-space: nowrap/, '項目内で折り返してしまう');
  assert.match(PAGE, /\.ppe \.job-counts \{[^}]*flex-wrap: wrap/, '項目の境目で折り返せない');
});

test('guard(ui): 取消ボタンは件数と同じ行に押し込まない', () => {
  assert.match(PAGE, /\.ppe \.job-row \.ops \{[^}]*margin/, '操作を独立した行にしていない');
});

// ── ジョブカードからの送信（2026-08-03）──────────────────────────

test('guard(ui): 送信待ちカードに「確認 → 送信」がある', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'));
  assert.ok(block.length > 500, '送信パネルが見つからない');
  assert.match(block, /配信内容を確認/, '確認ボタンが無い');
  assert.match(block, /このジョブを今すぐ送信/, '送信ボタンが無い');
  // 送信待ち以外のカードには出さない
  assert.match(SCRIPT, /SENDABLE_STATUS[\s\S]{0,80}mkBuildJobSendPanel/, '送信待ち以外にも出している');
});

test('guard(ui): 対象は jobId で固定し、画面の選択に依存しない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobPreflight'));
  assert.match(block, /mkDispatchCall\(true, job\.jobId\)/, '確認が jobId 指定でない');
  assert.match(block, /mkDispatchCall\(false, job\.jobId, pre\.willSend\)/, '送信が jobId 指定でない');
  // 顧客選択・絞り込み・キャンペーン選択を読まない
  for (const forbidden of ['mkSelected', 'mkState.campaignId', 'currentCampaign(', 'mkState.filters']) {
    assert.equal(block.includes(forbidden), false, `送信パネルが ${forbidden} に依存している`);
  }
});

test('guard(ui): 判定は単一源に委譲する（画面で再実装しない）', () => {
  assert.match(PAGE, /marketingJobSend\.js/, '判定モジュールを読み込んでいない');
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobPreflight'));
  for (const fn of ['buildJobPreflight(', 'canSendJob(', 'verifyJobSendPrecondition(', 'buildJobSendConfirmation(']) {
    assert.ok(block.includes(fn), `${fn} を使っていない`);
  }
});

test('guard(ui): 二重クリック・実行中・送信後の再実行を防ぐ', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobPreflight'));
  assert.match(block, /sendBtn\.dataset\.busy === '1'/, '二重クリック防止が無い');
  assert.match(block, /sendBtn\.disabled = !verdict\.allowed/, '押せない状態を反映していない');
  assert.match(block, /state\.sent = true/, '送信後の状態を持っていない');
  assert.match(block, /送信済み（このカードからは再送できません）/, '完了後の表示が無い');
});

test('guard(ui): 人数入力を必須にし、直前に確認を取り直す', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobPreflight'));
  assert.match(block, /window\.prompt\([^)]*送信予定人数/, '人数入力が無い');
  assert.match(block, /const latest = await mkDispatchCall\(true, job\.jobId\)/, '直前の再確認が無い');
  assert.match(block, /verifyJobSendPrecondition\(\{/, '照合していない');
});

test('guard(ui): 確認結果に必要な項目を出す', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkRenderJobPreflight'), SCRIPT.indexOf('function mkRenderJobSendResult'));
  for (const label of ['キャンペーン', '内容 hash', '組み立て版', 'キュー登録', '実送信予定', '除外', '除外理由']) {
    assert.ok(block.includes(label), `確認結果に ${label} が無い`);
  }
  assert.match(block, /配信停止リストの照合/, 'suppression の可否を出していない');
});

test('guard(ui): 取消ボタンは独立したまま（送信と混ぜない）', () => {
  assert.match(SCRIPT, /送信予定を取り消す/, '取消ボタンが消えている');
  const panel = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobPreflight'));
  assert.equal(panel.includes("action: 'cancelJob'"), false, '送信パネルに取消を混ぜている');
});

test('guard(ui): 送信パネルはモバイルで縦積みになる', () => {
  assert.match(PAGE, /@media \(max-width: 640px\) \{[\s\S]{0,300}\.ppe \.job-send-ops \{ flex-direction: column/,
    'モバイルでの縦積み指定が無い');
  assert.match(PAGE, /\.ppe \.job-send-ops button \{[^}]*min-height: 40px/, 'タップ領域が足りない');
});

test('guard(ui): secret をレスポンスや URL へ出さない', () => {
  const block = SCRIPT.slice(SCRIPT.indexOf('function mkBuildJobSendPanel'), SCRIPT.indexOf('function mkRenderJobSendResult'));
  assert.equal(/secretEl|x-admin-secret/.test(block), false, '送信パネルが secret を直接扱っている');
  assert.equal(/URLSearchParams|location\.(href|search)\s*=/.test(block), false, 'URL へ載せている');
});
