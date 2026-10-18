import log from 'electron-log';

// Set once the console transport's pipe is dead (EPIPE on stdout/stderr, see main.ts): from
// then on the transport stays off, or toggling debug logging would switch it back on and the
// next console write would EPIPE again
let consoleTransportDisabled = false;

export function disableConsoleTransport() {
  consoleTransportDisabled = true;
  log.transports.console.level = false;
}

export function isConsoleTransportDisabled(): boolean {
  return consoleTransportDisabled;
}

// Tests only
export function resetConsoleTransportForTests() {
  consoleTransportDisabled = false;
}

export function disableDebugLogging() {
  log.transports.file.level = 'info';
  if (!consoleTransportDisabled) {
    log.transports.console.level = 'info';
  }
}

export function enableDebugLogging() {
  log.transports.file.level = 'debug';
  if (!consoleTransportDisabled) {
    log.transports.console.level = 'debug';
  }
}
