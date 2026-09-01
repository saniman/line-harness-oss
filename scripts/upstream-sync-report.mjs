#!/usr/bin/env node
/**
 * upstream との差分を「事実だけ」レポートする。
 *
 * ## なぜ事実だけなのか
 *
 * 以前のレポートは LLM がリスク評価と取り込み推奨まで書いていたが、その推奨は
 * 実際には危険か不要だった:
 *
 *   - 「fork の 050〜054 を 070番台にリナンバせよ」→ 実行すれば本番 D1 が壊れた (#32)
 *   - 「git checkout upstream/main -- scheduled.test.ts」→ fork に scheduled.ts が無く
 *     テストが落ちる (#37)
 *   - 「5分ティック最適化を適用検討」→ fork の cron は既に5分間隔で不要 (#37)
 *
 * 一方でコミット一覧・変更ファイルの分類・マイグレーション番号といった「事実」は
 * 毎回正確だった。Issue 本文は計画の SSoT なので、検証されていない推奨をそこに
 * 置かない。リスク評価と取り込み判断は人間か /feature-plan が後から付ける。
 *
 * ## 使い方
 *
 *   node scripts/upstream-sync-report.mjs           # Markdown を stdout
 *   node scripts/upstream-sync-report.mjs --json    # JSON（CI の重複判定用）
 *
 * 読み取り専用。git の書き込み操作は一切行わない。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = join(REPO_ROOT, '.claude/upstream-sync-state.json');

/** 一覧に載せる最大件数。超えた分は件数だけ示す（黙って切り捨てない）。 */
export const LIST_LIMIT = 20;

/**
 * コミット一覧の最大件数。
 * `last_synced_commit` は実際に取り込んだときだけ進むため件数は単調増加する。
 * 無制限に並べると Issue 本文が GitHub の上限 65536 文字を超え、
 * `gh issue create` が 422 で落ちて週次ジョブごと死ぬ。
 */
export const COMMIT_LIMIT = 30;

/**
 * 変更ファイルを4分類する。
 *
 * 「upstream のみ変更」をひとまとめに「取り込み可」とすると、fork が採用していない
 * 機能のファイルまで推奨に混ざる（実測では 83 件中 53 件がそれだった）。
 * fork にファイルが存在するかで「更新候補」と「未導入機能」を分ける。
 *
 * @param upstreamChanged upstream 側で変更されたファイル
 * @param forkChanged     fork 側で変更されたファイル
 * @param existsInFork    そのパスが fork の作業ツリーに存在するか
 * @param upstreamDeleted upstream 側で削除されたファイル
 */
export function classifyFiles(upstreamChanged, forkChanged, existsInFork, upstreamDeleted = []) {
  const fork = new Set(forkChanged);
  const up = new Set(upstreamChanged);
  const deleted = new Set(upstreamDeleted);

  const updatable = [];
  const notAdopted = [];
  const needsCheck = [];
  const deletedUpstream = [];

  for (const path of [...up].sort()) {
    // fork 側も触っているなら、削除であっても消してよいかは人間の判断。
    if (fork.has(path)) {
      needsCheck.push(path);
      continue;
    }
    // upstream で削除されたファイルを「更新候補（そのまま取り込める）」に入れると、
    // 案内どおり git checkout したときに pathspec エラーになる。別枠にする。
    if (deleted.has(path)) {
      deletedUpstream.push(path);
      continue;
    }
    if (existsInFork(path)) updatable.push(path);
    else notAdopted.push(path);
  }

  // fork でだけ変更されている＝upstream に無い独自実装。貢献候補の母集団。
  const contribution = [...fork].filter((p) => !up.has(p)).sort();

  return { updatable, notAdopted, needsCheck, contribution, deletedUpstream };
}

/**
 * 箇条書きにする。上限を超えたら省略した件数を明示する。
 * @param code バッククォートで囲むか（ファイルパスは true、コミット行は false）
 */
export function renderList(files, limit = LIST_LIMIT, code = true) {
  if (files.length === 0) return '_なし_';
  const shown = files.slice(0, limit);
  const lines = shown.map((f) => (code ? `- \`${f}\`` : `- ${f}`));
  if (files.length > limit) {
    lines.push(`- _…他 ${files.length - limit} 件（全 ${files.length} 件）_`);
  }
  return lines.join('\n');
}

// ─── ここから下は git を呼ぶ薄いラッパ（純粋関数ではない） ───

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function gitLines(args) {
  const out = git(args);
  return out ? out.split('\n') : [];
}

/**
 * 前回同期地点。state が無い・壊れている・**その SHA に到達できない**場合は
 * fork の分岐点にフォールバックする。
 *
 * upstream の force-push 等で SHA が消えると `git log <sha>..upstream/main` が throw し、
 * レポート生成そのものが落ちる。週次ジョブが黙って失敗し続けるのを避ける。
 */
