#!/usr/bin/env node
/**
 * `DROP TABLE` を含むマイグレーションの「巻き添え被害」を洗い出す（Issue #111）。
 *
 * ## なぜ要るか
 *
 * SQLite は外部キーが有効なとき `DROP TABLE <親>` が暗黙の `DELETE FROM <親>` を行い、
 * 子テーブルへ `ON DELETE CASCADE` が伝播する。CHECK 制約を変えるためのテーブル再作成は
 *
 *     CREATE TABLE 親_v2 ...;  INSERT INTO 親_v2 SELECT ... FROM 親;  DROP TABLE 親;
 *
 * という形になるが、**親は INSERT...SELECT で救われるのに、子は誰も救わない**。
 * その結果「親はあるのに子が全部消えている」という気づきにくい壊れ方をする。
 * 実際に #110 で `scenario_steps` が DB 全体で 0 件になり、**8 日間** 誰も気づかなかった
 * （マイグレーションは成功し、アプリもエラーを出さないため）。
 *
 * ## 何をするか
 *
 * 1. マイグレーションから `DROP TABLE <親>` を抜き出す
 * 2. スキーマから `<親>` を参照する子テーブルと `ON DELETE` の挙動を求める
 * 3. 本番で流すための**読み取り専用**クエリを組み立てる
 *
 * ## 使い方
 *
 *   # 監査計画と、本番で流すクエリを出す（本番アクセス不要）
 *   node packages/db/scripts/audit-cascade-loss.mjs
 *   node packages/db/scripts/audit-cascade-loss.mjs --json
 *
 *   # 本番の実スキーマで見る（schema.sql は実 DB とズレることがある）
 *   pnpm exec wrangler d1 execute line-harness --remote --json \
 *     --command="SELECT name, sql FROM sqlite_master WHERE type='table'" > /tmp/master.json
 *   node packages/db/scripts/audit-cascade-loss.mjs --schema /tmp/master.json
 *
 * ⚠️ **このスクリプトは書き込まない。** 壊れているかもしれない本番に調査ツールが
 *    書き込む理由が無い。生成するクエリが SELECT だけであることはテストで守っている
 *    （`apps/worker/src/lib/cascade-audit.test.ts`）。
 *
 * ⚠️ `schema.sql` は実 DB とズレることがある（過去の ALTER が反映されていない等。
 *    `.claude/rules/migrations.md` 参照）。**結論を出すときは必ず本番の
 *    `sqlite_master` を `--schema` に渡す。**
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 件数比較の基準に使う時刻列の候補。左から順に探す */
const TIME_COLUMN_CANDIDATES = [
  'created_at',
  'started_at',
  'sent_at',
  'issued_at',
  'fetched_at',
  'updated_at',
];

/** `ON DELETE <action>` が子の行に何をするか */
function riskOf(onDelete) {
  if (onDelete === 'CASCADE') return 'rows_deleted';
  if (onDelete === 'SET NULL' || onDelete === 'SET DEFAULT') return 'link_cleared';
  // NO ACTION / RESTRICT は親の削除自体が拒否される（＝子は消えない）
  return 'blocked';
}

/**
 * `CREATE TABLE <名前> ( <本体> );` を取り出す。
 *
 * sqlite_master の `sql` も、schema.sql の記述も同じ形なので共通で扱える。
 */
export function parseTables(sql) {
  const tables = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)[`"\]]?\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    // 対応する閉じ括弧まで読む（本体に括弧が入れ子で出てくるため数える）
    let depth = 1;
    let i = re.lastIndex;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    tables.set(name, sql.slice(re.lastIndex, i - 1));
  }
  return tables;
}

/** 本体から列名を拾う（時刻列を選ぶためだけに使う簡易版） */
function columnsOf(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .map((line) => /^([a-z_]\w*)\s+\S/i.exec(line))
    .filter(Boolean)
    .map((m) => m[1])
    // 制約行（PRIMARY KEY (...) など）を列と誤認しない
    .filter((c) => !/^(primary|foreign|unique|check|constraint)$/i.test(c));
}

function pickTimeColumn(body) {
  const cols = columnsOf(body);
  return TIME_COLUMN_CANDIDATES.find((c) => cols.includes(c)) ?? null;
}

/**
 * `<子> → <親>` の外部キーを列挙する。
 *
 * ⚠️ 列インライン（`x TEXT REFERENCES p(id) ON DELETE CASCADE`）と
 *    テーブル末尾（`FOREIGN KEY (x) REFERENCES p(id) ON DELETE CASCADE`）の
 *    **両方**を拾う。片方だけ見ていると子を取りこぼし、「被害なし」と誤判定する。
 */
export function parseForeignKeys(tables) {
  const fks = [];
  for (const [child, body] of tables) {
    const re =
      /REFERENCES\s+[`"[]?([A-Za-z_]\w*)[`"\]]?\s*(?:\([^)]*\))?((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const parent = m[1];
      const clauses = m[2] || '';
      const onDelete = /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i.exec(clauses);
      fks.push({
        child,
        parent,
        onDelete: onDelete ? onDelete[1].toUpperCase().replace(/\s+/g, ' ') : 'NO ACTION',
        timeColumn: pickTimeColumn(body),
      });
    }
  }
  return fks;
}

