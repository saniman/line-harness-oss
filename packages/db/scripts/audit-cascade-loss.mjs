#!/usr/bin/env node
/**
 * `DROP TABLE` を含むマイグレーションの「巻き添え被害」を洗い出す（Issue #111）。
 *
 * ## なぜ要るか
 *
 * SQLite は外部キーが有効なとき `DROP TABLE <親>` が暗黙の `DELETE FROM <親>` を行い、
 * 子テーブルへ `ON DELETE` が伝播する。CHECK 制約を変えるためのテーブル再作成は
 *
 *     CREATE TABLE 親_v2 ...;  INSERT INTO 親_v2 SELECT ... FROM 親;  DROP TABLE 親;
 *
 * という形になるが、**親は INSERT...SELECT で救われるのに、子は誰も救わない**。
 * その結果「親はあるのに子が全部消えている」という気づきにくい壊れ方をする。
 * 実際に #110 で `scenario_steps` が DB 全体で 0 件になり、**8 日間** 誰も気づかなかった
 * （マイグレーションは成功し、アプリもエラーを出さないため）。
 *
 * ## 伝播は 1 段では終わらない
 *
 * 子が CASCADE で消えるとき、**その子を参照している孫にも伝播する**。
 *
 *     DROP TABLE scenarios
 *       └ scenario_steps   (CASCADE)   行が消える
 *           └ messages_log (SET NULL)  紐付けが外れる   ← 2 段目
 *
 * 直接の子だけを見ると、この 2 段目を丸ごと見落とす（初版で実際に見落とした）。
 * CASCADE の辺をたどれる限りたどる。
 *
 * ## 何をするか
 *
 * 1. マイグレーションから `DROP TABLE <親>` を抜き出す
 * 2. スキーマから伝播先（子・孫…）と `ON DELETE` の挙動を求める
 * 3. 本番で流すための**読み取り専用**クエリを組み立てる
 *
 * ## 使い方
 *
 *   # 監査計画と、本番で流すクエリを出す（本番アクセス不要）
 *   node packages/db/scripts/audit-cascade-loss.mjs
 *   node packages/db/scripts/audit-cascade-loss.mjs --json
 *
 *   # 本番の実スキーマで見る（結論を出すときは必ずこちら）
 *   pnpm exec wrangler d1 execute line-harness --remote --json \
 *     --command="SELECT name, sql FROM sqlite_master WHERE type='table'" > /tmp/master.json
 *   node packages/db/scripts/audit-cascade-loss.mjs --schema /tmp/master.json
 *
 * ⚠️ **このスクリプトは書き込まない。** 壊れているかもしれない本番に調査ツールが
 *    書き込む理由が無い。生成するクエリが SELECT だけであることはテストで守っている
 *    （`apps/worker/src/lib/cascade-audit.test.ts`）。
 *
 * ⚠️ `schema.sql` は実 DB とズレる（`.claude/rules/migrations.md` 参照）。実際 #111 では
 *    実 DB にだけ存在する参照が 3 本あり、結果が 6 件 vs 12 件と倍違った。
 *    **結論を出すときは必ず本番の `sqlite_master` を `--schema` に渡す。**
 *
 * ⚠️ **スキーマは「今」の姿しか分からない。** 突き合わせるのは過去に実行された
 *    `DROP TABLE` なので、当時の `ON DELETE` が今と同じとは限らないし、
 *    DROP より後に追加された子も混ざる。出力は**調査の出発点**であって、
 *    結論は当時のマイグレーション本文と実データで裏を取ること。
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
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
 * SQL からコメントを落とす。
 *
 * ⚠️ **行コメントだけでは足りない。** `/* ... DROP TABLE x ... *\/` を残すと、
 *    コメントアウトされた DROP や外部キーを「実在する」と誤判定し、
 *    ありもしない被害を報告する。マイグレーション側とスキーマ側の**両方**に掛ける
 *    （片方だけに掛けると、同じ書き方が片方でだけ通る非対称な挙動になる）。
 */
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * `CREATE TABLE <名前> ( <本体> );` を取り出す。
 *
 * sqlite_master の `sql` も schema.sql の記述も同じ形なので共通で扱える。
 */
