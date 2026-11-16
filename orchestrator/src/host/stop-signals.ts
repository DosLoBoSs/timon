/**
 * The signals that ask this daemon to stop, as each system delivers them.
 *
 * POSIX: SIGTERM is what systemd, launchd (`launchctl bootout`) and the desktop
 * send; SIGINT is a Ctrl+C at the terminal. SIGHUP is left alone: a daemon
 * started under `nohup` ignores it on purpose, and a listener would override
 * that and stop it when the terminal closes.
 *
 * Windows has no SIGTERM to receive (Node accepts the listener, nothing ever
 * fires it). What reaches a console process is SIGINT (Ctrl+C), SIGBREAK
 * (Ctrl+Break) and SIGHUP (its console window closing, a few seconds before
 * Windows ends it anyway). A `taskkill /F` or TerminateProcess runs no handler
 * at all, on any of them.
 */
export function stopSignalsFor(platform: NodeJS.Platform): readonly NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGTERM', 'SIGINT'];
}
