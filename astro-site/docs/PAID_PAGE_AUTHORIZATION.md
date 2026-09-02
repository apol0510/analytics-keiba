# 有料ページ認可の単一源ルール（2026-09-02 集約）

## 結論

**有料ページの認可は「サーバー側 gate（`ak_session` + `resolveEntitlements`）」だけで決める。
ページに独自の plan 判定を書かない。**

`localStorage` / `sessionStorage` / URL クエリの値は**認可の根拠にしてはいけない**。
利用者が自由に書き換えられるうえ、正本が持っている権利（買い切り・無料特典）を表現できない。

## なぜこのルールがあるか（2026-09-02 の事故）

三連複は**買い切りの追加権**で、入金確認時に書かれるのは `LifetimeSanrenpuku=true` **だけ**。
`プラン` 欄は `Premium`（馬単）のまま変わらない（`src/lib/payments/bankPaymentFlow.js`）。

そのため `plan === 'Premium'` を「三連複 未購入」と読むページ独自スクリプトが、

- `/premium-sanrenpuku/` … 購入済み会員を**無料体験ページへリダイレクト**（顧客申告で発覚）
- `/archive-sanrenpuku*` … 購入済み会員を**実績ページから締め出し**（`alert` + リダイレクト）
- 有料予想ページ … 購入済み会員に**追加購入 CTA と無料体験導線を表示**

を起こしていた。サーバー gate と `AccessControl` はどちらも正しく通しており、
**「3 つ目の判定」だけが壊れていた**。

## 判定の正本（この 4 つ以外を作らない）

| 層 | 単一源 | 役割 |
|---|---|---|
| 本人特定 | `src/lib/auth/pageAccess.js` `verifyPlanAccess` | `ak_session`（HttpOnly 署名 Cookie）を検証 |
| 権利判定 | `src/lib/entitlements/resolveEntitlements.js` | Airtable の正本から `canViewPremium` / `canViewSanrenpuku` 等を決める |
| ページ入口 | `src/lib/auth/paidPageGate.js` `gatePaidPage` | 上の 2 つを束ねて HTML を返す前に確定させる |
| クライアント表示 | `src/components/AccessControl.astro` / `resolveClientView` | **表示の補助**。認可の真実源ではない |

## ページの書き方

```astro
---
export const prerender = false;              // 静的 HTML に有料本文を出さない
import { gatePaidPage, PAID_PAGE_HEADERS } from '<rel>/lib/auth/paidPageGate.js';
import SessionKeepAlive from '<rel>/components/SessionKeepAlive.astro';

const gate = await gatePaidPage({
  request: Astro.request,
  requiredPlan: 'Premium Sanrenpuku',        // 配列なら any-of
  env: process.env,
});
if (gate.response) return gate.response;     // 未認可はここで終わり（本文を組み立てない）
for (const [k, v] of Object.entries(PAID_PAGE_HEADERS)) Astro.response.headers.set(k, v);
---
<SessionKeepAlive />
```

### any-of（複数の権利のどれかで開くページ）

`requiredPlan` に配列を渡すと **any-of**（どれか 1 つでも true なら通す）になる。
1 つでも未知の語が混ざれば `null` → `unknown_required_plan` で **fail closed**。

三連複の的中実績 `/archive-sanrenpuku*`（6 ページ）は 2 つの読者を持つため、
条件を定数 `SANRENPUKU_ARCHIVE_PLANS = ['premium', 'Premium Sanrenpuku']` に集約している。

- 馬単のみの Premium 会員 … 購入前に実績を見せる**アップセル面**（`canViewPremium`）
- 三連複の保有会員 … 自分が買った商品の**実績面**（`canViewSanrenpuku`）

**片方だけで判定すると、もう一方を締め出す。** ページごとに許可リストを書かないこと。

## 禁止事項

1. ページ内で `localStorage` / `sessionStorage` の plan を読んで**表示可否を決めない**
   （入力補助・表示ラベル・保存された UI 状態はこの限りではない）
2. ページが `user-plan` / `userPlan` / `userData` を**書かない**。
   書いてよいのは `src/pages/auth/verify.astro`（マジックリンク検証の応答）だけ
3. URL クエリから権限を作らない（`/welcome/?plan=premium` は 2026-09-02 に撤去）
4. 正規の書き込み元が無い権限チャネルを読まない
   （`auth_data` は 2026-08-08、`sessionStorage.temp_auth` は 2026-09-02 に削除）
5. 三連複の保有を `plan` 文字列だけで判定しない。必ず `lifetimeSanrenpuku` を併せて見る
6. 南関だけ / 中央だけにページ独自の表示判定を足さない（**片側だけ壊れる**）

## 追加購入 CTA（購入済みに売らない）

三連複の CTA・予告・的中結果の出し分けは
**`src/lib/sanrenpuku/sanrenpukuCtaStage.js`（`isFunnelTarget` / `planSanrenpukuDisplay`）** が単一源。
`isFunnelTarget(planRaw, lifetimeSanrenpuku)` の第 2 引数を必ず渡す。

サーバー側で判定できる面（`gatePaidPage` を通った SSR ページ）は
`gate.entitlements.canViewSanrenpuku` で条件描画し、クライアント判定を足さない。

## 検証

| コマンド | 内容 |
|---|---|
| `npm run test:auth-session` | `paidPageSingleSourceGate.test.mjs` / `sanrenpukuPurchasedNotDemo.guard.test.mjs` ほか |
| `npm run test:sanrenpuku-cta` | CTA 段階表示の単一源 |
| `npm run check:safety` | 上記を含む全 safety check |

`paidPageSingleSourceGate.test.mjs` が固定していること:

- 買い切り購入者 / 旧 `Premium Sanrenpuku` / `Premium Combo` / Light+買い切り / Free+買い切り /
  入金待ち+買い切り / 馬単のみ Premium を**締め出さない**
- Light のみ / 無料会員 / 期限切れ（買い切り無し）は**通さない**
- Cookie 無しの URL 直打ち → `302 /login`（本文ゼロ）／自作 Cookie は通らない
- `env` 未注入・未知 `requiredPlan` は fail closed
- アーカイブ 6 ページに `localStorage` / `sessionStorage` / `alert` ゲート / `getStaticPaths` が無い
- ページが `userPlan` を書き換えない／`welcome.astro` がクエリから自己付与しない
- `AccessControl` が `temp_auth` / `auth_data` を読まない
- 購入済みに追加購入 CTA・無料体験導線を出さない
