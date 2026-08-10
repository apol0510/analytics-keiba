// ブランド別 fromEmail / fromName / 許可ドメイン の設定
// dry-run / test / production すべてのモードで必ず validateBrandFromEmail を通すこと。
// 誤って analytics-keiba 顧客に keiba-intelligence の送信元から送ってしまう事故を防ぐ。

export const BRAND_FROM_WHITELIST = {
  'analytics-keiba': {
    // 2026-05-19 Phase 2.5+ B: 実送信値 (send-newsletter / newsletter-send-test / expiry-* 全て noreply@keiba.link)
    // と preview の表示値を揃えるため analytics@keiba.link → noreply@keiba.link に統一。
    // allowedDomains は 'keiba.link' のままで、admin が override する場合の互換性は維持。
    defaultFromEmail: 'noreply@keiba.link',
    defaultFromName: 'KEIBA Analytics',
    // 2026-08-10: 返信先を AK 正式窓口へ。
    // From は `DeliveryKey`（campaignId × version × 受信者 × **送信元**）の構成要素なので
    // **変えられない**（変えると既送分と鍵が変わり二重送信になる）。
    // 一方 Reply-To は鍵に入らないので、返信を受けられる窓口へ向けられる。
    // 実害: 14,279 通の配信後、返信できず問い合わせフォームへ回った利用者がいた。
    // `support@keiba.link` は senderIdentity.js の OFFICIAL_FROM_EMAIL・
    // production の SENDGRID_FROM_EMAIL・問い合わせフォームの from と同一。
    replyToEmail: 'support@keiba.link',
    replyToName: 'KEIBA Analytics サポート',
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
