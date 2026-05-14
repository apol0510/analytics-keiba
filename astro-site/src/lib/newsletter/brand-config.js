// ブランド別 fromEmail / fromName / 許可ドメイン の設定
// dry-run / test / production すべてのモードで必ず validateBrandFromEmail を通すこと。
// 誤って analytics-keiba 顧客に keiba-intelligence の送信元から送ってしまう事故を防ぐ。

export const BRAND_FROM_WHITELIST = {
  'analytics-keiba': {
    defaultFromEmail: 'analytics@keiba.link',
    defaultFromName: 'KEIBA Analytics',
    allowedDomains: ['keiba.link'],
  },
  'keiba-intelligence': {
    defaultFromEmail: 'newsletter@em8410.keiba-intelligence.jp',
    defaultFromName: '競馬インテリジェンス',
    allowedDomains: ['keiba-intelligence.jp', 'em8410.keiba-intelligence.jp'],
  },
};

export function getBrandConfig(brand) {
  const cfg = BRAND_FROM_WHITELIST[brand];
  if (!cfg) {
    throw new Error(`unknown brand: ${brand}`);
  }
  return cfg;
}

export function validateBrandFromEmail(brand, fromEmail) {
  if (typeof brand !== 'string' || !brand) {
    throw new Error('brand is required');
  }
  if (typeof fromEmail !== 'string' || !fromEmail.includes('@')) {
    throw new Error(`invalid fromEmail: ${fromEmail}`);
  }

  const cfg = BRAND_FROM_WHITELIST[brand];
  if (!cfg) {
    throw new Error(`unknown brand: ${brand}`);
  }

  const domain = fromEmail.split('@')[1].toLowerCase();
  if (!cfg.allowedDomains.includes(domain)) {
    throw new Error(
      `brand-from mismatch: brand="${brand}" does not allow fromEmail domain "${domain}". allowed: ${cfg.allowedDomains.join(', ')}`
    );
  }

  return true;
}
