/**
 * adminMarketingFunction.guard.test.mjs — Function 本体の安全条件をソースで固定する
 *   node --test src/lib/marketing/adminMarketingFunction.guard.test.mjs
 *
 * ここで守るのは「実装を後から書き換えても壊せない」性質:
 *   1. この Function は自分でメールを送らない（SendGrid を呼ばない）
 *   2. Customers を書き換えない（PATCH/POST/DELETE の対象にしない）
 *   3. KMA（keiba-marketing-automation）のテーブル・env を使わない
 *   4. 決済メール v2 / 権限 / Premium Plus 販売資格のフィールドを書かない
 *   5. live 送信は env で二重に閉じている（既定 OFF）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MK_FORBIDDEN_CUSTOMER_FIELDS } from './campaignSend.js';

const fnPath = fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url));
const src = readFileSync(fnPath, 'utf8');
/** コメントを除いた実コード（説明文で guard が誤検知しないようにする） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 関数 1 本ぶんを切り出す（**固定バイト数で切らない**）。
 *
 * 以前は `slice(from, from + 2500)` のような固定窓で見ていたため、
 * 関数へ安全条件を足して長くなるだけで、判定対象が窓の外へ落ちて
 * guard が「順序が壊れた」と誤検知した（2026-08-15）。
 * 窓の大きさに意味は無いので、閉じ括弧まで取る。
 */
function sliceFunction(source, name) {
  const from = source.indexOf(`async function ${name}`);
  if (from === -1) return '';
  const m = source.slice(from).match(/^[\s\S]*?\n\}/);
  return m ? m[0] : source.slice(from);
}

test('1. メール送信 API を呼ばない（suppression の読み取りだけは許可）', () => {
  for (const banned of ['mail/send', '@sendgrid', 'nodemailer', 'resend.com']) {
    assert.equal(code.toLowerCase().includes(banned.toLowerCase()), false, `${banned} を呼んでいる`);
  }
  // SendGrid へ触れるのは suppression の GET のみ。送信 API のエンドポイントは持たない。
  assert.equal(/api\.sendgrid\.com/.test(code), false, '直接 SendGrid のエンドポイントを組み立てている');
  // 鍵は suppression 読み取りモジュールへ渡すためだけに参照する
  assert.ok(code.includes('fetchProviderSuppression'), 'provider suppression を確認していない');
});

