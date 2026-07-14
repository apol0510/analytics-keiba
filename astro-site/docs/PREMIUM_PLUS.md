# Premium Plus 運用ガイド

`/premium-plus/` — 1 日 1 鞍・三連単フォーメーションの**単品商品**。

## 変更してはいけない前提

| 前提 | 実装での担保 |
|---|---|
| 単品商品（サブスクではない） | ページに継続課金の表現を置かない。FAQ に明記 |
| **Premium Sanrenpuku 会員にのみ表示**。Premium / Light には存在も知らせない | `AccessControl requiredPlan="Premium Sanrenpuku"` + `<meta name="robots" content="noindex, nofollow">` + `public/robots.txt` の `Disallow: /premium-plus/` + CTA は三連複ページのみ |
| 超精密 AI が厳選 1 鞍を提供 | コピーの中核。レース数を増やす訴求はしない |
| 価格 ¥98,000 → ¥68,000 | `premium-plus.astro` 冒頭の `PRICE` / `LIST_PRICE` |

**CTA (`PremiumPlusCta.astro`) を Premium / Light / 無料ページに置いてはいけない。**
置いてよいのは Premium Sanrenpuku 会員だけが到達するページに限る。

## 毎日の画像更新（1 日 1 枚）

画像は **Netlify Blobs** に保存する。git に置かないため **ビルド不要・数秒で本番反映**される。

### 方法 A: 管理画面

<https://analytics.keiba.link/admin/premium-plus-images>

1. 管理者シークレット（`PREMIUM_PLUS_ADMIN_SECRET`）を一度入力（ブラウザに保存される）
2. 投票内容照会のスクショをドラッグ＆ドロップ（ペーストも可）
3. 開催日 / 会場 / レース番号 / 投票金額 / 的中・不的中 / 払戻額 を入力
4. 「アップロードして本番反映」→ 数秒で `/premium-plus/` と `/premium-sanrenpuku/` に反映

### 方法 B: ターミナル

```bash
cd astro-site
export PREMIUM_PLUS_ADMIN_SECRET='...'   # Netlify に設定した値

# 的中した日
npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
  --date 2026-07-15 --venue 川崎 --race 6 --stake 16000 --payout 277000

# 不的中だった日（--miss。払戻は不要）
npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
  --date 2026-07-16 --venue 大井 --race 11 --stake 16000 --miss

# 削除（同じ日付で再アップロードすれば上書きなので通常は不要）
npm run upload:premium-plus -- --delete 2026-07-15
```

同じ日付を再アップロードすると**後勝ちで上書き**される（1 日 1 鞍のため）。

## 🚨 不的中の日も必ずアップロードする

**的中した日だけを上げると、的中率が「100%」になり数値そのものが信用されなくなる。**

刷新前（2026-03-02〜04-10）に保存されていた 30 枚は的中日のみで、不的中の日の控えが存在しない。
そのため seed 分は `legacy: true` を立て、**的中率・回収率の母数から除外**している
（最高払戻・的中時平均払戻にだけ寄与する）。

的中率タイルは、legacy を除いたサンプルが **10 鞍**たまるまで自動的に非表示のまま。
不的中を含めて毎日上げていれば、10 鞍目で自動的に公開される。

## 実績数値は手書き禁止

ページに出る数値は **`src/lib/premiumPlusShowcase.js` の `computeStats()` の戻り値だけ**。
`.astro` に数値を直接書かないこと。

旧版は「的中率78% / 平均配当¥281,340 / 最高配当¥973,500 / 期待リターン265% /
Premium会員の52%が利用 / 満足度4.9 / 継続率94%」を**手書き固定値**で持っており、
根拠が示せないうえ画像の更新も 3 ヶ月止まっていた。同じ事故を構造的に防ぐための設計。

| 数値 | 母数 |
|---|---|
| 的中率 / 回収率 | legacy を除く直近 30 鞍（10 鞍未満なら非表示） |
| 最高払戻 / 的中時平均払戻 | legacy を含む全的中エントリ |

## セットアップ（初回のみ）

```bash
# 1. 管理者シークレットを本番に設定
netlify env:set PREMIUM_PLUS_ADMIN_SECRET '<ランダムな長い文字列>' --context production --force

# 2. 再デプロイ（env は Function に再デプロイで反映される）
curl -X POST -d '{}' '<Netlify Build Hook URL>'

# 3. 過去 30 枚を Blobs へ流し込む（1 回だけ）
cd astro-site
export PREMIUM_PLUS_ADMIN_SECRET='<上と同じ値>'
npm run seed:premium-plus -- --dry-run   # 確認
npm run seed:premium-plus                # 実行
```

**シークレットの値そのものを CLAUDE.md / commit / ログに書かないこと。**

## 関連ファイル

| 目的 | ファイル |
|---|---|
| 集計ロジック（単一源・純粋） | `src/lib/premiumPlusShowcase.js` |
| テスト | `src/lib/premiumPlusShowcase.test.mjs`（`npm run test:premium-plus` / `check:safety` に組込済み） |
| 画像 API（Blobs） | `netlify/functions/premium-plus-media.js` |
| 商品ページ | `src/pages/premium-plus.astro` |
| 三連複ページの CTA | `src/components/PremiumPlusCta.astro` → `src/pages/premium-sanrenpuku.astro` |
| 管理画面 | `src/pages/admin/premium-plus-images.astro` |
| アップロード CLI | `scripts/uploadPremiumPlusImage.mjs` |
| 過去分の流し込み | `scripts/seedPremiumPlusLegacy.mjs` + `scripts/data/premium-plus-legacy.json` |

## 旧実装（参考・復活させないこと）

- `public/upsell-images/upsell-YYYYMMDD.png` をページに**ハードコード**し、
  `scripts/update-premium-plus-images.sh` が sed で書き換える方式だった（削除済み）。
  更新が止まると古い日付が本番に残り続けるため、Blobs 方式へ移行した。
- `public/upsell-images/` 自体は `withdrawal-upsell.astro` がまだ参照しているため**残す**。
  `scripts/update-all-images.sh` は withdrawal-upsell 専用に縮小済み。
