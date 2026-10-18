import log from 'electron-log';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disableConsoleTransport,
  disableDebugLogging,
  enableDebugLogging,
  isConsoleTransportDisabled,
  resetConsoleTransportForTests,
} from 'main/sentient-sims/util/debugLog';

// Once the console transport's pipe is dead (EPIPE, main.ts) it stays off: toggling debug
// logging must not switch it back on, or the next console write EPIPEs again
describe('debugLog', () => {
  afterEach(() => {
    resetConsoleTransportForTests();
    log.transports.console.level = 'info';
  });

  it('debug toggles move the console level while the transport is alive', () => {
    enableDebugLogging();
    expect(log.transports.console.level).toBe('debug');
    expect(log.transports.file.level).toBe('debug');
    disableDebugLogging();
    expect(log.transports.console.level).toBe('info');
  });

  it('a disabled console transport stays off across debug toggles', () => {
    disableConsoleTransport();
    expect(isConsoleTransportDisabled()).toBe(true);
    expect(log.transports.console.level).toBe(false);
    enableDebugLogging();
    expect(log.transports.console.level).toBe(false);
    expect(log.transports.file.level).toBe('debug');
    disableDebugLogging();
    expect(log.transports.console.level).toBe(false);
    expect(log.transports.file.level).toBe('info');
  });
});
