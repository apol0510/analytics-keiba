#!/usr/bin/env node

/**
 * ウェルカムメール復活防止チェックスクリプト
 * 削除されたウェルカムメール機能の復活を検知・阻止
 */

const fs = require('fs');
const path = require('path');

// 復活禁止対象の検索パターン
const FORBIDDEN_PATTERNS = [
  'sendWelcomeEmail',
  'HTMLメールテンプレート',
  '8912keibalink',
  'process.env.SITE_URL.*dashboard',
  'ウェルカムメール送信成功',
  'NANKANアナリティクスへようこそ',
  'マイページにログイン 📊'
];

// チェック対象ファイル
const TARGET_FILES = [
  'netlify/functions/auth-user.js',
  'netlify/functions/send-newsletter.js',
  'netlify/functions/contact-form.js'
];

function checkFile(filePath) {
  console.log(`🔍 チェック中: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️ ファイルが存在しません: ${filePath}`);
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const violations = [];

  FORBIDDEN_PATTERNS.forEach(pattern => {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(content)) {
      // コメント内での言及は除外
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (regex.test(line) && !line.trim().startsWith('//') && !line.includes('復活禁止') && !line.includes('削除済み')) {
          violations.push({
            pattern,
            line: index + 1,
            content: line.trim()
          });
        }
      });
    }
  });

  if (violations.length > 0) {
    console.log(`🚨 復活禁止違反を検出: ${filePath}`);
    violations.forEach(v => {
      console.log(`   行 ${v.line}: ${v.pattern} -> ${v.content}`);
    });
    return true;
  } else {
    console.log(`✅ 問題なし: ${filePath}`);
    return false;
  }
}

function main() {
  console.log('🚫 ウェルカムメール復活防止チェック開始\n');

  let hasViolations = false;

  TARGET_FILES.forEach(file => {
    if (checkFile(file)) {
      hasViolations = true;
    }
    console.log('');
  });

  if (hasViolations) {
    console.log('🚨 復活禁止違反が検出されました！');
    console.log('📋 対応方法:');
    console.log('   1. 削除された機能を再削除してください');
    console.log('   2. 新規メール機能は別ファイルで実装してください');
    console.log('   3. WELCOME_EMAIL_REVIVAL_PREVENTION.mdを参照してください');
    process.exit(1);
  } else {
    console.log('✅ 復活防止チェック完了: 問題ありません');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkFile, FORBIDDEN_PATTERNS };