test('2. Customers を書き換えない（GET 以外の対象にしない）', () => {
  // Customers テーブルを指す URL が PATCH / POST / DELETE と同じ fetch 呼び出しに現れないこと
  const writeCalls = [...code.matchAll(/method:\s*'(PATCH|POST|DELETE|PUT)'/g)];
  assert.ok(writeCalls.length > 0, '書き込み経路が消えている（テストの前提が壊れた）');
  // 書き込みヘルパーは CampaignDeliveries / ScheduledEmails のみを対象にする
  const writeTargets = [...code.matchAll(/\$\{encodeURIComponent\(table\)\}|\$\{DELIVERIES_TABLE\}/g)];
  assert.ok(writeTargets.length > 0);
  assert.equal(/CUSTOMERS_TABLE[^\n]*method/.test(code), false);
  // createRecord / upsert に Customers を渡している箇所が無いこと
  assert.equal(/table:\s*CUSTOMERS_TABLE[\s\S]{0,200}?method/.test(code), false, 'Customers を書き込み経路へ渡している');
  for (const m of code.matchAll(/createRecord\(\{[^}]*table:\s*([A-Za-z_]+)/g)) {
    assert.notEqual(m[1], 'CUSTOMERS_TABLE', 'Customers を createRecord へ渡している');
  }
});

test('3. KMA のテーブル / env を使わない（統合しない）', () => {
  for (const banned of [
    'CampaignDeliveries_MarketingAutomation', 'CampaignDeliveries_M5A3LiveTest',
    'MARKETING_AUTOMATION', 'keiba-marketing-automation', 'KMA_',
  ]) {
    assert.equal(code.includes(banned), false, `KMA の資産 ${banned} を参照している`);
  }
  assert.ok(code.includes("DELIVERIES_TABLE = 'CampaignDeliveries'"), 'AK 自身の台帳を使っていない');
});

test('4. 決済 / 権限 / Premium Plus 販売資格のフィールドを書かない（読み取りは可）', () => {
  // 書き込み payload は `fields: { ... }` リテラルだけ。その中身に禁止名が無いことを見る。
  // （表示のために プラン / PremiumPlusEligibility を **読む** のは正当なので全文検索はしない）
  // ⚠️ ScheduledEmails の payload は **共通契約モジュール** へ抽出済み
  //    （手動送信と自動配信で同じ行を作るため）。検査対象も追随させる。
  const CONTRACT = readFileSync(
    fileURLToPath(new URL('./marketingEnqueueContract.js', import.meta.url)), 'utf8',
  );
  const payloads = [
    ...[...code.matchAll(/fields:\s*\{([\s\S]*?)\n\s{6}\},/g)].map((m) => m[1]),
    ...[...CONTRACT.matchAll(/return \{([\s\S]*?)\n\s{2}\};/g)].map((m) => m[1]),
  ];
  assert.ok(payloads.length > 0, '書き込み payload を検出できない（テストの前提が壊れた）');
  for (const p of payloads) {
    // 「キーとして」現れていないかを見る（TargetPlan のような別カラムに部分一致させない）
    const keys = [...p.matchAll(/(?:^|[\s,{])'?([A-Za-z_぀-ヿ一-龯]+)'?\s*:/gm)].map((m) => m[1]);
    for (const f of MK_FORBIDDEN_CUSTOMER_FIELDS) {
      if (f === 'Status') continue; // ScheduledEmails / CampaignDeliveries 自身の列
      assert.equal(keys.includes(f), false, `書き込み payload に禁止フィールド ${f} がある`);
    }
    // ScheduledEmails の Status は PENDING（送信基盤へ渡すキュー状態）のみ
    if (p.includes('Status:')) {
      assert.ok(/Status:\s*'(PENDING|queued)'/.test(p), '想定外の Status を書いている');
    }
  }
  // Premium Plus の販売資格判定モジュールを import していない（販売と販促の分離）
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const i of imports) assert.equal(i.includes('premiumPlus'), false, `${i} を import している`);
});

test('5. live 送信は既定 OFF（env が無ければ書き込みへ到達しない）', () => {
  assert.ok(code.includes('isMarketingEnqueueEnabled'), 'live gate（キュー登録）が無い');
  assert.ok(code.includes('isMarketingSendEnabled(process.env)'), 'live gate を使っていない');
  // gate 判定より前に書き込みが起きないこと（gate → 書き込みの順序）
  const gateIdx = code.indexOf('if (live && !isMarketingSendEnabled');
  const writeIdx = Math.min(
    ...['upsertDeliveries(', 'createRecord('].map((s) => {
      const i = code.indexOf(s, code.indexOf('async function handlePlan'));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  assert.ok(gateIdx > 0 && gateIdx < writeIdx, 'live gate が書き込みより後ろにある');
});

test('6. send は dry-run の確認トークン必須（TOCTOU 防止）', () => {
  assert.ok(code.includes('planFingerprint'), '確認トークンを使っていない');
  assert.ok(/token\s*!==\s*plan\.planFingerprint/.test(code), 'トークン照合が無い');
  assert.ok(code.includes('409'), '不一致時に中止していない');
});

test('7. 冪等 upsert のマージキーが DeliveryKey である', () => {
  assert.ok(code.includes("fieldsToMergeOn: ['DeliveryKey']"), 'DeliveryKey で冪等化していない');
});

test('8. 認可がある（secret 未設定なら機能無効）', () => {
  assert.ok(code.includes('x-admin-secret'), '認可ヘッダを見ていない');
  assert.ok(code.includes('return json(403'), '不一致で 403 にしていない');
  assert.ok(/if \(!SECRET\) return json\(503/.test(code), 'secret 未設定で無効化していない');
});

test('9. secret やレコード内容をログへ出さない', () => {
  const logs = [...code.matchAll(/console\.(log|error|warn)\(([^\n]*)/g)].map((m) => m[2]);
  for (const l of logs) {
    for (const banned of ['SECRET', 'KEY', 'provided', 'fields', 'email', 'Email']) {
      assert.equal(l.includes(banned), false, `ログに ${banned} を出している: ${l.slice(0, 80)}`);
    }
  }
});

test('10. モジュールとして読み込める（handler が公開されている）', async () => {
  const mod = await import(fnPath);
  assert.equal(typeof mod.handler, 'function');
  assert.equal(mod.isMarketingSendEnabled({}), false, 'env 未設定で送信が有効になっている');
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: 'false' }), false);
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: '1' }), false, "'true' 以外は無効");
  assert.equal(mod.isMarketingSendEnabled({ MARKETING_CAMPAIGN_ENABLED: 'true' }), true);
});

