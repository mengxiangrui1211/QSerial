/**
 * MCP context helper tests
 * Covers ANSI-tolerant pattern matching, state analysis, and connection locking.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectionType } from '@qserial/shared';
import { ConnectionFactory } from '../../src/services/connection/factory.ts';
import {
  stripAnsi,
  matchPattern,
  analyzeState,
  withConnectionLock,
  waitPattern,
  ensureBuffer,
} from '../../src/services/mcp/context.ts';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, (d?: unknown) => void> = {};
    return {
      onData: vi.fn((cb: (d: string) => void) => {
        handlers.data = cb;
      }),
      onExit: vi.fn((cb: (code: number) => void) => {
        handlers.exit = cb;
      }),
      write: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
      __emitData: (d: string) => handlers.data?.(d),
    };
  }),
}));

describe('stripAnsi / matchPattern', () => {
  it('strips ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[0;32m[root@100ask:~]#\x1b[0m ')).toBe('[root@100ask:~]# ');
  });

  it('matches the prompt regex when ANSI codes sit between # and space', () => {
    const output = '\x1b[0;32m[root@100ask:~]#\x1b[0m ';
    expect(matchPattern(output, '[#$>]\\s', true)).toBe(true);
  });

  it('matches substring patterns despite ANSI codes', () => {
    expect(matchPattern('login: \x1b[0m', 'login:', false)).toBe(true);
  });

  it('falls back to substring on invalid regex after stripping ANSI', () => {
    expect(matchPattern('[invalid\x1b[0m', '[invalid', true)).toBe(true);
    expect(matchPattern('Password: \x1b[0m', '[invalid', true)).toBe(false);
  });
});

describe('analyzeState', () => {
  it('detects a root shell when the prompt is wrapped in ANSI codes', () => {
    const state = analyzeState(
      'Linux version 5.10\n\x1b[0;32m[root@100ask:~]#\x1b[0m ',
      'connected'
    );
    expect(state.state).toBe('shell');
    expect(state.shell_type).toBe('root');
  });

  it('detects a user shell with ANSI colors', () => {
    const state = analyzeState('\x1b[01;32muser@host\x1b[00m:~\x1b[01;34m$\x1b[00m ', 'connected');
    expect(state.state).toBe('shell');
    expect(state.shell_type).toBe('user');
  });
});

describe('withConnectionLock', () => {
  it('serializes concurrent operations on the same connection', async () => {
    const order: string[] = [];
    const run = async (name: string, delayMs: number) =>
      withConnectionLock('lock-test', async () => {
        order.push(name + ':start');
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(name + ':end');
      });

    await Promise.all([run('a', 50), run('b', 10)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('waitPattern with continuous device output', () => {
  it('extends the wait window while data keeps arriving', async () => {
    const conn = await ConnectionFactory.create({
      id: 'sliding-test',
      name: 'sliding',
      type: ConnectionType.PTY,
      shell: 'bash',
    });
    await conn.open();
    ensureBuffer('sliding-test');

    const spawnMock = vi.mocked((await import('node-pty')).spawn);
    const proc = spawnMock.mock.results[0].value as { __emitData: (d: string) => void };

    // 设备持续输出日志,间隔小于超时窗口,最后才出现提示符
    const resultP = waitPattern('sliding-test', '[#$>]\\s', 1, true);
    await new Promise((r) => setTimeout(r, 300));
    proc.__emitData('[6114.79] IPv6: link not ready\n');
    await new Promise((r) => setTimeout(r, 700));
    proc.__emitData('[6433.75] IPv6: link not ready\n');
    await new Promise((r) => setTimeout(r, 500));
    proc.__emitData('root@host:# ');

    const result = await resultP;
    expect(result.matched).toBe(true);
    expect(result.output).toContain('link not ready');
    expect(result.output).toContain('root@host');

    await ConnectionFactory.destroy('sliding-test');
  }, 15000);
});
