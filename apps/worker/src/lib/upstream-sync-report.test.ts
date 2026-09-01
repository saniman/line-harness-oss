/**
 * `scripts/upstream-sync-report.mjs` の分類ロジックのテスト。
 *
 * テスト対象はリポジトリルートの scripts/ にあるが、CI（.github/workflows/test.yml）が
 * 実行するテストは `pnpm --filter worker test` だけなので、CI で守られる場所として
 * apps/worker 配下に置いている（packages/db/scripts のテストと同じ判断）。
 *
 * 分類は純粋関数なので直接 import している（CLI 側は git を呼ぶ薄いラッパ）。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `new URL(...)` を使わないのは、worker の tsconfig が @cloudflare/workers-types の
// グローバル URL を読み込んでおり node:url の URL 型と衝突するため。
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/upstream-sync-report.mjs',
);

interface Classified {
  updatable: string[];
  notAdopted: string[];
  needsCheck: string[];
  contribution: string[];
  deletedUpstream: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = await import(SCRIPT);
const classifyFiles = mod.classifyFiles as (
  upstreamChanged: string[],
  forkChanged: string[],
  existsInFork: (path: string) => boolean,
  upstreamDeleted?: string[],
) => Classified;
const renderList = mod.renderList as (files: string[], limit?: number) => string;

/** fork に存在するファイルの集合から existsInFork を作る */
function existsIn(paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe('classifyFiles', () => {
  it('upstream のみ変更で fork にも存在する場合は更新候補になる', () => {
    const r = classifyFiles(['a.ts'], [], existsIn(['a.ts']));
    expect(r.updatable).toEqual(['a.ts']);
    expect(r.notAdopted).toEqual([]);
    expect(r.needsCheck).toEqual([]);
  });

  it('upstream のみ変更で fork に存在しない場合は未導入機能になる', () => {
    // 「取り込み可」と出すと、fork が採用していない機能の追加を勧めることになる
    const r = classifyFiles(['webinars/page.tsx'], [], existsIn([]));
    expect(r.notAdopted).toEqual(['webinars/page.tsx']);
    expect(r.updatable).toEqual([]);
  });

  it('両側で変更されている場合は要確認になる（fork に存在するかは問わない）', () => {
    const r = classifyFiles(['b.ts'], ['b.ts'], existsIn(['b.ts']));
    expect(r.needsCheck).toEqual(['b.ts']);
    expect(r.updatable).toEqual([]);
    expect(r.notAdopted).toEqual([]);
  });

  it('fork のみ変更の場合は貢献候補になる', () => {
    const r = classifyFiles([], ['c.ts'], existsIn(['c.ts']));
    expect(r.contribution).toEqual(['c.ts']);
  });

  it('4分類が同時に成立する場合もそれぞれに振り分けられる', () => {
    const r = classifyFiles(
      ['upd.ts', 'new.ts', 'both.ts'],
      ['both.ts', 'forkonly.ts'],
      existsIn(['upd.ts', 'both.ts', 'forkonly.ts']),
    );
    expect(r.updatable).toEqual(['upd.ts']);
    expect(r.notAdopted).toEqual(['new.ts']);
    expect(r.needsCheck).toEqual(['both.ts']);
    expect(r.contribution).toEqual(['forkonly.ts']);
  });

  it('結果はファイル名順にソートされる（実行ごとに並びが変わらない）', () => {
    const r = classifyFiles(['b.ts', 'a.ts', 'c.ts'], [], existsIn(['a.ts', 'b.ts', 'c.ts']));
    expect(r.updatable).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('未取り込みが無い場合はすべて空になる', () => {
    const r = classifyFiles([], [], existsIn([]));
    expect(r).toEqual({
      updatable: [],
      notAdopted: [],
      needsCheck: [],
      contribution: [],
      deletedUpstream: [],
    });
  });

  it('同じファイルが重複して渡されても1回だけ分類される', () => {
    const r = classifyFiles(['a.ts', 'a.ts'], [], existsIn(['a.ts']));
    expect(r.updatable).toEqual(['a.ts']);
  });
});

describe('classifyFiles（upstream で削除されたファイル）', () => {
  it('upstream で削除されたファイルは更新候補に入れない', () => {
    // 「そのまま取り込める」と案内された先で git checkout すると pathspec エラーになる
    const r = classifyFiles(['gone.ts'], [], existsIn(['gone.ts']), ['gone.ts']);
    expect(r.updatable).toEqual([]);
    expect(r.deletedUpstream).toEqual(['gone.ts']);
  });

  it('upstream で削除され fork にも無い場合は未導入にも入れない', () => {
    const r = classifyFiles(['gone.ts'], [], existsIn([]), ['gone.ts']);
    expect(r.notAdopted).toEqual([]);
    expect(r.deletedUpstream).toEqual(['gone.ts']);
  });

  it('両側で変更されている場合は削除でも要確認を優先する', () => {
    // fork 側が触っているファイルの削除は、消してよいか人間の判断が要る
    const r = classifyFiles(['x.ts'], ['x.ts'], existsIn(['x.ts']), ['x.ts']);
    expect(r.needsCheck).toEqual(['x.ts']);
    expect(r.deletedUpstream).toEqual([]);
  });

  it('削除リストが未指定でも従来どおり動く', () => {
    const r = classifyFiles(['a.ts'], [], existsIn(['a.ts']));
    expect(r.updatable).toEqual(['a.ts']);
    expect(r.deletedUpstream).toEqual([]);
  });
});

describe('renderList', () => {
  it('件数が上限以下ならすべて列挙する', () => {
    const out = renderList(['a.ts', 'b.ts'], 5);
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).not.toContain('他');
  });

  it('上限を超えたら省略し、省略した件数を明示する', () => {
    // 黙って切り捨てると「全部見た」と誤読される（.claude/rules の方針）
    const out = renderList(['a', 'b', 'c', 'd', 'e'], 2);
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).not.toContain('\nc');
    expect(out).toContain('他 3 件');
  });

  it('空の場合は「なし」を返す', () => {
    expect(renderList([], 5)).toContain('なし');
  });
});
