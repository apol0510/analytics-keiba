# archive 同期・取込要否の監視契約

> CLAUDE.md から集約（2026-08-13）。**契約の正本はこのファイル**。
> 偽の緑（監視が成立していないのに ✅）を二度と作らないための取り決め。

- `auto-sync-check.yml` - archive整合性検証
- `verify-archive-sync.yml` - archive 欠落の日次監視（過去7日）

### verify-archive-sync.yml の監視契約（2026-08-09 恒久修正）

`scripts/checkArchiveCoverage.mjs` が keiba-data-shared の **per-venue 構造**を直接読み、
archive（`src/data/archiveResultsJra.json` / `archiveResults.json`）と突き合わせる。

**背景**: 2026-08-09 以前は `checkSharedDailyFile.mjs` で
**統合 daily ファイル**（`jra/results/YYYY/MM/YYYY-MM-DD.json`）だけを見ていた。
shared の正本は per-venue（`...-CHU.json`）なので常に 404 になり、
実開催日でも「Not found」→ アラート判定に入らず
「✅ All dates synchronized」を出していた（＝監視が成立していない偽の緑）。

**開催会場の決め方**: 暦や決め打ちで推測しない。月ディレクトリ一覧から
`YYYY-MM-DD-{CODE}.json` に一致するファイルを拾い、**shared に実在するものだけ**を採用する。

**状態の区別と exit code**:

| 状態 | 意味 | exit | run |
|---|---|---|---|
| `ok` | archive 反映済み | 0 | 緑 |
| `no_race` | results も予想も無い＝非開催 | 0 | 緑 |
| `partial` | 投入途中（閾値未満）。欠落と断定しない | 0 | 緑 |
| `deferred` | rate limit / timeout / 5xx で確定不能 | 2 | 緑（⚠️ ログのみ・次回再検証） |
| `archive_missing` | shared に実データがあるのに archive 未反映 | 3 | **赤**（アラートメール後に failure） |
| `results_missing` | 予想はあるのに結果未登録 | 3 | **赤**（同上） |
| — | token 未設定 / 401 / 権限不足 / schema 不一致 | 1 | **赤**（即時） |

閾値は JRA 10R / 南関 12R。予想の有無は JRA が computer 予想
（`jra/predictions/computer/`）、南関が `nankan/predictions/`。
racebook は前倒し/日付誤りの stray があるため判定根拠にしない。

**禁止**: `continue-on-error` で隠さない。欠落があるのに exit 0 を返さない。
一時エラーだけを緑にし、実データ欠落は必ず run を failure にする。

**API GET**: 1 プロセスで7日ぶんを処理し、月ディレクトリ一覧を cache する
（同一 run で同じディレクトリを二度取らない）。非開催日にはファイル GET を撃たない。

### import-results-jra-daily.yml の取込要否判定（2026-08-09 恒久修正）

`scripts/checkJraResultsForImport.mjs` が shared の **per-venue results** を読み、
取込要否（`has_missing`）を判定する。

**背景**: 2026-08-09 以前は `checkSharedDailyFile.mjs`（統合 daily ファイル前提）を
使っていたため `FOUND` が常に false → `has_missing=false` → **取込が一度も起動しなかった**。
JRA archive が最新に保たれていたのは `archive-sync.yml`（自己回復）が補っていたため。
verify-archive-sync と同じ根因。

**判定**:

| STATE | 意味 | FOUND | exit |
|---|---|---|---|
| `complete` | 実在会場すべてが 10R 以上 | true | 0 |
| `partial` | results はあるが未完了の会場がある（当日未完了など） | true | 0 |
| `not_posted` | computer 予想はあるが results が 1 件も無い | false | 0 |
| `no_race` | results も予想も無い＝非開催 | false | 0 |
| `deferred` | rate limit / timeout / 5xx で確定不能 | false | 2 |
| — | token 未設定 / 401 / 権限不足 / schema 不一致 | — | 1 |

`EXPECTED_VENUES` は shared に実在する会場ファイル数。workflow は
「archive 済み会場数 < EXPECTED_VENUES なら再取込」で追いつく（partial でも自動的に収束する）。

**deferred は「results 無し」に丸めない**。取込を見送るだけで run は落とさず、
次回 schedule で再判定する。token/認証/権限/schema は **fail-closed**（run を失敗させ、
results 無しと誤判定しない）。

keiba-intelligenceで実証済みの構成を採用。Concurrency Groupは
- 南関: `archive-nankan-update`
- JRA: `archive-jra-update`
で統一。

