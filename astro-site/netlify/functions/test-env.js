import { withLambda } from '@netlify/aws-lambda-compat';
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'test-env' });
/**
 * 環境変数テスト用エンドポイント（デバッグ専用）
 * URL: /.netlify/functions/test-env
 */

const __lambdaHandler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // 環境変数の存在確認（値は表示しない）
  const envStatus = {
    AIRTABLE_API_KEY: !!process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: !!process.env.AIRTABLE_BASE_ID,
    SENDGRID_API_KEY: !!process.env.SENDGRID_API_KEY,
    BLASTMAIL_USERNAME: !!process.env.BLASTMAIL_USERNAME,
    BLASTMAIL_PASSWORD: !!process.env.BLASTMAIL_PASSWORD,
    BLASTMAIL_API_KEY: !!process.env.BLASTMAIL_API_KEY,
    MAKE_MAILHOOK_EMAIL: !!process.env.MAKE_MAILHOOK_EMAIL,

    // 長さも確認（設定されているが空文字の場合を検出）
    lengths: {
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY?.length || 0,
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID?.length || 0,
      SENDGRID_API_KEY: process.env.SENDGRID_API_KEY?.length || 0
    }
  };

  console.log('🔍 Environment variables check:', envStatus);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: '環境変数チェック完了',
      status: envStatus,
      timestamp: new Date().toISOString()
    }, null, 2)
  };
};

export default withLambda(__lambdaHandler);
