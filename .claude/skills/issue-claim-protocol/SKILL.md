---
allowed-agents: claude-code
description: 複数のエージェントセッションが同一GitHubリポジトリのIssueを並行処理する際のclaimプロトコル。同じIssueへの殺到による重複実装・相互巻き戻しを防ぐため、Issueのピック手順・早期Draft PRによるclaim確立・heartbeat付きclaimメタデータ・staleなclaimの回収・完了/撤退時の後始末を定める。「重要度の高いIssueを順次解決して」のような複数セッションでの並行処理指示時に使う。
metadata:
    github-path: issue-claim-protocol
    github-ref: refs/heads/main
    github-repo: https://github.com/mpppk/skills
    github-tree-sha: c62e2476d2a326c8b08e9bf74fc9bacf5717c29c
name: issue-claim-protocol
---
# issue-claim-protocol

複数のエージェントセッション（環境）が同じリポジトリのIssueを並行処理する際の占有（claim）プロトコル。並行セッションが同じIssueに殺到して重複実装・相互巻き戻しを起こすのを防ぐ。

**claimの一次情報は「`Closes #N` でIssueにリンクされた open PR」**。ラベルは高速な事前フィルタとしての補助信号（best-effort）で、付与・除去に失敗しても致命的ではない。

## When to use

- 「重要度の高いIssueを順次解決して」のように、複数セッションで同一リポジトリのIssueを並行処理するとき
- 自分がIssue対応を開始する前に、他セッションが着手していないかを確認したいとき
- 着手したIssueのclaim（Draft PR）を確立・更新・回収するとき

## リポジトリ固有の設定

リポジトリの `CLAUDE.md`（または `AGENTS.md`）に下記キーを定義できる。定義が無ければデフォルト値で動く。

| キー | デフォルト | 意味 |
|---|---|---|
| `CLAIM_LABEL` | `in-progress` | claim状態を示すラベル名。ラベルが存在しない場合は該当チェックをスキップ可 |
| `CLAIM_BRANCH_PREFIX` | `claude/issue-<N>-<slug>` | ブランチ命名規則 |
| `CLAIM_SCHEMA_DIRS` | （なし） | スキーマ変更PRを同時に1本に制限するフォルダ（カンマ区切りで複数可）。定義時は「該当フォルダを変更する open PR が存在したら対象Issueはスキップ」のチェックが有効になる |
| `CLAIM_HOT_FILES` | （なし） | 並行PR間で変更が大きく重なるのを避けるホットファイル（カンマ区切りで複数可）。定義時は「既存 open PR が同時に触るIssue同士は後回し」のチェックが有効になる |
| `CLAIM_STALE_HOURS` | `6` | staleと判定する `last-heartbeat`（またはPR最終更新）からの経過時間 |

リポジトリ側の記載例:

```markdown
## 複数セッションでのIssue並行処理

`issue-claim-protocol` skill に従う。リポジトリ固有設定:

- CLAIM_LABEL: `in-progress`
- CLAIM_SCHEMA_DIRS: `drizzle/`
- CLAIM_HOT_FILES: `src/data/aops.json`, `src/db/schema.ts`
```

## Issueのピック手順

1. `origin/main` を最新化し、重要度順に候補Issueを並べる。
2. 上位から順に以下を確認し、**最初に全て通過したIssueを1つだけ**選ぶ:
   - `CLAIM_LABEL` ラベルが付いていない（ラベルが存在しない場合はこのチェックはスキップ可）
   - Issueにリンクされた open PR がない（本文に `Closes #N` / `#N` を含む open PR を検索して確認）
   - スキーマ変更を伴うIssueで `CLAIM_SCHEMA_DIRS` が定義されている場合、該当フォルダを変更する open PR が存在しない（存在するならこのIssueはスキップ。「スキーマ変更PRは同時1本」ルールのピック時適用）
   - 既存 open PR の変更ファイルと大きく重ならない（`CLAIM_HOT_FILES` に定義されたファイルを同時に触るIssue同士は後回し）
