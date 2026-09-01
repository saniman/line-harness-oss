#!/usr/bin/env node
/**
 * 次に使うべきマイグレーション番号を出力する。
 *
 * ## なぜこのスクリプトがあるのか
 *
 * 2026-08-17 の upstream sync レポートが「fork の 050〜054 を 070番台にリナンバせよ」と
 * 提案した。これは実行すると本番 D1 が壊れる（D1 は適用済み migration を d1_migrations に
 * **ファイル名で**記録するため、リネーム＝未適用の新規ファイルと判定され再実行される）。
 *
 * 原因は「番号が同じ＝衝突」という誤った推論だった。番号の算出を人にも LLM にも
 * 推論させず、このスクリプトの出力をそのまま使うことで、その推論自体を不要にする。
 *
 * 採番ルール・リネーム禁止の理由は `.claude/rules/migrations.md` を参照。
 *
 * ## 使い方
 *
 *   node packages/db/scripts/next-migration-number.mjs           # 人間向け出力
 *   node packages/db/scripts/next-migration-number.mjs --json    # JSON 出力
 *   node packages/db/scripts/next-migration-number.mjs --dir <path>  # 対象ディレクトリ指定
 *
 * 読み取り専用。ファイルの作成・変更・削除は一切行わない。
 */
import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** 既定のマイグレーションディレクトリ（このスクリプトからの相対で解決する） */
export const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * ファイル名の先頭の数字を番号として取り出す。
 * `009_token_expiry.sql` → 9 / `README.md` → null
 *
 * 文字列のまま比較すると '099' > '100' になってしまうため、必ず数値化して扱う。
 */
export function parseMigrationNumber(filename) {
  if (!filename.endsWith('.sql')) return null;
  const m = /^(\d+)_/.exec(filename);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** 番号を既存ファイルに合わせて3桁ゼロ埋めする（1000 以上はそのまま） */
export function formatMigrationPrefix(n) {
  return String(n).padStart(3, '0');
}

/**
 * ファイル名の配列から採番の状況をまとめる。
 *
 * 番号の重複は**再適用を引き起こさない**。ファイル名が違えば d1_migrations 上は
 * 別レコードなので、fork に 009 / 018 / 043 が 2 本ずつあっても本番は正常に動作している。
 * 誤って「衝突」と報告されないよう、重複は「正常・対処不要」として明示的に返す。
 *
 * ただし wrangler は数値プレフィックスだけでソートし、同番号は tie-break せず
 * readdir の順序が残る（4.0.0 で確認）。**同番号のファイル同士の適用順は保証されない**
 * ため、依存関係のあるマイグレーションを同じ番号で作ってはいけない。
 * だからこそ新規追加は常に「最大 + 1」を使う。
 */
export function summarizeMigrations(filenames) {
  const seen = new Map();
  let max = null;

  for (const name of filenames) {
    const n = parseMigrationNumber(name);
    if (n === null) continue;
    seen.set(n, (seen.get(n) ?? 0) + 1);
    if (max === null || n > max) max = n;
  }

  // 最大番号が重複している場合、readdir の順序に依存すると実行ごとに表示が変わる。
  // ファイル名でソートして先頭を採ることで決定的にする。
  const maxFile =
    max === null
      ? null
      : filenames
          .filter((name) => parseMigrationNumber(name) === max)
          .sort()[0];

  const duplicates = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b)
    .map(formatMigrationPrefix);

  const count = [...seen.values()].reduce((a, b) => a + b, 0);
  const next = max === null ? 1 : max + 1;

  return { count, max, maxFile, next, nextPrefix: formatMigrationPrefix(next), duplicates };
}

/** ディレクトリを読んで採番状況を返す（サブディレクトリは無視する） */
export function summarizeMigrationsDir(dir = DEFAULT_MIGRATIONS_DIR) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return summarizeMigrations(names);
}

/** 引数エラーを標準エラーに出して終了する */
function fail(message) {
  process.stderr.write(`エラー: ${message}\n`);
  process.exit(1);
}

/**
 * 引数を解釈する。
 *
 * 未知のフラグや値の無い --dir を**黙って無視すると、既定ディレクトリの番号を
 * 「指定したディレクトリの番号」として返してしまう**（打ち間違いに気づけない）。
 * 番号を間違えさせないためのツールなので、解釈できない引数は必ず落とす。
 */
function parseArgs(argv) {
  let dir = DEFAULT_MIGRATIONS_DIR;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        fail('--dir にディレクトリを指定してください（例: --dir packages/db/migrations）');
      }
      dir = value;
      i++;
    } else if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length);
      if (!value) {
        fail('--dir= にディレクトリを指定してください（例: --dir=packages/db/migrations）');
      }
      dir = value;
    } else {
      fail(`不明な引数です: ${arg}（使えるのは --json / --dir <path> / --dir=<path>）`);
    }
  }

  return { dir, json };
}

function main(argv) {
  const { dir, json } = parseArgs(argv);

  let summary;
  try {
    summary = summarizeMigrationsDir(dir);
  } catch (err) {
    fail(`マイグレーションディレクトリを読めません: ${dir}（${err.code ?? err.message}）`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
    return;
  }

  const lines = [
    `次の採番: ${summary.nextPrefix}`,
    summary.max === null
      ? '現在の最大: (マイグレーションなし)'
      : `現在の最大: ${formatMigrationPrefix(summary.max)} (${summary.maxFile})`,
    `ファイル数: ${summary.count}`,
    summary.duplicates.length > 0
      ? `番号の重複（正常・対処不要）: ${summary.duplicates.join(', ')}`
      : '番号の重複: なし',
    '',
    '※ 既存のマイグレーションファイルはリネーム・削除しないこと。',
    '  d1_migrations がファイル名で適用済みを記録しているため、リネームすると再適用され本番が壊れる。',
    '  詳細: .claude/rules/migrations.md',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// 直接実行されたときだけ CLI として動く（import 時は副作用なし）。
// import.meta.url は realpath 解決済みなので、argv[1] も realpath に揃えないと
// シンボリックリンク経由の実行で一致せず、何も出力せず終了してしまう。
if (process.argv[1]) {
  let invoked = resolve(process.argv[1]);
  try {
    invoked = realpathSync(invoked);
  } catch {
    /* 解決できなければ resolve 結果のまま比較する */
  }
  if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
}
