import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEADERBOARD_LIMIT } from '../../src/domain/constants';
import type { Env } from '../../src/types/worker-env';
import { handleHttpRequest } from '../../src/worker/httpHandler';
import { buildChallengeMessage } from '../../src/worker/session';
import {
  createTestSession,
  createTestWallet,
  must,
  seedAccount,
} from './helpers';

const HTTPS_BASE = 'https://test.local';
const HTTP_BASE = 'http://test.local';
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
const NON_TEST_TURNSTILE_SITE_KEY = '3x00000000000000000000FF';
const NON_TEST_TURNSTILE_SECRET_KEY = '3x0000000000000000000000000000000FF';
const TURNSTILE_ACTION = 'landing_example_vote';
const TURNSTILE_HOSTNAME = 'test.local';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface SeedLeaderboardAccountInput {
  accountId: string;
  displayName: string | null;
  balance: number;
  coherentGames?: number;
  leaderboardEligible?: boolean;
}

interface LeaderboardResponseEntry {
  rank: number;
  displayName: string;
  tokenBalance: number;
  coherentGames: number;
}

function compareLeaderboardEntries(
  a: LeaderboardResponseEntry,
  b: LeaderboardResponseEntry,
): number {
  return (
    b.tokenBalance - a.tokenBalance ||
    b.coherentGames - a.coherentGames ||
    a.displayName.localeCompare(b.displayName)
  );
}

