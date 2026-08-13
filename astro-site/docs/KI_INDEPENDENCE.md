# keiba-intelligence との関係（独立運用）

> CLAUDE.md から集約（2026-08-13）。**運用方針の正本はこのファイル**。
> AK と KI の分離は事故防止の中核なので、要約せず原文のまま保持する。

### keiba-intelligence との関係（独立運用、2026-05-23〜）

`analytics-keiba` と `keiba-intelligence` は **別サービスとして独立運用** する。
両方とも今後も稼働を続け、それぞれ独自の顧客に対して予想を提供する。

#### 運用方針

- `keiba-intelligence` は `analytics-keiba` とは **別サービスとして独立運用** する
- admin (`keiba-data-shared-admin`) からの dispatch / データ供給は **当面維持** する（両 repo にデータが届く状態を続ける）
- `/admin/computer-manager` は **予想本体**（コンピ指数 + 印 + 役割振り分け）
- `/admin/race-data-importer` は **補完情報**（騎手・調教師・斤量・性齢・近走などの値）
- `analytics-keiba` 側のロジック修正を `keiba-intelligence` へ **自動的に横展開しない**
- `keiba-intelligence` 側は **必要な場合のみ個別に修正** する
- 顧客表示に影響する汚染・誤表示が残る場合は、`keiba-intelligence` 側の運用方針に沿って **別途最小修正する**

#### 過去の経緯

2026-05-22 以前は両 repo で同じ判定式・同じ買い目生成ロジックを使う前提で、
メインレース判定や10点ロジックの変更は両 repo 同時に行うルールだった。
2026-05-23 にこの同期義務を取りやめ、両 repo は独立進化することとした。
過去の経緯を理由に同期作業を再開してはいけない。

