# Premium Plus 次期 storage 設計比較（read-only・未着手）

Phase 5（2026-07-16）で **Netlify Blobs 単独の manifest-current multi-writer 更新は不採用**と確定した。
Netlify Blobs は同一キー競合 last-write-wins で **concurrency control（atomic CAS）を提供しない**ため、
eventual 遅延下で lost-update を防げない（#13 実証。詳細は [`PREMIUM_PLUS.md`](./PREMIUM_PLUS.md) 冒頭）。

本書は次期設計候補を **比較するだけ**の read-only ドキュメントである。
storage migration / 外部 DB 作成 / env 投入 / 実データ書込みは**まだ行わない**。実装着手には別承認が要る。

## 評価軸

| 軸 | 意味 |
|---|---|
| lost-update 防止 | 同時 2 writer / stale read でも勝者を上書きしないことを storage が保証できるか |
| operationId 一意性 | 同一 operationId の再送で副作用 1 回（冪等）を保証できるか |
| rollback | 過去 version への巻き戻し（immutable 履歴 + 現行ポインタ切替）が原子的にできるか |
| 障害復旧 | 書込み途中失敗で「公開が壊れた中間状態」を残さないか・再送で回収できるか |
| 運用コスト | 追加サービス・課金・秘密情報・監視・バックアップの負担 |
| 実装コスト | 既存 `manifestStore.js` / handlers / admin 画面の改修量 |

## 前提（実運用の実態）

- **書込みは 1 日 1 回・単一管理者（MK）**。同時多重書込みは通常運用では発生しない。
  lost-update は「稀な二重操作・リトライ・複数タブ」でのみ顕在化する。
- 読取り（会員の閲覧）は頻度が高いが、eventual でも実害は小さい（1 日 1 更新）。
- 画像本体は immutable（`images/{date}/{checksum}`）。**画像の保存先は Blobs のままで問題ない**
  （競合するのは manifest/pointer の更新であって画像ではない）。

---

## 案 A: transactional DB を manifest/operation/version の正本にし、画像だけ Blobs

manifest・operation・logicalVersion を **トランザクション対応 DB**（例: 既存 Airtable ／ もしくは
Postgres/SQLite 系マネージド）に置き、画像バイトだけ Netlify Blobs に残す。

- **lost-update 防止**: ◎ DB の条件付き UPDATE（`WHERE logicalVersion = :expected`）や
  トランザクション/ユニーク制約で真の排他が得られる。stale write は 0 行更新 → 409。
- **operationId 一意性**: ◎ `operations(operationId PK)` のユニーク制約で冪等を storage が保証。
- **rollback**: ◎ 履歴行 immutable + `current_version` の条件付き更新で原子的。
- **障害復旧**: ◎ トランザクション境界で中間状態を残さない。画像は先に Blobs へ create-only、
  manifest 行の commit は最後に 1 トランザクション。
- **運用コスト**: △〜○ Airtable 流用なら追加サービス無し（ただし Airtable は厳密な
  トランザクション/条件付き更新が弱く、レート制限・整合性に注意）。専用 DB 採用なら
  接続情報・課金・バックアップが増える。
- **実装コスト**: △ `manifestStore.js` の store I/F を DB アダプタに置換。handlers は概ね流用可
  （apply* の CAS を DB の条件付き UPDATE に写像）。
- **備考**: **既存の UUID-manifest + logicalVersion + operationId 設計をほぼそのまま DB に移せる**
  ため、設計思想の連続性が高い。Airtable は「条件付き更新の原子性」が保証しづらい点が最大の懸念。

## 案 B: durable single-writer queue（直列化キュー）

書込みリクエストを **durable なキュー**（例: Netlify Background Functions + 外部キュー、
もしくは順序保証のあるジョブランナー）に載せ、**1 本の consumer が直列に**適用する。

- **lost-update 防止**: ○ 直列適用で同時実行が構造的に消える。ただし「キューが正しく単一
  consumer・順序保証・at-least-once」であることに依存。at-least-once なら operationId 冪等が必須。
- **operationId 一意性**: △ storage が保証しない。適用側で「処理済み operationId」を
  永続化して重複を弾く必要がある（結局 A の operation テーブル相当が要る）。