3. claim競合を検知したら**同一Issueで再挑戦せず、次の候補へ進む**（先着優先・バックオフ）。

## claimの確立（早期Draft PR）

1. 可能なら `CLAIM_LABEL` ラベルをIssueに付与する（なければ・権限がなければ省略可）。
2. ブランチを作り、最初の小さなコミット（計画のみ・空実装でも可）をpushして、**実装を進める前に直ちにDraft PRを作成**する。本文に `Closes #N` と後述のclaimメタデータを含める。PRを作業の最後に作る運用では「着手〜PR作成」の間が無防備になり、リンクPRチェックが機能しない。
3. **Draft PR作成後、同一Issueにリンクされた open PR を再取得**し、自分より作成時刻の早いPRが存在したら、自分のDraft PRをその旨を本文に記してクローズし、ラベルを外して次の候補Issueへ移る（claim-then-verify。作成時刻はGitHubがサーバ側で採番するため順序が確定する）。

## claimメタデータ（PR descriptionを都度更新）

PR本文の末尾に以下のセクションを置き、**作業の節目（実装開始・push・動作確認開始・ready化など）ごとに `last-heartbeat` と `status` を更新する**。Issueへのコメント追記ではなくPR description更新にするのは、最新状態が1箇所に保たれ、他セッションの読む場所が固定されるため。タイムスタンプは `date -u +%Y-%m-%dT%H:%M:%SZ` で取得したUTCを使う。

```
## Claim
- branch: <CLAIM_BRANCH_PREFIX>
- last-heartbeat: <UTC ISO8601>
- status: implementing | verifying | ready
```

## staleなclaimの回収

セッションはコンテナ回収等で予告なく死ぬため、放置されたclaimは回収してよい。以下を**全て**満たす場合にstaleとみなす:

- `last-heartbeat` が `CLAIM_STALE_HOURS`（デフォルト6）時間以上前（claimメタデータがないPRは、PR本文・コミットの最終更新が `CLAIM_STALE_HOURS` 時間以上前）
- ブランチに新しいコミットがない

回収する側は、旧Draft PRに回収の旨をコメントしてクローズし、新たに自分のclaim（Draft PR）を確立する。**stale判定に満たないclaimは、進捗が見えなくても上書きしない**（誤回収による重複実装のほうが待ちより高くつく）。

## 完了・撤退時の後始末

- ready化の直前に、**同一Issueへの別open PR・mainへの先行マージがないかを再確認**する（長時間セッションでは着手時のチェックが陳腐化する）。
- PRがマージ/クローズされたら `CLAIM_LABEL` ラベルを外す（`Closes #N` のauto-closeはラベルまでは外さない）。
- 作業を断念する場合は、Draft PRに理由を記してクローズし、ラベルを外す。**黙って放置しない**。

## その他のルール

- **1 Issue = 1 ブランチ = 1 PR**。「重要度の高いIssueを順次解決して」のように複数Issueをまたぐ指示を受けた場合、**2件目以降もユーザに確認せず新しいブランチを切ってよい**（`CLAIM_BRANCH_PREFIX` に従う）。セッションに作業ブランチが指定されていても、それは1件目の置き場所であって「以降の全Issueをそこに積む」意味ではない。同じブランチに積むと1本のPRが複数Issueの混在になり、`Closes #N` のauto-closeもレビューも成立しなくなる。
- **WIP制限**: 1セッションが同時にclaimしてよいIssueは1つ。PRをopen（Draft作成）してから次のIssueをclaimするのではなく、**現在のPRをready化（または撤退）してから**次をclaimする。
- 作業途中で同一Issueの別 open PR を発見したら、競合PRをready化せず作業を止め、自分のPR本文に状況を記して撤退する（先着優先）。判断が付かない場合はユーザに報告する。
