# 会員が予想へ辿り着く導線（正本 / 2026-09-02）

**この文書が正本。**マイページの表示条件・ナビの行き先・Light ページの構成を変える前に必ず読むこと。

## 発端

2026-09-02、Light 会員から問い合わせ。

> ライトプランですが今日のメインレース見れません 今日こいうインシデント多いよ 対応して

調査の結果、**システム側に不具合は無かった**。

| 確認項目 | 結果 |
|---|---|
| Airtable 権利 | Light / active / 有効期限 2026-10-01 / 退会なし |
| 本番と同じ `resolveMembership` | `memberType=paid` / `plan=light` |
| ログイン状態 | 前日 15:24 にマジックリンク使用済み。`ak_session` は idle 30 日で有効 |
| 当日データ | 大井 12R 全件・R11 メイン買い目 `3→4.6.8.14.15(抑え…)` 生成済み |
| 本番反映 | 当日分がデプロイ済み |

**壊れていたのは導線**だった。

## 何が壊れていたか（3 つが重なる）

### A. ナビに有料予想への直リンクが 1 本も無い

上部ナビ・スマホナビ・フッターのどこにも `/light-predictions*` `/premium-prediction/*` が無く、
無料予想（`/free-prediction/*` `/free/*`）だけが載っていた。
**有料会員が予想へ行く道はマイページのカード 1 枚だけ**だった。

### B. マイページの「ログイン済みか」が localStorage だけで決まっていた

```js
// 旧 dashboard.astro
function isAuthenticated() {
  return !!(user-plan || isLoggedIn || userPlan || user_plan || user_email);
}
```

有料会員の権威は `ak_session`（HttpOnly 署名 Cookie）と Airtable なのに、画面はそれを見ていなかった。
**localStorage が消えた会員（別ブラウザ・履歴消去・プライベートウィンドウ）は、
セッションが有効でもログインフォームが出る。**

### C. カードがプラン文字列一致でしか出ない

カードは既定 `display:none` で、`plan` が `'light'`/`'standard'`/`'ライト'` に一致したときだけ JS が出す。
しかもその `plan` はまず localStorage のキャッシュから読む。

**A + B + C が揃うと、権利も当日データも正常な会員が、サイト内から予想へ到達する手段を全部失う。**

## 直した形

### 判定の単一源

| 目的 | ファイル |
|---|---|
| **いま見ているのは誰で何を見られるか** | `src/lib/auth/viewerEntitlements.js`（`resolveViewer`） |
| **権利 → 出すカード** | `src/lib/entitlements/resolveEntitlements.js`（`viewFromEntitlements`） |
| **「今日の予想」の行き先** | `src/lib/navigation/predictionDestination.js` |

`resolveViewer` は **新しい認証方式を作らない**。`gatePaidPage` と同じ 2 つの単一源へ委譲する。

1. 本人特定 … `verifyPlanAccess`（`ak_session`）。入口は `ALL_MEMBER_PLANS`（無料・Light を含む会員全員）
2. 権利判定 … `resolveEntitlements`（Airtable の契約・買い切り・無料特典）

### 3 状態にする（`anonymous` と `unknown` を潰さない）

| state | 意味 | 権利 |
|---|---|---|
| `member` | 本人を特定し権利まで確定した | Airtable の正本どおり |
| `anonymous` | ログインしていないと**確定できた**（Cookie 無し・期限切れ・署名不正・会員不在） | ゼロ |
| `unknown` | 判定できなかった（鍵未設定・Airtable 一時障害） | ゼロ |

**一時障害を `anonymous` にしない。**有効な会員に「ログアウトしました」と見せると、
不要な再ログインを促す（2026-08-08 の障害で実際に起きた形）。

### ナビ → `/today/` → サーバーが振り分ける

ナビの「🎯 今日の予想」は **`/today/` の 1 本だけ**を指す。誰をどこへ送るかはサーバーが決める。
クライアントに分岐を置かないので、localStorage が消えても壊れない。

| 権利 | 行き先 |
|---|---|
| `canViewPremium` | `/premium-prediction/nankan/` |
| `canViewLight` | `/light-predictions/` |
| それ以外・未ログイン | `/free/`（無料予想の索引。会場を勝手に決めない） |
| `unknown` | `/dashboard/`（権利を主張しない中立な場所） |

> ⚠️ **`effectiveTier` を使ってはいけない。**
> `effectiveTier` は `canViewSanrenpuku` を最優先に見るため、
> 「三連複は買い切りで保有・馬単 Premium は期限切れ」の会員が `premium-sanrenpuku` と判定される。
> その人を `/premium-prediction/nankan/` へ送ると、そのページは `canViewPremium` を要求するので
> **ログイン画面へ跳ね返され、往復する**。
> 行き先は必ず「**そのページが要求する権利そのもの**」で選ぶこと。

