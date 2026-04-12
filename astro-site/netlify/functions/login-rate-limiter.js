// ログイン試行回数制限システム
// IPアドレスごとにログイン試行を追跡・制限

const Airtable = require('airtable');

// メモリ内のレート制限キャッシュ（本番環境ではRedis等を推奨）
const loginAttempts = new Map();
const ATTEMPT_LIMIT = 5; // 5回まで試行可能
const BLOCK_DURATION = 15 * 60 * 1000; // 15分間ブロック

// Airtableベースのブラックリスト（永続化）
async function checkBlacklist(ipAddress) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.warn('⚠️ Airtable設定なし - ブラックリストチェックスキップ');
    return false;
  }

  try {
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    const records = await base('LoginBlacklist')
      .select({
        filterByFormula: `{IPAddress} = '${ipAddress}'`,
        maxRecords: 1
      })
      .firstPage();

    return records.length > 0;
  } catch (error) {
    console.error('❌ ブラックリストチェックエラー:', error.message);
    return false; // エラー時は通過させる（サービス継続優先）
  }
}

// ブラックリストに追加
async function addToBlacklist(ipAddress, email) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.warn('⚠️ Airtable設定なし - ブラックリスト追加スキップ');
    return;
  }

  try {
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    await base('LoginBlacklist').create({
      'IPAddress': ipAddress,
      'Email': email,
      'BlockedAt': new Date().toISOString(),
      'Reason': '5回以上のログイン失敗',
      'AttemptCount': ATTEMPT_LIMIT
    });

    console.log(`🔒 ブラックリスト追加: ${ipAddress} (${email})`);
  } catch (error) {
    console.error('❌ ブラックリスト追加エラー:', error.message);
  }
}

// ログイン試行をチェック
function checkLoginAttempt(ipAddress) {
  const now = Date.now();
  const attempts = loginAttempts.get(ipAddress);

  if (!attempts) {
    // 初回試行
    loginAttempts.set(ipAddress, {
      count: 1,
      firstAttempt: now,
      blockedUntil: null
    });
    return { allowed: true, remaining: ATTEMPT_LIMIT - 1 };
  }

  // ブロック期間中かチェック
  if (attempts.blockedUntil && now < attempts.blockedUntil) {
    const remainingMinutes = Math.ceil((attempts.blockedUntil - now) / 60000);
    return {
      allowed: false,
      blocked: true,
      remainingMinutes
    };
  }

  // ブロック期間が終了していればリセット
  if (attempts.blockedUntil && now >= attempts.blockedUntil) {
    loginAttempts.set(ipAddress, {
      count: 1,
      firstAttempt: now,
      blockedUntil: null
    });
    return { allowed: true, remaining: ATTEMPT_LIMIT - 1 };
  }

  // 試行回数をカウント
  attempts.count++;
  loginAttempts.set(ipAddress, attempts);

  // 制限を超えた場合
  if (attempts.count >= ATTEMPT_LIMIT) {
    attempts.blockedUntil = now + BLOCK_DURATION;
    loginAttempts.set(ipAddress, attempts);

    return {
      allowed: false,
      blocked: true,
      remainingMinutes: 15
    };
  }

  return {
    allowed: true,
    remaining: ATTEMPT_LIMIT - attempts.count
  };
}

// ログイン成功時：カウンターをリセット
function resetLoginAttempts(ipAddress) {
  loginAttempts.delete(ipAddress);
  console.log(`✅ ログイン成功: ${ipAddress} - カウンターリセット`);
}

// ログイン失敗時：カウンターを増加
async function recordLoginFailure(ipAddress, email) {
  const result = checkLoginAttempt(ipAddress);

  if (result.blocked) {
    // 5回失敗でブラックリストに追加
    await addToBlacklist(ipAddress, email);
    console.log(`🚨 ログイン制限発動: ${ipAddress} (${email}) - 15分間ブロック`);
  } else {
    console.log(`⚠️ ログイン失敗: ${ipAddress} (${email}) - 残り${result.remaining}回`);
  }

  return result;
}

// クリーンアップ：古いエントリを削除（メモリ節約）
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    // ブロック期間終了 + 1時間経過したエントリを削除
    if (data.blockedUntil && now > data.blockedUntil + 3600000) {
      loginAttempts.delete(ip);
    }
  }
}, 3600000); // 1時間ごとにクリーンアップ

module.exports = {
  checkBlacklist,
  checkLoginAttempt,
  resetLoginAttempts,
  recordLoginFailure
};
