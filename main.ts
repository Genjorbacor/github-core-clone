// Lifecycle of the forge process, as the suite's env expects it.
//
// The forge itself lives in app.ts. This file only wires it to the env
// that grades the trial:
//   1. Read the env origin from MAKEFUN_ENV_URL. With nothing there the
//      process has nobody to talk to, so it stops with exit code 1.
//   2. Listen on a port the kernel picks (never 8080: that is the env's).
//   3. POST that port to $MAKEFUN_ENV_URL/register. The env then dials the
//      forge at the address the request came from plus this port. A 200
//      means the registration landed; a 409 means another entry already
//      registered first, which is equally fine to proceed from.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The env answers immediately every time, so this is a poll loop
//      with a short pause that grows between failed attempts. The process
//      never leaves before the env says the trial is over.
//   5. Shut the server down and exit 0.
//
// Nothing here touches the git store or the REST surface: those live
// behind createApp().

import { createApp } from './app.ts';

/** Env origin with trailing slashes removed, or '' when unset. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing: there is no env to register with\n');
  process.exit(1);
}

/** Give up on one register/done request after this long, then retry it. */
const FETCH_TIMEOUT_MS = 30_000;
/** Pause before the first retry, and the longest pause between retries. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

/** Sleep helper for the retry pauses. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` failed attempts: doubles from BACKOFF_FIRST_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * Tell the env which port the forge bound. A 200 accepts it; a 409 says
 * another entry registered first and this one just carries on waiting.
 * A 400 or 405 is a contract error and stops the process; anything else
 * (the env still starting, a dropped request) waits and tries again.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`registration failed with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registration failed with HTTP ')) throw err;
    }
    await wait(backoffMs(failures));
  }
}

/** Keep asking GET /done until the env answers {"done": true}. */
async function awaitCompletion(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering, or the request timed out: not done yet.
    }
    await wait(backoffMs(failures));
  }
}

/** Bind, register, then wait for the env to finish the trial. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered with the env; waiting for it to finish\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] trial done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
