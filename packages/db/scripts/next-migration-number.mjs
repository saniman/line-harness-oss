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
 *   node packages/db/scripts/next-migration-number.mjs --no-remote   # リモート探索を省く
 *
 * 読み取り専用。ファイルの作成・変更・削除は一切行わない。
 *
 * ## リモートブランチも見る理由（Issue #69）
 *
 * ローカルの migrations だけを見ていたため、**別ブランチで採番済みの番号が見えず**、
 * 並列レーンで同じ番号を採番する事故が起きた（2026-09-05・#66 と #67 が両方 824）。
 * どちらもこのスクリプトの出力に従っただけで、手順の誤りではなかった。
 *
 * そこでリモート追跡ブランチ（refs/remotes/origin/*）の migrations も集計する。
 * ⚠️ ただし **git が無くても・オフラインでも動くこと**を優先する。
 *    採番できないと日常の作業が止まるので、失敗したらローカルだけの結果に落として
 *    「リモートは確認できなかった」と明示する。
 */
import { readdirSync, realpathSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  const ignored = [];
  let max = null;

  for (const name of filenames) {
    const n = parseMigrationNumber(name);
    if (n === null) {
      // wrangler の getMigrationNames は .sql なら番号の有無に関わらず拾って実行する。
      // 黙って無視すると「wrangler は実行するのに集計に出てこない」ファイルが生まれる。
      if (name.endsWith('.sql')) ignored.push(name);
      continue;
    }
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

  return {
    count,
    max,
    maxFile,
    next,
    nextPrefix: formatMigrationPrefix(next),
    duplicates,
    ignored: ignored.sort(),
  };
}

/** ディレクトリを読んで採番状況を返す（サブディレクトリは無視する） */
export function summarizeMigrationsDir(dir = DEFAULT_MIGRATIONS_DIR) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return summarizeMigrations(names);
}

const execFileAsync = promisify(execFile);

/**
 * リモート追跡ブランチが使っている番号を集める。
 *
 * ⚠️ **失敗しても例外を投げない。** git が無い・リポジトリでない等は、
 *    採番できない理由にはならない。checked: false と理由を返して、
 *    呼び出し側がローカルだけで続行できるようにする。
 *
 * ⚠️ `git fetch` はしない。ネットワーク待ちで採番が止まるのを避ける。
 *    見えるのは「最後に fetch した時点のリモート」なので、
 *    並列レーンでは各自が fetch していることが前提（出力にもその旨を出す）。
 *
 * ⚠️ ブランチごとの `ls-tree` は**並列で回す**。直列だと 33 ブランチで 2.2 秒かかり、
 *    採番のたびに待たされて使われなくなる（並列なら 0.5 秒程度）。
 */
export async function collectRemoteMigrationNumbers(cwd = process.cwd()) {
  const git = (args) =>
    execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });

  let branches;
  try {
    const { stdout } = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
    branches = stdout.split('\n').filter(Boolean);
  } catch (err) {
    return {
      checked: false,
      max: null,
      holders: {},
      reason: `git のリモート追跡ブランチを読めませんでした（${err.code ?? err.message}）`,
    };
  }

  if (branches.length === 0) return { checked: true, max: null, holders: {} };

  const listings = await Promise.all(
    branches.map((b) =>
      git(['ls-tree', '--name-only', b, 'packages/db/migrations/'])
        .then((r) => [b, r.stdout])
        // migrations が無いブランチ・壊れた ref はスキップして他を続ける
        .catch(() => [b, '']),
    ),
  );

  /** @type {Map<number, Set<string>>} */
  const holders = new Map();
  let max = null;

  for (const [branch, out] of listings) {
    for (const path of out.split('\n')) {
      const name = path.split('/').pop();
      if (!name) continue;
      const n = parseMigrationNumber(name);
      if (n === null) continue;
      if (!holders.has(n)) holders.set(n, new Set());
      holders.get(n).add(branch);
      if (max === null || n > max) max = n;
    }
  }

  // JSON に出すため Set を配列にし、キーはゼロ埋め文字列にそろえる
  const holdersOut = {};
  for (const [n, set] of [...holders.entries()].sort((a, b) => a[0] - b[0])) {
    holdersOut[formatMigrationPrefix(n)] = [...set].sort();
  }

  return { checked: true, max, holders: holdersOut };
}

