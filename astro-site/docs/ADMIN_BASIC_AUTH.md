# 管理画面の Basic 認証（`/admin/*`）

`netlify/edge-functions/admin-auth.ts` が `/admin/*` を Basic 認証で保護する。
判定の単一源は `src/lib/auth/adminBasicAuth.js`（純粋・依存ゼロ・Deno/Node 両対応）。

## 🚨 インシデント: 認証情報がソースへ平文で置かれていた（2026-05-19〜2026-08-13）

管理画面のユーザー名とパスワードが `admin-auth.ts` に**平文リテラル**で書かれていた。

| 項目 | 実測 |
|---|---|
| git 追跡 | **されている**（`.gitignore` 対象外） |
| 履歴 | **残っている**。変数名 `validPassword` を含むコミットが **7 件**、最古 **2026-05-19** |
| 範囲 | このファイル 1 本のみ（他ファイルへの複製なし） |
| `origin/main` との差 | **無し** = 本番はこのコードで動いていた |
| 本番での有効性 | **有効だった**。`/admin/*` が 401 + `realm="KEIBA Admin Panel"` を返し、認証なし=`Authentication required` / 誤った認証情報=`Invalid credentials` と**ソースのコードパスどおりに応答**することを確認（実際の認証情報は送っていない） |

**影響**: repo を読める者は誰でも管理画面へ入れた。管理画面からは顧客の閲覧・
販売資格の変更・配信操作ができるため、影響は repo の閲覧権限と同じ範囲まで広がる。

**git 履歴に残っているため、コードを直しても過去の値は消えない。**
値のローテーション（新しい認証情報への変更）が別途必要。

## 現在の設計

認証情報は **Netlify の env にだけ**置く。ソースには**絶対に書かない**。

| env | 必須 |
|---|---|
| `ADMIN_BASIC_AUTH_USER` | ✅ |
| `ADMIN_BASIC_AUTH_PASSWORD` | ✅ |

### 不変条件

- **fail closed**: env が片方でも欠けたら**誰も通さない**。
  未設定を「認証不要」と解釈しない（管理画面が全世界へ開く）
- 設定ミスでも**理由を外部へ出さない**（「まだ設定されていない」は攻撃者への情報提供）
- 比較は**定数時間**。長さの不一致でも早期 return しない
- 認証情報を**戻り値・レスポンス本文・ログへ載せない**
- 壊れた `Authorization` ヘッダで**例外を投げない**

> ⚠️ 旧実装は `atob(header.split(' ')[1])` を素で呼んでいたため、値の欠けたヘッダや
> base64 でない値で例外 → **502 edge function invocation failed** になっていた。
> 502 は「認証が壊れている」ことを外部へ知らせる情報でもあるため、握って 401 にする。

## ⚠️ 反映手順（順序を守る。逆順にすると管理画面が閉じる）

**env を先に入れてから merge する。** fail closed のため、env 未設定のまま
このコードが本番へ出ると `/admin/*` が全面 401 になる。

```bash
# 1. 先に env を入れる（値は新規に発行する。旧値を再利用しない）
netlify env:set ADMIN_BASIC_AUTH_USER '<新しいユーザー名>' --context production --force
netlify env:set ADMIN_BASIC_AUTH_PASSWORD '<新しいパスワード>' --context production --force

# 2. env が入ったことを確認（値は表示しない）
netlify env:list --context production | grep ADMIN_BASIC_AUTH

# 3. その後に merge → deploy
```

**値そのものを CLAUDE.md / docs / commit / ログ / PR 本文へ書かないこと。**

### rollback

`git revert` で旧実装へ戻せば復旧する（旧実装は env を見ないため env の状態に依存しない）。
ただし**平文の認証情報がソースへ戻る**ため、恒久的な退避先にしてはいけない。
env を入れ直して再適用するのが本筋。

## 残件

- **認証情報のローテーション**（git 履歴に旧値が残っているため必須）
- 履歴そのものの purge は別判断（force push は他の作業を壊すため慎重に）

## 関連ファイル

| 目的 | ファイル |
|---|---|
| 判定の単一源（純粋） | `src/lib/auth/adminBasicAuth.js` |
| Edge Function | `netlify/edge-functions/admin-auth.ts` |
| テスト | `src/lib/auth/adminBasicAuth.test.mjs`（`npm run test:auth-session` / `check:safety` に組込済み） |
