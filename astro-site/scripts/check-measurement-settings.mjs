#!/usr/bin/env node
/**
 * check-measurement-settings.mjs — 配信の計測が「効いているか」を **GET だけ**で確認する
 *
 *   netlify dev:exec --context production npm run check:measurement
 *   （env を直接持っているなら `SENDGRID_API_KEY=... npm run check:measurement` でも動く）
 *
 * ── 何のためにあるか ──────────────────────────────────────────
 * 開封・クリックが AK の台帳（EmailEvents）へ入るには **2 つが同時に成立**している必要がある:
 *   1. 配信基盤がその種別を計測している（tracking）
 *   2. Event Webhook がその種別を AK へ送る
 * 片方だけでは「0 件」に見えるが、実際は**測っていないだけ**。
 * 設定変更の**前後で同じ出力を取る**ことが、この作業の唯一の証拠になる。
 *
 * ── 安全 ──────────────────────────────────────────────────
 * - GET のみ。設定変更・送信・書き込みは一切しない（送信 API のパスを持たない）
 * - 鍵・Webhook URL・公開鍵は**値を出さない**（設定の有無と長さだけ）
 * - 終了コード: 計測が両方 enabled なら 0 / それ以外は 1（変更前は 1 で正常）
 *   `--allow-disabled` を付けると、取得できた時点で 0 を返す（変更前の記録取り用）
 */

import { readMeasurementSettings } from '../src/lib/crm/segmentInputs.js';
import { MEASURE } from '../src/lib/crm/deliveryMeasurement.js';

const SG_BASE = 'https://api.sendgrid.com';
const apiKey = process.env.SENDGRID_API_KEY;
const allowDisabled = process.argv.includes('--allow-disabled');

if (!apiKey) {
  console.error('❌ SENDGRID_API_KEY が無いため確認できません（「無効」ではなく「不明」です）');
  console.error('   netlify dev:exec --context production npm run check:measurement');
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(`${SG_BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return { __error: `http_${res.status}` };
  return res.json();
};

const [open, click, webhook] = await Promise.all([
  get('/v3/tracking_settings/open'),
  get('/v3/tracking_settings/click'),
  get('/v3/user/webhooks/event/settings'),
]);

const state = await readMeasurementSettings({ apiKey });

/** 値そのものは出さない（鍵・URL は設定の有無だけ分かればよい） */
const present = (v) => (v ? `設定あり(${String(v).length}文字)` : '未設定');

console.log('── 配信基盤の計測設定（read-only）──');
console.log(`取得時刻: ${new Date().toISOString()}`);
console.log('');
console.log(`open tracking : ${open.__error ? `取得不可(${open.__error})` : (open.enabled ? '有効' : '無効')}`);
console.log(`click tracking: ${click.__error ? `取得不可(${click.__error})` : (click.enabled ? '有効' : '無効')}`
  + (click.__error ? '' : ` / 本文テキストの書き換え: ${click.enable_text ? '有効' : '無効'}`));
if (webhook.__error) {
  console.log(`Event Webhook : 取得不可(${webhook.__error})`);
} else {
  console.log(`Event Webhook : ${webhook.enabled ? '有効' : '無効'}`);
  const flags = ['processed', 'delivered', 'deferred', 'bounce', 'dropped',
    'open', 'click', 'spam_report', 'unsubscribe'];
  console.log('  送る種別: ' + flags.map((k) => `${k}=${webhook[k] === true ? 'true' : 'false'}`).join(' '));
  console.log(`  通知先 URL: ${present(webhook.url)} / 署名用公開鍵: ${present(webhook.public_key)}`);
}
console.log('');
console.log(`判定: 開封=${state.openLabel} / クリック=${state.clickLabel}`);
if (state.reasons.length) console.log(`理由: ${state.reasons.join(' / ')}`);
console.log('');
console.log('※ AK 側の台帳書き込みには EMAIL_EVENT_LEDGER_ENABLED=true も必要です（本スクリプトでは判定しません）');
console.log('※ マーケティング配信のクリック計測は per-message 指定（MARKETING_CLICK_TRACKING_ENABLED）で行います。');
console.log('   配信基盤のアカウント設定を ON にすると、ログインリンクまで書き換わるため使いません。');

const ok = state.open === MEASURE.ENABLED && state.click === MEASURE.ENABLED;
if (ok) {
  console.log('\n✅ 開封・クリックとも AK の台帳へ入る設定です');
  process.exit(0);
}
console.log('\n⚠️ 開封・クリックのいずれかが台帳へ入りません（画面では「0」ではなく「—」と表示されます）');
process.exit(allowDisabled ? 0 : 1);
