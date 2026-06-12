import { COMMIT_DURATION, REVEAL_DURATION } from '../../domain/constants';
import type { Env } from '../../types/worker-env';
import {
  EXAMPLE_VOTE_LIMIT,
  errorResponse,
  getClientIdentifier,
  getRequiredString,
  isRateLimited,
  jsonResponse,
  rateLimitResponse,
  readJsonObjectBody,
} from './_helpers';

interface CacheStorageWithDefault extends CacheStorage {
  default?: Cache;
}

interface TurnstileVerificationResult {
  success: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const EXAMPLE_VOTE_TURNSTILE_ACTION = 'landing_example_vote';
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

function getConfiguredTurnstileSiteKey(env: Env): string | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  return siteKey ? siteKey : null;
}

function getConfiguredTurnstileSecretKey(env: Env): string | null {
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  return secretKey ? secretKey : null;
}

function normalizeBracketedIpv6Hostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLocalHostname(hostname: string): boolean {
  const normalizedHostname = normalizeBracketedIpv6Hostname(hostname);
  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1' ||
    normalizedHostname.endsWith('.localhost')
  );
}

function isCloudflareTurnstileTestMode(
  siteKey: string,
  secretKey: string,
  hostname: string,
): boolean {
  return (
    siteKey === TURNSTILE_TEST_SITE_KEY &&
    secretKey === TURNSTILE_TEST_SECRET_KEY &&
    isLocalHostname(hostname)
  );
}

async function verifyExampleVoteTurnstileToken(
  request: Request,
  env: Env,
  token: string,
): Promise<Response | null> {
  const siteKey = getConfiguredTurnstileSiteKey(env);
  const secretKey = getConfiguredTurnstileSecretKey(env);
  if (!siteKey || !secretKey) {
    return errorResponse('Demo voting is temporarily unavailable.', 503);
  }

  const body = new URLSearchParams();
  body.set('secret', secretKey);
  body.set('response', token);

  const clientIdentifier = getClientIdentifier(request);
  if (clientIdentifier !== 'unknown') {
    body.set('remoteip', clientIdentifier);
  }

  let verificationResponse: Response;
  try {
    verificationResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    console.error('Turnstile siteverify request failed', error);
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  if (!verificationResponse.ok) {
    console.error(
      'Turnstile siteverify request returned non-OK status',
      verificationResponse.status,
    );
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  let verificationResult: TurnstileVerificationResult;
  try {
    verificationResult =
      (await verificationResponse.json()) as TurnstileVerificationResult;
  } catch (error) {
    console.error('Turnstile siteverify response was not valid JSON', error);
    return errorResponse('Human verification is temporarily unavailable.', 503);
  }

  const expectedHostname = normalizeBracketedIpv6Hostname(
    new URL(request.url).hostname,
  );
  const verifiedHostname = verificationResult.hostname
    ? normalizeBracketedIpv6Hostname(verificationResult.hostname)
    : null;
  if (
    verificationResult.success &&
    isCloudflareTurnstileTestMode(siteKey, secretKey, expectedHostname)
  ) {
    return null;
  }

  if (
    !verificationResult.success ||
    verificationResult.action !== EXAMPLE_VOTE_TURNSTILE_ACTION ||
    verifiedHostname !== expectedHostname
  ) {
    return errorResponse('Human verification failed.', 403);
  }

  return null;
}

const LANDING_STATS_CACHE_TTL_SECONDS = 60;
const LANDING_STATS_CACHE_CONTROL = `public, max-age=${LANDING_STATS_CACHE_TTL_SECONDS}, s-maxage=${LANDING_STATS_CACHE_TTL_SECONDS}`;
const LANDING_STATS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function handleLandingStats(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const cache = (globalThis.caches as CacheStorageWithDefault | undefined)
    ?.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const startedAfter = new Date(
    Date.now() - LANDING_STATS_LOOKBACK_MS,
  ).toISOString();

  const [playersLast24hRow, completedMatchesRow, longestStreakRow] =
    await Promise.all([
      env.DB.prepare(
        'SELECT COUNT(DISTINCT mp.account_id) AS players_last_24h ' +
          'FROM matches m ' +
          'JOIN match_players mp ON mp.match_id = m.match_id ' +
          'WHERE m.started_at >= ? AND m.ai_assisted = 0',
      )
        .bind(startedAfter)
        .first<{ players_last_24h: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS completed_matches FROM matches WHERE status = 'completed' AND ai_assisted = 0",
      ).first<{ completed_matches: number }>(),
      env.DB.prepare(
        'SELECT COALESCE(MAX(longest_streak), 0) AS longest_streak FROM player_stats',
      ).first<{ longest_streak: number }>(),
    ]);

  const response = jsonResponse(
    {
      playersLast24h: playersLast24hRow?.players_last_24h ?? 0,
      completedMatches: completedMatchesRow?.completed_matches ?? 0,
      longestStreak: longestStreakRow?.longest_streak ?? 0,
    },
    200,
    { 'Cache-Control': LANDING_STATS_CACHE_CONTROL },
  );

  if (cache) {
    await cache.put(cacheKey, response.clone());
  }

  return response;
}

export function handleGameConfig(_request: Request, env: Env): Response {
  return jsonResponse({
    commitDuration: COMMIT_DURATION,
    revealDuration: REVEAL_DURATION,
    turnstileSiteKey: getConfiguredTurnstileSiteKey(env),
    build: env.BUILD_HASH?.trim() || null,
  });
}

export async function handleExampleVote(
  request: Request,
  env: Env,
): Promise<Response> {
  if (isRateLimited('example_vote', request, EXAMPLE_VOTE_LIMIT)) {
    return rateLimitResponse(EXAMPLE_VOTE_LIMIT.windowMs);
  }
  const rawBody = await readJsonObjectBody(request);
  if (rawBody instanceof Response) return rawBody;

  const idx = rawBody.optionIndex;
  const turnstileToken = getRequiredString(rawBody, 'turnstileToken');
  if (
    typeof idx !== 'number' ||
    !Number.isInteger(idx) ||
    idx < 0 ||
    idx > 17
  ) {
    return errorResponse('optionIndex must be an integer 0-17', 400);
  }
  if (!turnstileToken) {
    return errorResponse('turnstileToken is required', 400);
  }

  const verificationError = await verifyExampleVoteTurnstileToken(
    request,
    env,
    turnstileToken,
  );
  if (verificationError) return verificationError;

  await env.DB.prepare('INSERT INTO example_votes (option_index) VALUES (?)')
    .bind(idx)
    .run();
  return jsonResponse({ ok: true });
}

export async function handleExampleTally(
  _request: Request,
  env: Env,
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT option_index, COUNT(*) as count FROM example_votes GROUP BY option_index',
  ).all();
  const votes = (results || []).map((r: Record<string, unknown>) => ({
    optionIndex: r.option_index as number,
    count: r.count as number,
  }));
  const total = votes.reduce(
    (sum: number, v: { count: number }) => sum + v.count,
    0,
  );
  return jsonResponse({ total, votes });
}