test('11. 実送信の判定が NEWSLETTER_AUTOMATION_ENABLED から独立している', async () => {
  const mod = await import(fnPath);
  assert.equal(mod.isDispatchEnabled({}), false);
  // 既存メールのマスタースイッチを ON にしてもキャンペーンは送信可にならない
  assert.equal(mod.isDispatchEnabled({ NEWSLETTER_AUTOMATION_ENABLED: 'true' }), false,
    'newsletter の global gate でキャンペーンが解禁されている');
  // 専用ゲートだけで判定する
  assert.equal(mod.isDispatchEnabled({ MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }), true);
});

test('12. provider suppression を確認できないときは中止する（fail closed）', () => {
  assert.ok(code.includes('provider_suppression_unavailable'), '確認失敗を検知していない');
  assert.match(code, /return json\(503, \{\s*error: 'SendGrid の配信停止リストを確認できないため中止/,
    '確認できないまま続行している');
});

// ── 反応の取得範囲を偽らない（2026-08-01）──────────────────────────
// 取得できているのに「取得できませんでした」と出す/その逆は、
// 「不明」と「反応なし」を区別するというこの機能の目的そのものを壊す。
test('12. engagementSource の note は deliveryActivity の戻り値キーと一致する', async () => {
  const mod = await import('./deliveryActivity.js');
  // モジュールが返すキー名を実測し、Function 側が別名を読んでいないか確かめる
  const result = await mod.fetchDeliveryActivity({ email: '', apiKey: '' });
  assert.ok('note' in result, 'deliveryActivity が note を返さなくなった');
  assert.equal('retentionNote' in result, false, 'retentionNote は使わない');

  assert.match(code, /note:\s*activity\.note/, 'Function が activity.note を読んでいない');
  assert.equal(/activity\.retentionNote/.test(code), false, '存在しないキーを読んでいる');
});

test('13. 取得できたときは「取得できませんでした」と表示しない', async () => {
  const mod = await import('./deliveryActivity.js');
  const fakeFetch = async (url) => {
    if (String(url).includes('?limit=')) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ msg_id: 'm1', last_event_time: '2026-08-01T00:00:00Z', status: 'delivered', subject: 's' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ events: [{ event_name: 'open', processed: '2026-08-01T00:01:00Z' }] }) };
  };
  const r = await mod.fetchDeliveryActivity({ email: 'a@b.co', apiKey: 'k', fetchImpl: fakeFetch });
  assert.equal(r.available, true);
  // 「全部ダメでした」を意味する固有文言が出ていないこと（『それ以前は取得できません』は正しい説明なので許す）
  assert.equal(r.note.includes('取得できませんでした'), false, '取得できているのに失敗文言を出している');
  assert.equal(r.note.includes('反応が無かったという意味ではありません'), false);
  assert.match(r.note, /直近 1 通/);
});