function lastSyncedCommit() {
  let candidate = null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (state.last_synced_commit) candidate = state.last_synced_commit;
  } catch {
    /* state が無い・壊れている場合は下のフォールバックへ */
  }

  if (candidate) {
    try {
      git(['cat-file', '-e', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      process.stderr.write(
        `警告: last_synced_commit (${candidate}) に到達できません。分岐点で代用します。\n`,
      );
    }
  }
  return git(['merge-base', 'HEAD', 'upstream/main']);
}

export function collectReport() {
  const last = lastSyncedCommit();
  const upstreamHead = git(['rev-parse', 'upstream/main']);
  const mergeBase = git(['merge-base', 'HEAD', 'upstream/main']);

  const commits = gitLines([
    'log', '--format=%h %ad %s', '--date=short', `${last}..upstream/main`,
  ]);

  const upstreamChanged = gitLines(['diff', '--name-only', `${last}..upstream/main`]);
  const forkChanged = gitLines(['diff', '--name-only', `${mergeBase}..HEAD`]);
  // --diff-filter=D で「upstream 側で削除された」パスだけを取る。
  // --no-renames が無いと git がリネームを検出して削除として数えず、
  // fork に残った古いコピーを警告できない（diff.renames は既定で有効）。
  const upstreamDeleted = gitLines([
    'diff', '--name-only', '--diff-filter=D', '--no-renames', `${last}..upstream/main`,
  ]);

  const classified = classifyFiles(
    upstreamChanged,
    forkChanged,
    (p) => existsSync(join(REPO_ROOT, p)),
    upstreamDeleted,
  );

  // upstream 側のマイグレーション追加。番号は推論せず next-migration-number.mjs に任せる。
  const migrations = upstreamChanged.filter((p) => p.startsWith('packages/db/migrations/'));
  let nextNumber = null;
  try {
    const out = execFileSync(
      'node',
      [join(REPO_ROOT, 'packages/db/scripts/next-migration-number.mjs'), '--json'],
      { encoding: 'utf8' },
    );
    nextNumber = JSON.parse(out).nextPrefix;
  } catch {
    /* 取得できなくてもレポート自体は出す */
  }

  return { last, upstreamHead, commitCount: commits.length, commits, classified, migrations, nextNumber };
}

export function renderMarkdown(r) {
  const c = r.classified;
  return `## 事実

- 前回同期地点: \`${r.last.slice(0, 7)}\`
- upstream HEAD: \`${r.upstreamHead}\`
- 未取り込みコミット: **${r.commitCount} 件**

> このレポートは**機械的に出せる事実だけ**を載せています。リスク評価・取り込み推奨は
> 含みません（過去に自動生成した推奨が本番を壊しかけたため / #32 #37）。
> 取り込むかどうかは \`/feature-plan\` で調査してから判断してください。

## 未取り込みコミット

${renderList(r.commits, COMMIT_LIMIT, false)}

## 変更ファイルの分類

### ✅ 更新候補（upstream のみ変更・fork にも同じファイルがある）— ${c.updatable.length} 件

${renderList(c.updatable)}

### 🆕 未導入機能（upstream のみ変更・fork に該当ファイルが無い）— ${c.notAdopted.length} 件

fork が採用していない機能の可能性が高い。取り込み判断は #34 を参照。

${renderList(c.notAdopted)}

### ⚠️ 要確認（両側で変更）— ${c.needsCheck.length} 件

${renderList(c.needsCheck)}

### 🗑 upstream で削除 — ${c.deletedUpstream.length} 件

upstream 側に既に無いファイル。\`git checkout upstream/main -- <path>\` はできない。

${renderList(c.deletedUpstream)}

### 💡 貢献候補（fork のみ変更）— ${c.contribution.length} 件

${renderList(c.contribution)}

## マイグレーション

${
  r.migrations.length
    ? `upstream 側で追加/変更された migration:\n\n${renderList(r.migrations)}`
    : '_upstream 側の migration 変更なし_'
}

取り込む場合の採番: **${r.nextNumber ?? '（取得失敗。next-migration-number.mjs を実行してください）'}**

> ⛔ 既存の migration ファイルはリネーム・削除しないこと（\`.claude/rules/migrations.md\`）。

---
<sub>自動生成: \`.github/workflows/upstream-sync.yml\` / upstream HEAD \`${r.upstreamHead}\`</sub>
`;
}

function main(argv) {
  const report = collectReport();
  if (argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify({
        last: report.last,
        upstreamHead: report.upstreamHead,
        commitCount: report.commitCount,
        counts: {
          updatable: report.classified.updatable.length,
          notAdopted: report.classified.notAdopted.length,
          needsCheck: report.classified.needsCheck.length,
          contribution: report.classified.contribution.length,
          deletedUpstream: report.classified.deletedUpstream.length,
        },
        migrations: report.migrations.length,
      }) + '\n',
    );
    return;
  }
  process.stdout.write(renderMarkdown(report));
}

// 直接実行されたときだけ CLI として動く（import 時は副作用なし）。
// import.meta.url は realpath 解決済みなので argv[1] も揃える。
if (process.argv[1]) {
  let invoked = resolve(process.argv[1]);
  try {
    const { realpathSync } = await import('node:fs');
    invoked = realpathSync(invoked);
  } catch {
    /* 解決できなければ resolve 結果のまま比較する */
  }
  if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
}