/**
 * ローカルとリモートの両方を見て採番状況を返す。
 *
 * ⚠️ 既存の JSON 契約（count / max / maxFile / duplicates / ignored）は
 *    **ローカルの集計のまま**にする。テストが CLI の出力形を検証しているうえ、
 *    「ローカルに何があるか」と「次に何番を使うべきか」は別の情報だから。
 *    次番号（next / nextPrefix）だけがリモートを織り込む。
 */
export async function summarizeWithRemote(dir, { skipRemote = false, cwd } = {}) {
  const local = summarizeMigrationsDir(dir);
  if (skipRemote) {
    return {
      ...local,
      remote: { checked: false, max: null, holders: {}, reason: '--no-remote が指定されました' },
    };
  }

  const remote = await collectRemoteMigrationNumbers(cwd);
  if (!remote.checked || remote.max === null) return { ...local, remote };

  const max = local.max === null ? remote.max : Math.max(local.max, remote.max);
  const next = max + 1;
  return { ...local, next, nextPrefix: formatMigrationPrefix(next), remote };
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
  let skipRemote = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--no-remote') {
      skipRemote = true;
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
      fail(
        `不明な引数です: ${arg}`
        + '（使えるのは --json / --dir <path> / --dir=<path> / --no-remote）',
      );
    }
  }

  return { dir, json, skipRemote };
}

async function main(argv) {
  const { dir, json, skipRemote } = parseArgs(argv);

  let summary;
  try {
    summary = await summarizeWithRemote(dir, { skipRemote });
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
      ? `既存の番号重複: ${summary.duplicates.join(', ')}（適用済みなのでそのまま。新規に重複を作らないこと）`
      : '既存の番号重複: なし',
  ];

  const remote = summary.remote;
  if (remote?.checked) {
    // 次番号を押し上げたのがリモートなら、誰が使っているかを見せる。
    // 「相手が push 済みなら自分が譲る」を人が判断できるようにするため
    const used = Object.entries(remote.holders)
      .filter(([n]) => Number(n) >= (summary.max ?? 0))
      .map(([n, brs]) => `  ${n} … ${brs.join(', ')}`);
    if (used.length > 0) {
      lines.push('', 'リモートで採番済み（ローカルに無い番号を含む）:', ...used);
    }
  } else {
    lines.push(
      '',
      `⚠️ リモートの採番を確認できませんでした（${remote?.reason ?? '理由不明'}）。`,
      '  並列レーンで作業している場合、別ブランチと番号が衝突する可能性があります。',
    );
  }

  if (summary.ignored.length > 0) {
    lines.push(
      '',
      `⚠️ 番号が付いていない .sql: ${summary.ignored.join(', ')}`,
      '  wrangler はこれらも適用対象として拾うが、採番の集計には含めていない。',
    );
  }

  lines.push(
    '',
    '※ 既存のマイグレーションファイルはリネーム・削除しないこと。',
    '  d1_migrations がファイル名で適用済みを記録しているため、リネームすると再適用され本番が壊れる。',
    '  詳細: .claude/rules/migrations.md',
    '',
    '※ リモートは最後に fetch した時点のものを見ている。',
    '  並列レーンで作業するときは、採番の前に git fetch すること。',
    '  番号が衝突したら「push 済みの側が優先、未 push の側が振り直す」',
    '  （push 済みをリネームすると本番が壊れるため）。',
  );
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
  if (invoked === fileURLToPath(import.meta.url)) {
    // main は async。reject を握らないと Node 20+ で終了コードが 0 のまま警告だけ出る
    main(process.argv.slice(2)).catch((err) => fail(err?.message ?? String(err)));
  }
}
