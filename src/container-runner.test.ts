import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ATLAS_DIR: '/tmp/test-atlas-state',
  ATLAS_STATE_DIR: '/tmp/test-atlas-state',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  HOST_CLAUDE_DIR: '/tmp/test-claude-dir',
  // Credential root and rulebook root are separate constants (2026-07-31
  // propagation fix). Distinct values here so a re-aliasing regression cannot
  // hide behind an identical mock.
  CLAUDE_CONFIG_DIR: '/tmp/test-claude-dir',
  CLAUDE_SETTINGS_SOURCE_DIR: '/tmp/test-settings-source-dir',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  extractQualityCheckTelemetry,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

// --- quality-check stderr telemetry (scoring-infra diagnosis 2026-06-12 §4) ---

describe('extractQualityCheckTelemetry', () => {
  it('retains interceptor and agent-runner quality lines, ignores noise', () => {
    const stderr = [
      'sdk debug chatter',
      '[response-interceptor] Quality-check timed out after 12000ms',
      '[response-interceptor] Host quality-check UNAVAILABLE: reason=timeout retryable=true detail= sha=9ca3e08625b9',
      '[agent-runner] Quality DEGRADED: reason=timeout retryable=true detail=Container timed out after 12000ms',
      '[agent-runner] unrelated line about sessions',
      'more sdk noise',
    ].join('\n');

    const t = extractQualityCheckTelemetry(stderr);
    expect(t.lines).toHaveLength(3);
    expect(t.lines[0]).toContain('timed out after 12000ms');
    // The exact classified reason is captured for the alert path — this is
    // the telemetry that did not exist for any historical event (all five
    // containers exited 0 and stderr was discarded).
    expect(t.degradedReasons).toEqual(['timeout']);
  });

  it('captures every classified degraded reason shape', () => {
    const stderr = [
      '[agent-runner] Quality DEGRADED: reason=host_unreachable retryable=true detail=connect ECONNREFUSED',
      '[agent-runner] Quality DEGRADED: reason=host_unauthorized retryable=false detail=Host endpoint returned 401',
    ].join('\n');
    expect(extractQualityCheckTelemetry(stderr).degradedReasons).toEqual([
      'host_unreachable',
      'host_unauthorized',
    ]);
  });

  it('a passing quality check retains the line but emits no degraded reason', () => {
    const stderr =
      '[agent-runner] Quality check: status=pass score=92 violations=0';
    const t = extractQualityCheckTelemetry(stderr);
    expect(t.lines).toHaveLength(1);
    expect(t.degradedReasons).toEqual([]);
  });

  it('is empty-safe', () => {
    expect(extractQualityCheckTelemetry('')).toEqual({
      lines: [],
      degradedReasons: [],
    });
  });
});

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});
