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

/** このリポジトリのルート（SCRIPT から4階層上が packages/db/scripts なので、その2つ上） */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface Summary {
  count: number;
  max: number | null;
  maxFile: string | null;
  next: number;
  nextPrefix: string;
  duplicates: string[];
  ignored: string[];
  /** リモート追跡ブランチの探索結果（#69。git が使えない場所では checked=false） */
  remote?: {
    checked: boolean;
    max: number | null;
    /** 番号 → その番号を持つブランチ名（「誰が使っているか」を人が判断するため） */
    holders: Record<string, string[]>;
    /** 読めなかったブランチ（浅いクローン・壊れた ref。集計に入っていない） */
    failed?: string[];
    reason?: string;
  };
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

/**
 * 「リモートに別のマイグレーションがあるローカルリポジトリ」を作る。
 *
 * 実際の git を使う。モックにすると **ls-tree の出力形式が変わったときに気づけない**
 * ——このスクリプトが解こうとしているのは「git に聞かないと分からない」問題なので、
 * git に聞く部分こそ本物で確かめる必要がある。
 *
 * @param local  作業ツリー（= HEAD）に置くファイル
 * @param remote 「リモートブランチだけが持つ」ファイル
 */
function gitFixture(local: string[], remote: Record<string, string[]> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mignum-git-'));
  const git = (args: string[], cwd = root) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

  // origin として使う裸リポジトリ
  const originDir = join(root, 'origin.git');
  mkdirSync(originDir);
  git(['init', '--bare', '-b', 'main'], originDir);

  const work = join(root, 'work');
  mkdirSync(work);
  git(['init', '-b', 'main'], work);
  git(['config', 'user.email', 't@example.test'], work);
  git(['config', 'user.name', 'Test'], work);
  git(['remote', 'add', 'origin', originDir], work);

  const migDir = join(work, 'packages/db/migrations');
  mkdirSync(migDir, { recursive: true });

  // ブランチごとにファイルを積んで push する
  for (const [branch, names] of Object.entries(remote)) {
    git(['checkout', '-B', branch], work);
    for (const name of names) writeFileSync(join(migDir, name), '-- test\n');
    // ⚠️ 空のコミットは git が拒否する。migrations を持たないブランチも
    //    「落ちないこと」の検証に要るので --allow-empty で作る
    git(['add', '-A'], work);
    git(['commit', '--allow-empty', '-m', `add ${branch}`], work);
    git(['push', '-q', 'origin', branch], work);
    // 次のブランチに持ち越さないよう消す
    for (const name of names) rmSync(join(migDir, name));
  }

  // 作業ツリー（ローカルだけが持つファイル）
  git(['checkout', '-B', 'main'], work);
  for (const name of local) writeFileSync(join(migDir, name), '-- test\n');
  git(['add', '-A'], work);
  git(['commit', '-m', 'local'], work);

  return work;
}

/** git リポジトリの中で CLI を実行する（--dir はリポジトリ内の相対パス） */
function runInRepo(repo: string, args: string[] = []): Summary {
  const out = execFileSync('node', [SCRIPT, '--json', '--dir', 'packages/db/migrations', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return JSON.parse(out);
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
    it('既定のディレクトリを読み、次番号が「ローカルとリモートの最大 + 1」になる', () => {
      // ⚠️ max は**ローカルだけ**の最大（既存の JSON 契約）。リモートの別ブランチが
      //    大きい番号を持っていれば next はそれを上回る。ここを max + 1 で固定すると、
      //    #69 が本来の仕事をした瞬間に CI が赤くなる
      const r = run();
      expect(r.count).toBeGreaterThan(0);
      expect(r.max).not.toBeNull();
      const highest = Math.max(r.max as number, r.remote?.max ?? 0);
      expect(r.next).toBe(highest + 1);
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

describe('リモートブランチの採番も見る（#69）', () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) rmSync(join(r, '..'), { recursive: true, force: true });
  });
  const make = (local: string[], remote: Record<string, string[]> = {}) => {
    const r = gitFixture(local, remote);
    repos.push(r);
    return r;
  };

  it('【重要】リモートだけにある番号を検出して次番号に反映する', () => {
    // 実際に起きた事故: ローカル最大 823・リモートの別ブランチが 824 を採番済み。
    // ローカルしか見ないと 824 を返し、両方が 824 になる
    const repo = make(
      ['001_a.sql', '823_c.sql'],
      { 'feature/66': ['824_receipt_name.sql'] },
    );

    const res = runInRepo(repo);

    expect(res.next).toBe(825);
    expect(res.nextPrefix).toBe('825');
  });

  it('【重要】どのブランチが使っているかを出す（人が譲る判断をするため）', () => {
    const repo = make(['823_c.sql'], { 'feature/66': ['824_receipt_name.sql'] });

    const res = runInRepo(repo);

    expect(res.remote?.holders['824']).toContain('origin/feature/66');
  });

  it('複数のブランチが同じ番号を持っていれば両方出す', () => {
    const repo = make(['823_c.sql'], {
      'feature/a': ['824_a.sql'],
      'feature/b': ['824_b.sql'],
    });

    const res = runInRepo(repo);

    expect(res.remote?.holders['824']).toHaveLength(2);
  });

  it('ローカルの方が大きければローカルが優先される', () => {
    const repo = make(['830_local.sql'], { 'feature/66': ['824_x.sql'] });

    const res = runInRepo(repo);

    expect(res.next).toBe(831);
  });

  it('リモートに migrations が無くても落ちない', () => {
    const repo = make(['823_c.sql'], { 'feature/docs': [] });

    const res = runInRepo(repo);

    expect(res.next).toBe(824);
    expect(res.remote?.checked).toBe(true);
  });

  it('【重要】git リポジトリでなくてもローカルだけで動く（オフライン耐性）', () => {
    // ネットワークや git が無いと採番できない、では日常の邪魔になる。
    // ⚠️ cwd も git の外にしないと、リポジトリ内から実行したことになって検証にならない
    const dir = fixture(['001_a.sql', '002_b.sql']);
    const out = execFileSync('node', [SCRIPT, '--json', '--dir', dir], {
      cwd: dir, encoding: 'utf8',
    });
    const res = JSON.parse(out) as Summary;

    expect(res.next).toBe(3);
    expect(res.remote?.checked).toBe(false);
    expect(res.remote?.reason).toBeTruthy();
  });

  it('リモートを見なかった理由が出力に残る', () => {
    const dir = fixture(['001_a.sql']);
    const out = execFileSync('node', [SCRIPT, '--json', '--dir', dir], {
      cwd: dir, encoding: 'utf8',
    });
    const res = JSON.parse(out) as Summary;

    // 「確認できなかった」ことが分からないと、見たつもりで衝突する
    expect(res.remote?.reason).toMatch(/git/);
  });

  it('--no-remote でリモート探索を止められる', () => {
    // CI やオフラインで待ちたくないとき
    const repo = make(['823_c.sql'], { 'feature/66': ['824_x.sql'] });

    const res = runInRepo(repo, ['--no-remote']);

    expect(res.next).toBe(824);
    expect(res.remote?.checked).toBe(false);
  });

  it('人間向け出力にリモートの使用状況が出る', () => {
    const repo = make(['823_c.sql'], { 'feature/66': ['824_receipt_name.sql'] });

    const out = execFileSync('node', [SCRIPT, '--dir', 'packages/db/migrations'], {
      cwd: repo, encoding: 'utf8',
    });

    expect(out).toContain('825');
    expect(out).toContain('origin/feature/66');
  });

  // ⚠️ ここが #69 の本丸。`git ls-tree <branch> <path>` の path は
  //    **リポジトリのルートではなく実行時のカレントディレクトリからの相対**として
  //    解釈される。ルート以外から実行するとリモートが 0 件になり、しかも
  //    checked=true のまま「衝突なし」に見える（= #69 の事故が再現する）。
  //    このリポジトリの正規の呼び出し方は
  //      node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
  //    で **cwd は移動しない**（作業は apps/worker 起点）ので、これは例外ケースではなく既定の経路。
  it('【重要】リポジトリのルート以外から実行してもリモートを検出する', () => {
    const repo = make(['823_c.sql'], { 'feature/66': ['824_receipt_name.sql'] });

    const out = execFileSync(
      'node',
      [SCRIPT, '--json', '--dir', join(repo, 'packages/db/migrations')],
      { cwd: join(repo, 'packages/db'), encoding: 'utf8' },
    );
    const res = JSON.parse(out) as Summary;

    expect(res.remote?.checked).toBe(true);
    expect(res.remote?.holders['824']).toContain('origin/feature/66');
    expect(res.next).toBe(825);
  });

  it('【重要】無関係なディレクトリを --dir で指したらリモートは混ぜない', () => {
    // リモート側は packages/db/migrations 決め打ちで見ている。ローカルが別の
    // ディレクトリなら、その番号はこのリポジトリの採番とは無関係なので
    // 混ぜてはいけない（混ぜると「次の採番」が意味不明な値になる）
    const dir = fixture(['001_a.sql', '002_b.sql']);
    const out = execFileSync('node', [SCRIPT, '--json', '--dir', dir], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    const res = JSON.parse(out) as Summary;

    expect(res.next).toBe(3);
    expect(res.remote?.checked).toBe(false);
    expect(res.remote?.reason).toBeTruthy();
  });

  it('【重要】別のリポジトリの中から絶対パスで叩かれてもリモートを混ぜない', () => {
    // cwd の git リポジトリと、--dir が指すリポジトリが別物のとき、
    // cwd 側のブランチを読んで採番すると無関係な番号に押し上げられる
    const other = make(['900_unrelated.sql'], { 'feature/x': ['950_unrelated.sql'] });
    const dir = fixture(['001_a.sql']);

    const out = execFileSync('node', [SCRIPT, '--json', '--dir', dir], {
      cwd: other, encoding: 'utf8',
    });
    const res = JSON.parse(out) as Summary;

    expect(res.next).toBe(2);
    expect(res.remote?.checked).toBe(false);
  });

  it('origin/HEAD は実体のあるブランチではないので出さない', () => {
    // origin/main への symref。残すと「いもしないレーン」が使用中に見える
    const repo = make(['823_c.sql'], { main: ['824_x.sql'] });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: repo, stdio: 'pipe',
    });

    const res = runInRepo(repo);

    expect(res.remote?.holders['824']).toEqual(['origin/main']);
  });

  it('【重要】リモート追跡ブランチが1本も無ければ「確認できなかった」にする', () => {
    // 「見たけど 0 件」と同じ扱いにすると出力に何も出ず、確認済みに見えてしまう。
    // remote が origin という名前でない・新しい worktree・浅いチェックアウトで起きる
    const repo = make(['823_c.sql']);

    const res = runInRepo(repo);

    expect(res.remote?.checked).toBe(false);
    expect(res.remote?.reason).toBeTruthy();
    expect(res.next).toBe(824);
  });

  it('【重要】読めなかったブランチは握りつぶさず報告する', () => {
    // 「migrations が無い」と「読めなかった」を同じ扱いにすると、
    // 827 を持つブランチが黙って消えたまま checked: true が返る
    const repo = make(['823_c.sql'], { 'feature/66': ['824_x.sql'] });
    // 実体の無いオブジェクトを指す壊れた ref を作る（浅いクローン等の再現）
    writeFileSync(join(repo, '.git/refs/remotes/origin/broken'), `${'0'.repeat(39)}1\n`);

    const res = runInRepo(repo);

    expect(res.remote?.failed).toContain('origin/broken');
    // 読めた分の集計は続ける（1本壊れただけで採番が止まると日常の邪魔になる）
    expect(res.next).toBe(825);
  });

  it('読めなかったブランチは人間向け出力にも警告として出る', () => {
    const repo = make(['823_c.sql'], { 'feature/66': ['824_x.sql'] });
    writeFileSync(join(repo, '.git/refs/remotes/origin/broken'), `${'0'.repeat(39)}1\n`);

    const out = execFileSync('node', [SCRIPT, '--dir', 'packages/db/migrations'], {
      cwd: repo, encoding: 'utf8',
    });

    expect(out).toContain('origin/broken');
    expect(out).toContain('衝突');
  });

  it('【重要】ブランチ数が同時実行の上限を超えても取りこぼさない', () => {
    // git の同時実行数に上限をつけた（EAGAIN/EMFILE 対策）。手書きの並列プールなので、
    // 上限を超える本数で**1本も落とさない**ことを確かめる。ここを取りこぼすと
    // 「見たのに見つからなかった」= #69 がそのまま再発する
    const remote: Record<string, string[]> = {};
    for (let i = 0; i < 12; i++) remote[`feature/${i}`] = [`${840 + i}_x.sql`];
    const repo = make(['823_c.sql'], remote);

    const res = runInRepo(repo);

    expect(Object.keys(res.remote?.holders ?? {})).toHaveLength(12);
    expect(res.next).toBe(852);
  });

  it('【重要】既存の JSON 契約を壊さない', () => {
    // migration-numbering.test.ts の既存28件が守っている形
    const dir = fixture(['001_a.sql', '002_b.sql']);

    const res = run(dir);

    for (const key of ['count', 'max', 'maxFile', 'next', 'nextPrefix', 'duplicates', 'ignored']) {
      expect(res).toHaveProperty(key);
    }
  });
});
