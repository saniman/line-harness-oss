# LINE Harness OSS — CLAUDE.md

プロジェクト指示の本体は **`AGENTS.md`**（エージェント非依存の SSoT）。下部の `@AGENTS.md` で読み込む。
Codex / Cursor など他エージェントに切り替えても同じ指示で作業できるよう、内容は AGENTS.md 側に置く。

## Claude Code 固有
- `/feature-*`（plan / implement / pr / review / address）はこのリポジトリの Claude Code スラッシュコマンド（`.claude/commands/`）。パイプラインの詳細は `docs/dev-workflow.md`。
- `.claude/rules/*.md` は `paths` frontmatter により対象ファイルを触ると自動ロードされる（Claude 専用の最適化）。他エージェント向けの索引は AGENTS.md の「詳細ルールの所在」を参照。

@AGENTS.md
@my-preferences.md