/** マイグレーションから `DROP TABLE <親>` を抜き出す */
export function findDrops(dir) {
  const drops = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // 行コメント（-- ...）に書かれた DROP TABLE を拾わない
    const stripped = sql.replace(/--[^\n]*/g, '');
    const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)[`"\]]?/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(stripped)) !== null) {
      const parent = m[1];
      if (seen.has(parent)) continue;
      seen.add(parent);
      drops.push({ migration: basename(file), parent });
    }
  }
  return drops;
}

/**
 * 本番で流す読み取り専用クエリを組み立てる。
 *
 * 見たいのは2つ。
 *   ① 子テーブルの現在の件数（0 件なら全消しの疑いが濃い）
 *   ② そのマイグレーションの適用日より前の行が残っているか
 *      → 0 件なら「その時点で消された」と言える
 */
export function buildQueries(findings) {
  const queries = [
    "SELECT name, applied_at FROM d1_migrations ORDER BY applied_at",
  ];
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.child)) continue;
    seen.add(f.child);
    queries.push(`SELECT '${f.child}' AS child, COUNT(*) AS rows FROM ${f.child}`);
    if (f.timeColumn) {
      queries.push(
        `SELECT '${f.child}' AS child, MIN(${f.timeColumn}) AS oldest, COUNT(*) AS rows FROM ${f.child}`,
      );
    }
  }
  return queries;
}

export function audit({ migrationsDir, schemaSql }) {
  const tables = parseTables(schemaSql);
  const fks = parseForeignKeys(tables);
  const drops = findDrops(migrationsDir);

  const findings = [];
  for (const { migration, parent } of drops) {
    for (const fk of fks) {
      if (fk.parent.toLowerCase() !== parent.toLowerCase()) continue;
      findings.push({
        migration,
        parent,
        child: fk.child,
        onDelete: fk.onDelete,
        risk: riskOf(fk.onDelete),
        timeColumn: fk.timeColumn,
      });
    }
  }
  return { drops, findings, queries: buildQueries(findings) };
}

/** `--schema` は生の SQL でも、wrangler の `--json` 出力でも受け取れる */
function loadSchema(path) {
  const raw = readFileSync(path, 'utf8');
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return raw;
  // wrangler d1 execute --json の形: [{ results: [{ name, sql }, ...] }]
  const parsed = JSON.parse(raw);
  const arrays = Array.isArray(parsed) ? parsed : [parsed];
  return arrays
    .flatMap((entry) => entry.results ?? [])
    .map((row) => row.sql)
    .filter(Boolean)
    .join(';\n');
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const migrationsDir = arg('--migrations', join(HERE, '..', 'migrations'));
  const schemaPath = arg('--schema', join(HERE, '..', 'schema.sql'));
  const report = audit({ migrationsDir, schemaSql: loadSchema(schemaPath) });

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  const label = {
    rows_deleted: '❌ 行ごと消える',
    link_cleared: '⚠️  紐付けだけ外れる',
    blocked: '✅ 消えない',
  };

  console.log('# DROP TABLE の巻き添え調査（Issue #111）\n');
  console.log(`DROP TABLE を含むマイグレーション: ${report.drops.length} 箇所`);
  for (const d of report.drops) console.log(`  - ${d.migration} → DROP TABLE ${d.parent}`);

  console.log(`\n## 巻き添えを受ける子テーブル: ${report.findings.length} 件\n`);
  if (report.findings.length === 0) {
    console.log('  （なし）');
  } else {
    for (const f of report.findings) {
      console.log(
        `  ${label[f.risk]}  ${f.migration}  ${f.parent} → ${f.child}`
        + `  (ON DELETE ${f.onDelete}${f.timeColumn ? `, 時刻列 ${f.timeColumn}` : ', 時刻列なし'})`,
      );
    }
  }

  const noChild = report.drops.filter(
    (d) => !report.findings.some((f) => f.parent === d.parent),
  );
  if (noChild.length) {
    console.log('\n## 子がいない（＝確認済み・被害なし）\n');
    for (const d of noChild) console.log(`  ✅ ${d.migration} → ${d.parent}`);
  }

  console.log('\n## 本番で流す読み取り専用クエリ\n');
  for (const q of report.queries) {
    console.log(`  pnpm exec wrangler d1 execute line-harness --remote --json \\`);
    console.log(`    --command="${q}"`);
  }
  console.log(
    '\n⚠️ schema.sql は実 DB とズレることがある。結論を出すときは本番の sqlite_master を'
    + '\n   --schema に渡し直すこと（使い方は先頭のコメント参照）。',
  );
}

// テストからは import して使えるよう、直接実行のときだけ main を呼ぶ
if (process.argv[1] && process.argv[1].endsWith('audit-cascade-loss.mjs')) main();