// ── 恒久台帳（EmailEvents）の read-only 配線（Phase 1d）─────────────
test('guard: 台帳は read-only（GET のみ）で、この顧客の resolved 行だけを引く', () => {
  assert.match(src, /async function fetchCustomerLedgerEvents/, '台帳取得の関数が無い');
  const from = src.indexOf('async function fetchCustomerLedgerEvents');
  const to = src.indexOf('\n/**', from + 10);
  const fn = src.slice(from, to > from ? to : from + 1200);
  assert.match(fn, /\{ResolutionStatus\}='resolved'/, 'resolved 以外も顧客の反応として引いている');
  assert.match(fn, /\{CustomerRecordId\}='\$\{id\}'/, 'CustomerRecordId で絞っていない');
  assert.match(fn, /\^rec\[A-Za-z0-9\]\{14\}\$/, 'recordId 形式を検証していない（formula injection）');
  assert.equal(/method: 'PATCH'|method: 'POST'|method: 'DELETE'/.test(fn), false, '台帳へ書き込んでいる');
});

test('guard: 台帳を引けないときは 0 件ではなく「取得不能」として返す', () => {
  assert.match(src, /ledgerSource: \{[\s\S]{0,400}available: ledger\.available/, '取得可否を画面へ返していない');
  assert.match(src, /取得できませんでした（反応が無かったという意味ではありません）/,
    '取得不能の注記が無い（0 件と混同する）');
  assert.match(src, /return \{ rows: \[\], available: false \}/, '失敗時に available:false を返していない');
});

test('guard: 台帳テーブル名は受信側の単一源から取る', () => {
  assert.match(src, /EMAIL_EVENTS_TABLE as EMAIL_EVENTS_TABLE_NAME.*emailEventLedger\.js/,
    'テーブル名を admin 側で直書きしている');
  assert.equal(/['"]EmailEvents['"]/.test(src), false, 'テーブル名のリテラルが admin 側にある');
});

// ── 送信状況・取消（運用機能 / 2026-08-02）────────────────────────
test('guard: 取消は単一源 marketingJobs.js に委譲する（Function に再実装しない）', () => {
  assert.match(src, /from '[^']*marketing\/marketingJobs\.js'/, '取消の単一源を import していない');
  assert.match(src, /canCancelJob\(/, '取消可否の判定を単一源で行っていない');
  assert.match(src, /buildJobCancelFields\(/);
  assert.match(src, /selectCancelableDeliveries\(/, '取消対象の選別を単一源で行っていない');
  assert.equal(/Status: 'CANCELLED'/.test(src), false, 'Function 側で取消の状態値を直書きしている');
});

test('guard: 取消は operationId 必須で冪等（同じ取消を 2 回書かない）', () => {
  assert.match(src, /操作 ID（operationId）が必要です/, 'operationId 無しを拒否していない');
  assert.match(src, /isAlreadyCancelledBy\(\{ job, operationId \}\)/, '実施済み判定をしていない');
  const seg = sliceFunction(src, 'handleCancelJob');
  const idemIdx = seg.indexOf('isAlreadyCancelledBy');
  const writeIdx = seg.indexOf('patchRecord(');
  assert.ok(idemIdx > -1 && writeIdx > idemIdx, '冪等判定より前に書き込んでいる');
});

test('guard: 取消は sent の配信行に触れない', () => {
  const seg = sliceFunction(src, 'handleCancelJob');
  assert.match(seg, /selectCancelableDeliveries\(/, '対象を絞らずに配信行を書き換えている');
  assert.equal(/Status: 'sent'/.test(seg), false, '送信済みの状態を書き換えている');
});

test('guard: 取消の書き込みは allow-list を通す', () => {
  assert.match(src, /assertOnlyCancelFields\(deliveryFields, DELIVERY_CANCEL_WRITABLE_FIELDS\)/);
  assert.match(src, /assertOnlyCancelFields\(jobFields, JOB_CANCEL_WRITABLE_FIELDS\)/);
});

test('guard: 送信経路を増やさない（admin から SendGrid を直接叩かない）', () => {
  for (const banned of ['mail/send', '@sendgrid', 'nodemailer', 'resend.com']) {
    assert.equal(code.includes(banned), false, `admin が送信経路 ${banned} を持っている`);
  }
});

test('guard: ジョブ一覧はマーケティングジョブだけを返す', () => {
  assert.match(src, /buildJobView\(\{ jobRecords: scheduled, deliveryRecords: deliveries, isMarketingJob \}\)/,
    'マーケティング以外のジョブを混ぜている');
});

test('guard: ジョブ一覧・取消の応答にアドレスを載せない', () => {
  const from = src.indexOf('async function handleJobs');
  const to = src.indexOf('async function handleHistory');
  const seg = src.slice(from, to > from ? to : from + 3000);
  // EmailType / ScheduledEmailJobId は列名なので誤検知しないよう、宛先そのものだけを見る
  for (const banned of ['RecipientEmail', 'fields.Email', 'email:']) {
    assert.equal(seg.includes(banned), false, `応答に ${banned} を載せている`);
  }
});

// ── Blobs へ触るときは接続してから（2026-08-16）─────────────────
test('【重要】Blob を読む前に connectLambda する（v1 Function の必須手順）', () => {
  const fn = src.slice(src.indexOf('async function handleEventBackfill'));
  const getAt = fn.indexOf("getStore('ak-email-events')");
  const connectAt = fn.indexOf('connectLambda(event)');
  assert.ok(getAt > -1, 'Blob を読んでいない');
  assert.ok(connectAt > -1, 'connectLambda を呼んでいない（MissingBlobsEnvironmentError になる）');
  assert.ok(connectAt < getAt, 'getStore の後に接続している');
});

test('【重要】backfill の下見は 1 バイトも書かない', () => {
  const fn = src.slice(
    src.indexOf('async function handleEventBackfill'),
    src.indexOf('async function handleDuplicateCheck'),
  );
  // 下見の分岐（live でない）は必ず sideEffects: 'none' で返す
  assert.ok(fn.includes("mode: 'event-backfill-dry-run'"));
  assert.ok(fn.includes("sideEffects: 'none'"));
  // 索引以外へ書かない（Customers・台帳・送信に触れない）
  assert.equal(/method: 'PATCH'|method: 'POST'|upsertDeliveries|createRecord|sendgrid/.test(fn), false,
    '索引以外へ書いている');
});

test('【重要】backfill の実行は確認つき（confirm + 件数一致 + conflict 0）', () => {
  const fn = src.slice(
    src.indexOf('async function handleEventBackfill'),
    src.indexOf('async function handleDuplicateCheck'),
  );
  assert.ok(fn.includes('req.confirm !== true'), '確認なしで実行できる');
  assert.ok(fn.includes('expectedWriteKeys'), '下見との件数一致を要求していない');
  assert.ok(fn.includes('view.conflicts > 0'), 'conflict があっても書いてしまう');
  // 書き込みは索引の共通関数（webhook と同じ経路）だけ
  assert.ok(fn.includes('createDeliveryEventIndex'), '索引の単一源を使っていない');
  assert.ok(fn.includes("sideEffects: '配信イベント索引（Redis）のみ'"));
});

test('【重要】touch 別計測は Blob 全件走査をしない', () => {
  const fn = src.slice(
    src.indexOf('async function handleTouchMeasurement'),
    src.indexOf('async function handleEventBackfill'),
  );
  assert.equal(fn.includes('getStore'), false, 'Blob を読んでいる');
  assert.ok(fn.includes('MAX_READ_KEYS'), 'Redis 読み取りに上限が無い');
});
