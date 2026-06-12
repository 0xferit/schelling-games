import type { Env } from '../types/worker-env';
import { ensureAccountWithStats } from './routes/_helpers';
import {
  handleExportVotesCsv,
  handleLeaderboardEligible,
} from './routes/admin';
import { handleChallenge, handleLogout, handleVerify } from './routes/auth';
import {
  handleExampleTally,
  handleExampleVote,
  handleGameConfig,
  handleLandingStats,
} from './routes/landing';
import { handleLeaderboard, handleLeaderboardMe } from './routes/leaderboard';
import { handleGetMe, handlePatchProfile } from './routes/profile';
import { parseCookies, verifySessionCookie } from './session';

export async function handleHttpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // ---- WebSocket upgrade: /ws ----
  if (url.pathname === '/ws') {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const accountId = verifySessionCookie(cookies.session);
    if (!accountId) return new Response('Unauthorized', { status: 401 });

    const account = await ensureAccountWithStats(env.DB, accountId);

    if (!account) {
      return new Response('Failed to provision account', { status: 500 });
    }

    const displayName =
      account.display_name ||
      `${accountId.slice(0, 6)}..${accountId.slice(-4)}`;

    const id = env.GAME_ROOM.idFromName('lobby');
    const stub = env.GAME_ROOM.get(id);
    const doUrl = new URL(request.url);
    doUrl.searchParams.set('accountId', accountId);
    doUrl.searchParams.set('displayName', displayName);
    doUrl.searchParams.set('tokenBalance', String(account.token_balance ?? 0));
    const rawClientBuild = url.searchParams.get('clientBuild');
    if (rawClientBuild && rawClientBuild.length <= 64) {
      doUrl.searchParams.set('clientBuild', rawClientBuild);
    } else {
      doUrl.searchParams.delete('clientBuild');
    }
    return stub.fetch(new Request(doUrl.toString(), request));
  }

  // ---- Auth routes ----
  if (url.pathname === '/api/logout' && method === 'POST') {
    return handleLogout(request);
  }
  if (url.pathname === '/api/auth/challenge' && method === 'POST') {
    return handleChallenge(request, env);
  }
  if (url.pathname === '/api/auth/verify' && method === 'POST') {
    return handleVerify(request, env);
  }

  // ---- Profile routes ----
  if (url.pathname === '/api/me' && method === 'GET') {
    return handleGetMe(request, env);
  }
  if (url.pathname === '/api/me/profile' && method === 'PATCH') {
    return handlePatchProfile(request, env);
  }

  // ---- Leaderboard routes ----
  if (url.pathname === '/api/leaderboard' && method === 'GET') {
    return handleLeaderboard(request, env);
  }
  if (url.pathname === '/api/leaderboard/me' && method === 'GET') {
    return handleLeaderboardMe(request, env);
  }

  // ---- Landing / public routes ----
  if (url.pathname === '/api/landing-stats' && method === 'GET') {
    return handleLandingStats(request, env);
  }
  if (url.pathname === '/api/game-config' && method === 'GET') {
    return handleGameConfig(request, env);
  }
  if (url.pathname === '/api/example-vote' && method === 'POST') {
    return handleExampleVote(request, env);
  }
  if (url.pathname === '/api/example-tally' && method === 'GET') {
    return handleExampleTally(request, env);
  }

  // ---- Admin routes ----
  if (url.pathname === '/api/export/votes.csv' && method === 'GET') {
    return handleExportVotesCsv(request, env);
  }
  if (url.pathname === '/api/admin/leaderboard-eligible' && method === 'POST') {
    return handleLeaderboardEligible(request, env);
  }

  // All other paths fall through to static asset serving (configured in wrangler.toml).
  return new Response('Not found', { status: 404 });
}
