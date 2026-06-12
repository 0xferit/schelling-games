import { Wallet } from 'ethers';

const baseUrl = process.env.SMOKE_BASE_URL;

if (!baseUrl) {
  throw new Error('SMOKE_BASE_URL is required');
}

const base = new URL(baseUrl);

// Mirrors BUILD_HASH_RE in src/worker/gameRoom/index.ts: a deployed build
// value outside this shape disables the admission gate (it fails open).
const BUILD_HASH_RE = /^[a-f0-9]{7,40}$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRetryablePreviewFailure(status, payload, text) {
  if (status >= 500) return true;
  if (status !== 404) return false;

  const title =
    payload && typeof payload.title === 'string' ? payload.title : '';
  const detail =
    payload && typeof payload.detail === 'string' ? payload.detail : text;

  return (
    title.includes('Error 1042') || detail.includes('No Workers script was found')
  );
}

async function fetchWithTransientPreviewRetry(path, init) {
  const MAX_ATTEMPTS = 6;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const headers = new Headers(init?.headers);
      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
      }
      const response = await fetch(new URL(path, base), {
        ...init,
        headers,
      });

      const text = await response.text();
      const payload = parseJson(text);
      if (
        attempt < MAX_ATTEMPTS &&
        isRetryablePreviewFailure(response.status, payload, text)
      ) {
        lastError = new Error(
          `${path} returned transient preview error ${response.status}: ${text.slice(0, 200)}`,
        );
        console.warn(
          `${lastError.message}; retrying (${attempt}/${MAX_ATTEMPTS}) after preview propagation delay`,
        );
        await sleep(2000);
        continue;
      }

      return { response, text, payload };
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      console.warn(
        `${path} request failed (${error instanceof Error ? error.message : String(error)}); retrying (${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(2000);
    }
  }

  throw lastError;
}

async function waitForReady() {
  let lastError;

  for (let attempt = 1; attempt <= 18; attempt += 1) {
    try {
      const response = await fetch(new URL('/api/game-config', base), {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`unexpected status ${response.status}`);
      }

      const payload = await response.json();
      assert(
        typeof payload.commitDuration === 'number',
        'game-config missing commitDuration',
      );
      assert(
        typeof payload.revealDuration === 'number',
        'game-config missing revealDuration',
      );
      assert(
        typeof payload.build === 'string' && BUILD_HASH_RE.test(payload.build),
        'game-config build is not a git sha (admission gate would be disabled)',
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(5000);
    }
  }

  throw new Error(
    `remote deployment never became ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function expectJson(path, init, validate) {
  const { response, text, payload } = await fetchWithTransientPreviewRetry(
    path,
    init,
  );
  if (payload === undefined) {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }

  validate(payload, response);
  return { payload, response };
}

async function expectStatus(path, status, init) {
  const { response, text } = await fetchWithTransientPreviewRetry(path, init);
  if (response.status !== status) {
    throw new Error(
      `${path} returned ${response.status}, expected ${status}: ${text.slice(0, 200)}`,
    );
  }
  return { text, response };
}

async function expectHtml(path, marker) {
  const { text } = await expectStatus(path, 200, {
    headers: { Accept: 'text/html' },
  });
  assert(text.includes(marker), `${path} did not include marker ${marker}`);
}

async function expectHtmlEventually(path, marker) {
  let lastError;

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await expectHtml(path, marker);
      return;
    } catch (error) {
      lastError = error;
      await sleep(2000);
    }
  }

  throw new Error(
    `${path} never became ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function uniqueDisplayName() {
  return `smoke${Date.now().toString(36).slice(-8)}`;
}

await waitForReady();

await expectHtmlEventually('/', 'Schelling Games');
await expectHtmlEventually('/app', 'Schelling Games');

await expectJson('/api/game-config', undefined, (payload) => {
  assert(payload.commitDuration === 60, 'unexpected commitDuration');
  assert(payload.revealDuration === 15, 'unexpected revealDuration');
  assert(
    typeof payload.build === 'string' && BUILD_HASH_RE.test(payload.build),
    'game-config build is not a git sha (admission gate would be disabled)',
  );
});

await expectJson('/api/landing-stats', undefined, (payload) => {
  assert(typeof payload.playersLast24h === 'number', 'missing playersLast24h');
  assert(
    typeof payload.completedMatches === 'number',
    'missing completedMatches',
  );
  assert(typeof payload.longestStreak === 'number', 'missing longestStreak');
});

await expectJson('/api/leaderboard', undefined, (payload) => {
  assert(Array.isArray(payload), 'leaderboard was not an array');
});

await expectJson('/api/example-tally', undefined, (payload) => {
  assert(typeof payload.total === 'number', 'missing tally total');
  assert(Array.isArray(payload.votes), 'missing tally votes');
});

await expectStatus('/api/me', 401, {
  headers: { Accept: 'application/json' },
});

await expectStatus('/ws', 401);

const wallet = Wallet.createRandom();

const { payload: challenge } = await expectJson(
  '/api/auth/challenge',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress: wallet.address }),
  },
  (payload) => {
    assert(typeof payload.challengeId === 'string', 'missing challengeId');
    assert(typeof payload.message === 'string', 'missing challenge message');
    assert(typeof payload.expiresAt === 'string', 'missing expiresAt');
  },
);

const signature = await wallet.signMessage(challenge.message);

const { payload: verifyPayload, response: verifyResponse } = await expectJson(
  '/api/auth/verify',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      walletAddress: wallet.address,
      signature,
    }),
  },
  (payload) => {
    assert(payload.accountId === wallet.address.toLowerCase(), 'account mismatch');
    assert(
      typeof payload.requiresDisplayName === 'boolean',
      'missing requiresDisplayName',
    );
  },
);

const setCookie = verifyResponse.headers.get('set-cookie');
assert(setCookie, 'auth verify did not return a session cookie');
const sessionCookie = setCookie.split(';', 1)[0];

const authHeaders = {
  Cookie: sessionCookie,
  Accept: 'application/json',
};

await expectJson('/api/me', { headers: authHeaders }, (payload) => {
  assert(payload.accountId === verifyPayload.accountId, 'api/me account mismatch');
  assert(typeof payload.tokenBalance === 'number', 'missing tokenBalance');
  assert(typeof payload.queueStatus === 'string', 'missing queueStatus');
});

const displayName = uniqueDisplayName();

await expectJson(
  '/api/me/profile',
  {
    method: 'PATCH',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ displayName }),
  },
  (payload) => {
    assert(payload.displayName === displayName, 'profile update did not stick');
  },
);

await expectJson('/api/me', { headers: authHeaders }, (payload) => {
  assert(payload.displayName === displayName, 'displayName was not persisted');
});

await expectJson(
  '/api/logout',
  {
    method: 'POST',
    headers: authHeaders,
  },
  (payload) => {
    assert(payload.ok === true, 'logout did not return ok');
  },
);

console.log(`remote smoke passed for ${base.origin}`);
