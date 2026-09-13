/**
 * `packages/db/scripts/audit-cascade-loss.mjs` の CLI テスト（#111）。
 *
 * テスト対象は別パッケージ（packages/db）にあるが、CI が実行するのは
 * `pnpm --filter worker test` だけなので、**CI で守られる場所**に置くため
 * あえて apps/worker 配下にある（`migration-numbering.test.ts` と同じ理由）。
 *
 * worker の tsconfig は `rootDir: "src"` なので src の外の .mjs を import できない。
 * CLI を子プロセスで実行して出力を検証する（運用で叩くのも CLI なので契約に忠実）。
 *
 * ## このテストが守るもの
 *
 * #110 の事故（`DROP TABLE scenarios` が `scenario_steps` を CASCADE で全消し）を
 * **このスクリプトが検出できること**。検出できなければ調査の道具として意味が無い。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// `new URL(...)` を使わないのは、worker の tsconfig が @cloudflare/workers-types の
// グローバル URL を読み込んでおり node:url の URL 型と衝突するため。
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '../../../../packages/db/scripts/audit-cascade-loss.mjs');
const REPO_ROOT = join(HERE, '../../../..');

interface Finding {
  migration: string;
  parent: string;
  child: string;
  onDelete: string;
  /** rows_deleted = 行ごと消える / link_cleared = 紐付けだけ外れる */
  risk: string;
  timeColumn: string | null;
}

interface Report {
  findings: Finding[];
  /** 本番で流す読み取り専用クエリ */
  queries: string[];
  /** DROP TABLE を含むマイグレーションと、そこで落とされる親テーブル */
  drops: { migration: string; parent: string }[];
}

function run(args: string[]): Report {
  const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return JSON.parse(out) as Report;
}

/** 実物のマイグレーションと schema.sql で走らせる */
function runOnRepo(): Report {
  return run([
    '--migrations', join(REPO_ROOT, 'packages/db/migrations'),
    '--schema', join(REPO_ROOT, 'packages/db/schema.sql'),
    '--json',
  ]);
}

/** 一時ディレクトリに最小のマイグレーション＋スキーマを作る */
function withFixture(
  migrations: Record<string, string>,
  schema: string,
  fn: (args: string[]) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'cascade-audit-'));
  try {
    const mig = join(dir, 'migrations');
    mkdirSync(mig);
    for (const [name, body] of Object.entries(migrations)) writeFileSync(join(mig, name), body);
    const schemaPath = join(dir, 'schema.sql');
    writeFileSync(schemaPath, schema);
    fn(['--migrations', mig, '--schema', schemaPath, '--json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('audit-cascade-loss（DROP TABLE の巻き添え調査）', () => {
  it('【最重要】#110 の実害（820 が scenario_steps を CASCADE で消す）を検出する', () => {
    const report = runOnRepo();

    const hit = report.findings.find(
      (f) => f.migration.startsWith('820') && f.child === 'scenario_steps',
    );
    expect(hit).toBeDefined();
    expect(hit?.parent).toBe('scenarios');
    expect(hit?.onDelete).toBe('CASCADE');
    expect(hit?.risk).toBe('rows_deleted');
  });

  it('同じ親を落とす別のマイグレーション（806）も見落とさない', () => {
    const report = runOnRepo();
    const found = report.findings.filter(
      (f) => f.migration.startsWith('806') && f.child === 'scenario_steps',
    );
    expect(found).toHaveLength(1);
  });

  it('まだ確認されていない巻き添え（035 → broadcast_insights）も挙げる', () => {
    // 035_account_management_v2.sql が DROP TABLE broadcasts を行う。
    // broadcast_insights は CASCADE なので、同じ壊れ方をしている疑いがある。
    const report = runOnRepo();
    const hit = report.findings.find(
      (f) => f.migration.startsWith('035') && f.child === 'broadcast_insights',
    );
    expect(hit?.onDelete).toBe('CASCADE');
    expect(hit?.risk).toBe('rows_deleted');
  });

  it('CASCADE と SET NULL を取り違えない', () => {
    // 取り違えると「行が消えた」と「紐付けが外れた」を混同し、調査の結論が変わる
    const report = runOnRepo();
    const setNull = report.findings.find((f) => f.child === 'messages_log');
    expect(setNull?.onDelete).toBe('SET NULL');
    expect(setNull?.risk).toBe('link_cleared');
  });

  it('件数の比較に使う時刻列を子テーブルごとに選ぶ', () => {
    const report = runOnRepo();
    expect(report.findings.find((f) => f.child === 'scenario_steps')?.timeColumn).toBe('created_at');
    expect(report.findings.find((f) => f.child === 'friend_scenarios')?.timeColumn).toBe('started_at');
  });

  it('子のいない親も DROP として記録する（確認済みと言えるようにする）', () => {
    const report = runOnRepo();
    // 032 / 804 は event_bookings を落とすが、これを参照する子は無い
    expect(report.drops.some((d) => d.parent === 'event_bookings')).toBe(true);
    expect(report.findings.some((f) => f.parent === 'event_bookings')).toBe(false);
  });

  it('生成するクエリは SELECT だけ（本番に書き込まない）', () => {
    // ⚠️ 壊れているかもしれない本番に、調査スクリプトが書き込む理由は無い
    const report = runOnRepo();
    expect(report.queries.length).toBeGreaterThan(0);
    for (const q of report.queries) {
      expect(q.trimStart()).toMatch(/^SELECT /i);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
    }
  });

  it('テーブル末尾の FOREIGN KEY 表記でも子を拾う', () => {
    // 列インライン（REFERENCES ... ON DELETE ...）だけを見ていると取りこぼす
    withFixture(
      { '900_drop.sql': 'DROP TABLE parents;' },
      `CREATE TABLE parents (id TEXT PRIMARY KEY);
CREATE TABLE kids (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  created_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE
);`,
      (args) => {
        const report = run(args);
        const hit = report.findings.find((f) => f.child === 'kids');
        expect(hit?.onDelete).toBe('CASCADE');
        expect(hit?.risk).toBe('rows_deleted');
      },
    );
  });

  it('ON DELETE の指定が無い参照は「行は消えない」と判定する', () => {
    withFixture(
      { '900_drop.sql': 'DROP TABLE parents;' },
      `CREATE TABLE parents (id TEXT PRIMARY KEY);
CREATE TABLE kids (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents (id));`,
      (args) => {
        const report = run(args);
        const hit = report.findings.find((f) => f.child === 'kids');
        expect(hit?.onDelete).toBe('NO ACTION');
        expect(hit?.risk).not.toBe('rows_deleted');
      },
    );
  });

  it('DROP TABLE を含まないマイグレーションは対象外', () => {
    withFixture(
      { '900_add.sql': 'ALTER TABLE kids ADD COLUMN memo TEXT;' },
      'CREATE TABLE kids (id TEXT PRIMARY KEY);',
      (args) => {
        const report = run(args);
        expect(report.drops).toHaveLength(0);
        expect(report.findings).toHaveLength(0);
      },
    );
  });
});