- **rollback**: ○ 直列なので巻き戻しも 1 ジョブとして順序内で処理できる。
- **障害復旧**: △ consumer クラッシュ時の再開・毒メッセージ・可視性タイムアウトの設計が要る。
- **運用コスト**: △ キュー基盤・consumer の死活監視・DLQ が増える。Netlify 単体では
  「単一 consumer の順序保証」を素直に得にくい（外部依存が濃くなる）。
- **実装コスト**: △〜✗ 非同期化で admin UX（即時反映）が変わる。API は 202 Accepted +
  状態ポーリングに再設計が要る。
- **備考**: 書込みが 1 日 1 回の本要件に対しては **overkill**。直列化のためだけに非同期基盤を
  持ち込むと運用が重くなる。

## 案 C: single-writer 制約への仕様縮小（アプリ層で同時書込みを禁止）

storage は現状（Blobs）のまま、**同時書込みが起きない前提を運用と軽量ロックで担保**する。
例: 書込み前に `write-lease`（短 TTL の create-only ロックキー）を取得できた 1 者だけが書ける。

- **lost-update 防止**: △ Blobs の create-only 自体が strong でない（#13 で実証）ため、
  **lease キーの create-only も同じ理由で取りこぼし得る**。＝ Blobs だけでは真の排他にならない。
  「MK が 1 人・1 日 1 操作」という**運用規約**に頼る形になり、storage 保証ではない。
- **operationId 一意性**: △ 同上（アプリ層の再送ガードのみ。strong でない）。
- **rollback**: ○ ロジックは現状流用。
- **障害復旧**: △ lease の TTL 切れ・孤児ロックのリカバリ設計が要る。
- **運用コスト**: ◎ 追加サービス無し。
- **実装コスト**: ◎ 最小。
- **備考**: **storage 保証ではなく運用規約**での縮小。「絶対に同時書込みしない」を人手で守れる
  範囲でのみ許容。厳密な安全性は得られないため、金銭が絡む実績表示には弱い。

---

## 比較サマリ

| 軸 | A: DB 正本 | B: single-writer queue | C: 仕様縮小 |
|---|---|---|---|
| lost-update 防止 | ◎ storage 保証 | ○ 直列化に依存 | △ 運用規約（strong でない） |
| operationId 一意性 | ◎ PK 制約 | △ アプリ層 | △ アプリ層 |
| rollback | ◎ 原子的 | ○ | ○ |
| 障害復旧 | ◎ TX 境界 | △ consumer 設計 | △ lease 復旧 |
| 運用コスト | △〜○ | △ | ◎ |
| 実装コスト | △ | △〜✗ | ◎ |
| 設計連続性 | ◎（既存設計を移設） | △ | ◎ |

## 推奨

**案 A（transactional DB を manifest/operation/version の正本、画像は Blobs 継続）を推奨する。**

理由:

1. **唯一 storage レベルで lost-update と operationId 一意性を保証できる**。B/C は結局
   「アプリ層の冪等＋運用規約」に帰着し、金銭が絡む実績表示（的中/払戻）の正当性根拠として弱い。
2. 既存の **UUID-manifest + logicalVersion + operationId + immutable 履歴**設計をほぼそのまま
   DB に写像でき、`manifestStore.js` の store I/F 差し替えで済む（handlers/検証は流用）。
3. 画像は競合しない immutable リソースなので **Blobs のまま**でよく、移行範囲を最小化できる。

実装に進む場合の論点（別タスク・別承認）:

- **DB 選定**: Airtable 流用は「条件付き更新の原子性」保証が弱く不安。**条件付き UPDATE /
  ユニーク制約 / トランザクションを明確に持つ DB**（マネージド Postgres 等）を優先検討。
- 秘密情報（接続文字列）は Netlify env（Functions scope）へ。**SESSION_SIGNING_SECRET /
  ADMIN_SECRET は変更しない**。
- 移行は **read-only 検証 → canary（隔離）→ 本番**の段階を踏み、その間も
  `PREMIUM_PLUS_STORAGE_SAFE` hard block は**安全が実証されるまで解除しない**。

> 本書は比較のみ。DB 作成・env 投入・実装・データ書込みは未実施。着手には別承認が必要。
