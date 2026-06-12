import {
  createCommitHash,
  createOpenTextCommitHash,
  validateAnswerText,
  validateHash,
  validateOptionIndex,
  validateSalt,
  verifyCommit,
  verifyOpenTextCommit,
} from '../../domain/commitReveal';
import {
  COMMIT_DURATION,
  clampTokenBalance,
  GAME_ANTE,
  MATCH_GAME_COUNT,
  MIN_ALLOWED_BALANCE,
  RESULTS_DURATION,
  REVEAL_DURATION,
} from '../../domain/constants';
import {
  canonicalizeOpenTextAnswer,
  normalizeRevealText,
} from '../../domain/openText';
import {
  getPromptRecordById,
  selectPromptsForMatch,
} from '../../domain/prompts';
import { settleGame, voidGame } from '../../domain/settlement';
import type {
  GameResult,
  NormalizationMode,
  OpenTextPrompt,
  PlayerResultWithBalance,
  PlayerSettlementInput,
  SchellingPrompt,
  SelectPrompt,
} from '../../types/domain';
import type {
  ClientMessage,
  GameResultMessage,
  QueueStateMessage,
  ServerMessage,
} from '../../types/messages';
import type { AiBinding, Env } from '../../types/worker-env';
import type {
  PersistedMatchFields,
  PersistedPlayerState,
  PlayerActionFields,
} from '../persistence';
import {
  checkpointMatch,
  checkpointPlayerAction,
  deleteMatchCheckpoint,
  initCheckpointTables,
  restoreMatchesFromStorage,
} from '../persistence';

// ---------------------------------------------------------------------------
// Local interfaces for worker-internal state
// ---------------------------------------------------------------------------

interface ConnectionState {
  ws: WebSocket;
  displayName: string;
  startNow: boolean;
  previousOpponents: Set<string>;
  lastActivityAt: number;
  livenessTimer: ReturnType<typeof setInterval> | null;
}

// UX hint against accidentally stale client bundles — NOT an auth boundary.
// A tampered client can still forge this value; the ws protocol itself is open.
const CLIENT_BUILD_HASH_RE = /^[a-f0-9]{7,40}$/;

interface WorkerPlayerState extends PersistedPlayerState {
  ws: WebSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  pendingAiCommit: boolean;
}

interface WorkerMatchState extends PersistedMatchFields {
  players: Map<string, WorkerPlayerState>;
  commitTimer: ReturnType<typeof setTimeout> | null;
  revealTimer: ReturnType<typeof setTimeout> | null;
  resultsTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  normalizingInFlight: boolean;
}

interface FormingMatchState {
  players: string[];
  timer: ReturnType<typeof setTimeout> | null;
  fillDeadlineMs: number | null;
}

interface NormalizationVerdict {
  normalizedInputText: string;
  bucketKey: string;
  bucketLabel: string;
}

interface NormalizationCandidate {
  normalizedInputText: string;
  rawAnswerText: string;
  canonicalCandidate: string;
  bucketLabelCandidate: string;
}

interface NormalizationRun {
  runId: string | null;
  mode: 'llm' | 'llm_failed' | null;
  verdicts: Map<string, NormalizationVerdict>;
  model: string | null;
  normalizerPrompt: string | null;
  requestJson: string | null;
  responseJson: string | null;
  failureReason: string | null;
}

interface PersistedVoteLogRow {
  account_id: string;
  display_name_snapshot: string | null;
  revealed_option_index: number | null;
  revealed_option_label: string | null;
  revealed_input_text: string | null;
  revealed_bucket_key: string | null;
  revealed_bucket_label: string | null;
  won_game: number;
  earns_coordination_credit: number;
  ante_amount: number;
  game_payout: number;
  net_delta: number;
  player_count: number;
  valid_reveal_count: number;
  top_count: number;
  winner_count: number;
  winning_option_indexes_json: string | null;
  winning_bucket_keys_json: string | null;
  voided: number;
  void_reason: string | null;
  normalization_mode: NormalizationMode;
}

type AiBotStructuredOutputMode =
  | 'guided_json'
  | 'response_format'
  | 'prompt_only';

