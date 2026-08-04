# 配信計測の正常化（開封・クリックを AK の台帳へ入れる）

**単一源**: 判定 `src/lib/crm/deliveryMeasurement.js` / 設定読み取り `src/lib/crm/segmentInputs.js`
**確認コマンド**: `npm run check:measurement`（GET のみ・書き込みなし）

> このドキュメントは**設定変更の手順書**である。手順の途中で止まっても安全なように、
> 「変更前の記録 → 1 つ変える → 確認 → 次」の順に並べてある。まとめて変えない。

## 0. なぜやるか（2026-08-04 の実測）

`comeback-light-30d-granted:v2` を 2 回配信し、AK の台帳では**開封 0** だった。
だが配信基盤側では **15 名が開封**していた。0 だったのは開かれなかったからではなく、
**Event Webhook が `open` を AK へ送らない設定**だったから。

| ジョブ | 宛先 | 台帳（EmailEvents） | provider 実測（参考値） |
|---|---|---|---|
| `mkt-comeback-light-30d-granted-v2-d9678b3d-1`（8/3 送信） | 28 | delivered 28 / open **0 行** | 開封 **10 名** |
| `mkt-comeback-light-30d-granted-v2-0f57abd4-1`（8/4 送信） | 36 | delivered 36 / open **0 行** | 開封 **5 名** |
| 合計 | 64 | delivered 64 / bounce 0 | 開封 15 名 / 21 イベント / **クリック 0** |

クリック 0 は「押されなかった」ではなく **click tracking 自体が無効**という意味。
provider の Activity API は**保持 3 日**なので、この実測値は 8/7 頃に消える。

## 1. 変更前の状態（2026-08-04 実測 / `npm run check:measurement`）

```
open tracking : 有効
click tracking: 無効 / 本文テキストの書き換え: 有効
Event Webhook : 有効
  送る種別: processed=false delivered=true deferred=false bounce=true dropped=true
            open=false click=false spam_report=true unsubscribe=true
判定: 開封=計測していません / クリック=計測していません
```

AK 側の受け皿はすでに完成している（**取込側のコード変更は不要**）:

- `EMAIL_EVENT_LEDGER_ENABLED=true`（production 設定済み）
- `emailEventLedger.js` は `open` / `click` を既に扱う。クリック URL は**分類だけ**保存し
  token・クエリは捨てる。同じ人の複数回の開封は別行として残る
  （固定テスト: `src/lib/webhooks/emailEventOpenClick.fixture.test.mjs`）
- マーケ配信は `custom_args` を刻んでいるので、届いた open は**推測なしで**顧客へ確定できる

## 2. 変えるもの / 絶対に変えないもの

| # | 変更 | 種別 | 現在 | 変更後 |
|---|---|---|---|---|
| A | Event Webhook の `open` | **外部サービス設定** | false | **true** |
| B | Event Webhook の `click` | **外部サービス設定** | false | **true** |
| C | マーケ配信のクリック計測 | **production env** | 未設定 | `MARKETING_CLICK_TRACKING_ENABLED=true` |
| — | **アカウント全体の click tracking** | — | 無効 | **無効のまま。触らない** |

### アカウント全体の click tracking を有効化してはいけない理由

アカウント設定を ON にすると、**1 通ごとの `tracking_settings` で opt-out していない
送信経路すべて**で本文リンクが配信基盤のリダイレクタへ書き換わる。実測（2026-08-04）で
opt-out していない経路:

`marketing-campaign-dispatch` / `send-magic-link` / `confirm-bank-payment` /
`contact-form` / `domain-protection-alert` / `paymentEmailDeps`（入金確認メール v2）

このうち **`send-magic-link` のリンクは 15 分・単回使用のログイントークン**を含む。書き換わると:

1. リンク検査ボット（企業ゲートウェイ等）が先読みしただけで**トークンが消費され、本人がログインできない**
2. ログイントークンが第三者のリダイレクタを経由する
3. 本文に併記しているコピー用 URL が別ドメインになり、**偽装リンクに見える**

そこで **アカウント設定は触らず**、マーケ配信の 1 通ごとの指定でのみ有効化する
（per-message はアカウント設定より優先される）。
`send-magic-link` には明示的な opt-out を入れ、将来アカウント設定が ON にされても
ログインリンクだけは書き換わらないようにした（guard: `src/lib/crm/deliveryTracking.guard.test.mjs`）。

### C を有効にすると起きること（承知のうえで決める）

- マーケ配信の本文リンク（**オファーの申込 URL `?t=<署名トークン>` を含む**）が
  配信基盤のリダイレクタ経由になる。オファートークンは単回使用ではないのでログイン不能は起きないが、
  **トークンが provider を経由する**ことと、**ボットの先読みでクリック数が水増しされる**ことは避けられない
- 配信停止リンクも書き換わる。One-Click 配信停止（`List-Unsubscribe-Post`）はヘッダ側なので影響しない

### A を有効にすると起きること

`custom_args` を刻んでいない経路（ログインメール等）の open も台帳へ届く。
これらは **`unresolved` として保存され、顧客の反応としては数えない**（fixture テストで固定）。
台帳は生アドレスを持たず `EmailHash` だけを保存する。行数は実測ベースで月あたり数百〜数千行。

