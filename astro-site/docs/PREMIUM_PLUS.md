# Premium Plus 運用ガイド

`/premium-plus/` — 1 日 1 鞍・三連単フォーメーションの**単品商品**。

## ⛔ Phase 5 結論（2026-07-16）: サーバー側書込み経路は本番 hard block・現状 404 inert

`premium-plus-media` API のサーバー側 manifest 更新経路（upload / seed / hide / show /
rollback）は、**Netlify Blobs 単独では multi-writer の lost-update を防げないと確定した**ため、
env フラグとは独立に**コードレベルで hard block** している。安全な storage backend が
実装されるまで有効化してはならない。

- **本番判定 = No-Go**。`/premium-plus/` ページ自体（SSR 会員ゲート）は従来どおり稼働するが、
  `premium-plus-media` Function は **GET / POST とも常時 404**（`PREMIUM_PLUS_STORAGE_SAFE = false`
  コード定数 ＋ `PREMIUM_PLUS_ENABLED` env の二重 kill）。
- 画像日次更新（この doc の「方法 A / B」）は **この書込み経路に依存するため現状は使用不可**。
  安全な backend が入るまで実運用の画像更新はできない（設計見直しが前提）。

### 何が起きたか（#13 実 lost-update の確定証拠）

canary（`premium-plus-canary` 隔離ストア）で並び順を検証したところ、eventual 遅延下で
**実際の lost-update が再現**した。manifest チェーンの証拠:

- #4 upload → manifest `50fad4a6`（v1）、pointer → 50fad4a6
- #13 stale write（別 operationId）→ manifest `010738f9`（v1, **`previousManifestId="" `= 空 snapshot
  から生成**）。その pointer への **`setJSONIfNew`（create-only）が成功して #4 の pointer を上書き**
  し、50fad4a6 を orphan 化した。
- #18 hide は #13 の manifest に chain した。

`setJSONIfNew` は既存キーに対して `modified:false`（=409）を返すべきところ **成功した**。

### 根本原因（重要・次工程の前提を修正）

**Netlify Blobs は同一キー競合について last-write-wins であり、concurrency control mechanism
（atomic compare-and-swap）を提供しない。** `onlyIfNew` / `onlyIfMatch` は best-effort であって
strong な排他保証ではなく、eventual read で「キー無し／古い etag」を見た writer が既存の勝者を
上書きできる。

- **strong consistency は「読取り鮮度」の設定であり、atomic CAS の保証ではない。**
  したがって **Netlify Functions 2.0 / modern Blobs runtime への移行だけでは #13 は解決しない**
  （この前提は撤回済み）。`uncachedEdgeURL` による strong 読取を足しても、書込みの排他は得られない。
- 以前コード内に書いていた「etag CAS が正当性を担保」「eventual でも stale は CAS 失敗→リトライに
  なるだけで破損しない」「atomic なので TOCTOU にならない」は **実 Netlify Blobs には当てはまらない**
  （in-memory テストストアは atomic 条件付き書込みを*モデル化*しているため、機械テストは design が
  正しいことのみを示す。実ストアがそのモデルを破る）。該当コメントは実態へ是正済み。

### readCurrentStable の位置づけ（是正）

`readCurrentStable`（収束読取）は **freshness mitigation（読取鮮度の best-effort 改善）であって
correctness guarantee ではない**。同一 edge の cache を読み続ける burst では収束しないことがあり、
lost-update を防ぐ機能はない。以前「fail-closed で stale client を 409 で弾く」と記述していたが、
**その 409 は CAS の strong 排他に依存しており、実 Blobs ではその依存が成立しない**ため、
correctness の主張から除外した。読取鮮度の改善策としてコードに残すが、安全性の根拠にはしない。

### 次期設計

lost-update 防止・operationId 一意性・rollback・障害復旧・運用コストの比較と推奨案は
[`PREMIUM_PLUS_STORAGE_DESIGN.md`](./PREMIUM_PLUS_STORAGE_DESIGN.md) を参照（read-only 比較・未着手）。
storage migration / 外部 DB 作成 / env 投入 / 実データ書込みは**まだ行わない**。