export function parseTables(sql) {
  const clean = stripSqlComments(sql);
  const tables = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)[`"\]]?\s*\(/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    // 対応する閉じ括弧まで読む（本体に括弧が入れ子で出てくるため数える）
    let depth = 1;
    let i = re.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') depth--;
    }
    tables.set(name, clean.slice(re.lastIndex, i - 1));
  }
  return tables;
}

/**
 * テーブル本体を「列・制約」の単位に割る。
 *
 * ⚠️ **改行では割らないこと。** sqlite_master が返す `sql` は 1 行のことがあり、
 *    行単位で見ると最初の列しか拾えない。そうなると時刻列が見つからず、
 *    「適用日より前の行が残っているか」のクエリが**黙って出力されなくなる**。
 *    そのクエリは「消えた」と「元々無かった」を分ける唯一の根拠なので、
 *    欠けると調査の結論そのものが崩れる。
 *
 * 括弧の深さを数えて、トップレベルのカンマだけで割る
 * （`CHECK (x IN ('a','b'))` の内側のカンマで割らないため）。
 */
export function splitDefinitions(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (const ch of body) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

const CONSTRAINT_HEAD = /^(primary|foreign|unique|check|constraint)\b/i;

function pickTimeColumn(body) {
  const cols = splitDefinitions(body)
    .filter((d) => !CONSTRAINT_HEAD.test(d))
    .map((d) => /^[`"[]?([a-z_]\w*)/i.exec(d))
    .filter(Boolean)
    .map((m) => m[1]);
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
  const REF =
    /REFERENCES\s+[`"[]?([A-Za-z_]\w*)[`"\]]?\s*(?:\([^)]*\))?((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)/i;
  for (const [child, body] of tables) {
    const timeColumn = pickTimeColumn(body);
    for (const def of splitDefinitions(body)) {
      const ref = REF.exec(def);
      if (!ref) continue;
      const onDeleteMatch =
        /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i.exec(ref[2] || '');
      const fkColumn = /^FOREIGN\s+KEY\s*\(\s*[`"[]?([a-z_]\w*)/i.exec(def)
        ?? /^[`"[]?([a-z_]\w*)/i.exec(def);
      fks.push({
        child,
        parent: ref[1],
        column: fkColumn ? fkColumn[1] : null,
        onDelete: onDeleteMatch
          ? onDeleteMatch[1].toUpperCase().replace(/\s+/g, ' ')
          : 'NO ACTION',
        timeColumn,
      });
    }
  }
  return fks;
}

/** マイグレーションから `DROP TABLE <親>` を抜き出す */
export function findDrops(dir) {
  const drops = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = stripSqlComments(readFileSync(join(dir, file), 'utf8'));
    const re = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)[`"\]]?/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(sql)) !== null) {
      const parent = m[1];
      if (seen.has(parent)) continue;
      seen.add(parent);
      drops.push({ migration: basename(file), parent });
    }
  }
  return drops;
}

/**
 * 親から伝播する先を、CASCADE の辺をたどれる限り集める。
 *
 * CASCADE は行を消すので、その子にもさらに `ON DELETE` が効く。
 * SET NULL / RESTRICT は行が残るので、そこで止まる。
 */
export function collectImpact(parent, fks, { depth = 0, chain = [], seen = new Set() } = {}) {
  const out = [];
  for (const fk of fks) {
    if (fk.parent.toLowerCase() !== parent.toLowerCase()) continue;
    const edge = `${parent.toLowerCase()}>${fk.child.toLowerCase()}`;
    // 自己参照・循環参照で無限に潜らない
    if (seen.has(edge)) continue;
    const via = [...chain, parent, fk.child];
    out.push({ ...fk, parent, depth, risk: riskOf(fk.onDelete), via });
    if (fk.onDelete === 'CASCADE') {
      out.push(
        ...collectImpact(fk.child, fks, {
          depth: depth + 1,
          chain: [...chain, parent],
          seen: new Set([...seen, edge]),
        }),
      );
    }
  }
  return out;
}

/**
 * 本番で流す読み取り専用クエリを組み立てる。
 *
 * 見たいのは3つ。
 *   ① マイグレーションの適用日
 *   ② 子テーブルの現在の件数と最古データ
 *      → 適用日より前の行が無ければ「その時点で消された」と言える
 *   ③ SET NULL の子は、紐付け列が NULL になっている件数
 */
export function buildQueries(findings) {
  const queries = ['SELECT name, applied_at FROM d1_migrations ORDER BY applied_at'];
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.child)) continue;
    seen.add(f.child);
    if (f.timeColumn) {
      queries.push(
        `SELECT '${f.child}' AS child, COUNT(*) AS rows, MIN(${f.timeColumn}) AS oldest FROM ${f.child}`,
      );
    } else {
      queries.push(`SELECT '${f.child}' AS child, COUNT(*) AS rows FROM ${f.child}`);
    }
    if (f.risk === 'link_cleared' && f.column) {
      queries.push(
        `SELECT '${f.child}.${f.column}' AS link, COUNT(*) AS rows,`
        + ` SUM(CASE WHEN ${f.column} IS NULL THEN 1 ELSE 0 END) AS null_link FROM ${f.child}`,
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
    for (const hit of collectImpact(parent, fks)) {
      findings.push({
        migration,
        droppedTable: parent,
        parent: hit.parent,
        child: hit.child,
        column: hit.column,
        onDelete: hit.onDelete,
        risk: hit.risk,
        depth: hit.depth,
        via: hit.via,
        timeColumn: hit.timeColumn,
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

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const migrationsDir = arg(argv, '--migrations', join(HERE, '..', 'migrations'));
  const schemaPath = arg(argv, '--schema', join(HERE, '..', 'schema.sql'));
  const report = audit({ migrationsDir, schemaSql: loadSchema(schemaPath) });

  if (argv.includes('--json')) {
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

  console.log(`\n## 伝播先: ${report.findings.length} 件\n`);
  if (report.findings.length === 0) {
    console.log('  （なし）');
  } else {
    for (const f of report.findings) {
      const indent = '  '.repeat(f.depth);
      console.log(
        `  ${indent}${label[f.risk]}  ${f.migration}  ${f.via.join(' → ')}`
        + `  (ON DELETE ${f.onDelete}${f.timeColumn ? `, 時刻列 ${f.timeColumn}` : ', 時刻列なし'})`,
      );
    }
  }

  const noChild = report.drops.filter(
    (d) => !report.findings.some((f) => f.droppedTable === d.parent),
  );
  if (noChild.length) {
    console.log('\n## 伝播先が無い（＝巻き添えは起きない）\n');
    for (const d of noChild) console.log(`  ✅ ${d.migration} → ${d.parent}`);
    console.log(
      '\n  ⚠️ 「巻き添えが無い」だけで、**そのテーブル自身のデータが無事とは限らない**。'
      + '\n     マイグレーション本文が明示的に DELETE している場合がある'
      + '\n     （例: 027_dedup_delivery.sql は friend_scenarios を意図的に間引く）。',
    );
  }

  console.log('\n## 本番で流す読み取り専用クエリ\n');
  for (const q of report.queries) {
    console.log('  pnpm exec wrangler d1 execute line-harness --remote --json \\');
    console.log(`    --command="${q}"`);
  }
  console.log(
    '\n⚠️ schema.sql は実 DB とズレる。結論を出すときは本番の sqlite_master を'
    + '\n   --schema に渡すこと（使い方は先頭のコメント参照）。'
    + '\n⚠️ スキーマは「今」の姿。過去の DROP と突き合わせているので、当時の ON DELETE が'
    + '\n   今と同じとは限らない。最終的な裏取りは当時のマイグレーション本文と実データで行う。',
  );
}

// テストからは import して使えるよう、直接実行のときだけ main を呼ぶ。
//
// ⚠️ import.meta.url は realpath 解決済みなので、argv[1] も realpath に揃えないと
//    シンボリックリンク経由・リネーム後の実行で一致せず、**何も出力せず exit 0** になる。
//    それは「巻き添え被害ゼロ」と見分けがつかない。兄弟スクリプト
//    （next-migration-number.mjs）が同じ罠を踏んで対策済みなので、同じ形にする。
if (process.argv[1]) {
  let invoked = resolve(process.argv[1]);
  try {
    invoked = realpathSync(invoked);
  } catch {
    /* 解決できなければ resolve 結果のまま比較する */
  }
  if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
}
