import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const getLineAccounts = vi.fn();
const createAccountHealthLog = vi.fn();
const getAccountHealthLogs = vi.fn();

vi.mock('@line-crm/db', () => ({
  getLineAccounts: (...args: unknown[]) => getLineAccounts(...args),
  createAccountHealthLog: (...args: unknown[]) => createAccountHealthLog(...args),
  getAccountHealthLogs: (...args: unknown[]) => getAccountHealthLogs(...args),
}));

const { checkAccountHealth } = await import('./ban-monitor.js');

/** messages_log の集計だけを返す最小の D1 スタブ。 */
function dbStub(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => ({ count: 0 }) }),
    }),
  } as unknown as D1Database;
}

/** テスト中の「現在時刻」。ハートビート判定が経過時間を見るため固定する。 */
const NOW = new Date('2026-09-01T12:00:00.000+09:00');

/** JST オフセット付きの文字列（jstNow() と同じ形式）を作る */
function jst(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().replace('Z', '+09:00');
}

/**
 * 直近ログのスタブ。`ageHours` で「何時間前に書かれたか」を指定する。
 * 既定は 0（＝たった今書かれた）＝ハートビートの対象外。
 */
function log(riskLevel: string, errorCode: number | null, ageHours = 0) {
  const at = jst(new Date(NOW.getTime() - ageHours * 60 * 60 * 1000));
  return {
    id: 'log-1',
    line_account_id: 'acc-1',
    error_code: errorCode,
    error_count: errorCode === null ? 0 : 1,
    check_period: at,
    risk_level: riskLevel,
    created_at: at,
  };
}

describe('checkAccountHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getLineAccounts.mockReset();
    createAccountHealthLog.mockReset();
    getAccountHealthLogs.mockReset();
    getLineAccounts.mockResolvedValue([
      { id: 'acc-1', channel_access_token: 'token', is_active: 1 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('状態が前回から変わっていなければログを書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();
  });

  test('403 が出て risk が変わったらログを書く', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      lineAccountId: 'acc-1',
      errorCode: 403,
      riskLevel: 'danger',
    });
  });

  test('403 が続いている間は最初の1回しか書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('danger', 403)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();
  });

  test('履歴が1件も無ければ現在の状態を記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      riskLevel: 'normal',
      errorCode: undefined,
    });
  });

  test('risk は同じでもエラーコードが変わったら記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      errorCode: 500,
      riskLevel: 'normal',
    });
  });

  test('状態が同じでも前回から6時間以上経っていれば書く（cron の生存確認）', async () => {
    // 正常が続くと最新行が何日も前になり、cron が死んでいるのか正常なのか
    // 管理画面から見分けられなくなる。一定間隔では必ず記録して生存を示す。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null, 7)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  test('6時間以内なら状態が同じ限り書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null, 5)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();
  });

  test('created_at が未来の場合は書く（オフセット無しの行が UTC 解釈されるケース）', async () => {
    // スキーマの DEFAULT はオフセット無し（strftime の JST 壁時計）。それが UTC として
    // 解釈されると 9 時間先の未来になり、経過時間が負になる。「新しい」と誤判定すると
    // ハートビートが実時間で約15時間止まるため、未来は「古い」扱いにして書く。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null, -9)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  test('created_at が解釈できない場合は書く（取りこぼすより余分に記録する）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([{ ...log('normal', null), created_at: 'not-a-date' }]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  test('403 が続いている間もアカウントごとに警告ログは出し続ける', async () => {
    // DB の重複排除と、BAN を人に気づかせる警告は別の関心事。
    // console.error はこのアカウントが BAN された唯一の通知経路なので止めない。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('danger', 403)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();   // 書き込みは抑制
    expect(spy).toHaveBeenCalled();                          // 警告は出る
    spy.mockRestore();
  });
});