---


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

## インシデント記録: 2026-07-24 `/premium-plus/` 本番 500 → rollback で復旧

**要約**: 954880b の本番 deploy 後に `/premium-plus/` が SSR 500。365e184（防御的正規化＋lib キャッシュbust）を
push・auto-deploy したが **500 は解消せず**。deploy `6a62eadd`（99d7b15）への **rollback（restore）で復旧**。

| 項目 | 内容 |
|---|---|
| 障害開始 | 954880b deploy `6a62ee96…`（published 2026-07-24T04:49:21Z）以降 |
| 影響範囲 | **`/premium-plus/` に限局**（`/`・`/dashboard`・`/pricing`・`/login` は 200 のまま。redirect loop・他ページ波及なし） |
| 500 を確認した deploy | 954880b `6a62ee96…` / 365e184 `6a62f25d…`（**両 artifact とも permalink で 500 再現**＝本番エッジキャッシュ問題ではない） |
| 修復試行 SHA | 365e184（`ppCards` で `unitStake/stake/payout` を既定値正規化＋`premiumPlusResults.js` に cache-bust マーカー＋`X-PP-Template-Version=-3`）。**効果なし**（artifact 自体が 500 継続） |
| 復旧手段 | Netlify restore（rollback）で deploy **`6a62eadd809f6e0008684d14`（99d7b15）** を production 再公開（published 2026-07-24T05:20:19Z） |
| 404 復帰時刻 | rollback 後、`/premium-plus/`（未認証）＝ **404** を 3 回連続確認（2026-07-24T05:20Z 台） |
| authenticated 確認 | **未実施**（安全な既存テスト会員/認証 read-only 手段なし。cookie/token は扱わない方針） |
| template version | 復旧 deploy(99d7b15) は `X-PP-Template-Version` を持たない版（500 版でもヘッダは render throw で消失していた）。`-3` は不採用（壊れた 365e184 の版） |
| tests / build | 365e184 側で build OK・`test:premium-plus` 14・`test:premium-plus-media` 99 pass（ただし本番 500 は再現＝**テストが本番 SSR artifact drift を捕捉できていない**） |
| production env 変更 | **0** |
| data write | **0**（顧客/セッション/record 変更なし） |
| rollback | **実施**（restore `6a62eadd`・ユーザー明示承認後） |

**root cause の確定度**（証拠レベルを分離）:

- **Confirmed**（直接証拠）: 各 deploy permalink で `99d7b15=404（正常）/ 954880b=500 / 365e184=500`。500 は premium-plus 限局。
  500 応答に `X-PP-Template-Version` ヘッダなし＝**render フェーズの throw**（frontmatter で set 後に破棄）。365e184 の artifact 自体が 500。
- **Supported hypothesis**（コード証拠のみ・直接証拠なし）: 365e184 は frontmatter で `c.unitStake/stake/payout` を正規化したが 500 が残る＝
  throw はその経路とは別（旧 lib 由来の未定義シンボル / 別の `.toLocaleString()` 等）。commit 記載の「page 新版 × lib 旧版 混在」は状況と整合。
- **Unconfirmed**: 機構が **Netlify build-cache module drift** そのものである、とは**断定しない**（正確な exception stack trace は本番 500 body 空・Netlify UI 関数ログが必要で未取得）。

🔴 **重要な残リスク（恒久対策が未了）**: 本番は **main への push で自動 deploy**。現在 `origin/main` は依然 **365e184（壊れた版）**。
**次に main へ push されると 365e184 系が再 deploy され `/premium-plus/` が再び 500 になる**。rollback は暫定復旧であり、
**恒久解には main 上での実修正（正確な throw シンボルの特定 → 修正、またはキャッシュ無し再ビルドで drift 仮説の検証）が必要**。
それらは本記録時点では未実施（別承認）。

**未解決事項**: (a) 正確な exception stack trace（file:line・型）＝ Netlify UI 関数ログ要 / (b) throw する具体シンボル（unitStake 以外か）/
(c) build-cache drift の直接立証 / (d) main の恒久修正。