## 3. 手順（この順でやる。まとめて変えない）

### Step 0. 変更前の記録を取る（必須）

```bash
cd astro-site
netlify dev:exec --context production npm run check:measurement   # 出力を PR / 作業ログへ貼る
```

> ⚠️ `netlify dev:exec` が返す **secret 系 env はマスクされる**（例: `****...==`）。
> 実行時に取れた値をローカルで検証しないこと。`SENDGRID_WEBHOOK_VERIFICATION_KEY` を
> 「壊れている」と誤判定した前例がある（本番は正常に署名検証できている）。

### Step 1. Event Webhook の `open` / `click` を true にする（外部サービス設定）

配信基盤の Event Webhook 設定で `open` と `click` にチェックを入れる。
**通知先 URL・署名用公開鍵は変更しない**（変えると全イベントが 403 で落ちる）。

確認:

```bash
netlify dev:exec --context production npm run check:measurement
# 期待: 送る種別に open=true click=true / 判定は「開封=計測中」
#       クリックは MARKETING_CLICK_TRACKING_ENABLED を入れるまで「計測していません」のまま
```

### Step 2. テスト送信して台帳に open が入るか見る

**新規キャンペーンを作らない。** 既存のカナリア経路（`marketing-canary`）を 1 通だけ使う。

1. 管理画面 顧客マーケティング → カナリア宛先 1 名でキュー登録 → 送信
2. 送信したメールを**実際に開く**（プレビューではなく受信箱で開く。画像表示を許可する）
3. 1〜3 分待つ（実測の反映遅延は 10〜20 秒。混雑時で 2 分程度）

確認（read-only）:

| 見るもの | 期待 |
|---|---|
| `EmailEvents` の新しい行 | `EventType=open` / `ResolutionStatus=resolved` / `CampaignId=marketing-canary` |
| 管理画面の顧客カルテ ⑥-2 | 「開封 1 回」と**数値**で出る（設定前は「—（計測していません）」） |
| 期待する行の形 | `src/lib/webhooks/emailEventOpenClick.fixture.test.mjs` が正本 |

**開封が入らないとき**に確認する順序（推測で設定を戻さない）:

1. `npm run check:measurement` で `open=true` になっているか
2. 受信側で画像がブロックされていないか（開封は画像 1px で計測する。ブロックされたら計測できない）
3. `EmailEvents` に `unresolved` の open が増えていないか（届いてはいるが紐付いていない）

### Step 3. クリック計測を有効にする（production env）

Step 2 で開封が台帳に入ったことを確認してから。

```bash
netlify env:set MARKETING_CLICK_TRACKING_ENABLED true --context production --force
# 反映には再デプロイが要る（Build Hook で origin/main を 1 回ビルド）
```

確認: カナリア 1 通を送り、**本文のリンクを実際に押す** → `EmailEvents` に
`EventType=click` / `UrlCategory` が入る（`UrlPath` にクエリが**入っていない**ことも見る）。

## 4. 元に戻す

| 戻すもの | 方法 | 効果 |
|---|---|---|
| クリック計測 | `netlify env:unset MARKETING_CLICK_TRACKING_ENABLED --context production` → 再デプロイ | 次の送信から本文リンクの書き換えが止まる。**送信済みのメールのリンクは戻らない** |
| Webhook の `open` / `click` | 配信基盤の設定でチェックを外す | 新しいイベントが届かなくなる。**台帳の既存行は消えない**（append-only） |
| 台帳ごと止める | `EMAIL_EVENT_LEDGER_ENABLED` を unset → 再デプロイ | 受信は続くが書き込みだけ止まる |

**戻したあとは画面の表示も自動で「—（計測していません）」へ戻る**（判定は provider 設定を毎回読むため）。

## 5. 画面が「0」と「未計測」をどう分けるか

| 場所 | 実装 |
|---|---|
| セグメント下見の計測状態 | `mkRenderMeasurement()`（`premium-plus-eligibility.astro`） |
| 顧客カルテ ⑥-2 の開封・クリック | 計測が `enabled` のときだけ数値。無効なら `—（計測していません）` / 不明なら `—（計測状態を確認できません）` |
| delivered / bounce / 配信停止 / 迷惑報告 | **開封計測の状態に関係なく数値**（Webhook が届けている確定値） |
| キャンペーン単位の集計 | `summarizeDelivery()` が `value:null` を返す。provider 側の値は「参考値」と明示 |

guard: `src/lib/crm/crmAdminUi.guard.test.mjs` / `src/lib/crm/deliveryTracking.guard.test.mjs`
（`npm run test:crm` / `npm run check:safety` に組み込み済み）

## 6. やってはいけないこと

- アカウント全体の click tracking を有効化する（§2 の理由）
- `send-magic-link` の tracking opt-out を外す
- `marketing-campaign-dispatch` で `click_tracking.enable` を `true` 直書きする（env ゲートを迂回する）
- 台帳にクリック URL を**そのまま**保存する（token の保管庫になる）
- 「開封 0」を未開封として施策の評価に使う（計測状態を必ず添える）
