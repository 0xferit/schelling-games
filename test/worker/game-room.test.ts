import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCommitHash,
  createOpenTextCommitHash,
} from '../../src/domain/commitReveal';
import {
  MIN_ALLOWED_BALANCE,
  RESULTS_DURATION,
} from '../../src/domain/constants';
import type { OpenTextPrompt, SchellingPrompt } from '../../src/types/domain';
import {
  createTestSession,
  createTestWallet,
  must,
  seedAccount,
} from './helpers';

declare const __RUN_EXTENDED_WORKER_TESTS__: boolean;

const BASE = 'https://test.local';
const MATCH_START_TIMEOUT_MS = 40_000;
const GAME_START_TIMEOUT_MS = 45_000;
const MATCH_OVER_TIMEOUT_MS = 20_000;
const extendedWorkerTestsEnabled = __RUN_EXTENDED_WORKER_TESTS__;
const extendedIt = extendedWorkerTestsEnabled ? it : it.skip;

function makeSalt(gameNum: number, playerIdx: number): string {
  const nibbleA = (gameNum % 16).toString(16);
  const nibbleB = (playerIdx % 16).toString(16);
  return `${nibbleA}${nibbleB}`.repeat(32);
}

function getOpenTextTestAnswer(prompt: OpenTextPrompt, variant = 0): string {
  switch (prompt.answerSpec.kind) {
    case 'integer_range':
      return prompt.answerSpec.max <= 10
        ? variant === 0
          ? '7'
          : '8'
        : variant === 0
          ? '50'
          : '60';
    case 'playing_card':
      return variant === 0 ? 'Ace of Spades' : 'King of Hearts';
    case 'single_word':
      return variant === 0 ? 'love' : 'peace';
    case 'free_text':
      return variant === 0 ? 'New York' : 'London';
  }
}

function buildPromptAction(
  prompt: SchellingPrompt,
  salt: string,
  variant = 0,
): {
  hash: string;
  reveal: Record<string, string | number>;
} {
  if (prompt.type === 'select') {
    return {
      hash: createCommitHash(variant, salt),
      reveal: { type: 'reveal', optionIndex: variant, salt },
    };
  }

  const answerText = getOpenTextTestAnswer(prompt, variant);
  return {
    hash: createOpenTextCommitHash(answerText, salt, prompt),
    reveal: { type: 'reveal', answerText, salt },
  };
}

function getGameResultTimeoutMs(prompt: SchellingPrompt): number {
  return prompt.type === 'open_text' ? 25_000 : 5000;
}

function createDeterministicAiBinding() {
  return {
    async run(_model: string, inputs: Record<string, unknown>) {
      const promptText = typeof inputs.prompt === 'string' ? inputs.prompt : '';
      const jsonString = '"((?:\\\\.|[^"\\\\])*)"';
      const matches = [
        ...promptText.matchAll(
          new RegExp(
            `normalizedInputText=${jsonString} \\| rawAnswerText=${jsonString} \\| canonicalCandidate=${jsonString} \\| bucketLabelCandidate=${jsonString}`,
            'g',
          ),
        ),
      ];

      if (matches.length === 0) {
        return JSON.stringify({ optionIndex: 0 });
      }

      return JSON.stringify({
        verdicts: matches.map((match) => ({
          normalizedInputText: JSON.parse(`"${match[1] || ''}"`),
          bucketLabel: JSON.parse(
            `"${match[4] || match[3] || match[1] || ''}"`,
          ),
        })),
      });
    },
  };
}

const envWithAi = env as unknown as {
  AI?: {
    run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
  };
  AI_BOT_ENABLED?: string;
};

let originalAiBinding: typeof envWithAi.AI;
let originalAiBotEnabled: typeof envWithAi.AI_BOT_ENABLED;

/** Helper: collect WebSocket messages into an array for a short window. */
function collectMessages(
  ws: WebSocket,
  timeoutMs = 500,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const handler = (evt: MessageEvent) => {
      messages.push(JSON.parse(evt.data as string));
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      resolve(messages);
    }, timeoutMs);
  });
}

