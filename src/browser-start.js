import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function ensureBrowser({ port, fallbackExecutable, ready, launch = spawn, exists = async p => access(p).then(() => true, () => false), sleep = ms => Bun.sleep(ms), timeoutMs = 15000 }) {
  if (await ready()) return;
  const candidates = [process.env.CHROME_PATH,
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(dir => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    fallbackExecutable].filter(Boolean);
  let executable;
  for (const candidate of candidates) if (await exists(candidate)) { executable = candidate; break; }
  if (!executable) throw new Error('Chrome not found. Install Chrome or set CHROME_PATH to chrome.exe.');
  const profile = resolve(root, '.browser-profile');
  // Security: the debugging port gives full control of this Chrome, including the logged-in game
  // session in the profile. It is bound to 127.0.0.1 only, so anything running as a local user can
  // reach it: never change the address to 0.0.0.0, never forward or tunnel the port, and keep this
  // profile for the bot (no personal browsing, no other accounts).
  const child = launch(executable, [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  let launchError;
  const onError = error => { launchError = error; };
  child.on('error', onError);
  child.unref();
  try {
    const deadline = Date.now() + timeoutMs;
    do {
      if (launchError) throw new Error('Cannot start Chrome: ' + launchError.message);
      if (await ready()) return;
      await sleep(250);
    } while (Date.now() < deadline);
    throw new Error('Chrome debugging port ' + port + ' did not become ready. If Chrome already uses ' + profile + ' without debugging enabled, close that profile window and retry.');
  } finally { child.removeListener('error', onError); }
}
