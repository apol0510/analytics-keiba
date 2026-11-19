// ポイント交換申請処理
// Airtableに申請データ保存 + SendGridメール通知
// 2026-11-19: 本人はセッション（ak_session）だけで決め、保有ポイント・特典・必要ポイントはサーバー側で決める。
//   メール HTML の値はエスケープし、ログにメールアドレス・氏名を出さない。
//   判定と処理は src/lib/membership/pointExchangeServer.js（単一源）。
// 2026-08-31 管理者宛先・送信元を単一源 config/email-config.js へ統一

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'point-exchange' });
import { ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
import { handlePointExchangeRequest } from '../../src/lib/membership/pointExchangeServer.js';

const sgMail = require('@sendgrid/mail');

exports.handler = async (event) => {
  if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  return handlePointExchangeRequest(event, process.env, {
    deps: {
      adminEmail: ADMIN_EMAIL,
      fromEmail: FROM_EMAIL,
      sendMail: process.env.SENDGRID_API_KEY ? (msg) => sgMail.send(msg) : null,
    },
  });
};