function neutralizeAiAssistedResult(result: GameResult): GameResult {
  return {
    ...result,
    pot: 0,
    dustBurned: 0,
    payoutPerWinner: 0,
    players: result.players.map((player) => ({
      ...player,
      antePaid: 0,
      gamePayout: 0,
      netDelta: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FILL_TIMER_MS = 30_000;
const GRACE_DURATION_MS = 15_000;
const MAX_MATCH_SIZE = 21;
const MIN_MATCH_SIZE = 3;
const AI_BOT_TARGET_MATCH_SIZE = 5;
const STALE_MATCH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const AI_BOT_ACCOUNT_PREFIX = 'ai-bot:';
const DEFAULT_AI_BOT_MODELS = [
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwq-32b',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
const KNOWN_AI_BOT_OUTPUT_MODES = new Map<string, AiBotStructuredOutputMode>([
  ['@cf/meta/llama-3-8b-instruct', 'guided_json'],
  ['@cf/meta/llama-3.1-8b-instruct-fast', 'guided_json'],
  ['@cf/meta/llama-3.1-70b-instruct', 'guided_json'],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'guided_json'],
  ['@cf/qwen/qwq-32b', 'guided_json'],
  ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'response_format'],
]);
const DEFAULT_AI_BOT_TIMEOUT_MS = 30_000;
const AI_BOT_COMMIT_BUFFER_MS = 1500;
const AI_BOT_TEMPERATURE = 0.05;
const AI_BOT_SELECT_MAX_TOKENS = 24;
const AI_BOT_OPEN_TEXT_MAX_TOKENS = 40;
const DEFAULT_OPEN_TEXT_NORMALIZER_MODEL =
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_OPEN_TEXT_NORMALIZER_TIMEOUT_MS = 30_000;
const OPEN_TEXT_NORMALIZER_TEMPERATURE = 0;
const OPEN_TEXT_NORMALIZATION_RETRY_DELAYS_MS = [2000, 5000, 10_000];
const OPEN_TEXT_NORMALIZING_STATUS = 'Normalizing open-text answers...';
const D1_RETRY_DELAY_MS = 2000;
const WS_LIVENESS_CHECK_INTERVAL_MS = 10_000;
const WS_IDLE_TIMEOUT_MS = 35_000;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildAllowedMatchSizes(availablePlayers: number): number[] {
  const sizes: number[] = [];
  const maxAllowed = Math.min(availablePlayers, MAX_MATCH_SIZE);
  for (let size = MIN_MATCH_SIZE; size <= maxAllowed; size += 1) {
    sizes.push(size);
  }
  return sizes;
}

// ===========================================================================
// Durable Object: GameRoom (singleton Lobby)
// ===========================================================================

export class GameRoom {
  state: DurableObjectState;
  env: Env;
  configuredAiBotStructuredOutputModesCache: Map<
    string,
    AiBotStructuredOutputMode
  > | null;

  // accountId -> ConnectionState
  connections: Map<string, ConnectionState>;

  // FIFO waiting queue: array of accountId
  waitingQueue: string[];

  // Forming match state (one at a time)
  formingMatch: FormingMatchState | null;

  // Active matches: matchId -> WorkerMatchState
  activeMatches: Map<string, WorkerMatchState>;

  // Quick lookup: accountId -> matchId
  playerMatchIndex: Map<string, string>;

  buildGateDisabledWarned: boolean;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.configuredAiBotStructuredOutputModesCache = null;

    this.connections = new Map();
    this.waitingQueue = [];
    this.formingMatch = null;
    this.activeMatches = new Map();
    this.playerMatchIndex = new Map();
    this.buildGateDisabledWarned = false;

    initCheckpointTables(this.state.storage.sql);
    this._restoreMatchesFromStorage();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Non-WebSocket: return queue/match status for a player
    if (url.pathname === '/status' && request.method === 'GET') {
      const accountId = url.searchParams.get('accountId');
      const status = this._getPlayerStatus(accountId);
      return Response.json(status);
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const accountId = url.searchParams.get('accountId');
      const displayName = url.searchParams.get('displayName');
      const tokenBalance = parseInt(
        url.searchParams.get('tokenBalance') || '0',
        10,
      );
      const clientBuild = url.searchParams.get('clientBuild');

      if (!accountId || !displayName) {
        return new Response('Missing auth params', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this._handleWebSocket(
        server,
        accountId,
        displayName,
        tokenBalance,
        clientBuild,
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  _handleWebSocket(
    ws: WebSocket,
    accountId: string,
    displayName: string,
    _tokenBalance: number,
    clientBuild: string | null,
  ): void {
    ws.accept();

    // Check for reconnect to an active match
    const existingMatchId = this.playerMatchIndex.get(accountId);
    const existingConn = this.connections.get(accountId);

    if (existingConn && existingMatchId) {
      const match = this.activeMatches.get(existingMatchId);
      if (match) {
        const playerState = match.players.get(accountId);
        if (playerState && !playerState.forfeited) {
          if (playerState.disconnectedAt !== null) {
            // Reconnecting after a real disconnect during an active match.
            if (playerState.graceTimer) {
              clearTimeout(playerState.graceTimer);
              playerState.graceTimer = null;
            }
            playerState.disconnectedAt = null;
            playerState.ws = ws;
            this._clearConnectionLivenessMonitor(accountId);
            existingConn.ws = ws;
            existingConn.lastActivityAt = Date.now();
            this._checkpointPlayerAction(existingMatchId, accountId, {
              disconnectedAt: null,
            });
            this._setupWsListeners(ws, accountId);

            this._broadcastToMatch(match, {
              type: 'player_reconnected',
              displayName,
            });

            this._sendMatchStateToPlayer(match, accountId);
            return;
          }

          // Browser refresh during an active match: replace the connection
          // without creating a disconnect/reconnect lifecycle event.
          const oldWs = existingConn.ws;
          this._clearConnectionLivenessMonitor(accountId);
          existingConn.ws = ws;
          existingConn.displayName = displayName;
          existingConn.lastActivityAt = Date.now();
          playerState.ws = ws;
          this._setupWsListeners(ws, accountId);
          try {
            oldWs.close(1000, 'Replaced by new connection');
          } catch {}
          this._sendMatchStateToPlayer(match, accountId);
          return;
        }
      }
    }

    // Post-eviction reconnect: player has a restored match but no connection entry
    if (!existingConn && existingMatchId) {
      const match = this.activeMatches.get(existingMatchId);
      if (match) {
        const playerState = match.players.get(accountId);
        if (playerState && !playerState.forfeited) {
          // Create connection entry and reattach
          this.connections.set(accountId, {
            ws,
            displayName,
            startNow: false,
            previousOpponents: new Set(),
            lastActivityAt: Date.now(),
            livenessTimer: null,
          });
          if (playerState.graceTimer) {
            clearTimeout(playerState.graceTimer);
            playerState.graceTimer = null;
          }
          playerState.disconnectedAt = null;
          playerState.ws = ws;
          this._checkpointPlayerAction(existingMatchId, accountId, {
            disconnectedAt: null,
          });
          this._setupWsListeners(ws, accountId);

          this._ensureMatchTimerRunning(match);

          this._broadcastToMatch(match, {
            type: 'player_reconnected',
            displayName,
          });

          this._sendMatchStateToPlayer(match, accountId);
          return;
        }
      }
    }

    // Clean up the stale index entry so the player can re-queue, but only if
    // the match is actually gone or the player is no longer an active
    // participant in it.
    if (existingMatchId) {
      const match = this.activeMatches.get(existingMatchId);
      const playerState = match?.players.get(accountId);
      if (!match || !playerState || playerState.forfeited) {
        this.playerMatchIndex.delete(accountId);
      }
    }

    // Build-mismatch guard at the queue/forming boundary. Active-match
    // reconnects above are grandfathered (all players in a live match share a
    // build). Fresh queue joins and queue/forming reconnects must match the
    // deployed build so they cannot mix message shapes with newer clients.
    if (this.env.BUILD_HASH) {
      const clientBuildValid =
        typeof clientBuild === 'string' &&
        CLIENT_BUILD_HASH_RE.test(clientBuild);
      if (!clientBuildValid || clientBuild !== this.env.BUILD_HASH) {
        try {
          ws.close(4001, 'client build mismatch');
        } catch {}
        return;
      }
    } else if (!this.buildGateDisabledWarned) {
      // Fails open by design: rejecting everyone on a missing var would take
      // queueing down entirely. Expected unset only under `wrangler dev`.
      this.buildGateDisabledWarned = true;
      console.warn(
        'BUILD_HASH is unset: client build admission gate is disabled. ' +
          'Deploys must pass --var BUILD_HASH:<git short sha>.',
      );
    }

    const inFormingMatch =
      this.formingMatch?.players.includes(accountId) ?? false;
    const queuedConnection =
      existingConn &&
      !this.playerMatchIndex.has(accountId) &&
      (this.waitingQueue.includes(accountId) || inFormingMatch);

    if (queuedConnection) {
      const oldWs = existingConn.ws;
      this._clearConnectionLivenessMonitor(accountId);
      existingConn.ws = ws;
      existingConn.displayName = displayName;
      if (!inFormingMatch) {
        existingConn.startNow = false;
      }
      existingConn.lastActivityAt = Date.now();
      this._setupWsListeners(ws, accountId);
      try {
        oldWs.close(1000, 'Replaced by new connection');
      } catch {}
      this._syncFormingMatchFillTimer();
      this._broadcastQueueState();
      return;
    }

    // Close previous connection if any (not a match reconnect)
    if (existingConn) {
      this._clearConnectionLivenessMonitor(accountId);
      try {
        existingConn.ws.close(1000, 'Replaced by new connection');
      } catch {}
      // Remove from queue if they were queued
      this._removeFromQueue(accountId);
      this._rebalanceQueueAndForm();
    }

    this.connections.set(accountId, {
      ws,
      displayName,
      startNow: false,
      previousOpponents: existingConn
        ? existingConn.previousOpponents
        : new Set(),
      lastActivityAt: Date.now(),
      livenessTimer: null,
    });

    this._setupWsListeners(ws, accountId);

    // Send initial queue state
    this._sendQueueState(accountId);
  }

  _noteConnectionActivity(accountId: string, ws: WebSocket): void {
    const conn = this.connections.get(accountId);
    if (!conn || conn.ws !== ws) return;
    conn.lastActivityAt = Date.now();
  }

  _clearConnectionLivenessMonitor(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn?.livenessTimer) return;
    clearInterval(conn.livenessTimer);
    conn.livenessTimer = null;
  }

  _startConnectionLivenessMonitor(accountId: string, ws: WebSocket): void {
    this._clearConnectionLivenessMonitor(accountId);
    const conn = this.connections.get(accountId);
    if (!conn || conn.ws !== ws) return;
    conn.lastActivityAt = Date.now();
    conn.livenessTimer = setInterval(() => {
      const current = this.connections.get(accountId);
      if (!current || current.ws !== ws) {
        this._clearConnectionLivenessMonitor(accountId);
        return;
      }
      if (Date.now() - current.lastActivityAt < WS_IDLE_TIMEOUT_MS) return;

      this._clearConnectionLivenessMonitor(accountId);
      try {
        ws.close(4000, 'Heartbeat timeout');
      } catch {}
    }, WS_LIVENESS_CHECK_INTERVAL_MS);
  }

  _setupWsListeners(ws: WebSocket, accountId: string): void {
    this._startConnectionLivenessMonitor(accountId, ws);
    const isCurrentConnection = (): boolean =>
      this.connections.get(accountId)?.ws === ws;

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (!isCurrentConnection()) return;
      this._noteConnectionActivity(accountId, ws);
      this._waitUntil(
        (async () => {
          const raw = evt.data;
          if (typeof raw !== 'string') {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          if (
            !parsed ||
            typeof parsed !== 'object' ||
            typeof (parsed as { type?: unknown }).type !== 'string'
          ) {
            this._sendTo(accountId, {
              type: 'error',
              message: 'Invalid message payload.',
            });
            return;
          }

          try {
            await this._handleMessage(accountId, parsed as ClientMessage);
          } catch (error) {
            console.error('WebSocket message handling failed', {
              accountId,
              error,
            });
            this._sendTo(accountId, {
              type: 'error',
              message: 'Unable to process message.',
            });
          }
        })(),
        `websocket message for ${accountId}`,
      );
    });

    ws.addEventListener('close', () => {
      if (!isCurrentConnection()) return;
      this._clearConnectionLivenessMonitor(accountId);
      this._handleDisconnect(accountId);
    });

    ws.addEventListener('error', () => {
      if (!isCurrentConnection()) return;
      this._clearConnectionLivenessMonitor(accountId);
      this._handleDisconnect(accountId);
    });
  }

  // -------------------------------------------------------------------------
  // Message router
  // -------------------------------------------------------------------------

  async _handleMessage(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): Promise<void> {
    switch (msg.type) {
      case 'join_queue':
        return this._handleJoinQueue(accountId);
      case 'leave_queue':
        return this._handleLeaveQueue(accountId);
      case 'forfeit_match':
        return this._handleForfeitMatch(accountId);
      case 'set_start_now':
        return this._handleSetStartNow(accountId, msg);
      case 'commit':
        return this._handleCommit(accountId, msg);
      case 'reveal':
        return this._handleReveal(accountId, msg);
      case 'prompt_rating':
        return this._handlePromptRating(accountId, msg);
      case 'ping':
        this._sendTo(accountId, {
          type: 'pong',
          serverTime: Date.now(),
          ...(typeof msg.sentAt === 'number' ? { sentAt: msg.sentAt } : {}),
        });
        return;
      default:
        this._sendTo(accountId, {
          type: 'error',
          message: `Unknown message type: ${msg.type}`,
        });
    }
  }

  _aiBotEnabled(): boolean {
    return (
      this.env.AI_BOT_ENABLED === 'true' || this.env.AI_BOT_ENABLED === '1'
    );
  }

  _isAiBot(accountId: string): boolean {
    return accountId.startsWith(AI_BOT_ACCOUNT_PREFIX);
  }

  _createAiBotId(modelIndex: number): string {
    return `${AI_BOT_ACCOUNT_PREFIX}${modelIndex}:${crypto.randomUUID()}`;
  }

  _getBotModelIndex(accountId: string): number {
    const afterPrefix = accountId.slice(AI_BOT_ACCOUNT_PREFIX.length);
    const colonPos = afterPrefix.indexOf(':');
    if (colonPos === -1) return 0;
    return Number.parseInt(afterPrefix.slice(0, colonPos), 10) || 0;
  }

  _getAiBotModels(): string[] {
    const raw = this.env.AI_BOT_MODELS?.trim();
    if (raw) {
      const uniqueModels = [
        ...new Set(
          raw
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean),
        ),
      ];
      if (uniqueModels.length > 0) return uniqueModels;
    }
    return [...new Set(DEFAULT_AI_BOT_MODELS)];
  }

  _getAiBotBackfillModelIndexes(neededBots: number): number[] {
    const models = this._getAiBotModels();
    if (neededBots > models.length) {
      return [];
    }
    return Array.from({ length: neededBots }, (_, index) => index);
  }

  _getAiBotModel(accountId: string): string {
    const models = this._getAiBotModels();
    const index = this._getBotModelIndex(accountId);
    if (index >= 0 && index < models.length) {
      return models[index] as string;
    }
    return models[0] as string;
  }

  _getAiBotStructuredOutputMode(model: string): AiBotStructuredOutputMode {
    const configuredMode =
      this._getConfiguredAiBotStructuredOutputModes().get(model);
    if (configuredMode) {
      return configuredMode;
    }
    return KNOWN_AI_BOT_OUTPUT_MODES.get(model) ?? 'prompt_only';
  }

  _getConfiguredAiBotStructuredOutputModes(): Map<
    string,
    AiBotStructuredOutputMode
  > {
    if (this.configuredAiBotStructuredOutputModesCache) {
      return this.configuredAiBotStructuredOutputModesCache;
    }

    const configuredModes = new Map<string, AiBotStructuredOutputMode>();
    const raw = this.env.AI_BOT_MODEL_OUTPUT_MODES?.trim();
    if (!raw) {
      this.configuredAiBotStructuredOutputModesCache = configuredModes;
      return configuredModes;
    }

    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const separatorIndex = trimmed.lastIndexOf('=');
      if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
        console.warn('Ignoring malformed AI_BOT_MODEL_OUTPUT_MODES entry', {
          entry: trimmed,
        });
        continue;
      }
      const model = trimmed.slice(0, separatorIndex).trim();
      const mode = trimmed.slice(separatorIndex + 1).trim();
      if (!model) {
        console.warn(
          'Ignoring AI_BOT_MODEL_OUTPUT_MODES entry with empty model',
          { entry: trimmed },
        );
        continue;
      }
      if (
        mode !== 'guided_json' &&
        mode !== 'response_format' &&
        mode !== 'prompt_only'
      ) {
        console.warn(
          'Ignoring AI_BOT_MODEL_OUTPUT_MODES entry with invalid mode',
          {
            entry: trimmed,
            model,
            mode,
          },
        );
        continue;
      }
      configuredModes.set(model, mode);
    }

    this.configuredAiBotStructuredOutputModesCache = configuredModes;
    return configuredModes;
  }

  _openTextPromptsEnabled(): boolean {
    return (
      this.env.OPEN_TEXT_PROMPTS_ENABLED === 'true' ||
      this.env.OPEN_TEXT_PROMPTS_ENABLED === '1'
    );
  }

  _getOpenTextNormalizerModel(): string {
    const configured = this.env.OPEN_TEXT_NORMALIZER_MODEL?.trim();
    if (configured) return configured;
    return DEFAULT_OPEN_TEXT_NORMALIZER_MODEL;
  }

  _getOpenTextNormalizerTimeoutMs(): number {
    const parsed = Number.parseInt(
      this.env.OPEN_TEXT_NORMALIZER_TIMEOUT_MS || '',
      10,
    );
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_OPEN_TEXT_NORMALIZER_TIMEOUT_MS;
    }
    return parsed;
  }

  _getAiBinding(): AiBinding | null {
    try {
      return this.env.AI ?? null;
    } catch (error) {
      console.error('Workers AI binding access failed', error);
      return null;
    }
  }

  async _runWithTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(timeoutMessage)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  _previewAiOutput(output: unknown, maxLength = 240): string | null {
    const raw =
      this._extractAiResponseText(output) ??
      (() => {
        try {
          return JSON.stringify(output);
        } catch {
          return null;
        }
      })();
    if (!raw) {
      return null;
    }
    if (raw.length <= maxLength) {
      return raw;
    }
    return `${raw.slice(0, maxLength)}...`;
  }

  _getDisplayName(accountId: string): string {
    if (this._isAiBot(accountId)) {
      const model = this._getAiBotModel(accountId);
      return model.split('/').pop() || model;
    }
    return this.connections.get(accountId)?.displayName || 'unknown';
  }

  _getMatchGameAnte(match: Pick<PersistedMatchFields, 'aiAssisted'>): number {
    return match.aiAssisted ? 0 : GAME_ANTE;
  }

  _getAiBotTimeoutMs(): number {
    const parsed = Number.parseInt(this.env.AI_BOT_TIMEOUT_MS || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_AI_BOT_TIMEOUT_MS;
    }
    return parsed;
  }

  _countQueuedHumans(): number {
    let count = 0;
    for (const accountId of this.waitingQueue) {
      if (!this._isAiBot(accountId)) {
        count += 1;
      }
    }
    if (this.formingMatch) {
      for (const accountId of this.formingMatch.players) {
        if (!this._isAiBot(accountId)) {
          count += 1;
        }
      }
    }
    return count;
  }

  _getFormingHumanIds(): string[] {
    if (!this.formingMatch) return [];
    return this.formingMatch.players.filter(
      (accountId) => !this._isAiBot(accountId),
    );
  }

  _clearStartNowFlags(accountIds: string[]): void {
    for (const accountId of accountIds) {
      if (this._isAiBot(accountId)) continue;
      const conn = this.connections.get(accountId);
      if (conn) conn.startNow = false;
    }
  }

  _allFormingHumansWantStartNow(): boolean {
    const humanIds = this._getFormingHumanIds();
    if (humanIds.length === 0) return false;

    return humanIds.every(
      (accountId) => this.connections.get(accountId)?.startNow,
    );
  }

  _anyFormingHumanWantsStartNow(): boolean {
    const humanIds = this._getFormingHumanIds();
    if (humanIds.length === 0) return false;

    return humanIds.some(
      (accountId) => this.connections.get(accountId)?.startNow,
    );
  }

  _clearFormingMatchFillTimer(): void {
    if (!this.formingMatch) return;
    if (this.formingMatch.timer) {
      clearTimeout(this.formingMatch.timer);
      this.formingMatch.timer = null;
    }
    this.formingMatch.fillDeadlineMs = null;
  }

  _armFormingMatchFillTimer(): void {
    if (!this.formingMatch || this.formingMatch.timer) return;
    this.formingMatch.fillDeadlineMs = Date.now() + FILL_TIMER_MS;
    this.formingMatch.timer = setTimeout(
      () => this._onFillTimerExpired(),
      FILL_TIMER_MS,
    );
  }

  _syncFormingMatchFillTimer(): void {
    if (!this.formingMatch) return;
    if (this._anyFormingHumanWantsStartNow()) {
      this._armFormingMatchFillTimer();
      return;
    }
    this._clearFormingMatchFillTimer();
  }

  _tryStartReadyMatch(): boolean {
    if (!this.formingMatch) return false;
    if (this.formingMatch.players.length < MIN_MATCH_SIZE) return false;
    if (!this._allFormingHumansWantStartNow()) return false;

    this._startFormingMatch();
    return true;
  }

  _getQueuedAiBotIds(): string[] {
    const botIds = this.waitingQueue.filter((accountId) =>
      this._isAiBot(accountId),
    );
    if (this.formingMatch) {
      botIds.push(
        ...this.formingMatch.players.filter((accountId) =>
          this._isAiBot(accountId),
        ),
      );
    }
    return botIds;
  }

  // Adjusts AI bot count then attempts to form a match. This is the
  // standard entry point; use it instead of calling the two methods
  // separately to guarantee correct ordering.
  _rebalanceQueueAndForm(): void {
    this._ensureAiBotBackfill();
    this._tryFormMatch();
  }

  _ensureAiBotBackfill(): void {
    for (const botId of this._getQueuedAiBotIds()) {
      this._removeFromQueue(botId);
    }

    if (!this._aiBotEnabled() || !this._openTextPromptsEnabled()) {
      return;
    }
    if (!this._getAiBinding()) {
      return;
    }

    const queuedHumans = this._countQueuedHumans();
    if (queuedHumans === 0 || queuedHumans >= AI_BOT_TARGET_MATCH_SIZE) {
      return;
    }

    const neededBots = AI_BOT_TARGET_MATCH_SIZE - queuedHumans;
    const modelIndexes = this._getAiBotBackfillModelIndexes(neededBots);
    if (modelIndexes.length < neededBots) {
      return;
    }

    for (const modelIndex of modelIndexes) {
      this.waitingQueue.push(this._createAiBotId(modelIndex));
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  // -------------------------------------------------------------------------

  async _handleJoinQueue(accountId: string): Promise<void> {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    if (!this._openTextPromptsEnabled()) {
      return this._sendTo(accountId, {
        type: 'error',
        message:
          'Public matches are unavailable until open-text prompts are enabled',
      });
    }

    // Cannot join if already in a match
    if (this.playerMatchIndex.has(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Cannot join queue while in a match',
      });
    }
    // Cannot join if already queued
    if (this.waitingQueue.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already in queue',
      });
    }
    // Cannot join if in forming match
    if (this.formingMatch?.players.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already in forming match',
      });
    }

    const balance = await this._fetchAccountBalance(accountId);
    if (balance === null) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Unable to verify balance. Please try joining again.',
      });
    }

    conn.startNow = false;
    this.waitingQueue.push(accountId);
    this._rebalanceQueueAndForm();
    this._broadcastQueueState();
  }

  _handleLeaveQueue(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    conn.startNow = false;
    this._removeFromQueue(accountId);
    this._rebalanceQueueAndForm();
    this._broadcastQueueState();
  }

  _handleSetStartNow(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    if (typeof msg.value !== 'boolean') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'start_now vote must be true or false',
      });
    }

    if (!this.formingMatch?.players.includes(accountId)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Start now is only available while your match is forming',
      });
    }

    conn.startNow = msg.value;
    if (this._tryStartReadyMatch()) return;
    this._syncFormingMatchFillTimer();
    this._broadcastQueueState();
  }

  _removeFromQueue(accountId: string): void {
    // Remove from waiting queue
    const idx = this.waitingQueue.indexOf(accountId);
    if (idx !== -1) this.waitingQueue.splice(idx, 1);

    // Remove from forming match
    if (this.formingMatch) {
      const fIdx = this.formingMatch.players.indexOf(accountId);
      if (fIdx !== -1) {
        this.formingMatch.players.splice(fIdx, 1);
        // If forming group drops below 3, cancel formation
        if (this.formingMatch.players.length < MIN_MATCH_SIZE) {
          this._cancelFormingMatch();
        }
      }
    }

    this._syncFormingMatchFillTimer();
  }

  _cancelFormingMatch(): void {
    if (!this.formingMatch) return;
    this._clearFormingMatchFillTimer();

    // Return remaining players to front of queue in their existing order
    const returning = this.formingMatch.players;
    this._clearStartNowFlags(returning);
    this.waitingQueue.unshift(...returning);
    this.formingMatch = null;
  }

  _tryFormMatch(): void {
    // If there is already a forming match, try to add from queue
    if (this.formingMatch) {
      while (
        this.waitingQueue.length > 0 &&
        this.formingMatch.players.length < MAX_MATCH_SIZE
      ) {
        const nextId = this.waitingQueue.shift();
        if (nextId === undefined) break;
        this.formingMatch.players.push(nextId);
      }
      // If max reached, start immediately
      if (this.formingMatch.players.length >= MAX_MATCH_SIZE) {
        this._startFormingMatch();
      } else {
        if (!this._tryStartReadyMatch()) {
          this._syncFormingMatchFillTimer();
        }
      }
      return;
    }

    // No forming match: need at least 3 in queue to begin
    if (this.waitingQueue.length < MIN_MATCH_SIZE) return;

    // Reserve up to MAX_MATCH_SIZE players from the queue
    const reserveCount = Math.min(this.waitingQueue.length, MAX_MATCH_SIZE);
    const reserved = this.waitingQueue.splice(0, reserveCount);

    if (reserved.length >= MAX_MATCH_SIZE) {
      // Full house: start immediately
      this.formingMatch = {
        players: reserved,
        timer: null,
        fillDeadlineMs: null,
      };
      this._startFormingMatch();
      return;
    }

    // Hold the forming lobby until someone signals they are ready.
    this.formingMatch = {
      players: reserved,
      timer: null,
      fillDeadlineMs: null,
    };
    if (!this._tryStartReadyMatch()) {
      this._syncFormingMatchFillTimer();
    }
  }

  _onFillTimerExpired(): void {
    if (!this.formingMatch) return;
    this.formingMatch.timer = null;
    this.formingMatch.fillDeadlineMs = null;
    if (!this._anyFormingHumanWantsStartNow()) {
      this._broadcastQueueState();
      return;
    }
    this._startFormingMatch();
  }

  _startFormingMatch(): void {
    if (!this.formingMatch) return;
    this._clearFormingMatchFillTimer();

    const players = this.formingMatch.players;

    // Should still have at least 3
    if (players.length < MIN_MATCH_SIZE) {
      this._clearStartNowFlags(players);
      this.waitingQueue.unshift(...players);
      this.formingMatch = null;
      this._tryFormMatch();
      this._broadcastQueueState();
      return;
    }

    this._clearStartNowFlags(players);

    const matchId = crypto.randomUUID();
    this.formingMatch = null;

    this._waitUntil(
      this._startMatch(players, matchId),
      `start match ${matchId}`,
    );
    this._tryFormMatch();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Match lifecycle
  // -------------------------------------------------------------------------

  _failMatchStart(
    playerIds: string[],
    message: string,
    options: { retryMatchmaking?: boolean } = {},
  ): void {
    const returningHumans = playerIds.filter(
      (accountId) =>
        !this._isAiBot(accountId) && !this.waitingQueue.includes(accountId),
    );

    this._clearStartNowFlags(playerIds);
    if (returningHumans.length > 0) {
      this.waitingQueue.unshift(...returningHumans);
    }
    this._ensureAiBotBackfill();

    for (const accountId of playerIds) {
      if (this._isAiBot(accountId)) continue;
      this._sendTo(accountId, {
        type: 'error',
        message,
      });
    }
    if (options.retryMatchmaking) {
      this._tryFormMatch();
    }
    this._broadcastQueueState();
  }

  async _startMatch(playerIds: string[], matchId: string): Promise<void> {
    const aiAssisted = playerIds.some((id) => this._isAiBot(id));
    if (!this._openTextPromptsEnabled()) {
      this._failMatchStart(
        playerIds,
        'Public matches are unavailable until open-text prompts are enabled',
      );
      return;
    }

    let prompts: SchellingPrompt[];
    try {
      prompts = selectPromptsForMatch(MATCH_GAME_COUNT, {
        includeOpenText: true,
      });
    } catch (error) {
      this._failMatchStart(
        playerIds,
        (error as Error).message || 'Unable to start a public match',
      );
      return;
    }

    const connectedHumanIds = playerIds.filter(
      (id) => !this._isAiBot(id) && this.connections.has(id),
    );
    const balances = await Promise.all(
      connectedHumanIds.map((id) => this._fetchAccountBalance(id)),
    );
    const balanceByAccount = new Map(
      connectedHumanIds.map((id, i) => [id, balances[i]]),
    );

    const playersMap = new Map<string, WorkerPlayerState>();
    for (const accountId of playerIds) {
      let balance = 0;
      let displayName = this._getDisplayName(accountId);
      let ws: WebSocket | null = null;

      if (!this._isAiBot(accountId)) {
        const conn = this.connections.get(accountId);
        if (!conn) continue;
        displayName = conn.displayName;
        ws = conn.ws;

        balance = balanceByAccount.get(accountId) ?? 0;
      }

      playersMap.set(accountId, {
        accountId,
        displayName,
        ws,
        startingBalance: balance,
        currentBalance: balance,
        committed: false,
        revealed: false,
        hash: null,
        optionIndex: null,
        answerText: null,
        normalizedRevealText: null,
        salt: null,
        forfeited: false,
        forfeitedAtGame: null,
        disconnectedAt: null,
        graceTimer: null,
        pendingAiCommit: false,
      });

      this.playerMatchIndex.set(accountId, matchId);
    }

    if (playersMap.size < MIN_MATCH_SIZE) {
      const eligibleIds = [...playersMap.keys()];
      this._clearStartNowFlags(eligibleIds);
      for (const accountId of eligibleIds) {
        if (!this.waitingQueue.includes(accountId)) {
          this.waitingQueue.push(accountId);
        }
        this.playerMatchIndex.delete(accountId);
      }
      this._rebalanceQueueAndForm();
      this._broadcastQueueState();
      return;
    }

    const match: WorkerMatchState = {
      matchId,
      players: playersMap,
      prompts,
      currentGame: 0,
      totalGames: MATCH_GAME_COUNT,
      phase: 'starting',
      phaseEnteredAt: Date.now(),
      lastSettledGame: 0,
      commitTimer: null,
      revealTimer: null,
      resultsTimer: null,
      retryTimer: null,
      normalizingInFlight: false,
      lastGameResult: null,
      aiAssisted,
    };
    this.activeMatches.set(matchId, match);

    // Batch create match + match_players in D1
    try {
      const createStmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          'INSERT INTO matches (match_id, started_at, game_count, player_count, status, ai_assisted) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(
          matchId,
          new Date().toISOString(),
          MATCH_GAME_COUNT,
          playersMap.size,
          'active',
          match.aiAssisted ? 1 : 0,
        ),
      ];
      for (const [acctId, p] of playersMap) {
        if (this._isAiBot(acctId)) continue;
        createStmts.push(
          this.env.DB.prepare(
            'INSERT INTO match_players (match_id, account_id, display_name_snapshot, starting_balance, result) VALUES (?, ?, ?, ?, ?)',
          ).bind(matchId, acctId, p.displayName, p.startingBalance, 'active'),
        );
      }
      await this.env.DB.batch(createStmts);
    } catch (e) {
      const humanCount = [...playersMap.keys()].filter(
        (id) => !this._isAiBot(id),
      ).length;
      console.error(
        `D1: failed to insert match/match_players for ${matchId} (${humanCount} humans, ${playersMap.size} total)`,
        e,
      );
    }

    // Broadcast match_started
    const playersInfo = [...playersMap.values()].map((p) => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
    }));

    this._broadcastToMatch(match, {
      type: 'match_started',
      matchId,
      gameCount: MATCH_GAME_COUNT,
      aiAssisted: match.aiAssisted,
      players: playersInfo,
    });

    // Start game 1
    this._startCommitPhase(match);
  }

  _startCommitPhase(match: WorkerMatchState): void {
    const nextGame = match.currentGame + 1;
    const prompt = this._getPromptForGame(match, nextGame);

    match.phase = 'commit';
    match.currentGame = nextGame;
    match.phaseEnteredAt = Date.now();
    match.lastGameResult = null;
    match.normalizingInFlight = false;

    // Reset per-game player state
    for (const p of match.players.values()) {
      p.committed = false;
      p.revealed = false;
      p.hash = null;
      p.optionIndex = null;
      p.answerText = null;
      p.normalizedRevealText = null;
      p.salt = null;
      p.pendingAiCommit = false;
    }

    this._checkpointMatch(match);

    this._broadcastToMatch(match, {
      type: 'game_started',
      game: match.currentGame,
      prompt: cloneJson(prompt),
      commitDuration: COMMIT_DURATION,
      gameAnte: this._getMatchGameAnte(match),
      aiAssisted: match.aiAssisted,
      phase: 'commit',
    });

    this._maybeScheduleAiBotCommit(match);

    match.commitTimer = setTimeout(() => {
      match.commitTimer = null;
      this._startRevealPhase(match);
    }, COMMIT_DURATION * 1000);
  }

  _startRevealPhase(match: WorkerMatchState): void {
    if (match.commitTimer) {
      clearTimeout(match.commitTimer);
      match.commitTimer = null;
    }
    match.phase = 'reveal';
    match.phaseEnteredAt = Date.now();

    this._checkpointMatch(match);

    this._broadcastToMatch(match, {
      type: 'phase_change',
      phase: 'reveal',
      revealDuration: REVEAL_DURATION,
    });

    match.revealTimer = setTimeout(() => {
      match.revealTimer = null;
      this._completeRevealPhase(match);
    }, REVEAL_DURATION * 1000);

    this._autoRevealAiBots(match);
  }

  _completeRevealPhase(match: WorkerMatchState): void {
    const prompt = this._getPromptForGame(match, match.currentGame);
    if (prompt.type === 'open_text') {
      this._startNormalizingPhase(match);
      return;
    }

    this._waitUntil(
      this._finalizeGame(match),
      `finalize game ${match.currentGame} for ${match.matchId}`,
    );
  }

  _startNormalizingPhase(match: WorkerMatchState): void {
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    if (match.normalizingInFlight) {
      return;
    }

    match.phase = 'normalizing';
    match.phaseEnteredAt = Date.now();
    match.normalizingInFlight = true;

    this._checkpointMatch(match);
    this._broadcastToMatch(match, {
      type: 'phase_change',
      phase: 'normalizing',
      status: OPEN_TEXT_NORMALIZING_STATUS,
    });

    this._waitUntil(
      this._normalizeAndFinalizeOpenTextGame(match),
      `normalize game ${match.currentGame} for ${match.matchId}`,
    );
  }

  _buildSettlementInputs(
    match: WorkerMatchState,
    prompt: SchellingPrompt,
    normalizationRun: NormalizationRun | null,
  ): {
    normRun: NormalizationRun;
    result: GameResult;
  } {
    const players: PlayerSettlementInput[] = [...match.players.values()].map(
      (p) => {
        const validReveal = p.committed && p.revealed && !p.forfeited;
        const revealedOptionLabel =
          validReveal &&
          prompt.type === 'select' &&
          p.optionIndex !== null &&
          p.optionIndex >= 0 &&
          p.optionIndex < prompt.options.length
            ? (prompt.options[p.optionIndex] ?? null)
            : null;

        return {
          accountId: p.accountId,
          displayName: p.displayName,
          optionIndex: validReveal ? p.optionIndex : null,
          inputText: validReveal ? p.answerText : null,
          normalizedRevealText: validReveal ? p.normalizedRevealText : null,
          bucketKey:
            validReveal &&
            prompt.type === 'select' &&
            p.optionIndex !== null &&
            revealedOptionLabel
              ? `option:${p.optionIndex}`
              : null,
          bucketLabel:
            validReveal && prompt.type === 'select'
              ? revealedOptionLabel
              : null,
          validReveal,
          forfeited: p.forfeited,
          attached: !p.forfeited || p.forfeitedAtGame === match.currentGame,
        };
      },
    );

    const normRun = normalizationRun ?? this._buildEmptyNormalizationRun();

    let result: GameResult;
    if (prompt.type === 'open_text') {
      if (normRun.mode === 'llm_failed') {
        result = voidGame(players, 'open_text_normalization_failed');
      } else {
        for (const player of players) {
          if (!player.validReveal || !player.normalizedRevealText) continue;
          const verdict =
            normRun.verdicts.get(player.normalizedRevealText) || null;
          if (verdict) {
            player.bucketKey = verdict.bucketKey;
            player.bucketLabel = verdict.bucketLabel;
          }
        }
        result = settleGame(
          players,
          prompt,
          normRun.mode === 'llm' ? 'llm' : null,
        );
      }
    } else {
      result = settleGame(players, prompt, null);
    }

    result = match.aiAssisted ? neutralizeAiAssistedResult(result) : result;

    return { normRun, result };
  }

  _buildNormalizationD1Stmts(
    match: WorkerMatchState,
    prompt: SchellingPrompt,
    normRun: NormalizationRun,
    now: string,
  ): D1PreparedStatement[] {
    if (prompt.type !== 'open_text' || !normRun.runId) return [];

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      this.env.DB.prepare(
        'INSERT INTO normalization_runs (run_id, match_id, game_number, prompt_id, mode, model, normalizer_prompt, request_json, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        normRun.runId,
        match.matchId,
        match.currentGame,
        prompt.id,
        normRun.mode,
        normRun.model,
        normRun.normalizerPrompt,
        normRun.requestJson,
        normRun.responseJson,
        now,
      ),
    );

    for (const verdict of normRun.verdicts.values()) {
      stmts.push(
        this.env.DB.prepare(
          'INSERT INTO normalization_verdicts (run_id, match_id, game_number, prompt_id, normalized_input_text, bucket_key, bucket_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          normRun.runId,
          match.matchId,
          match.currentGame,
          prompt.id,
          verdict.normalizedInputText,
          verdict.bucketKey,
          verdict.bucketLabel,
          now,
        ),
      );
    }

    return stmts;
  }

  _buildVoteLogD1Stmts(
    match: WorkerMatchState,
    prompt: SchellingPrompt,
    result: GameResult,
    normRun: NormalizationRun,
    projectedBalances: Map<string, number>,
    now: string,
  ): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [];

    for (const pr of result.players) {
      const projectedBalance = projectedBalances.get(pr.accountId);
      if (projectedBalance === undefined) continue;

      if (!this._isAiBot(pr.accountId)) {
        if (!match.aiAssisted) {
          stmts.push(
            this.env.DB.prepare(
              'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
            ).bind(projectedBalance, pr.accountId),
          );
        }

        if (!result.voided && !match.aiAssisted) {
          stmts.push(
            this.env.DB.prepare(
              'UPDATE player_stats SET games_played = games_played + 1 WHERE account_id = ?',
            ).bind(pr.accountId),
          );
          if (pr.earnsCoordinationCredit) {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET coherent_games = coherent_games + 1, ' +
                  'current_streak = current_streak + 1, ' +
                  'longest_streak = MAX(longest_streak, current_streak + 1) ' +
                  'WHERE account_id = ?',
              ).bind(pr.accountId),
            );
          } else {
            stmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET current_streak = 0 WHERE account_id = ?',
              ).bind(pr.accountId),
            );
          }
        }
      }

      if (!this._isAiBot(pr.accountId)) {
        stmts.push(
          this.env.DB.prepare(
            'INSERT INTO vote_logs (match_id, game_number, prompt_id, account_id, display_name_snapshot, ' +
              'prompt_type, revealed_option_index, revealed_option_label, revealed_input_text, ' +
              'revealed_bucket_key, revealed_bucket_label, normalization_mode, normalization_run_id, ' +
              'won_game, earns_coordination_credit, ante_amount, game_payout, net_delta, player_count, ' +
              'valid_reveal_count, top_count, winner_count, winning_option_indexes_json, ' +
              'winning_bucket_keys_json, voided, void_reason, timestamp) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).bind(
            match.matchId,
            match.currentGame,
            prompt.id,
            pr.accountId,
            pr.displayName,
            prompt.type,
            pr.revealedOptionIndex,
            pr.revealedOptionLabel,
            pr.revealedInputText,
            pr.revealedBucketKey,
            pr.revealedBucketLabel,
            result.normalizationMode,
            normRun.runId,
            pr.wonGame ? 1 : 0,
            pr.earnsCoordinationCredit ? 1 : 0,
            pr.antePaid,
            pr.gamePayout,
            pr.netDelta,
            result.playerCount,
            result.validRevealCount,
            result.topCount,
            result.winnerCount,
            JSON.stringify(result.winningOptionIndexes),
            JSON.stringify(result.winningBucketKeys),
            result.voided ? 1 : 0,
            result.voidReason,
            now,
          ),
        );
      }
    }

    return stmts;
  }

  _buildGameResultPayload(
    match: WorkerMatchState,
    result: GameResult,
  ): GameResultMessage['result'] {
    return {
      gameNum: match.currentGame,
      voided: result.voided,
      voidReason: result.voidReason,
      playerCount: result.playerCount,
      pot: result.pot,
      dustBurned: result.dustBurned,
      validRevealCount: result.validRevealCount,
      topCount: result.topCount,
      winningOptionIndexes: result.winningOptionIndexes,
      winningBucketKeys: result.winningBucketKeys,
      winnerCount: result.winnerCount,
      payoutPerWinner: result.payoutPerWinner,
      normalizationMode: result.normalizationMode,
      players: result.players.map((pr) => ({
        accountId: pr.accountId,
        displayName: pr.displayName,
        revealedOptionIndex: pr.revealedOptionIndex,
        revealedOptionLabel: pr.revealedOptionLabel,
        revealedInputText: pr.revealedInputText,
        revealedBucketKey: pr.revealedBucketKey,
        revealedBucketLabel: pr.revealedBucketLabel,
        wonGame: pr.wonGame,
        earnsCoordinationCredit: pr.earnsCoordinationCredit,
        antePaid: pr.antePaid,
        gamePayout: pr.gamePayout,
        netDelta: pr.netDelta,
        newBalance:
          match.players.get(pr.accountId)?.currentBalance ??
          (pr as PlayerResultWithBalance).newBalance,
      })),
    };
  }

  async _finalizeGame(
    match: WorkerMatchState,
    normalizationRun: NormalizationRun | null = null,
  ): Promise<void> {
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    match.normalizingInFlight = false;
    if (match.resultsTimer) {
      clearTimeout(match.resultsTimer);
      match.resultsTimer = null;
    }
    if (match.retryTimer) {
      clearTimeout(match.retryTimer);
      match.retryTimer = null;
    }
    const prompt = this._getPromptForGame(match, match.currentGame);
    const recoveringSettlingWrite =
      match.phase === 'settling' && match.currentGame > match.lastSettledGame;
    const alreadySettled =
      match.currentGame <= match.lastSettledGame && !recoveringSettlingWrite;

    let recoveredGameResult: GameResultMessage['result'] | null = null;
    let persistedVoteLogs: boolean | null = null;

    if (recoveringSettlingWrite) {
      if (!match.aiAssisted) {
        try {
          recoveredGameResult = await this._loadPersistedGameResult(match);
          persistedVoteLogs = recoveredGameResult !== null;
        } catch (error) {
          console.error(
            'D1: failed to load persisted game result for',
            match.matchId,
            error,
          );
          this._checkpointMatch(match);
          this._scheduleFinalizeRetry(match);
          return;
        }
      } else {
        persistedVoteLogs =
          await this._hasPersistedVoteLogsForCurrentGame(match);
        if (persistedVoteLogs === null) {
          this._checkpointMatch(match);
          this._scheduleFinalizeRetry(match);
          return;
        }
      }
    }

    let result: GameResult | null = null;

    if (recoveredGameResult) {
      for (const recoveredPlayer of recoveredGameResult.players) {
        const playerState = match.players.get(recoveredPlayer.accountId);
        if (!playerState) continue;
        playerState.currentBalance = recoveredPlayer.newBalance;
      }
      match.lastSettledGame = match.currentGame;
    } else {
      let effectiveNormalizationRun = normalizationRun;
      if (prompt.type === 'open_text' && normalizationRun === null) {
        effectiveNormalizationRun = await this._normalizeOpenTextReveals(
          prompt,
          this._collectOpenTextNormalizationCandidates(match, prompt),
        );
      }

      const settled = this._buildSettlementInputs(
        match,
        prompt,
        effectiveNormalizationRun,
      );
      result = settled.result;
      const normRun = settled.normRun;

      const projectedBalances = new Map<string, number>();
      const shouldProjectSettledBalances =
        !alreadySettled || recoveringSettlingWrite;

      for (const pr of result.players) {
        const playerState = match.players.get(pr.accountId);
        if (!playerState) continue;
        let projectedBalance =
          playerState.currentBalance +
          (shouldProjectSettledBalances ? pr.netDelta : 0);
        if (!match.aiAssisted && projectedBalance < MIN_ALLOWED_BALANCE) {
          projectedBalance = MIN_ALLOWED_BALANCE;
        }
        projectedBalances.set(pr.accountId, projectedBalance);
        (pr as PlayerResultWithBalance).newBalance = projectedBalance;
      }

      if (!alreadySettled) {
        let shouldWriteGame = true;
        if (recoveringSettlingWrite) {
          if (persistedVoteLogs === null) {
            persistedVoteLogs =
              await this._hasPersistedVoteLogsForCurrentGame(match);
          }
          if (persistedVoteLogs === null) {
            this._checkpointMatch(match);
            this._scheduleFinalizeRetry(match);
            return;
          }
          shouldWriteGame = !persistedVoteLogs;
        }

        if (shouldWriteGame) {
          match.phase = 'settling';
          match.phaseEnteredAt = Date.now();
          this._checkpointMatch(match);

          const now = new Date().toISOString();
          const stmts: D1PreparedStatement[] = [
            ...this._buildNormalizationD1Stmts(match, prompt, normRun, now),
            ...this._buildVoteLogD1Stmts(
              match,
              prompt,
              result,
              normRun,
              projectedBalances,
              now,
            ),
          ];

          if (stmts.length > 0) {
            try {
              await this.env.DB.batch(stmts);
            } catch (error) {
              console.error('D1: batch finalizeGame for', match.matchId, error);
              this._checkpointMatch(match);
              this._scheduleFinalizeRetry(match);
              return;
            }
          }
        }

        for (const [accountId, projectedBalance] of projectedBalances) {
          const playerState = match.players.get(accountId);
          if (!playerState) continue;
          playerState.currentBalance = projectedBalance;
        }
        match.lastSettledGame = match.currentGame;
      }
    }

    match.phase = 'results';
    match.phaseEnteredAt = Date.now();

    let gameResultPayload: GameResultMessage['result'];
    if (recoveredGameResult) {
      gameResultPayload = recoveredGameResult;
    } else {
      if (!result) {
        throw new Error(
          `Missing game result for ${match.matchId}:${match.currentGame}`,
        );
      }
      gameResultPayload = this._buildGameResultPayload(match, result);
    }
    match.lastGameResult = gameResultPayload;

    this._checkpointMatch(match);

    this._broadcastToMatch(match, {
      type: 'game_result',
      resultsDuration: RESULTS_DURATION,
      result: gameResultPayload,
    });

    if (!this._hasNonForfeitedPlayers(match)) {
      match.resultsTimer = setTimeout(() => {
        match.resultsTimer = null;
        this._waitUntil(this._endMatch(match), `end match ${match.matchId}`);
      }, RESULTS_DURATION * 1000);
      return;
    }

    match.resultsTimer = setTimeout(() => {
      match.resultsTimer = null;
      this._advanceAfterResults(match);
    }, RESULTS_DURATION * 1000);
  }

  async _endMatch(match: WorkerMatchState): Promise<void> {
    match.lastGameResult = null;
    if (match.resultsTimer) {
      clearTimeout(match.resultsTimer);
      match.resultsTimer = null;
    }
    if (match.retryTimer) {
      clearTimeout(match.retryTimer);
      match.retryTimer = null;
    }
    if (match.commitTimer) {
      clearTimeout(match.commitTimer);
      match.commitTimer = null;
    }
    if (match.revealTimer) {
      clearTimeout(match.revealTimer);
      match.revealTimer = null;
    }
    for (const player of match.players.values()) {
      if (player.graceTimer) {
        clearTimeout(player.graceTimer);
        player.graceTimer = null;
      }
    }
    match.phase = 'ending';
    match.phaseEnteredAt = Date.now();
    this._checkpointMatch(match);

    const summary = {
      players: [...match.players.values()].map((p) => ({
        displayName: p.displayName,
        startingBalance: p.startingBalance,
        endingBalance: p.currentBalance,
        netDelta: p.currentBalance - p.startingBalance,
        result: p.forfeited ? ('forfeited' as const) : ('completed' as const),
      })),
    };

    const alreadyCompletedInD1 = await this._isMatchAlreadyCompleted(
      match.matchId,
    );
    if (alreadyCompletedInD1 === null) {
      this._checkpointMatch(match);
      this._scheduleEndMatchRetry(match);
      return;
    }

    if (!alreadyCompletedInD1) {
      // Batch all endMatch D1 writes
      try {
        const endStmts: D1PreparedStatement[] = [
          this.env.DB.prepare(
            'UPDATE matches SET ended_at = ?, status = ? WHERE match_id = ?',
          ).bind(new Date().toISOString(), 'completed', match.matchId),
        ];

        for (const p of match.players.values()) {
          if (this._isAiBot(p.accountId)) continue;

          if (!match.aiAssisted) {
            endStmts.push(
              this.env.DB.prepare(
                'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
              ).bind(p.currentBalance, p.accountId),
            );
          }

          endStmts.push(
            this.env.DB.prepare(
              'UPDATE match_players SET ending_balance = ?, net_delta = ?, result = ? WHERE match_id = ? AND account_id = ?',
            ).bind(
              p.currentBalance,
              p.currentBalance - p.startingBalance,
              p.forfeited ? 'forfeited' : 'completed',
              match.matchId,
              p.accountId,
            ),
          );

          if (!match.aiAssisted) {
            endStmts.push(
              this.env.DB.prepare(
                'UPDATE player_stats SET matches_played = matches_played + 1 WHERE account_id = ?',
              ).bind(p.accountId),
            );
          }
        }

        await this.env.DB.batch(endStmts);
      } catch (error) {
        console.error('D1: endMatch writes for', match.matchId, error);
        this._checkpointMatch(match);
        this._scheduleEndMatchRetry(match);
        return;
      }
    }

    match.phase = 'ended';

    this._broadcastToMatch(match, {
      type: 'match_over',
      aiAssisted: match.aiAssisted,
      summary,
    });

    // Track opponents for anti-repeat
    const matchPlayerIds = [...match.players.keys()];
    for (const accountId of matchPlayerIds) {
      const conn = this.connections.get(accountId);
      if (conn) {
        conn.previousOpponents = new Set(
          matchPlayerIds.filter((id) => id !== accountId && !this._isAiBot(id)),
        );
      }
    }

    // Clean up match after persistence is confirmed.
    this.activeMatches.delete(match.matchId);
    for (const accountId of matchPlayerIds) {
      if (this.playerMatchIndex.get(accountId) === match.matchId) {
        this.playerMatchIndex.delete(accountId);
      }
    }
    this._deleteMatchCheckpoint(match.matchId);

    this._rebalanceQueueAndForm();
    this._broadcastQueueState();
  }

  // -------------------------------------------------------------------------
  // Commit / Reveal handlers
  // -------------------------------------------------------------------------

  _maybeScheduleAiBotCommit(match: WorkerMatchState): void {
    for (const player of match.players.values()) {
      if (
        !this._isAiBot(player.accountId) ||
        player.forfeited ||
        player.committed ||
        player.pendingAiCommit
      ) {
        continue;
      }
      this._waitUntil(
        this._commitAiBotChoice(match, player.accountId),
        `AI bot commit for ${player.accountId} in ${match.matchId}`,
      );
    }
  }

  async _commitAiBotChoice(
    match: WorkerMatchState,
    accountId: string,
  ): Promise<void> {
    const player = match.players.get(accountId);
    if (
      !player ||
      !this._isAiBot(accountId) ||
      player.forfeited ||
      player.committed ||
      player.pendingAiCommit ||
      match.phase !== 'commit'
    ) {
      return;
    }

    const prompt = this._getPromptForGame(match, match.currentGame);
    const gameAtDispatch = match.currentGame;

    player.pendingAiCommit = true;
    try {
      if (prompt.type === 'select') {
        const optionIndex = await this._selectAiBotOption(
          match,
          prompt,
          accountId,
        );
        if (optionIndex === null) {
          return;
        }
        if (
          match.phase !== 'commit' ||
          match.currentGame !== gameAtDispatch ||
          player.forfeited ||
          player.committed
        ) {
          return;
        }

        if (!validateOptionIndex(optionIndex, prompt.options.length)) {
          return;
        }
        const salt = this._createAiBotSalt();
        const hash = createCommitHash(optionIndex, salt);

        player.committed = true;
        player.hash = hash;
        player.optionIndex = optionIndex;
        player.answerText = null;
        player.normalizedRevealText = null;
        player.salt = salt;
        this._checkpointPlayerAction(match.matchId, accountId, {
          committed: true,
          hash,
          optionIndex,
          answerText: null,
          normalizedRevealText: null,
          salt,
        });
      } else {
        const answerText = await this._selectAiBotOpenTextAnswer(
          match,
          prompt,
          accountId,
        );
        if (answerText === null) {
          return;
        }
        if (
          match.phase !== 'commit' ||
          match.currentGame !== gameAtDispatch ||
          player.forfeited ||
          player.committed
        ) {
          return;
        }

        const canonicalAnswer = canonicalizeOpenTextAnswer(answerText, prompt);
        if (!canonicalAnswer) {
          throw new Error('AI bot open-text answer failed canonicalization');
        }
        const salt = this._createAiBotSalt();
        const hash = createOpenTextCommitHash(answerText, salt, prompt);

        player.committed = true;
        player.hash = hash;
        player.optionIndex = null;
        player.answerText = answerText;
        player.normalizedRevealText = null;
        player.salt = salt;
        this._checkpointPlayerAction(match.matchId, accountId, {
          committed: true,
          hash,
          optionIndex: null,
          answerText,
          normalizedRevealText: null,
          salt,
        });
      }

      if (
        match.phase === 'commit' &&
        match.currentGame === gameAtDispatch &&
        match.players.get(accountId) === player &&
        player.committed
      ) {
        this._broadcastCommitStatus(match);

        if (this._allNonForfeitedCommitted(match)) {
          this._startRevealPhase(match);
        }
      }
    } finally {
      if (
        match.currentGame === gameAtDispatch &&
        match.players.get(accountId) === player
      ) {
        player.pendingAiCommit = false;
      }
    }
  }

  async _selectAiBotOption(
    match: WorkerMatchState,
    prompt: SchellingPrompt,
    accountId: string,
  ): Promise<number | null> {
    if (prompt.type !== 'select') {
      throw new Error('AI bot selection requires a select prompt');
    }

    const ai = this._getAiBinding();
    if (!ai) {
      return null;
    }

    const elapsedMs = Date.now() - match.phaseEnteredAt;
    const remainingCommitMs =
      COMMIT_DURATION * 1000 - elapsedMs - AI_BOT_COMMIT_BUFFER_MS;
    const timeoutMs = Math.min(this._getAiBotTimeoutMs(), remainingCommitMs);

    if (timeoutMs <= 0) {
      return null;
    }

    const model = this._getAiBotModel(accountId);

    try {
      const output = await this._runWithTimeout(
        ai.run(model, this._buildAiBotOptionRequest(model, prompt)),
        timeoutMs,
        'AI bot commit timed out',
      );

      const parsedIndex = this._parseAiBotOptionIndex(output, prompt);
      if (parsedIndex !== null) {
        return parsedIndex;
      }
      const outputPreview = this._previewAiOutput(output);
      if (outputPreview) {
        console.warn('Workers AI bot option output was unparseable', {
          model,
          outputPreview,
        });
      }
    } catch (error) {
      console.error('Workers AI bot inference failed', error);
    }

    return null;
  }

  async _selectAiBotOpenTextAnswer(
    match: WorkerMatchState,
    prompt: OpenTextPrompt,
    accountId: string,
  ): Promise<string | null> {
    const ai = this._getAiBinding();
    if (!ai) {
      return null;
    }

    const elapsedMs = Date.now() - match.phaseEnteredAt;
    const remainingCommitMs =
      COMMIT_DURATION * 1000 - elapsedMs - AI_BOT_COMMIT_BUFFER_MS;
    const timeoutMs = Math.min(this._getAiBotTimeoutMs(), remainingCommitMs);

    if (timeoutMs <= 0) {
      return null;
    }

    const model = this._getAiBotModel(accountId);

    try {
      const output = await this._runWithTimeout(
        ai.run(model, this._buildAiBotOpenTextRequest(model, prompt)),
        timeoutMs,
        'AI bot commit timed out',
      );

      const parsedAnswer = this._parseAiBotAnswerText(output, prompt);
      if (parsedAnswer !== null) {
        return parsedAnswer;
      }
      const outputPreview = this._previewAiOutput(output);
      if (outputPreview) {
        console.warn('Workers AI bot open-text output was unparseable', {
          model,
          outputPreview,
        });
      }
    } catch (error) {
      console.error('Workers AI bot inference failed', error);
    }

    return null;
  }

  _buildAiBotOptionRequest(model: string, prompt: SelectPrompt) {
    const basePayload: Record<string, unknown> = {
      prompt: this._buildAiBotPrompt(prompt),
      max_tokens: AI_BOT_SELECT_MAX_TOKENS,
      temperature: AI_BOT_TEMPERATURE,
    };
    const structuredOutputMode = this._getAiBotStructuredOutputMode(model);
    if (structuredOutputMode === 'prompt_only') {
      return basePayload;
    }
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['optionIndex'],
      properties: {
        optionIndex: {
          type: 'integer',
          minimum: 0,
          maximum: prompt.options.length - 1,
        },
      },
    };
    return {
      ...basePayload,
      ...(structuredOutputMode === 'guided_json'
        ? { guided_json: schema }
        : {
            response_format: {
              type: 'json_schema',
              json_schema: schema,
            },
          }),
    };
  }

  _buildAiBotOpenTextRequest(model: string, prompt: OpenTextPrompt) {
    const basePayload: Record<string, unknown> = {
      prompt: this._buildAiBotPrompt(prompt),
      max_tokens: AI_BOT_OPEN_TEXT_MAX_TOKENS,
      temperature: AI_BOT_TEMPERATURE,
    };
    const structuredOutputMode = this._getAiBotStructuredOutputMode(model);
    if (structuredOutputMode === 'prompt_only') {
      return basePayload;
    }
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['answerText'],
      properties: {
        answerText: {
          type: 'string',
          minLength: 1,
          maxLength: prompt.maxLength,
        },
      },
    };
    return {
      ...basePayload,
      ...(structuredOutputMode === 'guided_json'
        ? { guided_json: schema }
        : {
            response_format: {
              type: 'json_schema',
              json_schema: schema,
            },
          }),
    };
  }

  _buildAiBotPrompt(prompt: SchellingPrompt): string {
    const backfillProfile = this._getAiBackfillProfile(prompt);
    const hintLines = backfillProfile
      ? [
          '',
          'Focality hints:',
          ...backfillProfile.promptHints.map((hint) => `- ${hint}`),
        ]
      : [];

    if (prompt.type !== 'select') {
      const answerSpecLine = (() => {
        switch (prompt.answerSpec.kind) {
          case 'integer_range':
            return `Answer with a whole number from ${prompt.answerSpec.min} to ${prompt.answerSpec.max}.`;
          case 'playing_card':
            return 'Answer with one playing card, such as "Ace of Spades" or "10 of Hearts".';
          case 'single_word':
            return 'Answer with exactly one word.';
          default:
            return 'Answer with one short text response.';
        }
      })();
      const exampleLines =
        prompt.canonicalExamples && prompt.canonicalExamples.length > 0
          ? [
              '',
              'Valid examples:',
              ...prompt.canonicalExamples.map((x) => `- ${x}`),
            ]
          : [];
      return [
        'You are filling one seat in a multiplayer coordination game.',
        'Choose the answer you expect the most human players in this match to give.',
        "Base the choice on an ordinary player's first instinct, not your personal preference.",
        'Prefer the answer that feels culturally prominent and familiar to a typical person, not one that is merely frequent in text.',
        'Prefer the most common, boring, mainstream answer over a clever, surprising, or contrarian one.',
        'Do not explain your reasoning.',
        '',
        `Game prompt: ${prompt.text}`,
        answerSpecLine,
        `Keep the answer within ${prompt.maxLength} characters.`,
        ...hintLines,
        ...exampleLines,
        '',
        'Respond with JSON only: {"answerText": "<answer>"}',
      ].join('\n');
    }

    const options = prompt.options
      .map((option, index) => `${index}: ${option}`)
      .join('\n');
    return [
      'You are filling one seat in a multiplayer coordination game.',
      'Choose the option you expect the most human players in this match to choose.',
      "Base the choice on an ordinary player's first instinct, not your personal preference.",
      'Prefer the option that feels culturally prominent and familiar to a typical person, not one that is merely frequent in text.',
      'Prefer the most common, boring, mainstream answer over a clever, surprising, or contrarian one.',
      'Do not explain your reasoning.',
      '',
      `Game prompt: ${prompt.text}`,
      'Options:',
      options,
      ...hintLines,
      '',
      'Respond with JSON only: {"optionIndex": <zero-based index>}',
    ].join('\n');
  }

  _getAiBackfillProfile(prompt: SchellingPrompt) {
    return getPromptRecordById(prompt.id)?.aiBackfill ?? null;
  }

  _parseAiBotOptionIndex(
    output: unknown,
    prompt: SchellingPrompt,
  ): number | null {
    if (prompt.type !== 'select') {
      return null;
    }
    const parsed = this._parseAiResponseObject(output);
    if (
      parsed &&
      validateOptionIndex(parsed.optionIndex, prompt.options.length)
    ) {
      return parsed.optionIndex;
    }

    const response = this._extractAiResponseText(output);

    if (!response) {
      return null;
    }

    // Defense-in-depth: guided_json should guarantee structured output,
    // but some models silently ignore the constraint. These branches
    // catch plain-text responses like "Pizza" or "2".
    const exactOptionIndex = prompt.options.findIndex(
      (option) => option.toLowerCase() === response.toLowerCase(),
    );
    if (exactOptionIndex !== -1) {
      return exactOptionIndex;
    }

    const numericMatch = response.match(/-?\d+/);
    if (!numericMatch) {
      return null;
    }

    const parsedIndex = Number.parseInt(numericMatch[0], 10);
    if (!validateOptionIndex(parsedIndex, prompt.options.length)) {
      return null;
    }
    return parsedIndex;
  }

  _parseAiBotAnswerText(
    output: unknown,
    prompt: OpenTextPrompt,
  ): string | null {
    const parsed = this._parseAiResponseObject(output);
    if (
      parsed &&
      validateAnswerText(parsed.answerText, prompt) &&
      canonicalizeOpenTextAnswer(parsed.answerText, prompt)
    ) {
      return parsed.answerText;
    }

    const response = this._extractAiResponseText(output);
    if (!response) {
      return null;
    }

    const strippedResponse = response
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
      .replace(/^"(.*)"$/s, '$1');
    if (
      validateAnswerText(strippedResponse, prompt) &&
      canonicalizeOpenTextAnswer(strippedResponse, prompt)
    ) {
      return strippedResponse;
    }

    return null;
  }

  _createAiBotSalt(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  _extractAiResponseText(output: unknown): string | null {
    const responseValue = this._extractAiResponseValue(output);
    if (typeof responseValue === 'string') {
      return responseValue;
    }
    if (responseValue === null) {
      return null;
    }
    try {
      return JSON.stringify(responseValue);
    } catch {
      return null;
    }
  }

  _extractAiResponseValue(output: unknown): unknown | null {
    if (typeof output === 'string') {
      return output.trim() || null;
    }
    if (typeof output === 'object' && output !== null && 'response' in output) {
      const response = output.response;
      if (typeof response === 'string') {
        return response.trim() || null;
      }
      if (response !== undefined && response !== null) {
        return response;
      }
    }
    if (
      typeof output === 'object' &&
      output !== null &&
      'choices' in output &&
      Array.isArray(output.choices)
    ) {
      const firstChoice = output.choices[0];
      if (typeof firstChoice === 'object' && firstChoice !== null) {
        if ('text' in firstChoice && typeof firstChoice.text === 'string') {
          return firstChoice.text.trim() || null;
        }
        if (
          'message' in firstChoice &&
          typeof firstChoice.message === 'object' &&
          firstChoice.message !== null &&
          'content' in firstChoice.message
        ) {
          const content = firstChoice.message.content;
          if (typeof content === 'string') {
            return content.trim() || null;
          }
          if (Array.isArray(content)) {
            const joined = content
              .map((part) =>
                typeof part === 'object' &&
                part !== null &&
                'text' in part &&
                typeof part.text === 'string'
                  ? part.text
                  : '',
              )
              .join('')
              .trim();
            return joined || null;
          }
        }
      }
    }
    return null;
  }

  _extractFirstJsonObject(response: string): string | null {
    let start = response.indexOf('{');
    while (start !== -1) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < response.length; index += 1) {
        const char = response[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) {
          continue;
        }
        if (char === '{') {
          depth += 1;
          continue;
        }
        if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            return response.slice(start, index + 1);
          }
        }
      }
      start = response.indexOf('{', start + 1);
    }
    return null;
  }

  _parseAiResponseObject(output: unknown): Record<string, unknown> | null {
    const responseValue = this._extractAiResponseValue(output);
    if (!responseValue) {
      return null;
    }
    if (typeof responseValue === 'object' && !Array.isArray(responseValue)) {
      return responseValue as Record<string, unknown>;
    }
    if (typeof responseValue !== 'string') {
      return null;
    }

    const strippedResponse = responseValue
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!strippedResponse) {
      return null;
    }

    try {
      const parsed = JSON.parse(strippedResponse);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {}

    const jsonObject = this._extractFirstJsonObject(strippedResponse);
    if (!jsonObject) {
      return null;
    }
    try {
      const parsed = JSON.parse(jsonObject);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {}

    return null;
  }

  _buildEmptyNormalizationRun(): NormalizationRun {
    return {
      runId: null,
      mode: null,
      verdicts: new Map(),
      model: null,
      normalizerPrompt: null,
      requestJson: null,
      responseJson: null,
      failureReason: null,
    };
  }

  _buildOpenTextNormalizationPrompt(
    prompt: OpenTextPrompt,
    candidates: NormalizationCandidate[],
  ): string {
    const answerSpecKind = prompt.answerSpec?.kind || 'free_text';
    const exampleLines =
      prompt.canonicalExamples && prompt.canonicalExamples.length > 0
        ? [
            '',
            'Canonical examples for this prompt:',
            ...prompt.canonicalExamples.map(
              (example, index) => `${index + 1}. ${example}`,
            ),
          ]
        : [];

    return [
      'You are normalizing open-text answers for a Schelling coordination game.',
      'Your job is to decide when players are signaling the same underlying answer.',
      'Merge only when the intended answer is genuinely the same.',
      'You may merge spelling variants, abbreviations, suit symbols, numeral-vs-word forms, and standard aliases.',
      'Do not merge nearby-but-different places, categories, concepts, or objects.',
      'Return one verdict for each normalizedInputText exactly once.',
      '',
      `Game prompt: ${prompt.text}`,
      `Answer spec: ${answerSpecKind}`,
      ...exampleLines,
      '',
      'Unique normalized player answers:',
      ...candidates.map(
        (candidate, index) =>
          `${index + 1}. normalizedInputText=${JSON.stringify(candidate.normalizedInputText)} | rawAnswerText=${JSON.stringify(candidate.rawAnswerText)} | canonicalCandidate=${JSON.stringify(candidate.canonicalCandidate)} | bucketLabelCandidate=${JSON.stringify(candidate.bucketLabelCandidate)}`,
      ),
      '',
      'For each entry, choose a short human-readable bucketLabel.',
      'If canonicalCandidate or bucketLabelCandidate already captures the intended answer, prefer it.',
      'If two inputs are not clearly the same intended answer, keep them in separate buckets.',
    ].join('\n');
  }

  _buildBucketKey(bucketLabel: string): string | null {
    const normalized = normalizeRevealText(bucketLabel);
    return normalized || null;
  }

  _parseNormalizationVerdicts(
    output: unknown,
    candidates: NormalizationCandidate[],
  ): Map<string, NormalizationVerdict> | null {
    const parsed = this._parseAiResponseObject(output) as {
      verdicts?: Array<{
        normalizedInputText?: unknown;
        bucketLabel?: unknown;
      }>;
    } | null;
    if (!parsed || !Array.isArray(parsed.verdicts)) {
      return null;
    }

    const expectedInputs = new Set(
      candidates.map((candidate) => candidate.normalizedInputText),
    );
    const verdicts = new Map<string, NormalizationVerdict>();

    for (const verdict of parsed.verdicts) {
      if (
        !verdict ||
        typeof verdict.normalizedInputText !== 'string' ||
        typeof verdict.bucketLabel !== 'string'
      ) {
        return null;
      }

      const normalizedInputText = verdict.normalizedInputText.trim();
      const bucketLabel = verdict.bucketLabel.trim();
      const bucketKey = this._buildBucketKey(bucketLabel);

      if (
        !normalizedInputText ||
        !bucketLabel ||
        !bucketKey ||
        !expectedInputs.has(normalizedInputText) ||
        verdicts.has(normalizedInputText)
      ) {
        return null;
      }

      verdicts.set(normalizedInputText, {
        normalizedInputText,
        bucketKey,
        bucketLabel,
      });
    }

    if (verdicts.size !== expectedInputs.size) {
      return null;
    }

    for (const normalizedInputText of expectedInputs) {
      if (!verdicts.has(normalizedInputText)) {
        return null;
      }
    }

    return verdicts;
  }

  _buildFailedNormalizationRun(
    runId: string,
    model: string,
    normalizerPrompt: string,
    requestPayload: Record<string, unknown>,
    attemptLog: unknown[],
    failureReason: string,
  ): NormalizationRun {
    return {
      runId,
      mode: 'llm_failed',
      verdicts: new Map(),
      model,
      normalizerPrompt,
      requestJson: JSON.stringify({
        request: requestPayload,
        attempts: attemptLog,
      }),
      responseJson: JSON.stringify({
        attempts: attemptLog,
        failureReason,
      }),
      failureReason,
    };
  }

  _collectOpenTextNormalizationCandidates(
    match: WorkerMatchState,
    prompt: OpenTextPrompt,
  ): NormalizationCandidate[] {
    const candidatesByNormalizedInput = new Map<
      string,
      NormalizationCandidate
    >();

    for (const player of match.players.values()) {
      const validReveal =
        player.committed && player.revealed && !player.forfeited;
      if (!validReveal || player.answerText === null) continue;
      const canonical = canonicalizeOpenTextAnswer(player.answerText, prompt);
      if (!canonical) continue;
      if (candidatesByNormalizedInput.has(canonical.normalizedRevealText)) {
        continue;
      }
      candidatesByNormalizedInput.set(canonical.normalizedRevealText, {
        normalizedInputText: canonical.normalizedRevealText,
        rawAnswerText: player.answerText,
        canonicalCandidate: canonical.canonicalCandidate,
        bucketLabelCandidate: canonical.bucketLabelCandidate,
      });
    }

    return [...candidatesByNormalizedInput.values()].sort((left, right) =>
      left.normalizedInputText.localeCompare(right.normalizedInputText),
    );
  }

  async _normalizeOpenTextReveals(
    prompt: OpenTextPrompt,
    candidates: NormalizationCandidate[],
  ): Promise<NormalizationRun> {
    if (candidates.length === 0) {
      return this._buildEmptyNormalizationRun();
    }
    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (!candidate) {
        return this._buildEmptyNormalizationRun();
      }
      const bucketKey =
        this._buildBucketKey(candidate.bucketLabelCandidate) ??
        candidate.normalizedInputText;
      return {
        runId: null,
        mode: null,
        verdicts: new Map([
          [
            candidate.normalizedInputText,
            {
              normalizedInputText: candidate.normalizedInputText,
              bucketKey,
              bucketLabel: candidate.bucketLabelCandidate,
            },
          ],
        ]),
        model: null,
        normalizerPrompt: null,
        requestJson: null,
        responseJson: null,
        failureReason: null,
      };
    }

    const normalizerPrompt = this._buildOpenTextNormalizationPrompt(
      prompt,
      candidates,
    );
    const model = this._getOpenTextNormalizerModel();
    const requestPayload = {
      prompt: normalizerPrompt,
      guided_json: {
        type: 'object',
        additionalProperties: false,
        required: ['verdicts'],
        properties: {
          verdicts: {
            type: 'array',
            minItems: candidates.length,
            maxItems: candidates.length,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['normalizedInputText', 'bucketLabel'],
              properties: {
                normalizedInputText: { type: 'string' },
                bucketLabel: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
      max_tokens: 512,
      temperature: OPEN_TEXT_NORMALIZER_TEMPERATURE,
    };
    const runId = crypto.randomUUID();
    const attemptLog: Array<Record<string, unknown>> = [];

    for (
      let attemptIndex = 0;
      attemptIndex <= OPEN_TEXT_NORMALIZATION_RETRY_DELAYS_MS.length;
      attemptIndex += 1
    ) {
      const attemptNumber = attemptIndex + 1;

      try {
        const ai = this._getAiBinding();
        if (!ai) {
          throw new Error('Workers AI binding unavailable');
        }

        const output = await this._runWithTimeout(
          ai.run(model, requestPayload),
          this._getOpenTextNormalizerTimeoutMs(),
          'Open-text normalization timed out',
        );

        const responseText =
          this._extractAiResponseText(output) ?? JSON.stringify(output);
        const verdicts = this._parseNormalizationVerdicts(output, candidates);
        if (verdicts) {
          attemptLog.push({
            attempt: attemptNumber,
            status: 'success',
            responseText,
          });
          return {
            runId,
            mode: 'llm',
            verdicts,
            model,
            normalizerPrompt,
            requestJson: JSON.stringify({
              request: requestPayload,
              attempts: attemptLog,
            }),
            responseJson: JSON.stringify({
              attempts: attemptLog,
              finalResponseText: responseText,
            }),
            failureReason: null,
          };
        }

        attemptLog.push({
          attempt: attemptNumber,
          status: 'invalid_schema',
          responseText,
        });
      } catch (error) {
        console.error('Workers AI open-text normalization failed', error);
        attemptLog.push({
          attempt: attemptNumber,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const delayMs =
        OPEN_TEXT_NORMALIZATION_RETRY_DELAYS_MS[attemptIndex] ?? null;
      if (delayMs !== null) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }

    return this._buildFailedNormalizationRun(
      runId,
      model,
      normalizerPrompt,
      requestPayload,
      attemptLog,
      'open_text_normalization_failed',
    );
  }

  async _normalizeAndFinalizeOpenTextGame(
    match: WorkerMatchState,
  ): Promise<void> {
    const prompt = this._getPromptForGame(match, match.currentGame);
    if (prompt.type !== 'open_text') {
      match.normalizingInFlight = false;
      return;
    }

    try {
      const normalizationRun = await this._normalizeOpenTextReveals(
        prompt,
        this._collectOpenTextNormalizationCandidates(match, prompt),
      );
      await this._finalizeGame(match, normalizationRun);
    } finally {
      match.normalizingInFlight = false;
    }
  }

  _autoRevealAiBots(match: WorkerMatchState): boolean {
    let anyRevealed = false;
    const prompt = this._getPromptForGame(match, match.currentGame);
    for (const player of match.players.values()) {
      if (
        !this._isAiBot(player.accountId) ||
        player.forfeited ||
        !player.committed ||
        player.revealed ||
        !player.salt
      ) {
        continue;
      }

      if (prompt.type === 'select') {
        if (player.optionIndex === null) {
          continue;
        }
        player.revealed = true;
        this._checkpointPlayerAction(match.matchId, player.accountId, {
          revealed: true,
          optionIndex: player.optionIndex,
          answerText: null,
          normalizedRevealText: null,
          salt: player.salt,
        });
      } else {
        if (!player.answerText) {
          continue;
        }
        const canonicalAnswer = canonicalizeOpenTextAnswer(
          player.answerText,
          prompt,
        );
        if (!canonicalAnswer) {
          continue;
        }
        player.revealed = true;
        player.optionIndex = null;
        player.normalizedRevealText = canonicalAnswer.normalizedRevealText;
        this._checkpointPlayerAction(match.matchId, player.accountId, {
          revealed: true,
          optionIndex: null,
          answerText: player.answerText,
          normalizedRevealText: player.normalizedRevealText,
          salt: player.salt,
        });
      }

      anyRevealed = true;
    }

    if (!anyRevealed) {
      return false;
    }

    this._broadcastRevealStatus(match);

    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._completeRevealPhase(match);
      return true;
    }

    return false;
  }

  _handleCommit(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    const match = this.activeMatches.get(matchId);
    if (!match)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    if (match.phase !== 'commit') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in commit phase',
      });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'You have been forfeited',
      });
    }
    if (player.committed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already committed',
      });
    }

    const { hash } = msg as { hash: unknown; type: string };
    if (!validateHash(hash)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Invalid hash format (expected 64-char hex)',
      });
    }

    player.committed = true;
    player.hash = hash;
    this._checkpointPlayerAction(match.matchId, accountId, {
      committed: true,
      hash,
    });

    // Broadcast commit status
    this._broadcastCommitStatus(match);

    // Auto-advance if all non-forfeited players committed
    if (this._allNonForfeitedCommitted(match)) {
      this._startRevealPhase(match);
    }
  }

  _handleReveal(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    const match = this.activeMatches.get(matchId);
    if (!match)
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    if (match.phase !== 'reveal') {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in reveal phase',
      });
    }
    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'You have been forfeited',
      });
    }
    if (!player.committed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Did not commit this game',
      });
    }
    if (player.revealed) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already revealed',
      });
    }

    const { optionIndex, answerText, salt } = msg as {
      optionIndex?: unknown;
      answerText?: unknown;
      salt: unknown;
      type: string;
    };
    const prompt = this._getPromptForGame(match, match.currentGame);
    if (!validateSalt(salt)) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Salt must be a hex string between 32 and 128 characters',
      });
    }

    // Verify hash (verifyCommit is synchronous)
    if (!player.hash) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'No commitment found',
      });
    }

    if (prompt.type === 'select') {
      if (!validateOptionIndex(optionIndex, prompt.options.length)) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Invalid option index',
        });
      }

      const valid = verifyCommit(optionIndex, salt, player.hash);
      if (!valid) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Hash mismatch: reveal does not match commitment',
        });
      }

      player.revealed = true;
      player.optionIndex = optionIndex;
      player.answerText = null;
      player.normalizedRevealText = null;
      player.salt = salt;
      this._checkpointPlayerAction(match.matchId, accountId, {
        revealed: true,
        optionIndex,
        answerText: null,
        normalizedRevealText: null,
        salt,
      });
    } else {
      const canonicalAnswer = canonicalizeOpenTextAnswer(answerText, prompt);
      if (!canonicalAnswer || !validateAnswerText(answerText, prompt)) {
        return this._sendTo(accountId, {
          type: 'error',
          message: `Answer must match the prompt format and stay within ${prompt.maxLength} characters`,
        });
      }

      const valid = verifyOpenTextCommit(answerText, salt, player.hash, prompt);
      if (!valid) {
        return this._sendTo(accountId, {
          type: 'error',
          message: 'Hash mismatch: reveal does not match commitment',
        });
      }

      player.revealed = true;
      player.optionIndex = null;
      player.answerText = answerText;
      player.normalizedRevealText = canonicalAnswer.normalizedRevealText;
      player.salt = salt;
      this._checkpointPlayerAction(match.matchId, accountId, {
        revealed: true,
        optionIndex: null,
        answerText,
        normalizedRevealText: player.normalizedRevealText,
        salt,
      });
    }

    // Broadcast reveal status
    this._broadcastRevealStatus(match);

    // Auto-advance if all committed non-forfeited players revealed
    if (this._allCommittedNonForfeitedRevealed(match)) {
      this._completeRevealPhase(match);
    }
  }

  _handleForfeitMatch(accountId: string): void {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Not in a match',
      });
    }

    const match = this.activeMatches.get(matchId);
    if (!match) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Match not found',
      });
    }

    const player = match.players.get(accountId);
    if (!player) return;
    if (player.forfeited) {
      return this._sendTo(accountId, {
        type: 'error',
        message: 'Already forfeited',
      });
    }

    this._forfeitPlayer(match, accountId);
  }

  async _handlePromptRating(
    accountId: string,
    msg: { type: string; [key: string]: unknown },
  ): Promise<void> {
    const matchId = this.playerMatchIndex.get(accountId);
    if (!matchId) return;
    const match = this.activeMatches.get(matchId);
    if (!match || match.phase !== 'results') return;
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    const rating =
      msg.rating === 'like'
        ? 'like'
        : msg.rating === 'dislike'
          ? 'dislike'
          : null;
    if (!rating) return;
    const promptId = match.prompts[match.currentGame - 1]?.id;
    if (!promptId) return;

    try {
      await this.env.DB.prepare(`
        INSERT INTO prompt_ratings (prompt_id, account_id, match_id, game_number, rating)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(prompt_id, account_id, match_id) DO UPDATE SET rating = excluded.rating
      `)
        .bind(promptId, accountId, matchId, match.currentGame, rating)
        .run();
    } catch (e) {
      console.error('D1: prompt_ratings write failed', matchId, accountId, e);
      return;
    }

    // Broadcast updated tally to match
    const rows = await this.env.DB.prepare(`
      SELECT rating, COUNT(*) as cnt FROM prompt_ratings
      WHERE prompt_id = ? AND match_id = ?
      GROUP BY rating
    `)
      .bind(promptId, matchId)
      .all();

    const tally = { likes: 0, dislikes: 0 };
    for (const r of rows.results as Array<{ rating: string; cnt: number }>) {
      if (r.rating === 'like') tally.likes = r.cnt;
      else if (r.rating === 'dislike') tally.dislikes = r.cnt;
    }

    this._broadcastToMatch(match, {
      type: 'prompt_rating_tally',
      promptId,
      ...tally,
    });
  }

  // -------------------------------------------------------------------------
  // Disconnect / Reconnect / Forfeit
  // -------------------------------------------------------------------------

  _handleDisconnect(accountId: string): void {
    this._clearConnectionLivenessMonitor(accountId);
    const matchId = this.playerMatchIndex.get(accountId);

    if (!matchId) {
      // Not in a match: remove from queue and forming match
      this._removeFromQueue(accountId);
      this.connections.delete(accountId);
      this._rebalanceQueueAndForm();
      this._broadcastQueueState();
      return;
    }

    // In a match: start grace timer
    const match = this.activeMatches.get(matchId);
    if (!match) {
      this.playerMatchIndex.delete(accountId);
      this.connections.delete(accountId);
      return;
    }

    const player = match.players.get(accountId);
    if (!player || player.forfeited) {
      this.playerMatchIndex.delete(accountId);
      this.connections.delete(accountId);
      return;
    }

    player.disconnectedAt = Date.now();
    this._checkpointPlayerAction(matchId, accountId, {
      disconnectedAt: player.disconnectedAt,
    });

    // Broadcast disconnection
    this._broadcastToMatch(match, {
      type: 'player_disconnected',
      displayName: player.displayName,
      graceSeconds: GRACE_DURATION_MS / 1000,
    });

    // Start 15s grace timer
    player.graceTimer = setTimeout(() => {
      this._forfeitPlayer(match, accountId);
    }, GRACE_DURATION_MS);
  }

  _forfeitPlayer(match: WorkerMatchState, accountId: string): void {
    const player = match.players.get(accountId);
    if (!player || player.forfeited) return;

    player.forfeited = true;
    player.forfeitedAtGame = match.currentGame;
    player.graceTimer = null;

    // Burn future-game antes immediately. The player is detached from all
    // subsequent rounds, so this is the only place the penalty is applied.
    // Applying here instead of in _finalizeGame avoids a timing exploit
    // where a disconnect during the results phase would skip the penalty.
    const futureGamesPenaltyApplied = !match.aiAssisted;
    if (futureGamesPenaltyApplied) {
      const futureGames = match.totalGames - match.currentGame;
      player.currentBalance = Math.max(
        MIN_ALLOWED_BALANCE,
        player.currentBalance - futureGames * GAME_ANTE,
      );
    }

    this._checkpointPlayerAction(match.matchId, accountId, {
      forfeited: true,
      forfeitedAtGame: match.currentGame,
      currentBalance: player.currentBalance,
    });

    // Only take the results-phase path when the current game is fully
    // settled (lastGameResult built and cached). _finalizeGame sets
    // phase='results' before the D1 batch await, so checking phase alone
    // would race: the forfeit burn would fire while the batch is in
    // flight, and _finalizeGame would later build the payload from a
    // stale snapshot. Checking gameNum guards against both the mid-await
    // window and a stale lastGameResult from a prior game.
    //
    // During commit/reveal the player is still attached for the current
    // game. _finalizeGame will write the correct post-settlement
    // balance to D1, so persisting here would race with that write.
    const roundFullySettled =
      match.lastGameResult?.gameNum === match.currentGame;
    if (roundFullySettled && futureGamesPenaltyApplied) {
      this._waitUntil(
        this._persistAccountBalance(accountId, player.currentBalance),
        `persist forfeited balance for ${accountId}`,
      );

      // Patch the cached game result so reconnect replay reflects the
      // burned balance instead of the stale pre-forfeit value.
      if (match.lastGameResult) {
        const cached = match.lastGameResult.players.find(
          (p) => p.accountId === accountId,
        );
        if (cached) {
          cached.newBalance = player.currentBalance;
        }
        this._checkpointMatch(match);
      }
    }

    this._broadcastToMatch(match, {
      type: 'player_forfeited',
      displayName: player.displayName,
      futureGamesPenaltyApplied,
    });
    this._sendTo(accountId, {
      type: 'player_forfeited',
      displayName: player.displayName,
      futureGamesPenaltyApplied,
    });

    // If all players are now forfeited, check for early termination
    // This is handled naturally in _finalizeGame via the non-forfeited check.
    // But we also need to check if this forfeit triggers auto-advance:

    // During commit phase: if all non-forfeited have committed, advance
    if (match.phase === 'commit' && this._allNonForfeitedCommitted(match)) {
      this._startRevealPhase(match);
    }
    // During reveal phase: if all committed non-forfeited have revealed, advance
    if (
      match.phase === 'reveal' &&
      this._allCommittedNonForfeitedRevealed(match)
    ) {
      this._completeRevealPhase(match);
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  _sendTo(accountId: string, msg: ServerMessage): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch {}
  }

  _broadcastToMatch(match: WorkerMatchState, msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const p of match.players.values()) {
      if (!p.forfeited || msg.type === 'match_over') {
        if (p.ws)
          try {
            p.ws.send(data);
          } catch {}
      }
    }
  }

  _broadcastCommitStatus(match: WorkerMatchState): void {
    const committed = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      hasCommitted: p.committed,
    }));
    this._broadcastToMatch(match, { type: 'commit_status', committed });
  }

  _broadcastRevealStatus(match: WorkerMatchState): void {
    const revealed = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      hasRevealed: p.revealed,
    }));
    this._broadcastToMatch(match, { type: 'reveal_status', revealed });
  }

  _sendQueueState(accountId: string): void {
    const conn = this.connections.get(accountId);
    if (!conn) return;

    this._sendTo(accountId, this._buildQueueStateMsg(accountId));
  }

  _broadcastQueueState(): void {
    // Send to all connected players NOT in an active match
    for (const [accountId, conn] of this.connections) {
      if (this.playerMatchIndex.has(accountId)) continue;

      const msg = this._buildQueueStateMsg(accountId);
      try {
        conn.ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  _buildQueueStateMsg(accountId: string): QueueStateMessage {
    const isForming = this.formingMatch?.players.includes(accountId) ?? false;
    const isQueued = this.waitingQueue.includes(accountId);
    let status: QueueStateMessage['status'] = 'idle';
    if (isForming) {
      status = 'forming';
    } else if (isQueued) {
      status = 'queued';
    }
    // All queued + forming display names
    const allQueuedIds = [...this.waitingQueue];
    if (this.formingMatch) {
      allQueuedIds.unshift(...this.formingMatch.players);
    }
    const queuedPlayers = allQueuedIds.map((id) => this._getDisplayName(id));

    let formingMatch: {
      playerCount: number;
      humanPlayerCount: number;
      readyHumanCount: number;
      players: string[];
      allowedSizes: number[];
      fillDeadlineMs: number | null;
      youCanVoteStartNow: boolean;
    } | null = null;
    const formingState = this.formingMatch;
    if (formingState) {
      const fmPlayers = formingState.players.map((id) =>
        this._getDisplayName(id),
      );
      const humanIds = formingState.players.filter((id) => !this._isAiBot(id));
      const readyHumanCount = humanIds.filter(
        (id) => this.connections.get(id)?.startNow,
      ).length;
      formingMatch = {
        playerCount: formingState.players.length,
        humanPlayerCount: humanIds.length,
        readyHumanCount,
        players: fmPlayers,
        allowedSizes: buildAllowedMatchSizes(
          formingState.players.length + this.waitingQueue.length,
        ),
        fillDeadlineMs: formingState.fillDeadlineMs,
        youCanVoteStartNow: formingState.players.includes(accountId),
      };
    }

    return {
      type: 'queue_state',
      status,
      startNow: this.connections.get(accountId)?.startNow ?? false,
      queuedCount: allQueuedIds.length,
      queuedPlayers,
      formingMatch,
    };
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  _getPlayerStatus(accountId: string | null): {
    status: string;
    matchId?: string;
  } {
    if (!accountId) return { status: 'idle' };
    const matchId = this.playerMatchIndex.get(accountId);
    if (matchId) {
      return {
        status: 'in_match',
        matchId,
      };
    }
    if (this.formingMatch?.players.includes(accountId)) {
      return { status: 'forming' };
    }
    if (this.waitingQueue.includes(accountId)) {
      return { status: 'queued' };
    }
    return { status: 'idle' };
  }

  _allNonForfeitedCommitted(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited && !p.committed) return false;
    }
    return true;
  }

  _allCommittedNonForfeitedRevealed(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited && p.committed && !p.revealed) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // DO SQLite persistence (delegates to src/worker/persistence.ts)
  // -------------------------------------------------------------------------

  _checkpointMatch(match: WorkerMatchState): void {
    checkpointMatch(this.state.storage, match);
  }

  _checkpointPlayerAction(
    matchId: string,
    accountId: string,
    fields: PlayerActionFields,
  ): void {
    checkpointPlayerAction(this.state.storage.sql, matchId, accountId, fields);
  }

  async _persistAccountBalance(
    accountId: string,
    currentBalance: number,
  ): Promise<void> {
    const normalizedBalance = clampTokenBalance(currentBalance);
    try {
      await this.env.DB.prepare(
        'UPDATE accounts SET token_balance = ? WHERE account_id = ?',
      )
        .bind(normalizedBalance, accountId)
        .run();
    } catch (error) {
      console.error('D1: persist account balance for', accountId, error);
    }
  }

  async _fetchAccountBalance(accountId: string): Promise<number | null> {
    try {
      const row = await this.env.DB.prepare(
        'SELECT token_balance FROM accounts WHERE account_id = ?',
      )
        .bind(accountId)
        .first<{ token_balance: number | null }>();
      if (!row) return null;
      const rawBalance = row.token_balance ?? 0;
      const normalizedBalance = clampTokenBalance(rawBalance);
      if (normalizedBalance !== rawBalance) {
        await this._persistAccountBalance(accountId, normalizedBalance);
      }
      return normalizedBalance;
    } catch (error) {
      console.error('D1: fetch account balance for', accountId, error);
      return null;
    }
  }

  _deleteMatchCheckpoint(matchId: string): void {
    deleteMatchCheckpoint(this.state.storage.sql, matchId);
  }

  _restoreMatchesFromStorage(): void {
    const restoredAt = Date.now();
    const restored = restoreMatchesFromStorage(
      this.state.storage.sql,
      STALE_MATCH_THRESHOLD_MS,
    );
    for (const rm of restored) {
      const players = new Map<string, WorkerPlayerState>();
      for (const [id, rp] of rm.players) {
        players.set(id, {
          ...rp,
          // A restored DO cannot prove how long a previously-connected player
          // has been unreachable once their socket disappears with eviction, so
          // treat them as newly disconnected and give them one fresh grace
          // window rather than forfeiting them immediately on restore.
          disconnectedAt:
            !this._isAiBot(id) &&
            !rp.forfeited &&
            rm.phase !== 'ending' &&
            rp.disconnectedAt === null
              ? restoredAt
              : rp.disconnectedAt,
          ws: null,
          graceTimer: null,
          pendingAiCommit: false,
        });
        this.playerMatchIndex.set(id, rm.matchId);
      }
      const match: WorkerMatchState = {
        ...rm,
        players,
        commitTimer: null,
        revealTimer: null,
        resultsTimer: null,
        retryTimer: null,
        normalizingInFlight: false,
        lastGameResult: rm.lastGameResult,
      };
      this.activeMatches.set(rm.matchId, match);
      this._ensureMatchTimerRunning(match);
    }
  }

  _waitUntil(task: Promise<void>, description: string): void {
    this.state.waitUntil(
      task.catch((error) => {
        console.error(`GameRoom async task failed: ${description}`, error);
      }),
    );
  }

  _scheduleFinalizeRetry(
    match: WorkerMatchState,
    delayMs = D1_RETRY_DELAY_MS,
  ): void {
    if (match.retryTimer) {
      clearTimeout(match.retryTimer);
      match.retryTimer = null;
    }
    match.retryTimer = setTimeout(() => {
      match.retryTimer = null;
      if (!this.activeMatches.has(match.matchId)) return;
      this._waitUntil(
        this._finalizeGame(match),
        `retry finalize game ${match.currentGame} for ${match.matchId}`,
      );
    }, delayMs);
  }

  _scheduleEndMatchRetry(
    match: WorkerMatchState,
    delayMs = D1_RETRY_DELAY_MS,
  ): void {
    if (match.retryTimer) {
      clearTimeout(match.retryTimer);
      match.retryTimer = null;
    }
    match.retryTimer = setTimeout(() => {
      match.retryTimer = null;
      if (!this.activeMatches.has(match.matchId)) return;
      this._waitUntil(
        this._endMatch(match),
        `retry end match ${match.matchId}`,
      );
    }, delayMs);
  }

  _ensureMatchTimerRunning(match: WorkerMatchState): void {
    const elapsed = Date.now() - match.phaseEnteredAt;

    if (match.phase === 'commit' && !match.commitTimer) {
      const remaining = Math.max(0, COMMIT_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        this._startRevealPhase(match);
      } else {
        this._maybeScheduleAiBotCommit(match);
        match.commitTimer = setTimeout(() => {
          match.commitTimer = null;
          this._startRevealPhase(match);
        }, remaining);
      }
    } else if (match.phase === 'reveal' && !match.revealTimer) {
      const remaining = Math.max(0, REVEAL_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        if (this._autoRevealAiBots(match)) {
          return;
        }
        this._completeRevealPhase(match);
      } else {
        match.revealTimer = setTimeout(() => {
          match.revealTimer = null;
          this._completeRevealPhase(match);
        }, remaining);
        this._autoRevealAiBots(match);
      }
    } else if (match.phase === 'normalizing' && !match.normalizingInFlight) {
      match.normalizingInFlight = true;
      this._waitUntil(
        this._normalizeAndFinalizeOpenTextGame(match),
        `resume normalization for game ${match.currentGame} in ${match.matchId}`,
      );
    } else if (match.phase === 'settling' && !match.retryTimer) {
      this._scheduleFinalizeRetry(match, 0);
    } else if (match.phase === 'ending' && !match.retryTimer) {
      this._scheduleEndMatchRetry(match, 0);
    } else if (match.phase === 'results' && !match.resultsTimer) {
      const remaining = Math.max(0, RESULTS_DURATION * 1000 - elapsed);
      if (remaining <= 0) {
        this._advanceAfterResults(match);
      } else {
        match.resultsTimer = setTimeout(() => {
          match.resultsTimer = null;
          this._advanceAfterResults(match);
        }, remaining);
      }
    }

    if (match.phase === 'ending' || match.phase === 'ended') {
      return;
    }

    // Start grace timers for still-disconnected, non-forfeited players
    const now = Date.now();
    for (const p of match.players.values()) {
      if (
        !this._isAiBot(p.accountId) &&
        p.disconnectedAt !== null &&
        !p.forfeited &&
        !p.graceTimer
      ) {
        const elapsedGrace = now - p.disconnectedAt;
        const remainingGrace = GRACE_DURATION_MS - elapsedGrace;
        if (remainingGrace <= 0) {
          this._forfeitPlayer(match, p.accountId);
        } else {
          p.graceTimer = setTimeout(() => {
            this._forfeitPlayer(match, p.accountId);
          }, remainingGrace);
        }
      }
    }
  }

  _parsePersistedNumberArray(value: string | null, field: string): number[] {
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== 'number')
    ) {
      throw new Error(`Persisted ${field} is not a number array`);
    }
    return parsed;
  }

  _parsePersistedStringArray(value: string | null, field: string): string[] {
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(`Persisted ${field} is not a string array`);
    }
    return parsed;
  }

  async _loadPersistedGameResult(
    match: WorkerMatchState,
  ): Promise<GameResultMessage['result'] | null> {
    const rows = await this.env.DB.prepare(
      'SELECT account_id, display_name_snapshot, revealed_option_index, revealed_option_label, ' +
        'revealed_input_text, revealed_bucket_key, revealed_bucket_label, won_game, ' +
        'earns_coordination_credit, ante_amount, game_payout, net_delta, player_count, ' +
        'valid_reveal_count, top_count, winner_count, winning_option_indexes_json, ' +
        'winning_bucket_keys_json, voided, void_reason, normalization_mode ' +
        'FROM vote_logs WHERE match_id = ? AND game_number = ? ORDER BY id ASC',
    )
      .bind(match.matchId, match.currentGame)
      .all();

    const voteLogs = rows.results as unknown as PersistedVoteLogRow[];
    if (voteLogs.length === 0) {
      return null;
    }

    const attachedHumanPlayers = [...match.players.values()].filter(
      (player) =>
        !this._isAiBot(player.accountId) &&
        (!player.forfeited || player.forfeitedAtGame === match.currentGame),
    );
    if (voteLogs.length !== attachedHumanPlayers.length) {
      throw new Error(
        `Persisted vote log count mismatch for ${match.matchId}:${match.currentGame}`,
      );
    }

    const voteLogsByAccountId = new Map(
      voteLogs.map((voteLog) => [voteLog.account_id, voteLog]),
    );
    if (voteLogsByAccountId.size !== voteLogs.length) {
      throw new Error(
        `Duplicate persisted vote logs detected for ${match.matchId}:${match.currentGame}`,
      );
    }

    const summary = voteLogs[0];
    if (!summary) {
      return null;
    }

    for (const voteLog of voteLogs) {
      if (
        voteLog.player_count !== summary.player_count ||
        voteLog.valid_reveal_count !== summary.valid_reveal_count ||
        voteLog.top_count !== summary.top_count ||
        voteLog.winner_count !== summary.winner_count ||
        voteLog.voided !== summary.voided ||
        voteLog.void_reason !== summary.void_reason ||
        voteLog.normalization_mode !== summary.normalization_mode ||
        voteLog.winning_option_indexes_json !==
          summary.winning_option_indexes_json ||
        voteLog.winning_bucket_keys_json !== summary.winning_bucket_keys_json
      ) {
        throw new Error(
          `Persisted vote log summary mismatch for ${match.matchId}:${match.currentGame}`,
        );
      }
    }

    const winningOptionIndexes = this._parsePersistedNumberArray(
      summary.winning_option_indexes_json,
      'winning_option_indexes_json',
    );
    const winningBucketKeys = this._parsePersistedStringArray(
      summary.winning_bucket_keys_json,
      'winning_bucket_keys_json',
    );

    const players = attachedHumanPlayers.map((playerState) => {
      const voteLog = voteLogsByAccountId.get(playerState.accountId);
      if (!voteLog) {
        throw new Error(
          `Missing persisted vote log for ${playerState.accountId} in ${match.matchId}:${match.currentGame}`,
        );
      }

      let newBalance = playerState.currentBalance + voteLog.net_delta;
      if (newBalance < MIN_ALLOWED_BALANCE) {
        newBalance = MIN_ALLOWED_BALANCE;
      }

      return {
        accountId: voteLog.account_id,
        displayName: voteLog.display_name_snapshot ?? playerState.displayName,
        revealedOptionIndex: voteLog.revealed_option_index,
        revealedOptionLabel: voteLog.revealed_option_label,
        revealedInputText: voteLog.revealed_input_text,
        revealedBucketKey: voteLog.revealed_bucket_key,
        revealedBucketLabel: voteLog.revealed_bucket_label,
        wonGame: voteLog.won_game === 1,
        earnsCoordinationCredit: voteLog.earns_coordination_credit === 1,
        antePaid: voteLog.ante_amount,
        gamePayout: voteLog.game_payout,
        netDelta: voteLog.net_delta,
        newBalance,
      };
    });

    const pot = voteLogs.reduce((sum, voteLog) => sum + voteLog.ante_amount, 0);
    const totalPayout = voteLogs.reduce(
      (sum, voteLog) => sum + voteLog.game_payout,
      0,
    );
    const payoutPerWinner =
      summary.winner_count > 0
        ? Math.max(...players.map((player) => player.gamePayout))
        : 0;

    return {
      gameNum: match.currentGame,
      voided: summary.voided === 1,
      voidReason: summary.void_reason,
      playerCount: summary.player_count,
      pot,
      dustBurned: pot - totalPayout,
      validRevealCount: summary.valid_reveal_count,
      topCount: summary.top_count,
      winningOptionIndexes,
      winningBucketKeys,
      winnerCount: summary.winner_count,
      payoutPerWinner,
      normalizationMode: summary.normalization_mode,
      players,
    };
  }

  async _hasPersistedVoteLogsForCurrentGame(
    match: WorkerMatchState,
  ): Promise<boolean | null> {
    try {
      const row = await this.env.DB.prepare(
        'SELECT 1 AS found FROM vote_logs WHERE match_id = ? AND game_number = ? LIMIT 1',
      )
        .bind(match.matchId, match.currentGame)
        .first<{ found: number }>();
      return row?.found === 1;
    } catch (error) {
      console.error(
        'D1: failed to check vote log persistence for',
        match.matchId,
        error,
      );
      return null;
    }
  }

  async _isMatchAlreadyCompleted(matchId: string): Promise<boolean | null> {
    try {
      const row = await this.env.DB.prepare(
        'SELECT status FROM matches WHERE match_id = ?',
      )
        .bind(matchId)
        .first<{ status: string | null }>();
      return row?.status === 'completed';
    } catch (error) {
      console.error('D1: failed to check match completion for', matchId, error);
      return null;
    }
  }

  _advanceAfterResults(match: WorkerMatchState): void {
    if (
      match.currentGame >= match.totalGames ||
      !this._hasNonForfeitedPlayers(match)
    ) {
      this._waitUntil(this._endMatch(match), `end match ${match.matchId}`);
    } else {
      this._startCommitPhase(match);
    }
  }

  _hasNonForfeitedPlayers(match: WorkerMatchState): boolean {
    for (const p of match.players.values()) {
      if (!p.forfeited) return true;
    }
    return false;
  }

  _getPromptForGame(match: WorkerMatchState, game: number): SchellingPrompt {
    const prompt = match.prompts[game - 1];
    if (!prompt) {
      throw new Error(`Missing prompt for match ${match.matchId} game ${game}`);
    }
    return prompt;
  }

  _sendMatchStateToPlayer(match: WorkerMatchState, accountId: string): void {
    const player = match.players.get(accountId);
    if (!player) return;

    // Send match_started so the client knows the match context
    const playersInfo = [...match.players.values()].map((p) => ({
      displayName: p.displayName,
      startingBalance: p.startingBalance,
      currentBalance: p.currentBalance,
    }));
    this._sendTo(accountId, {
      type: 'match_started',
      matchId: match.matchId,
      gameCount: match.totalGames,
      aiAssisted: match.aiAssisted,
      players: playersInfo,
    });

    if (player.forfeited) {
      this._sendTo(accountId, {
        type: 'player_forfeited',
        displayName: player.displayName,
        futureGamesPenaltyApplied: !match.aiAssisted,
      });
    }

    // Replay peer disconnected/forfeited status so the client renders badges
    for (const peer of match.players.values()) {
      if (peer.accountId === accountId) continue;
      if (peer.forfeited) {
        this._sendTo(accountId, {
          type: 'player_forfeited',
          displayName: peer.displayName,
          futureGamesPenaltyApplied: !match.aiAssisted,
        });
      } else if (peer.disconnectedAt !== null) {
        const elapsedMs = Date.now() - peer.disconnectedAt;
        const remainingGraceSeconds = Math.max(
          0,
          Math.ceil((GRACE_DURATION_MS - elapsedMs) / 1000),
        );
        this._sendTo(accountId, {
          type: 'player_disconnected',
          displayName: peer.displayName,
          graceSeconds: remainingGraceSeconds,
        });
      }
    }

    // Send current game info with remaining time (not full duration)
    if (
      match.phase === 'commit' ||
      match.phase === 'reveal' ||
      match.phase === 'normalizing' ||
      match.phase === 'results'
    ) {
      const prompt = this._getPromptForGame(match, match.currentGame);
      const elapsed = Date.now() - match.phaseEnteredAt;
      const commitRemaining = Math.max(
        0,
        Math.ceil((COMMIT_DURATION * 1000 - elapsed) / 1000),
      );
      const revealRemaining = Math.max(
        0,
        Math.ceil((REVEAL_DURATION * 1000 - elapsed) / 1000),
      );
      const resultsRemaining = Math.max(
        0,
        Math.ceil((RESULTS_DURATION * 1000 - elapsed) / 1000),
      );

      this._sendTo(accountId, {
        type: 'game_started',
        game: match.currentGame,
        prompt: cloneJson(prompt),
        commitDuration:
          match.phase === 'commit' ? commitRemaining : COMMIT_DURATION,
        gameAnte: this._getMatchGameAnte(match),
        aiAssisted: match.aiAssisted,
        phase: match.phase,
        yourCommitted: player.committed,
        yourRevealed: player.revealed,
      });

      if (match.phase === 'reveal') {
        this._sendTo(accountId, {
          type: 'phase_change',
          phase: 'reveal',
          revealDuration: revealRemaining,
        });
      } else if (match.phase === 'normalizing') {
        this._sendTo(accountId, {
          type: 'phase_change',
          phase: 'normalizing',
          status: OPEN_TEXT_NORMALIZING_STATUS,
        });
      }

      // Send commit status
      this._sendTo(accountId, {
        type: 'commit_status',
        committed: [...match.players.values()].map((p) => ({
          displayName: p.displayName,
          hasCommitted: p.committed,
        })),
      });

      // Send reveal status if in reveal or results
      if (
        match.phase === 'reveal' ||
        match.phase === 'normalizing' ||
        match.phase === 'results'
      ) {
        this._sendTo(accountId, {
          type: 'reveal_status',
          revealed: [...match.players.values()].map((p) => ({
            displayName: p.displayName,
            hasRevealed: p.revealed,
          })),
        });
      }

      // Replay cached game result so the reconnecting client renders the results screen
      if (match.phase === 'results' && match.lastGameResult) {
        this._sendTo(accountId, {
          type: 'game_result',
          resultsDuration: resultsRemaining,
          result: match.lastGameResult,
        });

        // Replay prompt rating tally and the player's own rating (async D1 query)
        const promptId = match.prompts[match.currentGame - 1]?.id;
        if (promptId) {
          this._waitUntil(
            this._replayRatingTally(
              match.matchId,
              promptId,
              match.currentGame,
              accountId,
            ),
            'replay prompt rating tally on reconnect',
          );
        }
      }
    }
  }

  async _replayRatingTally(
    matchId: string,
    promptId: number,
    gameAtDispatch: number,
    accountId: string,
  ): Promise<void> {
    try {
      const [tallyRows, playerRow] = await Promise.all([
        this.env.DB.prepare(
          `SELECT rating, COUNT(*) as cnt FROM prompt_ratings
           WHERE prompt_id = ? AND match_id = ?
           GROUP BY rating`,
        )
          .bind(promptId, matchId)
          .all(),
        this.env.DB.prepare(
          `SELECT rating FROM prompt_ratings
           WHERE prompt_id = ? AND account_id = ? AND match_id = ?`,
        )
          .bind(promptId, accountId, matchId)
          .first<{ rating: string }>(),
      ]);

      // Guard: if the match advanced past the game we queried for, discard
      const match = this.activeMatches.get(matchId);
      if (
        !match ||
        match.phase !== 'results' ||
        match.currentGame !== gameAtDispatch
      ) {
        return;
      }

      const tally = { likes: 0, dislikes: 0 };
      for (const r of tallyRows.results as Array<{
        rating: string;
        cnt: number;
      }>) {
        if (r.rating === 'like') tally.likes = r.cnt;
        else if (r.rating === 'dislike') tally.dislikes = r.cnt;
      }

      const yourRating =
        playerRow?.rating === 'like' || playerRow?.rating === 'dislike'
          ? playerRow.rating
          : null;

      this._sendTo(accountId, {
        type: 'prompt_rating_tally',
        promptId,
        ...tally,
        yourRating,
      });
    } catch (err) {
      console.warn(
        'Failed to replay prompt rating tally',
        { matchId, promptId, accountId },
        err,
      );
    }
  }
}