/** Helper: wait for a specific message type from a WebSocket. */
function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for "${type}"`));
    }, timeoutMs);
    ws.addEventListener('message', handler);
  });
}

/** Helper: wait for a WebSocket close event. */
function waitForClose(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const handler = (evt: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener('close', handler);
      resolve({ code: evt.code, reason: evt.reason });
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('close', handler);
      reject(new Error('Timed out waiting for socket close'));
    }, timeoutMs);
    ws.addEventListener('close', handler);
  });
}

/** Wait for a message that satisfies a predicate. */
function waitForMessageWhere(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data as string);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('Timed out waiting for matching message'));
    }, timeoutMs);
    ws.addEventListener('message', handler);
  });
}

async function openWs(
  cookie: string,
  clientBuild?: string,
): Promise<WebSocket> {
  const url = clientBuild
    ? `${BASE}/ws?clientBuild=${encodeURIComponent(clientBuild)}`
    : `${BASE}/ws`;
  const resp = await exports.default.fetch(
    new Request(url, {
      headers: {
        Upgrade: 'websocket',
        Cookie: `session=${cookie}`,
      },
    }),
  );
  expect(resp.status).toBe(101);
  const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
  ws.accept();
  return ws;
}

/** Open a WebSocket for a wallet index and return the socket plus session cookie. */
async function connectWsWithSession(
  walletIndex: number,
): Promise<{ ws: WebSocket; accountId: string; cookie: string }> {
  const wallet = createTestWallet(walletIndex);
  const { accountId, cookie } = await createTestSession(wallet);
  const ws = await openWs(cookie);
  return { ws, accountId, cookie };
}

async function connectWs(
  walletIndex: number,
): Promise<{ ws: WebSocket; accountId: string }> {
  const { ws, accountId } = await connectWsWithSession(walletIndex);
  return { ws, accountId };
}

/** Connect a seeded player via WebSocket, returning the client socket. */
async function connectPlayer(
  walletIndex: number,
  displayName: string,
  balance = 0,
): Promise<{ ws: WebSocket; accountId: string }> {
  const { ws, accountId } = await connectPlayerWithSession(
    walletIndex,
    displayName,
    balance,
  );
  return { ws, accountId };
}

async function connectPlayerWithSession(
  walletIndex: number,
  displayName: string,
  balance = 0,
): Promise<{ ws: WebSocket; accountId: string; cookie: string }> {
  const wallet = createTestWallet(walletIndex);
  const { accountId, cookie } = await createTestSession(wallet);
  await seedAccount(env.DB, accountId, displayName, balance);
  const ws = await openWs(cookie);
  return { ws, accountId, cookie };
}

/**
 * Reconnect an already-seeded player via WebSocket without reseeding or
 * updating the account row in D1. Use this instead of connectPlayer when the
 * account already exists and its token_balance must not be reset (e.g. after
 * settlement has altered it).
 */
async function reconnectPlayer(
  walletIndex: number,
): Promise<{ ws: WebSocket; accountId: string }> {
  return connectWs(walletIndex);
}

/** Join queue and start immediately via unanimous start-now votes. */
async function joinPlayersAndStartNow(
  players: Array<{ ws: WebSocket }>,
): Promise<void> {
  const formingPromises = players.map((player) =>
    waitForMessageWhere(
      player.ws,
      (msg) => msg.type === 'queue_state' && msg.status === 'forming',
      3000,
    ),
  );

  for (const player of players) {
    player.ws.send(JSON.stringify({ type: 'join_queue' }));
  }

  await Promise.all(formingPromises);

  for (const player of players) {
    player.ws.send(JSON.stringify({ type: 'set_start_now', value: true }));
  }
}

/** Connect N players, join queue, and await match_started for all. */
async function formMatch(
  wallets: [index: number, name: string][],
): Promise<
  { ws: WebSocket; accountId: string; gameStarted: Record<string, unknown> }[]
> {
  const players: Array<Awaited<ReturnType<typeof connectPlayer>>> = [];
  for (const [index, name] of wallets) {
    players.push(await connectPlayer(index, name));
  }

  const startedPromises = players.map((p) =>
    waitForMessage(p.ws, 'match_started', MATCH_START_TIMEOUT_MS),
  );

  await joinPlayersAndStartNow(players);

  const started = await Promise.all(startedPromises);
  return players.map((p, i) => ({
    ...p,
    gameStarted: must(
      started[i],
      `Expected match_started for player index ${i}`,
    ),
  }));
}

describe('GameRoom Durable Object', () => {
  beforeEach(() => {
    originalAiBinding = envWithAi.AI;
    originalAiBotEnabled = envWithAi.AI_BOT_ENABLED;
    envWithAi.AI = createDeterministicAiBinding();
    envWithAi.AI_BOT_ENABLED = 'false';
  });

  afterEach(() => {
    envWithAi.AI = originalAiBinding;
    envWithAi.AI_BOT_ENABLED = originalAiBotEnabled;
  });

  it('rejects WebSocket without session cookie (401)', async () => {
    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: { Upgrade: 'websocket' },
      }),
    );
    expect(resp.status).toBe(401);
  });

  describe('client build admission', () => {
    const buildEnv = env as unknown as { BUILD_HASH?: string };
    const CURRENT_BUILD = 'deadbee';
    let previousBuildHash: string | undefined;

    beforeEach(() => {
      previousBuildHash = buildEnv.BUILD_HASH;
      buildEnv.BUILD_HASH = CURRENT_BUILD;
    });

    afterEach(() => {
      if (previousBuildHash === undefined) {
        delete buildEnv.BUILD_HASH;
      } else {
        buildEnv.BUILD_HASH = previousBuildHash;
      }
    });

    it('admits a client whose build matches the deployed build', async () => {
      const wallet = createTestWallet(20);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'MatchingBuildPlayer');
      const ws = await openWs(cookie, CURRENT_BUILD);
      const queueMsg = await waitForMessage(ws, 'queue_state', 3000);
      expect(queueMsg.type).toBe('queue_state');
      ws.close();
    });

    it('closes a client with a mismatched build (code 4001)', async () => {
      const wallet = createTestWallet(21);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'StalePlayer');
      const ws = await openWs(cookie, 'abc1234');
      const closed = await waitForClose(ws, 3000);
      expect(closed.code).toBe(4001);
      expect(closed.reason).toBe('client build mismatch');
    });

    it('closes a client with a malformed build (code 4001)', async () => {
      const wallet = createTestWallet(22);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'MalformedPlayer');
      const ws = await openWs(cookie, 'not-a-hex-sha!!');
      const closed = await waitForClose(ws, 3000);
      expect(closed.code).toBe(4001);
      expect(closed.reason).toBe('client build mismatch');
    });

    it('closes a client when BUILD_HASH is set but no clientBuild is sent', async () => {
      const wallet = createTestWallet(23);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'NoBuildPlayer');
      const ws = await openWs(cookie);
      const closed = await waitForClose(ws, 3000);
      expect(closed.code).toBe(4001);
    });

    it('admits a matching client when BUILD_HASH carries stray whitespace', async () => {
      buildEnv.BUILD_HASH = ` ${CURRENT_BUILD}\n`;
      const wallet = createTestWallet(26);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'TrimmedBuildPlayer');
      const ws = await openWs(cookie, CURRENT_BUILD);
      const queueMsg = await waitForMessage(ws, 'queue_state', 3000);
      expect(queueMsg.type).toBe('queue_state');
      ws.close();
    });
  });

  it('skips build-mismatch check when env.BUILD_HASH is unset', async () => {
    const buildEnv = env as unknown as { BUILD_HASH?: string };
    const previous = buildEnv.BUILD_HASH;
    delete buildEnv.BUILD_HASH;
    try {
      const wallet = createTestWallet(24);
      const { accountId, cookie } = await createTestSession(wallet);
      await seedAccount(env.DB, accountId, 'DevModePlayer');
      const ws = await openWs(cookie, 'anything-goes');
      const queueMsg = await waitForMessage(ws, 'queue_state', 3000);
      expect(queueMsg.type).toBe('queue_state');
      ws.close();
    } finally {
      if (previous === undefined) {
        delete buildEnv.BUILD_HASH;
      } else {
        buildEnv.BUILD_HASH = previous;
      }
    }
  });

  it('WebSocket auto-provisions a missing account for a valid session', async () => {
    const wallet = createTestWallet(0);
    const { accountId, cookie } = await createTestSession(wallet);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM player_stats WHERE account_id = ?').bind(
        accountId,
      ),
      env.DB.prepare('DELETE FROM accounts WHERE account_id = ?').bind(
        accountId,
      ),
    ]);

    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Cookie: `session=${cookie}`,
        },
      }),
    );

    expect(resp.status).toBe(101);

    const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
    ws.accept();
    const messages = await collectMessages(ws);
    expect(messages.some((message) => message.type === 'queue_state')).toBe(
      true,
    );

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
    ws.close();
  });

  it('WebSocket falls back to a wallet-derived display name', async () => {
    // Use wallet 5 so it does not collide with later tests.
    const wallet = createTestWallet(5);
    const { accountId, cookie } = await createTestSession(wallet);
    await seedAccount(env.DB, accountId, null);

    const resp = await exports.default.fetch(
      new Request(`${BASE}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Cookie: `session=${cookie}`,
        },
      }),
    );
    expect(resp.status).toBe(101);
    const ws = must(resp.webSocket, 'Expected WebSocket upgrade response');
    ws.accept();
    const messages = await collectMessages(ws);
    const queueMsg = messages.find((m) => m.type === 'queue_state');
    expect(queueMsg).toBeDefined();
    ws.close();
  });

  it('WebSocket connects with valid session + display name', async () => {
    const { ws } = await connectPlayer(6, 'Alice');
    const messages = await collectMessages(ws);

    // Should receive queue_state on connect
    const queueMsg = messages.find((m) => m.type === 'queue_state');
    expect(queueMsg).toBeDefined();
    ws.close();
  });

  it('join_queue and leave_queue cycle works', async () => {
    const { ws } = await connectPlayer(7, 'Bob');

    // Drain initial queue_state
    await collectMessages(ws, 200);

    // Join queue
    ws.send(JSON.stringify({ type: 'join_queue' }));
    const joinMsgs = await collectMessages(ws, 300);
    const joinState = joinMsgs.find((m) => m.type === 'queue_state');
    expect(joinState).toBeDefined();
    expect(
      must(joinState, 'Expected queue_state after join').queuedCount,
    ).toBeGreaterThanOrEqual(1);

    // Leave queue
    ws.send(JSON.stringify({ type: 'leave_queue' }));
    const leaveMsgs = await collectMessages(ws, 300);
    const leaveState = leaveMsgs.find((m) => m.type === 'queue_state');
    expect(leaveState).toBeDefined();

    ws.close();
  });

  it('queue state reflects a renamed player after websocket refresh', async () => {
    const { ws: initialWs, cookie } = await connectPlayerWithSession(
      1,
      'OldName',
    );
    await waitForMessageWhere(
      initialWs,
      (msg) => msg.type === 'queue_state' && msg.status === 'idle',
    );

    const resp = await exports.default.fetch(
      new Request(`${BASE}/api/me/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${cookie}`,
        },
        body: JSON.stringify({ displayName: 'NewName' }),
      }),
    );
    expect(resp.status).toBe(200);

    const initialClose = waitForClose(initialWs);
    const replacementWs = await openWs(cookie);
    await waitForMessageWhere(
      replacementWs,
      (msg) => msg.type === 'queue_state' && msg.status === 'idle',
    );
    await expect(initialClose).resolves.toEqual({
      code: 1000,
      reason: 'Replaced by new connection',
    });

    replacementWs.send(JSON.stringify({ type: 'join_queue' }));
    const queuedState = must(
      await waitForMessageWhere(
        replacementWs,
        (msg) => msg.type === 'queue_state' && msg.status === 'queued',
      ),
      'Expected queued queue_state after join',
    );
    expect(queuedState.queuedPlayers).toContain('NewName');
    expect(queuedState.queuedPlayers).not.toContain('OldName');

    initialWs.close();
    replacementWs.close();
  });

  it('PATCH /api/me/profile rejects display name changes while queued', async () => {
    const { ws, cookie } = await connectPlayerWithSession(2, 'QueuedName');
    await waitForMessageWhere(
      ws,
      (msg) => msg.type === 'queue_state' && msg.status === 'idle',
    );

    ws.send(JSON.stringify({ type: 'join_queue' }));
    await waitForMessageWhere(
      ws,
      (msg) => msg.type === 'queue_state' && msg.status === 'queued',
    );

    const resp = await exports.default.fetch(
      new Request(`${BASE}/api/me/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${cookie}`,
        },
        body: JSON.stringify({ displayName: 'BlockedName' }),
      }),
    );
    expect(resp.status).toBe(409);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toBe(
      'Cannot change display name while queued, forming, or in a match',
    );

    ws.close();
  });

  it('PATCH /api/me/profile rejects display name changes while in a match', async () => {
    const players = await Promise.all([
      connectPlayerWithSession(5, 'MatchRenameP1', 1000),
      connectPlayerWithSession(6, 'MatchRenameP2', 1000),
      connectPlayerWithSession(7, 'MatchRenameP3', 1000),
    ]);

    const startedPromises = players.map((player) =>
      waitForMessage(player.ws, 'match_started', MATCH_START_TIMEOUT_MS),
    );

    await joinPlayersAndStartNow(players);
    await Promise.all(startedPromises);

    const resp = await exports.default.fetch(
      new Request(`${BASE}/api/me/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${players[0].cookie}`,
        },
        body: JSON.stringify({ displayName: 'BlockedMidMatch' }),
      }),
    );
    expect(resp.status).toBe(409);
    const data = (await resp.json()) as { error: string };
    expect(data.error).toBe(
      'Cannot change display name while queued, forming, or in a match',
    );

    for (const player of players) {
      player.ws.close();
    }
  });

  it('repairs stale below-floor balances before queue entry', async () => {
    const { ws, accountId } = await connectPlayer(
      9,
      'LowBalance',
      MIN_ALLOWED_BALANCE - 120,
    );

    // Drain initial queue_state
    await collectMessages(ws, 200);

    ws.send(JSON.stringify({ type: 'join_queue' }));
    const msgs = await collectMessages(ws, 300);
    expect(msgs.find((m) => m.type === 'error')).toBeUndefined();

    const queueState = msgs.find((m) => m.type === 'queue_state');
    expect(queueState).toBeDefined();
    const repairedState = must(queueState, 'Expected queue_state after repair');
    expect(['queued', 'forming']).toContain(repairedState.status);
    if (repairedState.status === 'forming') {
      expect(repairedState.formingMatch).toBeTruthy();
    }

    const row = (await env.DB.prepare(
      'SELECT token_balance FROM accounts WHERE account_id = ?',
    )
      .bind(accountId)
      .first()) as { token_balance: number } | null;
    expect(row?.token_balance).toBe(MIN_ALLOWED_BALANCE);

    ws.close();
  });

  it('holds a forming lobby until someone presses ready', async () => {
    const players = await Promise.all([
      connectPlayer(10, 'ReadyHold1'),
      connectPlayer(11, 'ReadyHold2'),
      connectPlayer(12, 'ReadyHold3'),
    ]);

    const formingPromises = players.map((player) =>
      waitForMessageWhere(
        player.ws,
        (msg) => msg.type === 'queue_state' && msg.status === 'forming',
        3000,
      ),
    );

    for (const player of players) {
      player.ws.send(JSON.stringify({ type: 'join_queue' }));
    }

    const formingStates = await Promise.all(formingPromises);
    for (const state of formingStates) {
      expect(state.formingMatch).toBeDefined();
      expect(
        must(state.formingMatch, 'Expected forming match state').fillDeadlineMs,
      ).toBeNull();
    }

    const matchStarted = await Promise.all(
      players.map((player) =>
        waitForMessage(player.ws, 'match_started', 1200)
          .then(() => true)
          .catch(() => false),
      ),
    );
    expect(matchStarted).toEqual([false, false, false]);

    for (const player of players) {
      player.ws.close();
    }
  });

  it('3 players can queue and launch once everyone readies up', {
    timeout: 45_000,
  }, async () => {
    const players = await formMatch([
      [0, 'Player1'],
      [1, 'Player2'],
      [2, 'Player3'],
    ]);

    // Verify match_started has expected structure
    const gs1 = must(players[0], 'Expected first player').gameStarted;
    expect(gs1.matchId).toBeTruthy();
    expect(gs1.players).toBeDefined();
    expect(gs1.gameCount).toBe(10);

    // All three should share the same matchId
    expect(gs1.matchId).toBe(
      must(players[1], 'Expected second player').gameStarted.matchId,
    );
    expect(gs1.matchId).toBe(
      must(players[2], 'Expected third player').gameStarted.matchId,
    );

    for (const p of players) {
      p.ws.close();
    }
  });

  it('reconnect after commit replays game_started with yourCommitted flag', {
    timeout: 55_000,
  }, async () => {
    // Form a match with 3 players (wallet indices 3/4/8 to avoid collisions)
    const p1 = await connectPlayer(3, 'Reconnector');
    const p2 = await connectPlayer(4, 'Bystander1');
    const p3 = await connectPlayer(8, 'Bystander2');

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    // Listen for game_started before awaiting match_started to avoid missing
    // back-to-back messages from the server.
    const p1GameStart = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    const [gs1] = await Promise.all([p1Started, p2Started, p3Started]);
    const originalMatchId = gs1.matchId;
    expect(originalMatchId).toBeTruthy();

    const roundStart = await p1GameStart;
    expect(roundStart.phase).toBe('commit');

    // Player 1 commits a hash.
    // Set up listener before sending to avoid race with fast DO reply.
    const fakeHash =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const commitStatus = waitForMessage(p1.ws, 'commit_status', 3000);
    p1.ws.send(JSON.stringify({ type: 'commit', hash: fakeHash }));
    await commitStatus;

    // Disconnect player 1
    p1.ws.close();

    // Reconnect the same wallet (same accountId).
    // Register both listeners immediately after reconnectPlayer returns
    // (before any await) so queued replay messages can't dispatch first.
    const p1r = await reconnectPlayer(3);
    const reconnectGameStartedP = waitForMessage(p1r.ws, 'match_started', 3000);
    const reconnectGameStartP = waitForMessage(p1r.ws, 'game_started', 3000);

    const reconnectGameStarted = await reconnectGameStartedP;
    expect(reconnectGameStarted.matchId).toBe(originalMatchId);

    const reconnectRoundStart = await reconnectGameStartP;
    expect(reconnectRoundStart.yourCommitted).toBe(true);
    expect(reconnectRoundStart.yourRevealed).toBe(false);

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('refresh-style reconnect replays active match state and receives later broadcasts', {
    timeout: 55_000,
  }, async () => {
    const p1 = await connectPlayer(31, 'RefreshP1');
    const p2 = await connectPlayer(32, 'RefreshP2');
    const p3 = await connectPlayer(33, 'RefreshP3');

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    const p1GameStart = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    const [gs1] = await Promise.all([p1Started, p2Started, p3Started]);
    const originalMatchId = gs1.matchId;
    expect(originalMatchId).toBeTruthy();

    const roundStart = await p1GameStart;
    expect(roundStart.phase).toBe('commit');

    const p1r = await reconnectPlayer(31);
    const replayMessagesP = collectMessages(p1r.ws, 1500);
    const replayMatchStartedP = waitForMessage(p1r.ws, 'match_started', 3000);
    const replayGameStartedP = waitForMessage(p1r.ws, 'game_started', 3000);
    const updatedCommitStatusP = waitForMessageWhere(
      p1r.ws,
      (msg) =>
        msg.type === 'commit_status' &&
        Array.isArray(msg.committed) &&
        msg.committed.some(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            (entry as { displayName?: unknown }).displayName === 'RefreshP2' &&
            (entry as { hasCommitted?: unknown }).hasCommitted === true,
        ),
      5000,
    );

    const replayMatchStarted = await replayMatchStartedP;
    expect(replayMatchStarted.matchId).toBe(originalMatchId);

    const replayGameStarted = await replayGameStartedP;
    expect(replayGameStarted.phase).toBe('commit');

    const fakeHash =
      '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    p2.ws.send(JSON.stringify({ type: 'commit', hash: fakeHash }));

    const updatedCommitStatus = await updatedCommitStatusP;
    expect(updatedCommitStatus).toMatchObject({
      type: 'commit_status',
      committed: expect.arrayContaining([
        expect.objectContaining({
          displayName: 'RefreshP2',
          hasCommitted: true,
        }),
      ]),
    });

    const replayMessages = await replayMessagesP;
    expect(
      replayMessages.some((message) => message.type === 'queue_state'),
    ).toBe(false);
    expect(
      replayMessages.some((message) => message.type === 'match_started'),
    ).toBe(true);
    expect(
      replayMessages.some((message) => message.type === 'game_started'),
    ).toBe(true);

    p1.ws.close();
    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('grandfathers mid-match reconnect with a stale client build', {
    timeout: 55_000,
  }, async () => {
    const buildEnv = env as unknown as { BUILD_HASH?: string };
    const previousBuildHash = buildEnv.BUILD_HASH;
    delete buildEnv.BUILD_HASH;
    try {
      const p1 = await connectPlayer(25, 'GrandfatherP1');
      const p2 = await connectPlayer(26, 'GrandfatherP2');
      const p3 = await connectPlayer(27, 'GrandfatherP3');

      const p1Started = waitForMessage(
        p1.ws,
        'match_started',
        MATCH_START_TIMEOUT_MS,
      );
      const p2Started = waitForMessage(
        p2.ws,
        'match_started',
        MATCH_START_TIMEOUT_MS,
      );
      const p3Started = waitForMessage(
        p3.ws,
        'match_started',
        MATCH_START_TIMEOUT_MS,
      );

      await joinPlayersAndStartNow([p1, p2, p3]);

      const [gs1] = await Promise.all([p1Started, p2Started, p3Started]);
      const matchId = gs1.matchId;

      // Simulate a deploy after the match started.
      buildEnv.BUILD_HASH = 'newbuild';

      // Reconnect player 1 with a stale build — should NOT get 4001 close;
      // should replay match_started because active-match reconnect is grandfathered.
      const wallet = createTestWallet(25);
      const { cookie } = await createTestSession(wallet);
      const p1r = await openWs(cookie, 'oldbuild');
      const replayMatchStarted = await waitForMessage(
        p1r,
        'match_started',
        3000,
      );
      expect(replayMatchStarted.matchId).toBe(matchId);

      p1.ws.close();
      p1r.close();
      p2.ws.close();
      p3.ws.close();
    } finally {
      if (previousBuildHash === undefined) {
        delete buildEnv.BUILD_HASH;
      } else {
        buildEnv.BUILD_HASH = previousBuildHash;
      }
    }
  });

  it('reconnect replays player_disconnected for peers in grace period', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 19/20/21 to avoid collisions with other tests.
    const p1 = await connectPlayer(19, 'ReconP1');
    const p2 = await connectPlayer(20, 'ReconP2');
    const p3 = await connectPlayer(21, 'ReconP3');

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    // Listen for game_started before joining to avoid missing it
    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    await p1Round;

    // Disconnect player 2 so the DO starts a grace timer for them
    const p1DisconnectMsg = waitForMessage(p1.ws, 'player_disconnected', 3000);
    p2.ws.close();
    const disconnectMsg = await p1DisconnectMsg;
    expect(disconnectMsg.displayName).toBe('ReconP2');

    // Disconnect player 1 and reconnect: the replay should include
    // a synthetic player_disconnected for player 2.
    p1.ws.close();

    const p1r = await connectPlayer(19, 'ReconP1');
    const reconnectGameStarted = waitForMessage(p1r.ws, 'match_started', 3000);
    const reconnectDisconnected = waitForMessage(
      p1r.ws,
      'player_disconnected',
      3000,
    );

    await reconnectGameStarted;
    const replayed = await reconnectDisconnected;
    expect(replayed.displayName).toBe('ReconP2');
    expect(typeof replayed.graceSeconds).toBe('number');
    expect(Number.isInteger(replayed.graceSeconds)).toBe(true);
    expect(replayed.graceSeconds).toBeGreaterThan(0);
    expect(replayed.graceSeconds).toBeLessThanOrEqual(15);

    p1r.ws.close();
    p3.ws.close();
  });

  it('reconnect during results phase replays game_result', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 10/11/12 to avoid collisions with other tests.
    // Give players a balance so settlement can deduct ante.
    const p1 = await connectPlayer(10, 'ResultP1', 1000);
    const p2 = await connectPlayer(11, 'ResultP2', 1000);
    const p3 = await connectPlayer(12, 'ResultP3', 1000);

    // Listen for match_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    // Listen for game_started on all players before joining
    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    const [roundStart] = await Promise.all([p1Round, p2Round, p3Round]);
    const prompt = roundStart.prompt as SchellingPrompt;

    // All players commit to the same answer with distinct salts.
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const action1 = buildPromptAction(prompt, salt1, 0);
    const action2 = buildPromptAction(prompt, salt2, 0);
    const action3 = buildPromptAction(prompt, salt3, 0);

    // Listen for phase_change (to reveal) before committing.
    // All non-forfeited players committing triggers auto-advance.
    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: action1.hash }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: action2.hash }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: action3.hash }));

    const phaseChange = await p1PhaseChange;
    expect(phaseChange.phase).toBe('reveal');

    // All players reveal. When all committed players reveal, auto-advance
    // triggers _finalizeGame which enters results phase.
    const p1Result = waitForMessage(
      p1.ws,
      'game_result',
      getGameResultTimeoutMs(prompt),
    );

    p1.ws.send(JSON.stringify(action1.reveal));
    p2.ws.send(JSON.stringify(action2.reveal));
    p3.ws.send(JSON.stringify(action3.reveal));

    // Wait for game_result to confirm we are in results phase
    const originalResult = await p1Result;
    expect(originalResult.type).toBe('game_result');

    // Disconnect player 1 and reconnect during results phase
    p1.ws.close();

    const p1r = await reconnectPlayer(10);
    const reconnectResult = waitForMessage(
      p1r.ws,
      'game_result',
      getGameResultTimeoutMs(prompt),
    );

    const replayedResult = await reconnectResult;
    expect(replayedResult.type).toBe('game_result');
    expect(replayedResult.result).toBeDefined();

    const result = replayedResult.result as Record<string, unknown>;
    expect(result.gameNum).toBe(1);
    expect(result.players).toBeDefined();

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('persists vote logs and settlement side effects to D1 after a completed game', {
    timeout: 55_000,
  }, async () => {
    const p1 = await connectPlayer(28, 'PersistP1', 1000);
    const p2 = await connectPlayer(29, 'PersistP2', 1000);
    const p3 = await connectPlayer(30, 'PersistP3', 1000);
    const players = [p1, p2, p3];

    try {
      const startedPromises = players.map((player) =>
        waitForMessage(player.ws, 'match_started', MATCH_START_TIMEOUT_MS),
      );
      const gameStartedPromises = players.map((player) =>
        waitForMessage(player.ws, 'game_started', GAME_START_TIMEOUT_MS),
      );

      await joinPlayersAndStartNow(players);

      const started = await Promise.all(startedPromises);
      const matchId = must(
        started[0]?.matchId as string | undefined,
        'Expected match id from match_started',
      );
      const gameStarted = await Promise.all(gameStartedPromises);
      const prompt = must(
        gameStarted[0]?.prompt as SchellingPrompt | undefined,
        'Expected prompt from game_started',
      );

      const beforeStats = await Promise.all(
        players.map(({ accountId }) =>
          env.DB.prepare(
            'SELECT games_played FROM player_stats WHERE account_id = ?',
          )
            .bind(accountId)
            .first<{ games_played: number | null }>(),
        ),
      );

      const salt1 = 'a'.repeat(64);
      const salt2 = 'b'.repeat(64);
      const salt3 = 'c'.repeat(64);
      const action1 = buildPromptAction(prompt, salt1, 0);
      const action2 = buildPromptAction(prompt, salt2, 0);
      const action3 = buildPromptAction(prompt, salt3, 1);

      const phaseChange = waitForMessage(p1.ws, 'phase_change', 5000);
      p1.ws.send(JSON.stringify({ type: 'commit', hash: action1.hash }));
      p2.ws.send(JSON.stringify({ type: 'commit', hash: action2.hash }));
      p3.ws.send(JSON.stringify({ type: 'commit', hash: action3.hash }));

      await phaseChange;

      const gameResult = waitForMessage(
        p1.ws,
        'game_result',
        getGameResultTimeoutMs(prompt),
      );
      p1.ws.send(JSON.stringify(action1.reveal));
      p2.ws.send(JSON.stringify(action2.reveal));
      p3.ws.send(JSON.stringify(action3.reveal));

      const result = await gameResult;
      expect(result.type).toBe('game_result');
      expect(result.result.gameNum).toBe(1);

      const voteLogRow = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM vote_logs WHERE match_id = ? AND game_number = ?',
      )
        .bind(matchId, 1)
        .first<{ count: number }>();
      expect(voteLogRow?.count ?? 0).toBe(3);

      const afterStats = await Promise.all(
        players.map(({ accountId }) =>
          env.DB.prepare(
            'SELECT games_played FROM player_stats WHERE account_id = ?',
          )
            .bind(accountId)
            .first<{ games_played: number | null }>(),
        ),
      );
      expect(afterStats).toHaveLength(beforeStats.length);
      for (let index = 0; index < afterStats.length; index += 1) {
        expect(afterStats[index]?.games_played ?? 0).toBe(
          (beforeStats[index]?.games_played ?? 0) + 1,
        );
      }
    } finally {
      for (const player of players) {
        player.ws.close();
      }
    }
  });

  it('results-phase reconnect sends remaining time, not full duration', {
    timeout: 65_000,
  }, async () => {
    const WAIT_SECONDS = 3;
    // Use wallet indices 13/14/15 to avoid collisions with other tests.
    const p1 = await connectPlayer(13, 'RemP1', 1000);
    const p2 = await connectPlayer(14, 'RemP2', 1000);
    const p3 = await connectPlayer(15, 'RemP3', 1000);

    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    const [roundStart] = await Promise.all([p1Round, p2Round, p3Round]);
    const prompt = roundStart.prompt as SchellingPrompt;

    // All players commit to the same answer.
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const action1 = buildPromptAction(prompt, salt1, 0);
    const action2 = buildPromptAction(prompt, salt2, 0);
    const action3 = buildPromptAction(prompt, salt3, 0);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: action1.hash }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: action2.hash }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: action3.hash }));

    await p1PhaseChange;

    // All players reveal to enter results phase
    const p1Result = waitForMessage(
      p1.ws,
      'game_result',
      getGameResultTimeoutMs(prompt),
    );

    p1.ws.send(JSON.stringify(action1.reveal));
    p2.ws.send(JSON.stringify(action2.reveal));
    p3.ws.send(JSON.stringify(action3.reveal));

    await p1Result;

    // Wait partway through the results phase
    await new Promise((r) => setTimeout(r, WAIT_SECONDS * 1000));

    // Disconnect and reconnect player 1
    p1.ws.close();
    const p1r = await connectPlayer(13, 'RemP1', 1000);
    const reconnectResult = await waitForMessage(p1r.ws, 'game_result', 5000);

    // The replayed resultsDuration must reflect remaining time, not the full constant
    const replayedDuration = reconnectResult.resultsDuration as number;
    expect(replayedDuration).toBeLessThan(RESULTS_DURATION);

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect during results phase replays rating tally and own rating', {
    timeout: 55_000,
  }, async () => {
    // Use wallet indices 16/17/18 to avoid collisions with other tests.
    const p1 = await connectPlayer(16, 'RatingP1', 1000);
    const p2 = await connectPlayer(17, 'RatingP2', 1000);
    const p3 = await connectPlayer(18, 'RatingP3', 1000);

    // Listen for match_started and game_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Round = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Round = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Round = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    const [roundStart] = await Promise.all([p1Round, p2Round, p3Round]);
    const prompt = roundStart.prompt as SchellingPrompt;

    // All players commit to the same answer with distinct salts.
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const action1 = buildPromptAction(prompt, salt1, 0);
    const action2 = buildPromptAction(prompt, salt2, 0);
    const action3 = buildPromptAction(prompt, salt3, 0);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: action1.hash }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: action2.hash }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: action3.hash }));

    await p1PhaseChange;

    // All players reveal to reach results phase
    const p1Result = waitForMessage(
      p1.ws,
      'game_result',
      getGameResultTimeoutMs(prompt),
    );

    p1.ws.send(JSON.stringify(action1.reveal));
    p2.ws.send(JSON.stringify(action2.reveal));
    p3.ws.send(JSON.stringify(action3.reveal));

    await p1Result;

    // Player 1 submits a "like" rating during results phase
    const p1Tally = waitForMessage(p1.ws, 'prompt_rating_tally', 3000);
    p1.ws.send(JSON.stringify({ type: 'prompt_rating', rating: 'like' }));
    const tally = await p1Tally;
    expect(tally.likes).toBe(1);
    expect(tally.dislikes).toBe(0);

    // Disconnect player 1 and reconnect during results phase
    p1.ws.close();

    const p1r = await connectPlayer(16, 'RatingP1', 1000);
    // Listen for both game_result and prompt_rating_tally on reconnect
    const reconnectResult = waitForMessage(p1r.ws, 'game_result', 5000);
    const reconnectTally = waitForMessage(p1r.ws, 'prompt_rating_tally', 5000);

    const replayedResult = await reconnectResult;
    expect(replayedResult.type).toBe('game_result');

    const replayedTally = await reconnectTally;
    expect(replayedTally.likes).toBe(1);
    expect(replayedTally.dislikes).toBe(0);
    expect(replayedTally.yourRating).toBe('like');

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  it('reconnect after a settled game replays match_started with currentBalance', {
    timeout: 90_000,
  }, async () => {
    // Use wallet indices 22/23/24 to avoid collisions with other tests.
    // Give players a balance so settlement can deduct ante.
    const STARTING_BALANCE = 1000;
    const p1 = await connectPlayer(22, 'BalP1', STARTING_BALANCE);
    const p2 = await connectPlayer(23, 'BalP2', STARTING_BALANCE);
    const p3 = await connectPlayer(24, 'BalP3', STARTING_BALANCE);

    // Listen for match_started and game_started before joining queue
    const p1Started = waitForMessage(
      p1.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p2Started = waitForMessage(
      p2.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );
    const p3Started = waitForMessage(
      p3.ws,
      'match_started',
      MATCH_START_TIMEOUT_MS,
    );

    const p1Game1 = waitForMessage(
      p1.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p2Game1 = waitForMessage(
      p2.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );
    const p3Game1 = waitForMessage(
      p3.ws,
      'game_started',
      GAME_START_TIMEOUT_MS,
    );

    await joinPlayersAndStartNow([p1, p2, p3]);

    await Promise.all([p1Started, p2Started, p3Started]);
    const [game1Start] = await Promise.all([p1Game1, p2Game1, p3Game1]);
    const prompt = game1Start.prompt as SchellingPrompt;

    // Game 1: p1 and p2 pick the same answer, p3 picks a different one.
    // This creates winners (p1, p2) and a loser (p3) so balances change.
    const salt1 = 'a'.repeat(64);
    const salt2 = 'b'.repeat(64);
    const salt3 = 'c'.repeat(64);
    const action1 = buildPromptAction(prompt, salt1, 0);
    const action2 = buildPromptAction(prompt, salt2, 0);
    const action3 = buildPromptAction(prompt, salt3, 1);

    const p1PhaseChange = waitForMessage(p1.ws, 'phase_change', 5000);

    p1.ws.send(JSON.stringify({ type: 'commit', hash: action1.hash }));
    p2.ws.send(JSON.stringify({ type: 'commit', hash: action2.hash }));
    p3.ws.send(JSON.stringify({ type: 'commit', hash: action3.hash }));

    await p1PhaseChange;

    // All reveal
    const p1Result = waitForMessage(
      p1.ws,
      'game_result',
      getGameResultTimeoutMs(prompt),
    );

    p1.ws.send(JSON.stringify(action1.reveal));
    p2.ws.send(JSON.stringify(action2.reveal));
    p3.ws.send(JSON.stringify(action3.reveal));

    const roundResult = await p1Result;
    expect(roundResult.type).toBe('game_result');

    // Wait for game 2 to start (auto-advances after RESULTS_DURATION)
    const p1Game2 = waitForMessage(p1.ws, 'game_started', 30_000);
    await p1Game2;

    // Disconnect player 1 and reconnect during game 2 commit phase
    p1.ws.close();

    const p1r = await reconnectPlayer(22);
    const reconnectGameStarted = waitForMessage(p1r.ws, 'match_started', 5000);

    const gsMsg = await reconnectGameStarted;
    expect(gsMsg.type).toBe('match_started');

    // Verify that currentBalance is present and differs from startingBalance
    // for at least one player (settlement changed balances in game 1).
    const players = gsMsg.players as Array<{
      displayName: string;
      startingBalance: number;
      currentBalance?: number;
    }>;
    const hasChangedBalance = players.some(
      (p) =>
        p.currentBalance !== undefined &&
        p.currentBalance !== p.startingBalance,
    );
    expect(hasChangedBalance).toBe(true);

    // All players should have currentBalance set
    for (const p of players) {
      expect(p.currentBalance).toBeDefined();
      expect(typeof p.currentBalance).toBe('number');
    }

    p1r.ws.close();
    p2.ws.close();
    p3.ws.close();
  });

  extendedIt(
    'runs a full 10-game lifecycle and emits match_over',
    {
      timeout: 180_000,
    },
    async () => {
      const p1 = await connectPlayer(25, 'FullP1', 100_000);
      const p2 = await connectPlayer(26, 'FullP2', 100_000);
      const p3 = await connectPlayer(27, 'FullP3', 100_000);
      const players = [p1, p2, p3];

      const matchStartedPromises = players.map((p) =>
        waitForMessage(p.ws, 'match_started', MATCH_START_TIMEOUT_MS),
      );
      let gameStartedPromises = players.map((p) =>
        waitForMessage(p.ws, 'game_started', GAME_START_TIMEOUT_MS),
      );

      await joinPlayersAndStartNow(players);

      const started = await Promise.all(matchStartedPromises);
      for (const message of started) {
        expect(message.gameCount).toBe(10);
        expect(message.matchId).toBe(started[0].matchId);
      }

      for (let gameNum = 1; gameNum <= 10; gameNum++) {
        const gameStarted = await Promise.all(gameStartedPromises);
        const prompt = gameStarted[0]?.prompt as SchellingPrompt;
        for (const message of gameStarted) {
          expect(message.game).toBe(gameNum);
          expect(message.phase).toBe('commit');
          expect(message.prompt).toEqual(prompt);
        }

        const phaseChange = waitForMessage(players[0].ws, 'phase_change', 5000);
        for (let i = 0; i < players.length; i++) {
          const salt = makeSalt(gameNum, i + 1);
          const action = buildPromptAction(prompt, salt, 0);
          players[i].ws.send(
            JSON.stringify({ type: 'commit', hash: action.hash }),
          );
        }
        const phase = await phaseChange;
        expect(phase.phase).toBe('reveal');

        const gameResult = waitForMessage(
          players[0].ws,
          'game_result',
          getGameResultTimeoutMs(prompt),
        );
        for (let i = 0; i < players.length; i++) {
          const salt = makeSalt(gameNum, i + 1);
          const action = buildPromptAction(prompt, salt, 0);
          players[i].ws.send(JSON.stringify(action.reveal));
        }

        const result = await gameResult;
        expect(result.type).toBe('game_result');
        expect(result.result.gameNum).toBe(gameNum);

        if (gameNum < 10) {
          gameStartedPromises = players.map((p) =>
            waitForMessage(p.ws, 'game_started', 15_000),
          );
        }
      }

      const matchOver = await waitForMessage(
        players[0].ws,
        'match_over',
        MATCH_OVER_TIMEOUT_MS,
      );
      expect(matchOver.type).toBe('match_over');
      expect(Array.isArray(matchOver.summary.players)).toBe(true);
      expect(matchOver.summary.players).toHaveLength(3);

      for (const player of players) {
        player.ws.close();
      }
    },
  );
});
