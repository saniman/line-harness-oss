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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
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
  ignored: string[];
}

/** 指定ディレクトリに対して CLI を --json で実行し、結果をパースする */
function run(dir?: string): Summary {
  const args = ['--json', ...(dir ? ['--dir', dir] : [])];
  return JSON.parse(execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }));
}

/** CLI を実行し、終了コードと stderr を返す（失敗を期待するケース用） */
function runExpectingFailure(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? '' };
  }
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

  describe('数字で始まらない .sql の警告', () => {
    // wrangler の getMigrationNames は .sql なら番号の有無に関わらず拾って実行する。
    // このスクリプトが黙って無視すると「wrangler は実行するのにこちらの集計には
    // 出てこない」ファイルが生まれるので、無視したものを明示する。
    it('数字で始まらない .sql は ignored に列挙される', () => {
      const r = run(make(['001_a.sql', 'seed_data.sql', 'helper.sql']));
      expect(r.count).toBe(1);
      expect(r.ignored.sort()).toEqual(['helper.sql', 'seed_data.sql']);
    });

    it('.sql 以外のファイルは ignored に含めない', () => {
      const r = run(make(['001_a.sql', 'README.md']));
      expect(r.ignored).toEqual([]);
    });

    it('人間向け出力にも警告が出る', () => {
      const dir = make(['001_a.sql', 'seed_data.sql']);
      const out = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
      expect(out).toContain('seed_data.sql');
      expect(out).toContain('wrangler');
    });
  });

  describe('重複の表示', () => {
    it('「対処不要」を無条件に出さず、既存分に限定した表現にする', () => {
      const dir = make(['009_a.sql', '009_b.sql']);
      const out = execFileSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
      // エージェントがこの出力をレポートに貼るため、新規の重複まで
      // 「対処不要」と読める表現にしない
      expect(out).not.toContain('正常・対処不要');
      expect(out).toContain('009');
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

  describe('引数エラー（黙って既定ディレクトリを読まない）', () => {
    // --dir を付けたのに値を渡し忘れたとき、既定ディレクトリの番号を返すと
    // 「それらしいが要求とは違う番号」を人に見せることになる。番号を間違えさせない
    // ためのツールなので、曖昧なときは黙って続行せず落とす。
    it('--dir に値が無い場合はエラー終了する', () => {
      const r = runExpectingFailure(['--dir']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--dir');
    });

    it('--dir の次がフラグの場合もエラー終了する', () => {
      const r = runExpectingFailure(['--dir', '--json']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--dir');
    });

    it('存在しないディレクトリの場合は読めるエラーメッセージで終了する', () => {
      const r = runExpectingFailure(['--dir', '/nonexistent/path/xyz']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('/nonexistent/path/xyz');
      // 自前のハンドラを通っていること（生のスタックトレースを出さない）
      expect(r.stderr.startsWith('エラー:')).toBe(true);
    });
  });

  describe('--dir=<path> 形式と未知のフラグ', () => {
    // --dir=/path の形式を素通しすると、既定ディレクトリの番号を「指定した
    // ディレクトリの番号」として返してしまう（--dir の値なしと同じ事故）。
    it('--dir=<path> 形式でも指定したディレクトリを読む', () => {
      const dir = make(['700_x.sql']);
      const out = execFileSync('node', [SCRIPT, '--json', `--dir=${dir}`], { encoding: 'utf8' });
      const r = JSON.parse(out) as Summary;
      expect(r.max).toBe(700);
      expect(r.next).toBe(701);
    });

    it('--dir=<存在しないパス> の場合はエラー終了する（既定を読まない）', () => {
      const r = runExpectingFailure(['--dir=/nonexistent/path/xyz']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('/nonexistent/path/xyz');
    });

    it('--dir= の後ろが空の場合はエラー終了する', () => {
      const r = runExpectingFailure(['--dir=']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--dir');
    });

    it('未知のフラグは黙って無視せずエラー終了する', () => {
      // 打ち間違い（--dirr=... など）を素通しすると既定の番号を返してしまう
      const r = runExpectingFailure(['--dirr=/tmp']);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--dirr');
    });
  });

  describe('決定性', () => {
    it('最大番号が重複していても maxFile が決定的になる', () => {
      // readdir の順序はファイルシステム依存なので、同番号が最大のときに
      // 表示されるファイル名が実行ごとに変わらないようにする。
      const dir = make(['818_b_second.sql', '818_a_first.sql', '817_x.sql']);
      const first = run(dir);
      const second = run(dir);
      expect(first.maxFile).toBe(second.maxFile);
      expect(first.maxFile).toBe('818_a_first.sql');
      expect(first.next).toBe(819);
    });
  });

  describe('シンボリックリンク経由の実行', () => {
    it('シンボリックリンク経由でも無言終了せず出力する', () => {
      const linkDir = mkdtempSync(join(tmpdir(), 'miglink-'));
      dirs.push(linkDir);
      const link = join(linkDir, 'nmn.mjs');
      symlinkSync(SCRIPT, link);
      const out = execFileSync('node', [link, '--json'], { encoding: 'utf8' });
      expect(out.trim()).not.toBe('');
      expect(JSON.parse(out).next).toBeGreaterThan(0);
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