### ナビの項目数は増やしていない（入れ替え制）

上部ナビは**同時 6 項目**が上限（`navLayout.guard.test.mjs` が固定。2026-08-25 に MK 指摘で
ヘッダ幅 955px を超えた事故がある）。**項目は 1 つも増やしていない。**

| 状態 | 先頭項目 |
|---|---|
| 未ログイン | `#nav-free` … 🔍 無料予想 → `/free/`（従来どおり） |
| ログイン後 | `#nav-today` … 🎯 今日の予想 → `/today/` |

未ログイン時の見た目・行き先は**一切変わらない**（`homeCta.guard.test.mjs` が
「PC nav の親が索引 `/free/` を指す」ことを固定しており、それも維持している）。
スマホのハンバーガーは件数上限が無いので、「今日の予想」と「無料予想」を**両方**出す。

> ⚠️ **ナビの出し分けそのものは従来どおり localStorage 由来**（`readNavAuthState`）。
> 履歴を消した会員のナビには「無料予想」が出る。
> ただしその場合でも**マイページはサーバー権威で会員と判定してカードを出す**ため、
> 「マイページ → 予想カード」で導線は途切れない。
> ナビの出し分けまでサーバー権威にするには BaseLayout を全ページ SSR 化する必要があり、
> 今回は**やっていない**（静的ページのコストが跳ね上がるため）。

### マイページ

- `prerender = false`（SSR）へ変更。サーバーで `resolveViewer` を実行する
- 確定した状態を `window.__AK_SERVER_AUTH__` として**権威値**で渡す
  - 渡すのは**列挙した項目だけ**（`entitlements` 全体や Airtable レコードを素通ししない）
- `isAuthenticated()` は**サーバー判定を先に見る**
- カード表示は**権利**で決める。プラン文字列判定はサーバー判定が無いときのフォールバックとしてのみ残す
- `Cache-Control: private, no-store`（会員ごとに中身が変わるため共有キャッシュに載せない）

> **localStorage 経路を消してはいけない。**
> 無料登録だけの会員は `ak_session` を持たない。サーバーが `member` と確定できないときの
> フォールバックとして必要。**消すと無料会員のマイページが壊れる。**

### Light 会場別ページの整理

`/light-predictions-urawa/` `/light-predictions-funabashi/` は **301 のみ**へ畳んだ
（行き先 `/light-predictions/`）。

- サイト内のどこからもリンクされていなかった（ナビ・マイページ・フッターすべて参照なし）
- `astro.config.mjs` の `LEGACY_EXCLUDES` で「旧light会場別」として sitemap から除外済みだった
- `/light-predictions/` は会場を指定せず南関 predictions の**最新開催日**を選ぶ
  （`pickLatestAndAdapt(predictionModules)`）ため、大井・浦和・船橋のどれでも表示できる

4 ページに同じ修正を配る構造だと、片側だけ旧仕様で残る事故になる。

## 変更してはいけないこと

- `resolveViewer` に**第三の認証方式**を足さない。判定は `verifyPlanAccess` + `resolveEntitlements` のみ
- `unknown` を `anonymous` に丸めない（障害時に会員へ再ログインを促してしまう）
- ナビから `/light-predictions` `/premium-prediction` を**直接指さない**（行き先は `/today/` に集約）
- 上部ナビに項目を**足さない**（6 項目上限。増やすなら何かと入れ替える）。
  出し分け項目の id は `navLayout.guard.test.mjs` の集計にも必ず加える
  （加え忘れると上限検査が静かに緩む）
- マイページの `isAuthenticated()` を localStorage 単独判定へ戻さない
- カード表示をプラン文字列一致へ戻さない
- 畳んだ 2 ページに予想描画を戻さない
- **有料本文そのものの保護は `gatePaidPage` の仕事**。`resolveViewer` は表示の都合しか決めない
  （正本は `docs/PAID_PAGE_AUTHORIZATION.md`）

## 検証

```bash
npm run test:nav            # 導線先・カード表示・ページ配線 guard
npm run test:auth-session   # resolveViewer（会員/未ログイン/権利なし/一時障害）
npm run test:entitlements   # viewFromEntitlements
npm run check:safety        # 上記すべてを含む
```

| テスト | 固定している内容 |
|---|---|
| `src/lib/auth/viewerEntitlements.test.mjs` | localStorage 非関与・Light を締め出さない・`unknown` を潰さない・権利なし・profile の項目限定 |
| `src/lib/navigation/predictionDestination.test.mjs` | 権利ごとの行き先・三連複のみ保有者を往復させない・壊れた入力でも実在パス |
| `src/lib/navigation/memberPredictionFunnel.guard.test.mjs` | ナビ配線・`/today/` の SSR と委譲・マイページのサーバー権威・301 ページが予想を描画しない |
