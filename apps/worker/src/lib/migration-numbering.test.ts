/**
 * `packages/db/scripts/next-migration-number.mjs` の CLI テスト。
 *
 * テスト対象は別パッケージ（packages/db）にあるが、CI（.github/workflows/test.yml）が
 * 実行するテストは `pnpm --filter worker test` だけで packages/db にはテスト設定が無い。
 * CI で守られる場所に置くため、あえて apps/worker 配下に置いている。
 *
 * また、worker の tsconfig は `rootDir: "src"` なので src の外の .mjs を import すると
 * 型解決とパス制約で詰まる。そのため CLI を子プロセスで実行して出力を検証する形にした。
 * エージェントが実際に叩くのも CLI なので、こちらの方が契約に忠実でもある。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// `new URL(...)` を使わないのは、worker の tsconfig が @cloudflare/workers-types の
// グローバル URL を読み込んでおり node:url の URL 型と衝突するため。
// import.meta.url は文字列なので fileURLToPath にそのまま渡せる。
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/db/scripts/next-migration-number.mjs',
);

interface Summary {
  count: number;
  max: number | null;
  maxFile: string | null;
  next: number;
  nextPrefix: string;
  duplicates: string[];
}

/** 指定ディレクトリに対して CLI を --json で実行し、結果をパースする */
function run(dir?: string): Summary {
  const args = ['--json', ...(dir ? ['--dir', dir] : [])];
  return JSON.parse(execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }));
}

/** ファイル名の一覧から一時ディレクトリを作る */
function fixture(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mignum-'));
  for (const name of names) writeFileSync(join(dir, name), '-- test\n');
  return dir;
}

describe('next-migration-number CLI', () => {
  const dirs: string[] = [];
  const make = (names: string[]) => {
    const d = fixture(names);
    dirs.push(d);
    return d;
  };

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  describe('採番', () => {
    it('最大番号 + 1 を返す', () => {
      const r = run(make(['001_a.sql', '002_b.sql', '003_c.sql']));
      expect(r.max).toBe(3);
      expect(r.maxFile).toBe('003_c.sql');
      expect(r.next).toBe(4);
    });

    it('ファイル名の並び順ではなく数値の大小で最大を決める', () => {
      // 文字列ソートだと '099' > '100' になってしまうケース
      const r = run(make(['099_old.sql', '100_new.sql']));
      expect(r.max).toBe(100);
      expect(r.next).toBe(101);
    });

    it('3桁を超える番号が混ざっていても数値として比較される', () => {
      const r = run(make(['818_x.sql', '1000_y.sql']));
      expect(r.max).toBe(1000);
      expect(r.next).toBe(1001);
    });

    it('次番号は3桁ゼロ埋めの文字列でも返される', () => {
      const r = run(make(['008_a.sql']));
      expect(r.nextPrefix).toBe('009');
    });

    it('1000 以上の場合はゼロ埋めせずそのまま返す', () => {
      const r = run(make(['999_a.sql']));
      expect(r.next).toBe(1000);
      expect(r.nextPrefix).toBe('1000');
    });
  });

  describe('番号の重複（衝突ではない）', () => {
    it('同じ番号が複数あっても重複として列挙される', () => {
      const r = run(make(['009_delivery_type.sql', '009_token_expiry.sql', '010_z.sql']));
      expect(r.duplicates).toEqual(['009']);
    });

    it('重複があっても次番号の計算は壊れない', () => {
      const r = run(make(['009_a.sql', '009_b.sql', '018_c.sql', '018_d.sql']));
      expect(r.max).toBe(18);
      expect(r.next).toBe(19);
      expect(r.duplicates).toEqual(['009', '018']);
    });

    it('重複が無い場合は空配列になる', () => {
      const r = run(make(['001_a.sql', '002_b.sql']));
      expect(r.duplicates).toEqual([]);
    });
  });

  describe('無視するファイル', () => {
    it('.sql 以外のファイルは数えない', () => {
      const r = run(make(['001_a.sql', 'README.md', 'notes.txt']));
      expect(r.count).toBe(1);
      expect(r.max).toBe(1);
    });

    it('数字で始まらない .sql は数えない', () => {
      const r = run(make(['001_a.sql', 'seed_data.sql']));
      expect(r.count).toBe(1);
      expect(r.max).toBe(1);
    });
  });

  describe('境界値', () => {
    it('空のディレクトリの場合でも落ちず 001 を返す', () => {
      const empty = mkdtempSync(join(tmpdir(), 'migempty-'));
      dirs.push(empty);
      const r = run(empty);
      expect(r.count).toBe(0);
      expect(r.max).toBeNull();
      expect(r.maxFile).toBeNull();
      expect(r.next).toBe(1);
      expect(r.nextPrefix).toBe('001');
      expect(r.duplicates).toEqual([]);
    });

    it('サブディレクトリがあっても無視される', () => {
      const dir = make(['001_a.sql']);
      mkdirSync(join(dir, 'archive'));
      writeFileSync(join(dir, 'archive', '999_old.sql'), '-- x\n');
      const r = run(dir);
      expect(r.count).toBe(1);
      expect(r.max).toBe(1);
    });
  });

  describe('実際の migrations ディレクトリ', () => {
    // 番号をハードコードすると migration 追加のたびに壊れるので、
    // 「次番号 = 最大 + 1」という不変条件だけを検証する。
    it('既定のディレクトリを読み、次番号が最大+1になる', () => {
      const r = run();
      expect(r.count).toBeGreaterThan(0);
      expect(r.max).not.toBeNull();
      expect(r.next).toBe((r.max as number) + 1);
    });

    it('既知の重複（009 / 018 / 043）が衝突ではなく重複として報告される', () => {
      const r = run();
      expect(r.duplicates).toEqual(expect.arrayContaining(['009', '018', '043']));
    });
  });

  describe('人間向け出力', () => {
    it('--json なしの場合は次の採番が読める形で出力される', () => {
      const dir = make(['818_x.sql']);
      const out = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
      expect(out).toContain('819');
      expect(out).toContain('次の採番');
    });
  });
});
