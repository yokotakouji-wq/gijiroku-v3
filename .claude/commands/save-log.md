# 作業ログをGitに保存

作業ログ関連の変更をGitに保存してください。

## やること

以下を順番に実行してください。

1. `git status` を確認する
2. `.claude/commands/` と `docs/claude-code-log/` の変更を `git add` する
3. コミットメッセージを考える
4. `git commit` する
5. 最後に `git status` を確認する

## 実行するコマンド

```bash
git status
git add .claude/commands docs/claude-code-log
git commit -m "Update Claude Code work logs"
git status