async function seedLeaderboardAccounts(
  db: D1Database,
  accounts: SeedLeaderboardAccountInput[],
): Promise<void> {
  await db.batch(
    accounts.flatMap((account) => {
      const coherentGames = account.coherentGames ?? 0;
      const leaderboardEligible = account.leaderboardEligible ?? true;
      return [
        db
          .prepare(
            'INSERT INTO accounts (account_id, display_name, token_balance, leaderboard_eligible) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET display_name = excluded.display_name, token_balance = excluded.token_balance, leaderboard_eligible = excluded.leaderboard_eligible',
          )
          .bind(
            account.accountId,
            account.displayName,
            account.balance,
            leaderboardEligible ? 1 : 0,
          ),
        db
          .prepare(
            'INSERT INTO player_stats (account_id, matches_played, games_played, coherent_games, current_streak, longest_streak) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET matches_played = excluded.matches_played, games_played = excluded.games_played, coherent_games = excluded.coherent_games, current_streak = excluded.current_streak, longest_streak = excluded.longest_streak',
          )
          .bind(account.accountId, 10, 10, coherentGames, 0, 0),
      ];
    }),
  );
}

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, { headers }),
  );
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function postWithBase(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const exampleVoteEnv = {
  DB: env.DB,
  GAME_ROOM: {} as DurableObjectNamespace,
  TURNSTILE_SECRET_KEY,
  TURNSTILE_SITE_KEY,
} satisfies Env;

const nonTestExampleVoteEnv = {
  DB: env.DB,
  GAME_ROOM: {} as DurableObjectNamespace,
  TURNSTILE_SECRET_KEY: NON_TEST_TURNSTILE_SECRET_KEY,
  TURNSTILE_SITE_KEY: NON_TEST_TURNSTILE_SITE_KEY,
} satisfies Env;

function getWithEnv(
  targetEnv: Env,
  path: string,
  headers: Record<string, string> = {},
) {
  return handleHttpRequest(
    new Request(`${HTTPS_BASE}${path}`, { headers }),
    targetEnv,
  );
}

function postWithEnv(
  targetEnv: Env,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return handleHttpRequest(
    new Request(`${HTTPS_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    targetEnv,
  );
}

function mockTurnstileValidation(
  result: Record<string, unknown>,
  status = 200,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(result), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    new Request(`${HTTPS_BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('HTTP routes', () => {
  it('GET /api/leaderboard returns empty array on fresh DB', async () => {
    const resp = await get('/api/leaderboard');
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data).toEqual([]);
  });

  it('GET /api/leaderboard returns the top 100 eligible named accounts in rank order', async () => {
    const seeded: SeedLeaderboardAccountInput[] = [
      {
        accountId: 'leader-zulu',
        displayName: 'Zulu',
        balance: 1000,
        coherentGames: 5,
      },
      {
        accountId: 'leader-alpha',
        displayName: 'Alpha',
        balance: 950,
        coherentGames: 9,
      },
      {
        accountId: 'leader-tie-high',
        displayName: 'TieHigh',
        balance: 900,
        coherentGames: 9,
      },
      {
        accountId: 'leader-tie-low',
        displayName: 'TieLow',
        balance: 900,
        coherentGames: 3,
      },
      {
        accountId: 'leader-aaron',
        displayName: 'Aaron',
        balance: 850,
        coherentGames: 7,
      },
      {
        accountId: 'leader-beatrice',
        displayName: 'Beatrice',
        balance: 850,
        coherentGames: 7,
      },
      {
        accountId: 'excluded-ineligible',
        displayName: 'ShouldBeHidden',
        balance: 5000,
        coherentGames: 99,
        leaderboardEligible: false,
      },
      {
        accountId: 'excluded-nameless',
        displayName: null,
        balance: 4000,
        coherentGames: 88,
      },
      ...Array.from({ length: 96 }, (_, index) => ({
        accountId: `filler-${index}`,
        displayName: `Player${String(index).padStart(3, '0')}`,
        balance: 800 - index,
        coherentGames: index % 5,
      })),
    ];

    await seedLeaderboardAccounts(env.DB, seeded);

    const resp = await get('/api/leaderboard');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as LeaderboardResponseEntry[];

    expect(data).toHaveLength(LEADERBOARD_LIMIT);
    expect(data.map((entry) => entry.rank)).toEqual(
      Array.from({ length: LEADERBOARD_LIMIT }, (_, index) => index + 1),
    );
    expect(data.map((entry) => entry.displayName).slice(0, 6)).toEqual([
      'Zulu',
      'Alpha',
      'TieHigh',
      'TieLow',
      'Aaron',
      'Beatrice',
    ]);
    expect(data.every((entry) => typeof entry.displayName === 'string')).toBe(
      true,
    );
    expect(data.some((entry) => entry.displayName === 'ShouldBeHidden')).toBe(
      false,
    );

    for (let index = 1; index < data.length; index += 1) {
      expect(
        compareLeaderboardEntries(data[index - 1], data[index]),
      ).toBeLessThanOrEqual(0);
    }
  });

  it('GET /api/landing-stats returns recent activity and streak aggregates', async () => {
    const accountA = 'landing-stats-a';
    const accountB = 'landing-stats-b';
    const accountC = 'landing-stats-c';

    await seedAccount(env.DB, accountA, 'Alice');
    await seedAccount(env.DB, accountB, 'Bob');
    await seedAccount(env.DB, accountC, 'Carol');

    const recent = new Date().toISOString();
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, ended_at, game_count, player_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('match-recent', recent, recent, 10, 3, 'completed'),
      env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, ended_at, game_count, player_count, status) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('match-stale', stale, stale, 10, 2, 'completed'),
      env.DB.prepare(
        'INSERT INTO matches (match_id, started_at, ended_at, game_count, player_count, status, ai_assisted) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind('match-ai', recent, recent, 10, 2, 'completed', 1),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-recent', accountA, 'Alice', 0, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-recent', accountB, 'Bob', 0, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-stale', accountC, 'Carol', 0, 'completed'),
      env.DB.prepare(
        'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
      ).bind('match-ai', accountC, 'Carol', 0, 'completed'),
      env.DB.prepare(
        'UPDATE player_stats SET longest_streak = ? WHERE account_id = ?',
      ).bind(8, accountB),
    ]);

    const resp = await get('/api/landing-stats');
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as {
      playersLast24h: number;
      completedMatches: number;
      longestStreak: number;
    };
    expect(data.playersLast24h).toBe(2);
    expect(data.completedMatches).toBe(2);
    expect(data.longestStreak).toBe(8);
    expect(resp.headers.get('Cache-Control')).toBe(
      'public, max-age=60, s-maxage=60',
    );
  });

  it('POST /api/auth/challenge falls back when auth_challenges lacks issued_at', async () => {
    const queries: string[] = [];
    const fallbackDb = {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind: (..._params: unknown[]) => ({
            run: async () => {
              if (sql.includes('issued_at')) {
                throw new Error(
                  'table auth_challenges has no column named issued_at',
                );
              }
              return {};
            },
          }),
        };
      },
    } as unknown as D1Database;

    const resp = await handleHttpRequest(
      new Request(`${HTTPS_BASE}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: '0x1234567890123456789012345678901234567890',
        }),
      }),
      {
        DB: fallbackDb,
        GAME_ROOM: {} as DurableObjectNamespace,
      } as Env,
    );

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { message: string };
    expect(data.message).toContain('Issued:');
    expect(queries.some((q) => q.includes('issued_at'))).toBe(true);
    expect(
      queries.some(
        (q) =>
          q.includes('INSERT INTO auth_challenges') && !q.includes('issued_at'),
      ),
    ).toBe(true);
  });

  it('POST /api/auth/challenge returns challengeId and message', async () => {
    const wallet = createTestWallet();
    const resp = await post('/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      challengeId: string;
      message: string;
      expiresAt: string;
    };
    expect(data.challengeId).toMatch(/^ch_/);
    expect(data.message).toContain('Sign this message');
    expect(data.expiresAt).toBeTruthy();
  });

  it('POST /api/auth/challenge rejects malformed wallet addresses', async () => {
    const resp = await post('/api/auth/challenge', {
      walletAddress: 'not-a-wallet',
    });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toContain('0x-prefixed address');
  });

  it('POST /api/auth/challenge rate limits repeated requests per IP', async () => {
    const wallet = createTestWallet(20);
    const headers = { 'CF-Connecting-IP': '203.0.113.205' };

    let lastStatus = 0;
    for (let i = 0; i < 13; i += 1) {
      const resp = await post(
        '/api/auth/challenge',
        { walletAddress: wallet.address },
        headers,
      );
      lastStatus = resp.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('POST /api/auth/challenge opportunistically cleans up expired challenges', async () => {
    const wallet = createTestWallet(21);
    const now = Date.now();
    const expiredChallengeId = 'ch_expired_cleanup_probe';
    await env.DB.prepare(
      'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        expiredChallengeId,
        wallet.address.toLowerCase(),
        crypto.randomUUID(),
        'expired',
        new Date(now - 60_000).toISOString(),
        now - 60_000,
      )
      .run();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now + 5 * 60_000));
      const challengeResp = await post(
        '/api/auth/challenge',
        { walletAddress: wallet.address },
        { 'CF-Connecting-IP': '203.0.113.206' },
      );
      expect(challengeResp.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }

    const stale = await env.DB.prepare(
      'SELECT challenge_id FROM auth_challenges WHERE challenge_id = ?',
    )
      .bind(expiredChallengeId)
      .first<{ challenge_id: string }>();
    expect(stale).toBeNull();
  });

  it('POST /api/auth/verify with valid signature sets session cookie', async () => {
    const wallet = createTestWallet(1);
    const normalized = wallet.address.toLowerCase();

    // Step 1: request challenge
    const challengeResp = await post('/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };

    // Step 2: sign and verify
    const signature = await wallet.signMessage(message);
    const verifyResp = await post('/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);

    const setCookie = verifyResp.headers.get('Set-Cookie');
    expect(setCookie).toContain('session=');

    const body = (await verifyResp.json()) as {
      accountId: string;
      requiresDisplayName: boolean;
    };
    expect(body.accountId).toBe(normalized);
    expect(body.requiresDisplayName).toBe(true);
  });

  it('POST /api/auth/verify accepts legacy challenges with NULL issued_at', async () => {
    const wallet = createTestWallet(7);
    const challengeId = 'ch_legacy_issued_at';
    const nonce = crypto.randomUUID();
    const issuedAt = Date.now();
    const message = buildChallengeMessage(
      wallet.address.toLowerCase(),
      nonce,
      issuedAt,
    );
    const expiresAt = new Date(issuedAt + 5 * 60 * 1000).toISOString();

    await env.DB.prepare(
      'INSERT INTO auth_challenges (challenge_id, wallet_address, nonce, message, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        challengeId,
        wallet.address.toLowerCase(),
        nonce,
        message,
        expiresAt,
      )
      .run();

    const signature = await wallet.signMessage(message);
    const verifyResp = await post('/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });

    expect(verifyResp.status).toBe(200);
    const body = (await verifyResp.json()) as {
      accountId: string;
      requiresDisplayName: boolean;
    };
    expect(body.accountId).toBe(wallet.address.toLowerCase());
    expect(body.requiresDisplayName).toBe(true);
  });

  it('POST /api/auth/verify rejects malformed wallet addresses', async () => {
    const resp = await post('/api/auth/verify', {
      challengeId: 'ch_example',
      walletAddress: 'not-a-wallet',
      signature: `0x${'a'.repeat(130)}`,
    });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toContain('0x-prefixed address');
  });

  it('GET /api/me with valid session returns account data', async () => {
    const wallet = createTestWallet(2);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'TestPlayer2', 500);

    const resp = await get('/api/me', { Cookie: `session=${cookie}` });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      accountId: string;
      displayName: string;
      tokenBalance: number;
    };
    expect(data.accountId).toBe(accountId);
    expect(data.displayName).toBe('TestPlayer2');
    expect(data.tokenBalance).toBe(500);
    expect(data).not.toHaveProperty('autoRequeue');
  });

  it('GET /api/me auto-provisions missing account rows for a valid session', async () => {
    const wallet = createTestWallet(8);
    const { accountId, cookie } = await createTestSession(wallet);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM player_stats WHERE account_id = ?').bind(
        accountId,
      ),
      env.DB.prepare('DELETE FROM accounts WHERE account_id = ?').bind(
        accountId,
      ),
    ]);

    const resp = await get('/api/me', { Cookie: `session=${cookie}` });
    expect(resp.status).toBe(200);

    const data = (await resp.json()) as {
      accountId: string;
      displayName: string | null;
      tokenBalance: number;
    };
    expect(data.accountId).toBe(accountId);
    expect(data.displayName).toBeNull();
    expect(data.tokenBalance).toBe(0);

    const account = (await env.DB.prepare(
      'SELECT account_id FROM accounts WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { account_id: string } | null;
    const stats = (await env.DB.prepare(
      'SELECT account_id FROM player_stats WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { account_id: string } | null;

    expect(account?.account_id).toBe(accountId);
    expect(stats?.account_id).toBe(accountId);
  });

  it('GET /api/me without session returns 401', async () => {
    const resp = await get('/api/me');
    expect(resp.status).toBe(401);
  });

  it('PATCH /api/me/profile sets display name', async () => {
    const wallet = createTestWallet(3);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId);

    const resp = await patch(
      '/api/me/profile',
      { displayName: 'NewName' },
      { Cookie: `session=${cookie}` },
    );
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { displayName: string };
    expect(data.displayName).toBe('NewName');

    // Verify it persisted
    const row = (await env.DB.prepare(
      'SELECT display_name FROM accounts WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { display_name: string } | null;
    expect(row?.display_name).toBe('NewName');
  });

  it('GET /api/leaderboard/me returns rank: null for account with no display name', async () => {
    const wallet = createTestWallet(4);
    const { accountId, cookie } = await createTestSession(wallet);
    // Seed with display_name = null (default)
    await seedAccount(env.DB, accountId, null, 100);

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(data.rank).toBeNull();
    expect(data.leaderboardEligible).toBe(false);
  });

  it('GET /api/leaderboard/me returns rank: null for ineligible account', async () => {
    const wallet = createTestWallet(5);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'IneligiblePlayer', 100);
    // Mark account as ineligible
    await env.DB.prepare(
      'UPDATE accounts SET leaderboard_eligible = 0 WHERE account_id = ?',
    )
      .bind(accountId)
      .run();

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(data.rank).toBeNull();
    expect(data.leaderboardEligible).toBe(false);
  });

  it('GET /api/leaderboard/me returns numeric rank for eligible account', async () => {
    const wallet = createTestWallet(6);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, 'EligiblePlayer', 200);

    const resp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
    };
    expect(typeof data.rank).toBe('number');
    expect(data.leaderboardEligible).toBe(true);
  });

  it('GET /api/leaderboard/me returns global rank outside the visible top 100 table', async () => {
    const wallet = createTestWallet(7);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedLeaderboardAccounts(env.DB, [
      {
        accountId,
        displayName: 'TargetPlayer',
        balance: 100_000,
        coherentGames: 1,
      },
      ...Array.from({ length: LEADERBOARD_LIMIT }, (_, index) => ({
        accountId: `ahead-${index}`,
        displayName: `Ahead${String(index).padStart(3, '0')}`,
        balance: 200_000 - index,
        coherentGames: index % 7,
      })),
    ]);

    const leaderboardResp = await get('/api/leaderboard');
    expect(leaderboardResp.status).toBe(200);
    const leaderboard =
      (await leaderboardResp.json()) as LeaderboardResponseEntry[];
    expect(leaderboard).toHaveLength(LEADERBOARD_LIMIT);
    expect(
      leaderboard.some((entry) => entry.displayName === 'TargetPlayer'),
    ).toBe(false);

    const myRankResp = await get('/api/leaderboard/me', {
      Cookie: `session=${cookie}`,
    });
    expect(myRankResp.status).toBe(200);
    const myRank = (await myRankResp.json()) as {
      rank: number | null;
      leaderboardEligible: boolean;
      displayName: string;
    };
    expect(myRank.rank).toBe(LEADERBOARD_LIMIT + 1);
    expect(myRank.leaderboardEligible).toBe(true);
    expect(myRank.displayName).toBe('TargetPlayer');
  });

  it('GET /api/game-config exposes the landing-page Turnstile site key', async () => {
    const resp = await getWithEnv(exampleVoteEnv, '/api/game-config');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as {
      commitDuration: number;
      revealDuration: number;
      turnstileSiteKey: string | null;
      build: string | null;
    };
    expect(data.commitDuration).toBeGreaterThan(0);
    expect(data.revealDuration).toBeGreaterThan(0);
    expect(data.turnstileSiteKey).toBe(TURNSTILE_SITE_KEY);
    expect(data.build).toBeNull();
  });

  it('GET /api/game-config surfaces BUILD_HASH when set in env', async () => {
    const envWithBuild = {
      ...exampleVoteEnv,
      BUILD_HASH: 'abc1234',
    } satisfies Env;
    const resp = await getWithEnv(envWithBuild, '/api/game-config');
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { build: string | null };
    expect(data.build).toBe('abc1234');
  });

  it('POST /api/example-vote + GET /api/example-tally round-trips with a valid Turnstile token', async () => {
    mockTurnstileValidation({
      success: true,
      action: TURNSTILE_ACTION,
      hostname: TURNSTILE_HOSTNAME,
    });

    const voteResp = await postWithEnv(exampleVoteEnv, '/api/example-vote', {
      optionIndex: 8,
      turnstileToken: 'token-8',
    });
    expect(voteResp.status).toBe(200);

    const tallyResp = await get('/api/example-tally');
    expect(tallyResp.status).toBe(200);
    const tally = (await tallyResp.json()) as {
      total: number;
      votes: Array<{ optionIndex: number; count: number }>;
    };
    expect(tally.total).toBeGreaterThanOrEqual(1);
    const entry = tally.votes.find((v) => v.optionIndex === 8);
    expect(entry).toBeDefined();
    expect(
      must(entry, 'Expected tally entry for option 8').count,
    ).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/example-vote accepts Cloudflare localhost test-key validation responses', async () => {
    mockTurnstileValidation({
      success: true,
      action: 'test',
      hostname: 'localhost',
    });

    const voteResp = await handleHttpRequest(
      new Request('https://localhost/api/example-vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          optionIndex: 7,
          turnstileToken: 'token-localhost-test-key',
        }),
      }),
      exampleVoteEnv,
    );
    expect(voteResp.status).toBe(200);
  });

  it('POST /api/example-vote accepts Cloudflare localhost test-key validation responses on bracketed IPv6 loopback', async () => {
    mockTurnstileValidation({
      success: true,
      action: 'test',
      hostname: 'localhost',
    });

    const voteResp = await handleHttpRequest(
      new Request('http://[::1]:8787/api/example-vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          optionIndex: 6,
          turnstileToken: 'token-ipv6-localhost-test-key',
        }),
      }),
      exampleVoteEnv,
    );
    expect(voteResp.status).toBe(200);
  });

  it('POST /api/example-vote accepts bracketed IPv6 loopback when the verified hostname is unbracketed', async () => {
    mockTurnstileValidation({
      success: true,
      action: TURNSTILE_ACTION,
      hostname: '::1',
    });

    const voteResp = await handleHttpRequest(
      new Request('http://[::1]:8787/api/example-vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          optionIndex: 5,
          turnstileToken: 'token-ipv6-normalized-hostname',
        }),
      }),
      nonTestExampleVoteEnv,
    );
    expect(voteResp.status).toBe(200);
  });

  it('POST /api/example-vote rejects missing Turnstile tokens', async () => {
    const resp = await postWithEnv(exampleVoteEnv, '/api/example-vote', {
      optionIndex: 8,
    });
    expect(resp.status).toBe(400);
    await expect(resp.json()).resolves.toEqual({
      error: 'turnstileToken is required',
    });
  });

  it('POST /api/example-vote rejects failed Turnstile verification', async () => {
    mockTurnstileValidation({
      success: false,
      action: TURNSTILE_ACTION,
      hostname: TURNSTILE_HOSTNAME,
      'error-codes': ['invalid-input-response'],
    });

    const resp = await postWithEnv(exampleVoteEnv, '/api/example-vote', {
      optionIndex: 8,
      turnstileToken: 'token-fail',
    });
    expect(resp.status).toBe(403);
    await expect(resp.json()).resolves.toEqual({
      error: 'Human verification failed.',
    });
  });

  it('POST /api/example-vote rejects Turnstile action mismatches', async () => {
    mockTurnstileValidation({
      success: true,
      action: 'different_action',
      hostname: TURNSTILE_HOSTNAME,
    });

    const resp = await postWithEnv(exampleVoteEnv, '/api/example-vote', {
      optionIndex: 8,
      turnstileToken: 'token-action-mismatch',
    });
    expect(resp.status).toBe(403);
  });

  it('POST /api/example-vote rejects Turnstile hostname mismatches', async () => {
    mockTurnstileValidation({
      success: true,
      action: TURNSTILE_ACTION,
      hostname: 'evil.example',
    });

    const resp = await postWithEnv(exampleVoteEnv, '/api/example-vote', {
      optionIndex: 8,
      turnstileToken: 'token-hostname-mismatch',
    });
    expect(resp.status).toBe(403);
  });

  it('POST /api/example-vote returns 503 when Turnstile is not configured', async () => {
    const resp = await postWithEnv(
      {
        DB: env.DB,
        GAME_ROOM: {} as DurableObjectNamespace,
      } as Env,
      '/api/example-vote',
      {
        optionIndex: 8,
        turnstileToken: 'token-missing-config',
      },
    );
    expect(resp.status).toBe(503);
  });

  it('POST /api/example-vote rate limits write bursts per IP', async () => {
    const headers = { 'CF-Connecting-IP': '203.0.113.207' };
    mockTurnstileValidation({
      success: true,
      action: TURNSTILE_ACTION,
      hostname: TURNSTILE_HOSTNAME,
    });

    let lastStatus = 0;
    for (let i = 0; i < 41; i += 1) {
      const resp = await postWithEnv(
        exampleVoteEnv,
        '/api/example-vote',
        {
          optionIndex: 8,
          turnstileToken: `token-${i}`,
        },
        headers,
      );
      lastStatus = resp.status;
    }
    expect(lastStatus).toBe(429);
  });

  // ---- Cookie Secure attribute regression tests (issue #83) ----

  it('/api/auth/verify over HTTPS sets Secure cookie attribute', async () => {
    const wallet = createTestWallet(4);
    const challengeResp = await postWithBase(
      HTTPS_BASE,
      '/api/auth/challenge',
      {
        walletAddress: wallet.address,
      },
    );
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };
    const signature = await wallet.signMessage(message);
    const verifyResp = await postWithBase(HTTPS_BASE, '/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);
    const setCookie = must(
      verifyResp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on verify response',
    );
    expect(setCookie).toContain('Secure');
  });

  it('/api/auth/verify over HTTP omits Secure cookie attribute', async () => {
    const wallet = createTestWallet(5);
    const challengeResp = await postWithBase(HTTP_BASE, '/api/auth/challenge', {
      walletAddress: wallet.address,
    });
    const { challengeId, message } = (await challengeResp.json()) as {
      challengeId: string;
      message: string;
    };
    const signature = await wallet.signMessage(message);
    const verifyResp = await postWithBase(HTTP_BASE, '/api/auth/verify', {
      challengeId,
      walletAddress: wallet.address,
      signature,
    });
    expect(verifyResp.status).toBe(200);
    const setCookie = must(
      verifyResp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on verify response',
    );
    expect(setCookie).not.toContain('Secure');
  });

  it('/api/logout over HTTPS sets Secure cookie attribute', async () => {
    const resp = await postWithBase(HTTPS_BASE, '/api/logout', {});
    expect(resp.status).toBe(200);
    const setCookie = must(
      resp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on logout response',
    );
    expect(setCookie).toContain('Secure');
  });

  it('/api/logout over HTTP omits Secure cookie attribute', async () => {
    const resp = await postWithBase(HTTP_BASE, '/api/logout', {});
    expect(resp.status).toBe(200);
    const setCookie = must(
      resp.headers.get('Set-Cookie'),
      'Expected Set-Cookie header on logout response',
    );
    expect(setCookie).not.toContain('Secure');
  });

  // ---- Admin auth tests (timingSafeEqual fix) ----

  const ADMIN_KEY = 'test-admin-secret-key';
  const adminEnv = {
    DB: env.DB,
    GAME_ROOM: {} as DurableObjectNamespace,
    ADMIN_KEY,
  } satisfies Env;

  function adminGet(path: string, headers: Record<string, string> = {}) {
    return handleHttpRequest(
      new Request(`${HTTPS_BASE}${path}`, { headers }),
      adminEnv,
    );
  }

  it('admin route with valid Bearer token succeeds', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${ADMIN_KEY}`,
    });
    expect(resp.status).toBe(200);
  });

  it('admin route with wrong key (same length) returns 401', async () => {
    const wrongKey = 'x'.repeat(ADMIN_KEY.length);
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${wrongKey}`,
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with shorter key returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: 'Bearer short',
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with longer key returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: `Bearer ${ADMIN_KEY}-extra-long-suffix`,
    });
    expect(resp.status).toBe(401);
  });

  it('admin route with empty Authorization header returns 401', async () => {
    const resp = await adminGet('/api/export/votes.csv', {
      Authorization: '',
    });
    expect(resp.status).toBe(401);
  });

  it('admin route without ADMIN_KEY configured returns 503', async () => {
    const resp = await handleHttpRequest(
      new Request(`${HTTPS_BASE}/api/export/votes.csv`),
      {
        DB: env.DB,
        GAME_ROOM: {} as DurableObjectNamespace,
      } as Env,
    );
    expect(resp.status).toBe(503);
  });
});

describe('escapeCsvField — formula injection defense', () => {
  let escapeCsvField: (value: unknown) => string;

  beforeAll(async () => {
    const mod = await import('../../src/worker/routes/admin');
    escapeCsvField = mod.escapeCsvField;
  });

  it('passes through plain values', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes values containing commas, quotes, or newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('prefixes formula-triggering characters with tab', () => {
    expect(escapeCsvField('=SUM(A1)')).toBe('\t=SUM(A1)');
    expect(escapeCsvField('+cmd')).toBe('\t+cmd');
    expect(escapeCsvField('-val')).toBe('\t-val');
    expect(escapeCsvField('@import')).toBe('\t@import');
  });

  it('keeps tab inside quotes for formula values that also need quoting', () => {
    expect(escapeCsvField('=1,2')).toBe('"\t=1,2"');
    expect(escapeCsvField('=HYPERLINK("evil","click")')).toBe(
      '"\t=HYPERLINK(""evil"",""click"")"',
    );
    expect(escapeCsvField('+line\nbreak')).toBe('"\t+line\nbreak"');
  });
});
