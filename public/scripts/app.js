import {
  CARD_RANK_OPTIONS,
  CARD_SUIT_OPTIONS,
  canonicalizeOpenTextAnswer,
  getPlayingCardSelection,
  normalizeRevealText,
  validateOpenTextAnswer,
} from './openText.js';
import { getDisplayNameEditBlockMessage as getDisplayNameEditBlockMessageForState } from './displayNameEdit.js';

/* ═══════════════════════════════════════════════════════════════════
   Schelling Games client
   Vanilla JS, single-file. Connects via REST + WebSocket.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ── State ───────────────────────────────────────────────────────
const S = {
  view: 'auth',
  isBrowserWallet: false,
  walletAddress: null,
  accountId: null,
  displayName: null,
  hasClaimedDisplayName: false,
  tokenBalance: 0,
  aiAssistedMatch: false,
  startNow: false,
  // queue
  inQueue: false,
  queuedPlayers: [],
  formingMatch: null,
  // play
  matchId: null,
  players: [],
  game: 0,
  totalGames: 10,
  phase: null,       // 'commit' | 'reveal' | 'results' | null
  prompt: null,
  selectedOption: null,
  selectedAnswerText: '',
  salt: null,
  commitHash: null,
  committed: false,
  revealed: false,
  commitStatuses: [],
  revealStatuses: [],
  gameResult: null,
  myRating: null,
  playerStatuses: {},   // displayName -> 'connected'|'disconnected'|'forfeited'
  // timers
  timerEnd: 0,
  timerDuration: 0,
  timerInterval: null,
  // summary
  summary: null,
  gameHistory: [],
  // leaderboard
  previousView: 'queue',
  nameEditorReturnView: 'queue',
  // ws
  ws: null,
  wsConnected: false,
  pendingQueueAction: null,
};

// ── DOM refs ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const MIN_ESTABLISHED = 5; // must match backend MIN_ESTABLISHED_MATCHES
const LEADERBOARD_LIMIT = 100; // must match backend leaderboard cap
const LIVE_MATCH_STORAGE_PREFIX = 'schelling_live_match:';

// ── Browser wallet ───────────────────────────────────────────────
const BROWSER_KEY = 'schelling_browser_secret';
// Migrate from legacy key names on startup
(function migrateBrowserKey() {
  try {
    if (!localStorage.getItem(BROWSER_KEY)) {
      const legacy = localStorage.getItem('schelling_guest_secret')
        || localStorage.getItem('schelling_guest_pk');
      if (legacy) {
        localStorage.setItem(BROWSER_KEY, legacy);
      }
    }
    localStorage.removeItem('schelling_guest_secret');
    localStorage.removeItem('schelling_guest_pk');
  } catch (_) {}
})();

// Construct a wallet from a stored secret (mnemonic or private key)
function walletFromSecret(secret) {
  const trimmed = secret.trim();
  return /\s/.test(trimmed) ? ethers.Wallet.fromPhrase(trimmed) : new ethers.Wallet(trimmed);
}

function getOrCreateBrowserWallet() {
  try {
    const stored = localStorage.getItem(BROWSER_KEY);
    if (stored) {
      try { return walletFromSecret(stored); }
      catch (_) { localStorage.removeItem(BROWSER_KEY); }
    }
    const wallet = ethers.Wallet.createRandom();
    localStorage.setItem(BROWSER_KEY, wallet.mnemonic.phrase);
    return wallet;
  } catch (_) {
    throw new Error('Browser wallet requires storage to be enabled.');
  }
}

function parseBrowserWallet(input) {
  try {
    const wallet = walletFromSecret(input);
    const trimmed = input.trim();
    const storageValue = /\s/.test(trimmed) ? wallet.mnemonic.phrase : wallet.privateKey;
    return { wallet, storageValue };
  } catch (_) {
    throw new Error('Invalid seed phrase or private key.');
  }
}

function getBrowserMnemonic() {
  try {
    const stored = localStorage.getItem(BROWSER_KEY);
    if (!stored) return null;
    const trimmed = stored.trim();
    return /\s/.test(trimmed) ? trimmed : null;
  } catch (_) { return null; }
}

function getLiveMatchStorageKey(matchId) {
  return LIVE_MATCH_STORAGE_PREFIX + matchId;
}

function loadPersistedGameHistory(matchId) {
  if (!matchId) return [];
  try {
    const raw = sessionStorage.getItem(getLiveMatchStorageKey(matchId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function persistGameHistory() {
  if (!S.matchId) return;
  try {
    sessionStorage.setItem(
      getLiveMatchStorageKey(S.matchId),
      JSON.stringify(S.gameHistory),
    );
  } catch (_) {}
}

function clearPersistedGameHistory(matchId) {
  if (!matchId) return;
  try {
    sessionStorage.removeItem(getLiveMatchStorageKey(matchId));
  } catch (_) {}
}

// ── Notifications ───────────────────────────────────────────────
function notify(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'notif-item ' + type;
  el.textContent = msg;
  $('#notif').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

const GLOBAL_ERROR_NOTIFY_COOLDOWN_MS = 8000;
let lastGlobalErrorNoticeAt = 0;
function notifyUnexpectedClientError() {
  const now = Date.now();
  if (now - lastGlobalErrorNoticeAt < GLOBAL_ERROR_NOTIFY_COOLDOWN_MS) return;
  lastGlobalErrorNoticeAt = now;
  notify(
    'Unexpected client error. Reconnect in progress; refresh if it persists.',
    'error',
  );
}

window.addEventListener('error', (event) => {
  console.error('Client runtime error', event.error || event.message);
  notifyUnexpectedClientError();
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection', event.reason);
  notifyUnexpectedClientError();
});

// ── Header profile ──────────────────────────────────────────────
function updateHeaderProfile() {
  if (S.accountId) {
    const manageNameBtn = $('#manage-name-btn');
    const displayNameBlockMessage = getDisplayNameEditBlockMessage();
    $('#header-profile').classList.remove('hidden');
    $('#header-name').textContent = S.displayName || S.accountId.slice(0, 6) + '…';
    $('#header-balance').textContent = S.tokenBalance + ' tokens';
    manageNameBtn.textContent = S.hasClaimedDisplayName ? 'Change Name' : 'Claim Name';
    manageNameBtn.disabled = false;
    manageNameBtn.setAttribute('aria-disabled', displayNameBlockMessage ? 'true' : 'false');
    manageNameBtn.title = displayNameBlockMessage || 'Claim or change display name';
    $('#backup-seed-btn').classList.toggle('hidden', !S.isBrowserWallet);
  }
}

function hasActiveMatch() {
  return S.matchId !== null;
}

function getDisplayNameEditBlockMessage() {
  return getDisplayNameEditBlockMessageForState({
    hasActiveMatch: hasActiveMatch(),
    inQueue: S.inQueue,
  });
}

function updateNavigation() {
  $('#nav-queue').classList.toggle('hidden', S.view === 'auth');
  $('#nav-return-game').classList.toggle(
    'hidden',
    S.view === 'auth' || S.view === 'play' || !hasActiveMatch(),
  );
  // hide logout during active matches
  $('#logout-btn').classList.toggle('hidden', S.view === 'play');
}

function hasRevealPreimageForPrompt(prompt = S.prompt) {
  if (!prompt || !S.salt) return false;
  if (prompt.type === 'select') return S.selectedOption !== null;
  return validateOpenTextAnswer(S.selectedAnswerText, prompt);
}

function getCurrentRevealPayload() {
  if (!S.prompt || !S.salt || !hasRevealPreimageForPrompt(S.prompt)) return null;
  if (S.prompt.type === 'select') {
    return { type: 'reveal', optionIndex: S.selectedOption, salt: S.salt };
  }
  return { type: 'reveal', answerText: S.selectedAnswerText, salt: S.salt };
}

function updateCommitButtonState() {
  if (!S.prompt || S.committed || S.phase !== 'commit') {
    $('#commit-btn').disabled = true;
    return;
  }
  if (S.prompt.type === 'select') {
    $('#commit-btn').disabled = S.selectedOption === null;
    return;
  }
  $('#commit-btn').disabled = !validateOpenTextAnswer(S.selectedAnswerText, S.prompt);
}

function getRevealLabel(player) {
  if (player.revealedBucketLabel) {
    if (
      player.revealedInputText &&
      normalizeRevealText(player.revealedInputText) !==
        normalizeRevealText(player.revealedBucketLabel)
    ) {
      return `${player.revealedBucketLabel} (${player.revealedInputText})`;
    }
    return player.revealedBucketLabel;
  }
  if (player.revealedOptionLabel) return player.revealedOptionLabel;
  if (
    player.revealedOptionIndex !== null &&
    player.revealedOptionIndex !== undefined &&
    S.prompt &&
    S.prompt.type === 'select'
  ) {
    return S.prompt.options[player.revealedOptionIndex] || '?';
  }
  return '-';
}

// ── View switching ──────────────────────────────────────────────
function showView(name) {
  S.view = name;
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${name}-view`).classList.add('active');

  updateHeaderProfile();
  updateNavigation();
  if (name === 'queue') renderQueue();
}

// ── Display-name editor ─────────────────────────────────────────
function showDisplayNameEditor(statusText, tone = 'success') {
  updateHeaderProfile();
  setAuthStatus(statusText, tone);
  $('#name-section').classList.remove('hidden');
  $('#cancel-name-btn').classList.toggle('hidden', !S.accountId);
  $('#name-input').value = S.hasClaimedDisplayName ? S.displayName : '';
  $('#connect-wallet-btn').classList.add('hidden');
  $('#browser-wallet-btn').classList.add('hidden');
  $('.auth-divider').classList.add('hidden');
  $$('.browser-wallet-note').forEach(el => el.classList.add('hidden'));
  $('#show-import-btn').classList.add('hidden');
  $('#import-section').classList.add('hidden');
  $('#show-import-btn').setAttribute('aria-expanded', 'false');
  $('#import-input').value = '';
  requestAnimationFrame(() => $('#name-input').focus());
}

function openDisplayNameEditor(statusText) {
  const displayNameBlockMessage = getDisplayNameEditBlockMessage();
  if (displayNameBlockMessage) {
    notify(displayNameBlockMessage, 'error');
    return;
  }
  S.nameEditorReturnView = S.view === 'auth' ? 'queue' : S.view;
  showView('auth');
  showDisplayNameEditor(statusText, 'hint');
}

function closeDisplayNameEditor() {
  $('#name-section').classList.add('hidden');
  if (S.accountId) {
    showView(S.nameEditorReturnView || 'queue');
  }
}

// ── REST helpers ────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.error || err.message || res.statusText);
  }
  return res.json();
}

function setAuthStatus(message, tone = 'hint', { html = false } = {}) {
  const status = $('#auth-status');
  status.dataset.tone = tone;
  if (html) {
    status.innerHTML = message;
    return;
  }
  status.textContent = message;
}

function describeAuthError(err, action) {
  const raw = err instanceof Error ? err.message : String(err || 'Unexpected error');
  const normalized = raw.toLowerCase();

  if (
    normalized.includes('user rejected') ||
    normalized.includes('user denied') ||
    normalized.includes('cancelled') ||
    normalized.includes('canceled')
  ) {
    return 'Request canceled. Nothing changed.';
  }

  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed')
  ) {
    return 'Could not reach the local game server. Refresh and try again.';
  }

  if (normalized.includes('display name already claimed')) {
    return 'That display name is already taken. Try another one.';
  }

  if (normalized.includes('cannot change display name while queued')) {
    return 'Leave the queue before changing your display name.';
  }

  return `Could not ${action}. Please try again.`;
}

// ═══════════════════════════════════════════════════════════════
//  AUTH VIEW
// ═══════════════════════════════════════════════════════════════
async function authenticateWithWallet(address, signFn, { signingMsg, successMsg, isBrowserWallet }) {
  setAuthStatus('Requesting challenge...', 'pending');
  const challenge = await api('POST', '/api/auth/challenge', { walletAddress: address });

  setAuthStatus(signingMsg, 'pending');
  const signature = await signFn(challenge.message);

  setAuthStatus('Verifying signature...', 'pending');
  const result = await api('POST', '/api/auth/verify', {
    challengeId: challenge.challengeId,
    walletAddress: address,
    signature,
  });

  setAuthStatus(successMsg, 'success');

  S.walletAddress = address;
  S.accountId = result.accountId;
  S.tokenBalance = result.tokenBalance;
  S.isBrowserWallet = isBrowserWallet;
  S.hasClaimedDisplayName = !!result.displayName;

  S.displayName = result.displayName || (result.accountId.slice(0, 6) + '..' + result.accountId.slice(-4));
  onAuthComplete();
}

$('#connect-wallet-btn').addEventListener('click', async () => {
  if (!window.ethereum) {
    setAuthStatus(
      'No external wallet detected. Use Quick Start, or <a href="https://ethereum.org/en/wallets/find-wallet/" target="_blank" rel="noopener">install a wallet</a>.',
      'hint',
      { html: true },
    );
    return;
  }
  try {
    setAuthStatus('Requesting wallet connection...', 'pending');
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    await authenticateWithWallet(address, (msg) => signer.signMessage(msg), {
      signingMsg: 'Please sign the message in your wallet...',
      successMsg: 'Signed in.',
      isBrowserWallet: false,
    });
  } catch (err) {
    setAuthStatus(describeAuthError(err, 'connect your wallet'), 'error');
  }
});

$('#browser-wallet-btn').addEventListener('click', async () => {
  try {
    setAuthStatus('Setting up your wallet...', 'pending');
    const wallet = getOrCreateBrowserWallet();
    await authenticateWithWallet(wallet.address, (msg) => wallet.signMessage(msg), {
      signingMsg: 'Signing in...',
      successMsg: 'Signed in.',
      isBrowserWallet: true,
    });
  } catch (err) {
    setAuthStatus(describeAuthError(err, 'set up your browser wallet'), 'error');
  }
});

$('#claim-name-btn').addEventListener('click', async () => {
  const name = $('#name-input').value.trim();
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(name)) {
    setAuthStatus('Use 1-20 characters: A-Z, 0-9, _ or -.', 'error');
    return;
  }
  try {
    setAuthStatus('Saving your display name...', 'pending');
    await api('PATCH', '/api/me/profile', { displayName: name });
    S.displayName = name;
    S.hasClaimedDisplayName = true;
    $('#name-section').classList.add('hidden');
    showView(S.nameEditorReturnView || 'queue');
    updateHeaderProfile();
    refreshLiveWebSocketIdentity();
    notify('Display name saved.', 'success');
  } catch (err) {
    setAuthStatus(describeAuthError(err, 'save that display name'), 'error');
  }
});

$('#manage-name-btn').addEventListener('click', () => {
  openDisplayNameEditor(
    S.hasClaimedDisplayName
      ? 'Choose a new display name.'
      : 'Claim a human-readable display name.',
  );
});

$('#cancel-name-btn').addEventListener('click', () => {
  closeDisplayNameEditor();
});

$('#show-import-btn').setAttribute('aria-controls', 'import-section');
$('#show-import-btn').setAttribute('aria-expanded', 'false');
$('#show-import-btn').addEventListener('click', () => {
  const hidden = $('#import-section').classList.toggle('hidden');
  $('#show-import-btn').setAttribute('aria-expanded', hidden ? 'false' : 'true');
  if (hidden) $('#import-input').value = '';
});

$('#import-btn').addEventListener('click', async () => {
  const input = $('#import-input').value;
  if (!input.trim()) { setAuthStatus('Enter a seed phrase or private key to import a wallet.', 'error'); return; }
  try {
    setAuthStatus('Importing wallet...', 'pending');
    const { wallet, storageValue } = parseBrowserWallet(input);
    await authenticateWithWallet(wallet.address, (msg) => wallet.signMessage(msg), {
      signingMsg: 'Signing challenge...',
      successMsg: 'Wallet imported.',
      isBrowserWallet: true,
    });
    // Persist only after auth succeeds to avoid overwriting an existing browser wallet
    try {
      localStorage.setItem(BROWSER_KEY, storageValue);
    } catch (_) {
      notify('Wallet imported, but failed to save locally. You may need to re-import next time.', 'warn');
    }
    // Clear sensitive input from DOM
    $('#import-input').value = '';
    $('#import-section').classList.add('hidden');
    $('#show-import-btn').setAttribute('aria-expanded', 'false');
  } catch (err) {
    setAuthStatus(describeAuthError(err, 'import that wallet'), 'error');
  }
});

function closeSeedOverlay() {
  $('#seed-overlay').classList.add('hidden');
  $('#seed-phrase-text').value = '';
  $('#backup-seed-btn').focus();
}

$('#backup-seed-btn').addEventListener('click', () => {
  const mnemonic = getBrowserMnemonic();
  if (!mnemonic) {
    notify('No seed phrase available. This wallet was stored as a private key only (for example, imported via private key or created with an older version).', 'warn');
    return;
  }
  $('#seed-phrase-text').value = mnemonic;
  $('#seed-overlay').classList.remove('hidden');
  $('#close-seed-btn').focus();
});

$('#copy-seed-btn').addEventListener('click', () => {
  const text = $('#seed-phrase-text').value;
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    notify('Failed to copy. Please select and copy manually.', 'error');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => notify('Seed phrase copied to clipboard.', 'success'),
    () => notify('Failed to copy. Please select and copy manually.', 'error')
  );
});

$('#close-seed-btn').addEventListener('click', closeSeedOverlay);

// Close overlay on Escape or backdrop click; trap focus inside dialog
document.addEventListener('keydown', (e) => {
  if ($('#seed-overlay').classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeSeedOverlay(); return; }
  if (e.key === 'Tab') {
    const focusable = $('#seed-overlay').querySelectorAll('button, textarea, input, select, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('#seed-overlay').addEventListener('click', (e) => {
  if (e.target === $('#seed-overlay')) closeSeedOverlay();
});

// ── Rules overlay ──────────────────────────────────────────────
function closeRulesOverlay() {
  $('#rules-overlay').classList.add('hidden');
  $('#nav-rules').focus();
}

$('#nav-rules').addEventListener('click', () => {
  $('#rules-overlay').classList.remove('hidden');
  $('#close-rules-btn').focus();
});

$('#close-rules-btn').addEventListener('click', closeRulesOverlay);

document.addEventListener('keydown', (e) => {
  if ($('#rules-overlay').classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeRulesOverlay(); return; }
  if (e.key === 'Tab') {
    const focusable = $('#rules-overlay').querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('#rules-overlay').addEventListener('click', (e) => {
  if (e.target === $('#rules-overlay')) closeRulesOverlay();
});

function hasSelfForfeited() {
  return !!S.displayName && S.playerStatuses[S.displayName] === 'forfeited';
}

function closeForfeitOverlay({ restoreFocus = true } = {}) {
  $('#forfeit-overlay').classList.add('hidden');
  $('#confirm-forfeit-btn').disabled = false;
  if (restoreFocus && !$('#forfeit-match-btn').disabled) {
    $('#forfeit-match-btn').focus();
  }
}

function openForfeitOverlay() {
  if (!hasActiveMatch() || hasSelfForfeited()) return;
  $('#forfeit-overlay').classList.remove('hidden');
  $('#cancel-forfeit-btn').focus();
}

function syncReturnToMatchUi() {
  const label = hasSelfForfeited() ? 'Watch Match' : 'Back to Game';
  $('#return-to-game-btn').textContent = label;
  $('#nav-return-game').textContent = label;
}

function syncForfeitUi() {
  const activeMatch = hasActiveMatch();
  const selfForfeited = hasSelfForfeited();
  const button = $('#forfeit-match-btn');

  $('#forfeit-panel').classList.toggle('hidden', !activeMatch);
  $('#forfeit-panel').classList.toggle('is-locked', selfForfeited);
  button.disabled = !activeMatch || selfForfeited;
  $('#forfeit-status-banner').classList.toggle('hidden', !selfForfeited);

  $('#forfeit-panel-copy').textContent = selfForfeited
    ? 'Waiting for the match to finish so final standings can settle.'
    : 'Ends your participation for the rest of this run.';
  button.textContent = selfForfeited
    ? 'Forfeit Locked In'
    : 'Forfeit Match';
  syncReturnToMatchUi();

  if (!activeMatch || selfForfeited) {
    closeForfeitOverlay({ restoreFocus: false });
  }
}

$('#forfeit-match-btn').addEventListener('click', openForfeitOverlay);
$('#cancel-forfeit-btn').addEventListener('click', () => closeForfeitOverlay());
$('#confirm-forfeit-btn').addEventListener('click', () => {
  $('#confirm-forfeit-btn').disabled = true;
  wsSend({ type: 'forfeit_match' });
  closeForfeitOverlay({ restoreFocus: false });
});

document.addEventListener('keydown', (e) => {
  if ($('#forfeit-overlay').classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeForfeitOverlay(); return; }
  if (e.key === 'Tab') {
    const focusable = $('#forfeit-overlay').querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
$('#forfeit-overlay').addEventListener('click', (e) => {
  if (e.target === $('#forfeit-overlay')) closeForfeitOverlay();
});

function onAuthComplete() {
  intentionalClose = false;
  S.wsConnected = false;
  S.pendingQueueAction = null;
  connectWebSocket();
  showView('queue');
}

$('#logout-btn').addEventListener('click', async () => {
  intentionalClose = true;
  wsRetryCount = 0;
  wsQueueRecoveryPending = false;
  stopWebSocketHeartbeat();
  if (wsRetryTimer !== null) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  if (S.ws) { S.ws.close(); S.ws = null; }
  try {
    await api('POST', '/api/logout');
  } catch (_) {
    notify('Logout failed. Please try again.', 'error');
    intentionalClose = false;
    connectWebSocket();
    return;
  }
  S.walletAddress = null;
  S.accountId = null;
  S.displayName = null;
  S.hasClaimedDisplayName = false;
  S.tokenBalance = 0;
  S.isBrowserWallet = false;
  S.inQueue = false;
  S.queuedPlayers = [];
  S.wsConnected = false;
  S.pendingQueueAction = null;
  S.matchId = null;
  S.aiAssistedMatch = false;
  S.nameEditorReturnView = 'queue';
  $('#header-profile').classList.add('hidden');
  $('#connect-wallet-btn').classList.remove('hidden');
  $('#browser-wallet-btn').classList.remove('hidden');
  $('.auth-divider').classList.remove('hidden');
  $$('.browser-wallet-note').forEach(el => el.classList.remove('hidden'));
  $('#show-import-btn').classList.remove('hidden');
  $('#name-section').classList.add('hidden');
  $('#import-section').classList.add('hidden');
  $('#show-import-btn').setAttribute('aria-expanded', 'false');
  $('#import-input').value = '';
  $('#seed-overlay').classList.add('hidden');
  $('#seed-phrase-text').value = '';
  setAuthStatus('Choose how to identify yourself.');
  showView('auth');
});

// ── Check existing session on load ──────────────────────────────
async function checkSession() {
  try {
    const me = await api('GET', '/api/me');
    S.accountId = me.accountId;
    S.displayName = me.displayName;
    S.hasClaimedDisplayName = !!me.displayName;
    S.tokenBalance = me.tokenBalance;
    // Detect if this session belongs to a browser wallet
    try {
      const stored = localStorage.getItem(BROWSER_KEY);
      if (stored) {
        const gw = walletFromSecret(stored);
        if (gw.address.toLowerCase() === me.accountId.toLowerCase()) {
          S.isBrowserWallet = true;
        }
      }
    } catch (_) {
      try { localStorage.removeItem(BROWSER_KEY); } catch (_e) {}
    }
    if (!S.displayName) {
      S.displayName = S.accountId.slice(0, 6) + '..' + S.accountId.slice(-4);
    }
    onAuthComplete();
  } catch (_) {
    // not logged in; check if wallet is available
    if (!window.ethereum) {
      setAuthStatus(
        'No external wallet detected. Use Quick Start, or <a href="https://ethereum.org/en/wallets/find-wallet/" target="_blank" rel="noopener">install a wallet</a>.',
        'hint',
        { html: true },
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════════════
const WS_MAX_RETRIES = 10;
const WS_BASE_DELAY = 1000;
const WS_MAX_DELAY = 30000;
const WS_HEARTBEAT_INTERVAL_MS = 10000;
const WS_HEARTBEAT_TIMEOUT_MS = 12000;
let wsRetryCount = 0;
let intentionalClose = false;
let wsRetryTimer = null;
let wsHeartbeatTimer = null;
let wsPongTimeoutTimer = null;
let wsHeartbeatSocket = null;
let wsAwaitingPong = false;
let wsReconnectPaused = false;
let wsQueueRecoveryPending = false;
// Latched on a 4001 close; only a page refresh (script re-eval) clears it.
let buildMismatchTerminal = false;
const STALE_BUILD_REFRESH_MESSAGE =
  'A new version is available. Refresh this page to continue.';

function clearWebSocketRetryTimer() {
  if (wsRetryTimer !== null) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
}

function isPageVisible() {
  return document.visibilityState !== 'hidden';
}

function isNetworkOnline() {
  return navigator.onLine !== false;
}

function pauseWebSocketReconnect() {
  wsReconnectPaused = true;
  clearWebSocketRetryTimer();
}

function resumeWebSocketReconnect() {
  if (!S.accountId || !isPageVisible() || !isNetworkOnline()) return;
  const wasPaused = wsReconnectPaused;
  wsReconnectPaused = false;
  clearWebSocketRetryTimer();
  intentionalClose = false;
  if (isWebSocketOpen()) {
    startWebSocketHeartbeat(S.ws);
    return;
  }
  if (S.ws && S.ws.readyState === WebSocket.CONNECTING) return;
  if (wasPaused) {
    wsRetryCount = 0;
  }
  connectWebSocket();
}

function scheduleWebSocketReconnect() {
  if (!isPageVisible() || !isNetworkOnline()) {
    pauseWebSocketReconnect();
    return;
  }
  if (wsRetryCount >= WS_MAX_RETRIES) {
    notify('Connection lost. Please refresh the page.', 'error');
    return;
  }
  const delay = Math.min(WS_BASE_DELAY * Math.pow(2, wsRetryCount), WS_MAX_DELAY);
  wsRetryCount++;
  notify('Connection lost. Reconnecting (' + wsRetryCount + '/' + WS_MAX_RETRIES + ')...', 'warn');
  clearWebSocketRetryTimer();
  wsRetryTimer = setTimeout(() => {
    wsRetryTimer = null;
    if (!isPageVisible() || !isNetworkOnline()) {
      pauseWebSocketReconnect();
      return;
    }
    connectWebSocket();
  }, delay);
}

function isSocketReplacementClose(evt) {
  return evt && evt.code === 1000 && evt.reason === 'Replaced by new connection';
}

function isBuildMismatchClose(evt) {
  return evt && evt.code === 4001;
}

function readStampedClientBuild() {
  try {
    const stamp = document.querySelector('.build-stamp');
    const hash = stamp ? stamp.getAttribute('data-build-hash') : null;
    if (!hash || hash === '__BUILD_HASH__') return null;
    return /^[a-f0-9]{7,40}$/.test(hash) ? hash : null;
  } catch (_) {
    return null;
  }
}

function showTerminalClose(message) {
  try {
    const host = document.getElementById('notif');
    if (!host) return;
    const existing = host.querySelector('.notif-item.terminal');
    if (existing) {
      existing.textContent = message;
      return;
    }
    const el = document.createElement('div');
    el.className = 'notif-item error terminal';
    el.textContent = message;
    host.appendChild(el);
  } catch (_) {}
}

function stopWebSocketHeartbeat(targetSocket = null) {
  if (targetSocket && wsHeartbeatSocket !== targetSocket) return;
  if (wsHeartbeatTimer !== null) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
  if (wsPongTimeoutTimer !== null) {
    clearTimeout(wsPongTimeoutTimer);
    wsPongTimeoutTimer = null;
  }
  wsAwaitingPong = false;
  wsHeartbeatSocket = null;
}

function acknowledgeWebSocketLiveness() {
  wsAwaitingPong = false;
  if (wsPongTimeoutTimer !== null) {
    clearTimeout(wsPongTimeoutTimer);
    wsPongTimeoutTimer = null;
  }
}

function startWebSocketHeartbeat(targetSocket) {
  stopWebSocketHeartbeat();
  wsHeartbeatSocket = targetSocket;
  wsHeartbeatTimer = setInterval(() => {
    if (targetSocket !== S.ws || !isWebSocketOpen()) return;
    if (wsAwaitingPong) {
      notify('Connection heartbeat timed out. Reconnecting...', 'warn');
      try { targetSocket.close(4000, 'Heartbeat timeout'); } catch (_) {}
      return;
    }
    wsAwaitingPong = true;
    wsSend({ type: 'ping', sentAt: Date.now() });
    wsPongTimeoutTimer = setTimeout(() => {
      if (targetSocket !== S.ws || !wsAwaitingPong) return;
      notify('Connection heartbeat timed out. Reconnecting...', 'warn');
      try { targetSocket.close(4000, 'Heartbeat timeout'); } catch (_) {}
    }, WS_HEARTBEAT_TIMEOUT_MS);
  }, WS_HEARTBEAT_INTERVAL_MS);
}

function isWebSocketOpen() {
  return !!S.ws && S.ws.readyState === WebSocket.OPEN;
}

function ensureWebSocketConnection() {
  if (!S.accountId) return false;
  if (
    S.ws &&
    (S.ws.readyState === WebSocket.OPEN ||
      S.ws.readyState === WebSocket.CONNECTING)
  ) {
    return true;
  }
  wsReconnectPaused = false;
  intentionalClose = false;
  clearWebSocketRetryTimer();
  connectWebSocket();
  return true;
}

function refreshLiveWebSocketIdentity() {
  if (!S.accountId) return;
  clearWebSocketRetryTimer();
  wsReconnectPaused = false;
  intentionalClose = false;
  const previousWs = S.ws;
  if (
    previousWs &&
    (previousWs.readyState === WebSocket.OPEN ||
      previousWs.readyState === WebSocket.CONNECTING)
  ) {
    connectWebSocket();
    try { previousWs.close(1000, 'Identity refresh'); } catch (_) {}
    return;
  }
  connectWebSocket();
}

function queueQueueAction(action) {
  if (buildMismatchTerminal) {
    showTerminalClose(STALE_BUILD_REFRESH_MESSAGE);
    return;
  }
  const isNewAction = S.pendingQueueAction !== action;
  S.pendingQueueAction = action;
  renderQueue();
  if (!ensureWebSocketConnection()) {
    notify('Connection expired. Please sign in again.', 'error');
    return;
  }
  if (isNewAction) {
    notify(
      action === 'join'
        ? 'Connecting to the lobby. Your join will send automatically.'
        : 'Reconnecting. Your leave will send automatically.',
      'warn',
    );
  }
}

function flushPendingQueueAction() {
  if (!isWebSocketOpen() || !S.pendingQueueAction) return;
  const action = S.pendingQueueAction;
  S.pendingQueueAction = null;
  S.ws.send(
    JSON.stringify({ type: action === 'join' ? 'join_queue' : 'leave_queue' }),
  );
  renderQueue();
}

function connectWebSocket() {
  if (buildMismatchTerminal) return;
  if (!S.accountId) return;
  wsReconnectPaused = false;
  wsRetryTimer = null;
  S.wsConnected = false;
  stopWebSocketHeartbeat();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const clientBuild = readStampedClientBuild();
  const wsUrl = clientBuild
    ? `${proto}//${location.host}/ws?clientBuild=${encodeURIComponent(clientBuild)}`
    : `${proto}//${location.host}/ws`;
  S.ws = new WebSocket(wsUrl);
  const thisWs = S.ws;
  renderQueue();
  S.ws.onopen = () => {
    if (thisWs !== S.ws) return;
    wsRetryCount = 0;
    wsRetryTimer = null;
    S.wsConnected = true;
    if (isPageVisible()) {
      startWebSocketHeartbeat(thisWs);
    } else {
      stopWebSocketHeartbeat(thisWs);
    }
    flushPendingQueueAction();
    renderQueue();
  };
  S.ws.onerror = () => {
    if (thisWs !== S.ws) return;
    stopWebSocketHeartbeat(thisWs);
    S.wsConnected = false;
    renderQueue();
  };
  S.ws.onclose = (evt) => {
    stopWebSocketHeartbeat(thisWs);
    if (thisWs === S.ws) {
      S.wsConnected = false;
      renderQueue();
    }
    if (intentionalClose || thisWs !== S.ws) return;
    if (isSocketReplacementClose(evt)) {
      wsQueueRecoveryPending = false;
      showTerminalClose(
        'This session became active in another tab or window.',
      );
      return;
    }
    if (isBuildMismatchClose(evt)) {
      buildMismatchTerminal = true;
      intentionalClose = true;
      wsQueueRecoveryPending = false;
      S.pendingQueueAction = null;
      clearWebSocketRetryTimer();
      showTerminalClose(STALE_BUILD_REFRESH_MESSAGE);
      renderQueue();
      return;
    }
    wsQueueRecoveryPending =
      S.inQueue && !hasActiveMatch() && S.pendingQueueAction !== 'leave';
    scheduleWebSocketReconnect();
  };
  S.ws.onmessage = (evt) => {
    if (thisWs !== S.ws) return;
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (error) {
      console.error('WS: invalid message payload', error);
      notify('Received invalid server payload. Reconnecting...', 'warn');
      if (thisWs === S.ws) {
        try { thisWs.close(4002, 'Invalid payload'); } catch (_) {}
      }
      return;
    }
    acknowledgeWebSocketLiveness();
    handleMessage(msg);
  };
}

function wsSend(obj) {
  if (isWebSocketOpen()) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

document.addEventListener('visibilitychange', () => {
  if (isPageVisible()) {
    resumeWebSocketReconnect();
    return;
  }
  stopWebSocketHeartbeat(S.ws);
  pauseWebSocketReconnect();
});

window.addEventListener('online', () => {
  resumeWebSocketReconnect();
});

window.addEventListener('offline', () => {
  stopWebSocketHeartbeat(S.ws);
  pauseWebSocketReconnect();
});

window.addEventListener('beforeunload', () => {
  intentionalClose = true;
  stopWebSocketHeartbeat(S.ws);
  clearWebSocketRetryTimer();
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'queue_state': onQueueState(msg); break;
    case 'match_started': onMatchStarted(msg); break;
    case 'game_started': onGameStarted(msg); break;
    case 'commit_status': onCommitStatus(msg); break;
    case 'phase_change': onPhaseChange(msg); break;
    case 'reveal_status': onRevealStatus(msg); break;
    case 'game_result': onGameResult(msg); break;
    case 'match_over': onMatchOver(msg); break;
    case 'player_disconnected': onPlayerDisconnected(msg); break;
    case 'player_reconnected': onPlayerReconnected(msg); break;
    case 'player_forfeited': onPlayerForfeited(msg); break;
    case 'prompt_rating_tally': onPromptRatingTally(msg); break;
    case 'pong': break;
    case 'error': notify(msg.message, 'error'); break;
    default: break;
  }
}

function syncAiAssistedUi() {
  $('#off-record-banner').classList.toggle('hidden', !S.aiAssistedMatch);
  $('#summary-off-record-banner').classList.toggle('hidden', !S.aiAssistedMatch);
}

// ═══════════════════════════════════════════════════════════════
//  QUEUE VIEW
// ═══════════════════════════════════════════════════════════════
$('#join-queue-btn').addEventListener('click', () => {
  wsQueueRecoveryPending = false;
  S.startNow = false;
  syncStartNowUI();
  if (!wsSend({ type: 'join_queue' })) {
    queueQueueAction('join');
  }
});

$('#leave-queue-btn').addEventListener('click', () => {
  wsQueueRecoveryPending = false;
  S.startNow = false;
  syncStartNowUI();
  if (!wsSend({ type: 'leave_queue' })) {
    queueQueueAction('leave');
  }
});

function returnToGame() {
  if (!hasActiveMatch()) return;
  showView('play');
}

$('#return-to-game-btn').addEventListener('click', returnToGame);

$('#start-now-btn').addEventListener('click', () => {
  const nextValue = !S.startNow;
  S.startNow = nextValue;
  syncStartNowUI();
  wsSend({ type: 'set_start_now', value: nextValue });
});

function syncStartNowUI() {
  const btn = $('#start-now-btn');
  btn.setAttribute('aria-pressed', S.startNow ? 'true' : 'false');
  btn.textContent = S.startNow ? 'Ready' : 'Press Ready';
}

function onQueueState(msg) {
  if (
    wsQueueRecoveryPending &&
    msg.status === 'idle' &&
    !hasActiveMatch() &&
    S.pendingQueueAction !== 'leave' &&
    isWebSocketOpen()
  ) {
    wsQueueRecoveryPending = false;
    wsSend({ type: 'join_queue' });
    return;
  }
  if (msg.status !== 'idle') {
    wsQueueRecoveryPending = false;
  }
  S.pendingQueueAction = null;
  S.inQueue = msg.status === 'queued' || msg.status === 'forming';
  S.queuedPlayers = msg.queuedPlayers || [];
  S.formingMatch = msg.formingMatch || null;
  if (msg.startNow !== undefined) {
    S.startNow = msg.startNow;
  } else if (!S.formingMatch) {
    S.startNow = false;
  }
  updateNavigation();

  // ensure we are on queue view if we aren't playing
  if (S.view === 'auth') {
    showView('queue');
  }

  renderQueue();
}

function renderQueue() {
  const activeMatch = hasActiveMatch();
  const selfForfeited = hasSelfForfeited();
  const activeMatchBanner = $('#active-match-banner');
  const queueCount = S.queuedPlayers.length;
  updateHeaderProfile();
  $('#queue-count').textContent = queueCount;
  $('#queue-inline-count').textContent =
    queueCount === 1 ? '1 visible' : queueCount + ' visible';
  activeMatchBanner.classList.toggle('hidden', !activeMatch);
  activeMatchBanner.classList.toggle('is-forfeited', activeMatch && selfForfeited);
  if (activeMatch) {
    activeMatchBanner.innerHTML = selfForfeited
      ? '<strong>Forfeit locked in.</strong><span>You can stay in the lobby while the run finishes. Final standings will open automatically when the match ends. Use Watch Match only if you want to keep an eye on the board.</span>'
      : 'Active match in progress. Return to the game to keep committing and revealing on time.';
  } else {
    activeMatchBanner.innerHTML = '';
  }
  syncReturnToMatchUi();

  renderQueuePlayersList($('#queue-players-inline'));
  renderQueuePlayersList($('#queue-players'));

  // forming match
  if (S.formingMatch) {
    $('#forming-banner').classList.remove('hidden');
    $('#forming-count').textContent = S.formingMatch.playerCount;
    const readyCount = S.formingMatch.readyHumanCount || 0;
    const humanCount = S.formingMatch.humanPlayerCount || 0;
    $('#start-now-meta').textContent = readyCount + ' / ' + humanCount + ' humans ready to start';
    let note = 'Press ready to arm the 30s queue countdown. If every human gets ready, the match launches immediately.';
    if (S.startNow) {
      note = 'You are marked ready. The 30s queue countdown is running, and full readiness still launches immediately.';
    } else if (readyCount > 0) {
      note = 'At least one player is ready, so the 30s queue countdown is running. Press ready too if you want an immediate launch.';
    }
    $('#start-now-note').textContent = note;
    $('#forming-banner').classList.toggle('is-armed', readyCount > 0);
    $('#start-now-btn').classList.toggle('hidden', !S.formingMatch.youCanVoteStartNow);
    syncStartNowUI();
    updateFormingTimer();
  } else {
    $('#forming-banner').classList.add('hidden');
    $('#forming-banner').classList.remove('is-armed');
    S.startNow = false;
    syncStartNowUI();
    $('#forming-timer').textContent = 'Not started';
  }

  // buttons
  const joinBtn = $('#join-queue-btn');
  const leaveBtn = $('#leave-queue-btn');
  $('#return-to-game-btn').classList.toggle('hidden', !activeMatch);
  joinBtn.classList.toggle('hidden', activeMatch || S.inQueue);
  leaveBtn.classList.toggle('hidden', activeMatch || !S.inQueue);
  joinBtn.disabled = S.pendingQueueAction === 'join';
  leaveBtn.disabled = S.pendingQueueAction === 'leave';
  joinBtn.textContent =
    S.pendingQueueAction === 'join'
      ? S.wsConnected
        ? 'Joining...'
        : 'Connecting...'
      : 'Join Queue';
  leaveBtn.textContent =
    S.pendingQueueAction === 'leave'
      ? S.wsConnected
        ? 'Leaving...'
        : 'Connecting...'
      : 'Leave Queue';
}

function renderQueuePlayersList(list) {
  if (!list) return;
  list.innerHTML = '';
  if (S.queuedPlayers.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'queue-empty-state';
    empty.textContent = 'No visible players in queue yet.';
    list.appendChild(empty);
    return;
  }
  S.queuedPlayers.forEach(name => {
    const li = document.createElement('li');
    li.textContent = name;
    if (name === S.displayName) li.classList.add('is-self');
    list.appendChild(li);
  });
}

function updateFormingTimer() {
  if (!S.formingMatch || !S.formingMatch.fillDeadlineMs) {
    $('#forming-timer').textContent = 'Not started';
    return;
  }
  const remaining = Math.max(0, Math.ceil((S.formingMatch.fillDeadlineMs - Date.now()) / 1000));
  $('#forming-timer').textContent = remaining + 's';
}

// Update forming timer every second
setInterval(updateFormingTimer, 1000);

// ═══════════════════════════════════════════════════════════════
//  PLAY VIEW
// ═══════════════════════════════════════════════════════════════
function onMatchStarted(msg) {
  wsQueueRecoveryPending = false;
  if (S.matchId && S.matchId !== msg.matchId) {
    clearPersistedGameHistory(S.matchId);
  }
  S.pendingQueueAction = null;
  S.matchId = msg.matchId;
  S.aiAssistedMatch = !!msg.aiAssisted;
  S.inQueue = false;
  S.startNow = false;
  S.queuedPlayers = [];
  S.formingMatch = null;
  S.totalGames = msg.gameCount || S.totalGames;
  S.players = msg.players;
  S.game = 0;
  S.phase = null;
  S.prompt = null;
  S.selectedOption = null;
  S.selectedAnswerText = '';
  S.salt = null;
  S.commitHash = null;
  S.committed = false;
  S.revealed = false;
  S.summary = null;
  S.gameHistory = loadPersistedGameHistory(msg.matchId);
  S.playerStatuses = {};
  S.players.forEach(p => { S.playerStatuses[p.displayName] = 'connected'; });

  showView('play');
  syncAiAssistedUi();
  syncForfeitUi();
  renderPlayers();
  renderLiveReadout();
  $('#game-result-banner').classList.add('hidden');
  $('#phase-timer-label').textContent = 'Commit';
  $('#timer-progress').setAttribute('aria-valuemax', '100');
  $('#timer-progress').setAttribute('aria-valuenow', '0');
  $('#timer-progress').setAttribute('aria-valuetext', 'Waiting for first game');
  $('#timer-bar').style.width = '100%';
  $('#timer-bar').style.background = 'var(--accent)';
  $('#timer-num').textContent = '';
  $('#timer-num').classList.remove('urgent');
  announcePhase('Match started. Waiting for first game.');
  $('#question-text').textContent = 'Match started. Waiting for first game...';
  $('#select-grid').innerHTML = '';
  $('#commit-area').classList.add('hidden');
  $('#reveal-area').classList.add('hidden');
  if (S.aiAssistedMatch) {
    notify('AI backfill joined. This run is off the record.', '');
  } else {
    notify('Match started with ' + S.players.length + ' players', 'success');
  }
}

function onGameStarted(msg) {
  // Detect reconnect replay with recoverable preimage.
  // Cannot rely on S.game here: onMatchStarted() resets it to 0 before
  // this handler runs during reconnect replay. Use prompt.id as a
  // stable game identifier and verify we still hold the preimage.
  const hasLocalPreimage = hasRevealPreimageForPrompt(msg.prompt);
  const isSameGame = S.prompt && S.prompt.id === msg.prompt.id;
  const hasPreimage = !!msg.yourCommitted && isSameGame && hasLocalPreimage;

  S.game = msg.game;
  S.phase = msg.phase;
  S.prompt = msg.prompt;
  S.aiAssistedMatch = !!msg.aiAssisted;
  syncAiAssistedUi();

  if (hasPreimage) {
    // Reconnect with preimage intact: preserve selectedOption/salt/commitHash
    S.committed = true;
    S.revealed = !!msg.yourRevealed;
  } else if (msg.yourCommitted) {
    // Server says we committed but preimage is gone (page reload, etc.).
    // Can't reveal, but reflect the server-authoritative committed state.
    S.selectedOption = null;
    S.selectedAnswerText = '';
    S.salt = null;
    S.commitHash = null;
    S.committed = true;
    S.revealed = !!msg.yourRevealed;
  } else {
    // Fresh game start (not a reconnect)
    S.selectedOption = null;
    S.selectedAnswerText = '';
    S.salt = null;
    S.commitHash = null;
    S.committed = false;
    S.revealed = false;
  }

  S.commitStatuses = [];
  S.revealStatuses = [];
  S.gameResult = null;

  if (S.view !== 'play' && !hasSelfForfeited()) {
    // Reconnect replay should not yank a forfeited player back into the frozen play view.
    showView('play');
  }

  // UI: use server-provided phase for labels
  const phaseLabel = msg.phase === 'reveal' ? 'Auto-Reveal'
    : msg.phase === 'normalizing' ? 'Normalizing'
    : msg.phase === 'results' ? 'Settle' : 'Commit';
  $('#phase-label').textContent = `Game ${msg.game} / ${S.totalGames} : ${phaseLabel}`;
  const phaseTimerLabel = msg.phase === 'reveal' ? 'Auto-Reveal'
    : msg.phase === 'normalizing' ? 'Normalizing'
    : msg.phase === 'results' ? 'Settle'
    : msg.phase === 'commit' ? 'Commit' : '';
  $('#phase-timer-label').textContent = phaseTimerLabel;
  announcePhase(`Game ${msg.game} of ${S.totalGames}. ${phaseLabel} phase.`);
  $('#question-text').textContent = msg.prompt.text;
  $('#game-result-banner').classList.add('hidden');

  // Disable options if already committed or no longer in commit phase
  const alreadyCommitted = !!msg.yourCommitted;
  const optionsDisabled = alreadyCommitted || msg.phase !== 'commit';
  renderPromptInput(msg.prompt, optionsDisabled);

  // Only show commit controls during commit phase; for reveal/results the
  // subsequent phase_change message drives the UI.
  if (msg.phase === 'commit') {
    $('#commit-area').classList.remove('hidden');
    if (alreadyCommitted) {
      $('#commit-status').textContent = hasPreimage
        ? 'Committed. Waiting for others...'
        : 'Committed, but reveal key was lost (page reload). Cannot reveal this game.';
    } else {
      $('#commit-status').textContent = '';
      updateCommitButtonState();
    }
    $('#reveal-area').classList.add('hidden');
  } else {
    // Reconnect during reveal/normalizing/results: hide both; phase_change handles UI
    $('#commit-area').classList.add('hidden');
    $('#reveal-area').classList.add('hidden');
    if (msg.phase === 'normalizing') {
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = 'Normalizing open-text answers...';
    } else if (msg.yourRevealed) {
      // For reconnect during reveal when already committed+revealed, show status
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = 'Revealed. Waiting for others...';
    } else if (alreadyCommitted) {
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = hasPreimage
        ? 'Committed. Waiting for reveal phase...'
        : 'Committed, but reveal key was lost (page reload). Cannot reveal this game.';
    }
  }

  // Timer: only start during commit phase; reveal timer is driven by
  // phase_change. Results phase timer is started by onGameResult (which
  // is not replayed on reconnect), so clear stale timer state here.
  if (msg.phase === 'commit') {
    startTimer(msg.commitDuration);
  } else {
    // Clear any stale timer from a previous phase
    clearInterval(S.timerInterval);
    $('#timer-bar').style.width = msg.phase === 'normalizing' ? '100%' : '0%';
    $('#timer-bar').style.background =
      msg.phase === 'normalizing' ? 'rgba(201,168,76,.45)' : 'var(--accent)';
    $('#timer-num').textContent = msg.phase === 'normalizing' ? '--' : '';
    $('#timer-num').classList.remove('urgent');
  }

  // Reset player dots
  renderPlayers();
  renderLiveReadout();
}

function renderPromptInput(prompt, disabled) {
  const grid = $('#select-grid');
  grid.innerHTML = '';

  if (prompt.type === 'select') {
    prompt.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt-btn' + (disabled ? ' disabled' : '');
      if (S.selectedOption === idx) {
        btn.classList.add('selected');
      }
      btn.textContent = opt;
      btn.dataset.idx = idx;
      btn.disabled = disabled;
      btn.addEventListener('click', () => selectOption(idx, btn));
      btn.addEventListener('keydown', (event) => {
        if (!shouldHandleCommitShortcut(event)) return;
        if (S.selectedOption !== idx) return;
        event.preventDefault();
        void submitCommit();
      });
      grid.appendChild(btn);
    });
    return;
  }

  if (prompt.answerSpec.kind === 'playing_card') {
    renderPlayingCardInput(prompt, disabled, grid);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'text-answer-wrap';
  wrap.style.gridColumn = '1 / -1';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = prompt.maxLength;
  input.value = S.selectedAnswerText;
  input.disabled = disabled;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.autocapitalize = 'none';
  input.autocorrect = 'off';
  input.addEventListener('input', (event) => {
    if (S.committed || S.phase !== 'commit') return;
    S.selectedAnswerText = event.target.value;
    updateCommitButtonState();
  });
  input.addEventListener('keydown', (event) => {
    if (!shouldHandleCommitShortcut(event)) return;
    if (!validateOpenTextAnswer(S.selectedAnswerText, prompt)) return;
    event.preventDefault();
    void submitCommit();
  });

  const hint = document.createElement('div');
  hint.className = 'text-answer-hint';
  const answerHint = prompt.answerSpec.kind === 'integer_range'
    ? `Enter an integer from ${prompt.answerSpec.min} to ${prompt.answerSpec.max}.`
    : prompt.answerSpec.kind === 'playing_card'
      ? 'Enter one playing card only.'
      : prompt.answerSpec.kind === 'single_word'
        ? 'One word only.'
        : 'One short answer only.';
  hint.textContent = `${answerHint} Max ${prompt.maxLength} characters.`;

  wrap.appendChild(input);
  wrap.appendChild(hint);
  grid.appendChild(wrap);
}

function renderPlayingCardInput(prompt, disabled, grid) {
  const wrap = document.createElement('div');
  wrap.className = 'text-answer-wrap';
  wrap.style.gridColumn = '1 / -1';

  const pickerGrid = document.createElement('div');
  pickerGrid.className = 'card-picker-grid';

  const currentSelection = getPlayingCardSelection(S.selectedAnswerText);
  if (currentSelection.label && currentSelection.label !== S.selectedAnswerText) {
    S.selectedAnswerText = currentSelection.label;
  }

  const rankSelect = document.createElement('select');
  rankSelect.disabled = disabled;
  rankSelect.setAttribute('aria-label', 'Card rank');

  const rankPlaceholder = document.createElement('option');
  rankPlaceholder.value = '';
  rankPlaceholder.textContent = 'Choose rank';
  rankSelect.appendChild(rankPlaceholder);
  CARD_RANK_OPTIONS.forEach((rank) => {
    const option = document.createElement('option');
    option.value = rank;
    option.textContent = rank;
    option.selected = rank === currentSelection.rank;
    rankSelect.appendChild(option);
  });

  const suitSelect = document.createElement('select');
  suitSelect.disabled = disabled;
  suitSelect.setAttribute('aria-label', 'Card suit');

  const suitPlaceholder = document.createElement('option');
  suitPlaceholder.value = '';
  suitPlaceholder.textContent = 'Choose suit';
  suitSelect.appendChild(suitPlaceholder);
  CARD_SUIT_OPTIONS.forEach((suit) => {
    const option = document.createElement('option');
    option.value = suit.value;
    option.textContent = suit.label;
    option.selected = suit.value === currentSelection.suit;
    suitSelect.appendChild(option);
  });

  const preview = document.createElement('div');
  preview.className = 'card-picker-preview';

  const syncPlayingCardSelection = () => {
    const rank = rankSelect.value;
    const suit = suitSelect.value;
    S.selectedAnswerText = rank && suit ? `${rank} of ${suit}` : '';
    preview.textContent = S.selectedAnswerText
      ? `Locking in: ${S.selectedAnswerText}`
      : 'Choose both a rank and a suit.';
    updateCommitButtonState();
  };

  rankSelect.addEventListener('change', () => {
    if (S.committed || S.phase !== 'commit') return;
    syncPlayingCardSelection();
  });
  rankSelect.addEventListener('keydown', (event) => {
    if (!shouldHandleCommitShortcut(event)) return;
    if (!validateOpenTextAnswer(S.selectedAnswerText, prompt)) return;
    event.preventDefault();
    void submitCommit();
  });
  suitSelect.addEventListener('change', () => {
    if (S.committed || S.phase !== 'commit') return;
    syncPlayingCardSelection();
  });
  suitSelect.addEventListener('keydown', (event) => {
    if (!shouldHandleCommitShortcut(event)) return;
    if (!validateOpenTextAnswer(S.selectedAnswerText, prompt)) return;
    event.preventDefault();
    void submitCommit();
  });

  const rankField = document.createElement('label');
  rankField.className = 'card-picker-field';
  const rankLabel = document.createElement('span');
  rankLabel.className = 'card-picker-label';
  rankLabel.textContent = 'Rank';
  rankField.appendChild(rankLabel);
  rankField.appendChild(rankSelect);

  const suitField = document.createElement('label');
  suitField.className = 'card-picker-field';
  const suitLabel = document.createElement('span');
  suitLabel.className = 'card-picker-label';
  suitLabel.textContent = 'Suit';
  suitField.appendChild(suitLabel);
  suitField.appendChild(suitSelect);

  pickerGrid.appendChild(rankField);
  pickerGrid.appendChild(suitField);

  const hint = document.createElement('div');
  hint.className = 'text-answer-hint';
  hint.textContent = 'Choose a rank and a suit. We will format the card name for you.';

  syncPlayingCardSelection();

  wrap.appendChild(pickerGrid);
  wrap.appendChild(preview);
  wrap.appendChild(hint);
  grid.appendChild(wrap);
}

function selectOption(idx, sourceButton = null) {
  if (S.committed || S.phase !== 'commit') return;
  S.selectedOption = idx;
  S.selectedAnswerText = '';
  $$('.opt-btn').forEach(b => b.classList.toggle('selected', parseInt(b.dataset.idx) === idx));
  if (sourceButton instanceof HTMLElement) {
    sourceButton.focus();
  }
  updateCommitButtonState();
}

// ── Commit ───────────────────────────────────────────────────────
function isBlockingOverlayOpen() {
  return (
    !$('#seed-overlay').classList.contains('hidden') ||
    !$('#rules-overlay').classList.contains('hidden') ||
    !$('#forfeit-overlay').classList.contains('hidden')
  );
}

function isPlainEnterCommitEvent(event) {
  return (
    event.key === 'Enter' &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

function shouldHandleCommitShortcut(event) {
  return (
    isPlainEnterCommitEvent(event) &&
    S.view === 'play' &&
    S.phase === 'commit' &&
    !S.committed &&
    !isBlockingOverlayOpen()
  );
}

async function submitCommit() {
  if (!S.prompt || S.committed) return;
  if (S.prompt.type === 'select' && S.selectedOption === null) return;
  if (
    S.prompt.type === 'open_text' &&
    !validateOpenTextAnswer(S.selectedAnswerText, S.prompt)
  ) {
    return;
  }

  // Generate salt
  S.salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Create hash
  const commitValue = S.prompt.type === 'select'
    ? String(S.selectedOption)
    : canonicalizeOpenTextAnswer(S.selectedAnswerText, S.prompt)?.canonicalCommitText;
  if (commitValue === null || commitValue === undefined) return;
  const preimage = `${commitValue}:${S.salt}`;
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
  S.commitHash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  wsSend({ type: 'commit', hash: S.commitHash });
  S.committed = true;

  $('#commit-btn').disabled = true;
  $('#commit-status').textContent = 'Committed. Waiting for others...';
  $$('.opt-btn').forEach(b => b.classList.add('disabled'));
}

$('#commit-btn').addEventListener('click', () => {
  void submitCommit();
});

function onCommitStatus(msg) {
  S.commitStatuses = msg.committed;
  updatePlayerDots();
}

// ── Phase change to reveal ──────────────────────────────────────
function onPhaseChange(msg) {
  if (msg.phase === 'reveal') {
    S.phase = 'reveal';
    $('#phase-label').textContent = `Game ${S.game} / ${S.totalGames} : Auto-Reveal`;
    $('#phase-timer-label').textContent = 'Auto-Reveal';
    announcePhase(`Game ${S.game} of ${S.totalGames}. Auto-reveal phase.`);
    $('#commit-area').classList.add('hidden');

    const revealPayload = getCurrentRevealPayload();
    if (S.committed && !S.revealed && revealPayload) {
      // Auto-reveal: centralized server, no reason to hold back
      wsSend(revealPayload);
      S.revealed = true;
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = 'Revealed. Waiting for others...';
    } else if (S.committed && S.revealed) {
      // Already revealed before reconnect; restore status display
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = 'Revealed. Waiting for others...';
    } else if (S.committed && !S.revealed) {
      // Committed but preimage lost (page reload after commit): can't reveal
      $('#commit-area').classList.remove('hidden');
      $('#commit-status').textContent = 'Committed, but reveal key was lost. Cannot reveal this game.';
    } else if (!S.committed) {
      $('#reveal-area').classList.add('hidden');
      $('#commit-status').textContent = 'You did not commit in time.';
      $('#commit-area').classList.remove('hidden');
    }

    startTimer(msg.revealDuration);
    renderLiveReadout();
    return;
  }

  if (msg.phase === 'normalizing') {
    S.phase = 'normalizing';
    $('#phase-label').textContent = `Game ${S.game} / ${S.totalGames} : Normalizing`;
    $('#phase-timer-label').textContent = 'Normalizing';
    $('#commit-area').classList.remove('hidden');
    $('#reveal-area').classList.add('hidden');
    $('#commit-status').textContent = msg.status || 'Normalizing open-text answers...';
    clearInterval(S.timerInterval);
    $('#timer-bar').style.width = '100%';
    $('#timer-bar').style.background = 'rgba(201,168,76,.45)';
    $('#timer-num').textContent = '--';
    $('#timer-num').classList.remove('urgent');
    renderLiveReadout();
  }
}

// ── Reveal ───────────────────────────────────────────────────────
$('#reveal-btn').addEventListener('click', () => {
  const revealPayload = getCurrentRevealPayload();
  if (S.revealed || !revealPayload) return;
  wsSend(revealPayload);
  S.revealed = true;
  $('#reveal-btn').disabled = true;
  $('#reveal-status').textContent = 'Revealed. Waiting for others...';
});

function onRevealStatus(msg) {
  S.revealStatuses = msg.revealed;
  updatePlayerDots();
}

// ── Game result ──────────────────────────────────────────────────
function onGameResult(msg) {
  const r = msg.result;
  S.gameResult = r;
  S.phase = 'results';

  $('#phase-label').textContent = `Game ${S.game} / ${S.totalGames} : Settle`;
  $('#phase-timer-label').textContent = 'Settle';
  announcePhase(`Game ${S.game} settled. Results phase.`);
  $('#commit-area').classList.add('hidden');
  $('#reveal-area').classList.add('hidden');

  startTimer(msg.resultsDuration);

  // Update local balance
  const me = r.players.find(p => p.displayName === S.displayName);
  if (me) {
    S.tokenBalance = me.newBalance;
    $('#header-balance').textContent = S.tokenBalance + ' tokens';
  }

  // Update player balances
  r.players.forEach(rp => {
    const sp = S.players.find(p => p.displayName === rp.displayName);
    if (sp) sp.currentBalance = rp.newBalance;
  });

  storeGameHistoryEntry(r);
  renderGameResult(r);
  renderPlayers();
  renderLiveReadout({ flash: true });
}

function renderGameResult(r) {
  const banner = $('#game-result-banner');
  banner.classList.remove('hidden');
  $('#result-game-num').textContent = r.gameNum;

  // Reset rating row
  S.myRating = null;
  $('#rating-likes').textContent = '0';
  $('#rating-dislikes').textContent = '0';
  $('#rating-like').classList.remove('btn-primary');
  $('#rating-dislike').classList.remove('btn-primary');
  $('#rating-like').disabled = false;
  $('#rating-dislike').disabled = false;
  if (!r.voided) {
    $('#rating-row').classList.remove('hidden');
  } else {
    $('#rating-row').classList.add('hidden');
  }

  // Void banner
  if (r.voided) {
    $('#void-banner').classList.remove('hidden');
    $('#void-banner').textContent = 'Game voided: ' + (r.voidReason || 'all antes refunded');
  } else {
    $('#void-banner').classList.add('hidden');
  }

  // Result table
  const tbody = $('#result-tbody');
  tbody.innerHTML = '';
  r.players.forEach(p => {
    const tr = document.createElement('tr');
    const revealLabel = getRevealLabel(p);
    const deltaClass = p.netDelta > 0 ? 'delta-pos' : (p.netDelta < 0 ? 'delta-neg' : 'delta-zero');
    const deltaStr = p.netDelta > 0 ? '+' + p.netDelta : String(p.netDelta);

    tr.innerHTML = `
      <td>${esc(p.displayName)}</td>
      <td>${esc(revealLabel)}</td>
      <td class="${p.wonGame ? 'won-yes' : 'won-no'}">${p.wonGame ? 'Yes' : 'No'}</td>
      <td class="${p.earnsCoordinationCredit ? 'credit-yes' : ''}">${p.earnsCoordinationCredit ? 'Yes' : 'No'}</td>
      <td class="${deltaClass}">${deltaStr}</td>
      <td>${p.newBalance}</td>
    `;
    tbody.appendChild(tr);
  });

  // Note about solo wins
  const note = $('#result-note');
  if (S.aiAssistedMatch) {
    note.textContent = 'AI-assisted match: off the record. Winners are shown, but balances and coordination stats do not change.';
  } else if (!r.voided) {
    const hasWinnerNoCredit = r.players.some(p => p.wonGame && !p.earnsCoordinationCredit);
    if (hasWinnerNoCredit) {
      note.textContent = 'Solo win: won the pot but no coordination credit earned (topCount=1). Does not extend streak.';
    } else {
      note.textContent = '';
    }
  } else {
    note.textContent = '';
  }
}

// ── Player status dots ──────────────────────────────────────────
function updatePlayerDots() {
  $$('.player-row .dot').forEach(dot => {
    const name = dot.dataset.name;
    if (!name) return;
    const row = dot.closest('.player-row');
    const status = getPlayerStatusInfo(name);
    dot.className = `dot ${status.className}`.trim();
    dot.setAttribute('aria-hidden', 'true');
    if (row) {
      const statusText = row.querySelector('.player-status-text');
      const balance = row.querySelector('.balance-badge')?.textContent?.trim() ?? '';
      if (statusText) statusText.textContent = status.label;
      row.setAttribute('aria-label', `${name}, ${status.label}${balance ? `, balance ${balance}` : ''}`);
    }
  });
}

function renderPlayers() {
  const list = $('#players-list');
  list.innerHTML = '';
  S.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const bal = p.currentBalance !== undefined ? p.currentBalance : p.startingBalance;
    const status = getPlayerStatusInfo(p.displayName);
    row.setAttribute('aria-label', `${p.displayName}, ${status.label}, balance ${bal}`);
    row.innerHTML = `
      <div class="player-name">
        <span class="dot ${status.className}" data-name="${esc(p.displayName)}" aria-hidden="true"></span>
        <span>${esc(p.displayName)}</span>
        <span class="player-status-text">${esc(status.label)}</span>
      </div>
      <span class="balance-badge">${bal}</span>
    `;
    list.appendChild(row);
  });
  updatePlayerDots();
}

function renderLiveReadout({ flash = false } = {}) {
  if (!hasActiveMatch()) return;

  const strip = $('#live-stats-strip');
  const grid = $('#live-stats-grid');
  const headline = $('#live-stats-headline');
  const subhead = $('#live-stats-subhead');
  const foot = $('#live-stats-foot');
  const panel = $('#live-stats-panel');
  const totalGames = S.totalGames || 10;
  const settledGames = getSettledGameCount();
  const remainingGames = Math.max(0, totalGames - settledGames);
  const historyComplete = hasCompleteGameHistory(settledGames);
  const standings = getLiveStandings();
  const me = standings.find((player) => player.displayName === S.displayName) || null;
  const placement = me ? getLivePlacement(standings, me.liveBalance) : null;
  const net = me ? me.liveBalance - me.startingBalance : 0;
  const wins = historyComplete ? countCapturedGameResults((player) => player.wonGame, settledGames) : null;
  const coordinationHits = historyComplete
    ? countCapturedGameResults((player) => player.earnsCoordinationCredit, settledGames)
    : null;
  const coordinationStreak = historyComplete
    ? getCurrentCoordinationStreak(settledGames)
    : null;

  headline.textContent = settledGames === 0
    ? 'Opening read pending'
    : placement && me
      ? `${placement.tied ? 'Tied ' : ''}${ordinal(placement.rank)} at ${formatDelta(net)}`
      : 'Live readout unavailable';
  subhead.textContent = settledGames === 0
    ? 'The first settle will start the readout.'
    : historyComplete
      ? `${wins} pot win${wins === 1 ? '' : 's'}, ${coordinationHits} coordination hit${coordinationHits === 1 ? '' : 's'}, ${remainingGames} game${remainingGames === 1 ? '' : 's'} left.`
      : `${settledGames} game${settledGames === 1 ? '' : 's'} settled. Earlier results were not captured in this browser.`;

  grid.innerHTML = [
    { label: 'Standing', value: placement ? `${placement.tied ? 'T-' : ''}${placement.rank} / ${standings.length}` : '—', className: '' },
    { label: 'Net', value: me ? formatDelta(net) : '—', className: me ? deltaClassName(net) : '' },
    { label: 'Settled', value: `${settledGames} / ${totalGames}`, className: '' },
    { label: 'Coord Streak', value: settledGames === 0 || coordinationStreak === null ? '—' : `${coordinationStreak}`, className: '' },
  ].map((stat) => `
    <div class="live-stat-row">
      <span class="live-stat-label">${esc(stat.label)}</span>
      <span class="live-stat-value ${stat.className}">${esc(stat.value)}</span>
    </div>
  `).join('');

  strip.innerHTML = '';
  strip.style.gridTemplateColumns = `repeat(${totalGames}, minmax(0, 1fr))`;
  for (let index = 0; index < totalGames; index++) {
    const game = S.gameHistory[index];
    const mine = getMyRound(game);
    const step = document.createElement('div');
    const bar = document.createElement('div');
    const label = document.createElement('div');
    const gameNumber = index + 1;
    const classes = ['live-step'];
    let title = `Game ${gameNumber}: not settled yet.`;

    if (game) {
      if (mine?.result === 'forfeited') {
        classes.push('forfeited');
        title = `Game ${gameNumber}: you were already forfeited from the match.`;
      } else if (game.voided) {
        classes.push('void');
        title = `Game ${gameNumber}: voided${game.voidReason ? ` (${game.voidReason})` : ''}.`;
      } else if (mine?.wonGame) {
        classes.push('win');
        title = `Game ${gameNumber}: won ${formatDelta(mine.netDelta)} on ${quoteLabel(mine.revealedOptionLabel || 'no valid reveal')}.`;
      } else {
        classes.push('loss');
        title = `Game ${gameNumber}: missed ${quoteLabel(mine?.revealedOptionLabel || 'no valid reveal')} for ${formatDelta(mine?.netDelta ?? 0)}.`;
      }
      if (mine?.earnsCoordinationCredit) {
        classes.push('coord');
        title += ' Coordination credit earned.';
      }
    } else if (gameNumber <= settledGames) {
      classes.push('unknown');
      title = `Game ${gameNumber}: settled before this browser captured the result.`;
    } else {
      classes.push('future');
    }

    if (S.phase !== 'results' && S.game === gameNumber) {
      classes.push('current');
      title = game
        ? `${title} Current game in progress.`
        : `Game ${gameNumber}: in progress.`;
    }

    step.className = classes.join(' ');
    step.title = title;
    bar.className = 'live-step-bar';
    label.className = 'live-step-label';
    label.textContent = gameNumber;
    step.appendChild(bar);
    step.appendChild(label);
    strip.appendChild(step);
  }

  foot.textContent = S.aiAssistedMatch
    ? 'Off the record match. This readout tracks the run, but persistent balances and streaks stay unchanged.'
    : settledGames === 0
      ? 'The rail wakes up after the first settle. From there it tracks wins, misses, voids, and coordination hits.'
    : historyComplete
      ? 'Green bars won the pot. Gold dots mark rounds that counted as real coordination.'
      : 'The balance and standing are live. Round-by-round stats resume as soon as this browser sees the next settle.';

  if (flash) {
    panel.classList.remove('is-updated');
    void panel.offsetWidth;
    panel.classList.add('is-updated');
  }
}

function getSettledGameCount() {
  const completedFromPhase = S.game === 0
    ? 0
    : S.phase === 'results'
      ? S.game
      : Math.max(0, S.game - 1);
  return Math.min(
    S.totalGames || 10,
    Math.max(completedFromPhase, S.gameHistory.filter(Boolean).length),
  );
}

function hasCompleteGameHistory(settledGames) {
  for (let index = 0; index < settledGames; index++) {
    if (!S.gameHistory[index]) return false;
  }
  return true;
}

function getLiveStandings() {
  return [...S.players]
    .map((player) => ({
      ...player,
      liveBalance:
        player.currentBalance !== undefined
          ? player.currentBalance
          : player.startingBalance,
    }))
    .sort((a, b) =>
      b.liveBalance - a.liveBalance
      || b.startingBalance - a.startingBalance
      || a.displayName.localeCompare(b.displayName)
    );
}

function getLivePlacement(standings, liveBalance) {
  const higherStacks = standings.filter((player) => player.liveBalance > liveBalance).length;
  const tiedStacks = standings.filter((player) => player.liveBalance === liveBalance).length;
  return {
    rank: higherStacks + 1,
    tied: tiedStacks > 1,
  };
}

function countCapturedGameResults(predicate, settledGames) {
  let count = 0;
  for (let index = 0; index < settledGames; index++) {
    const mine = getMyRound(S.gameHistory[index]);
    if (mine && predicate(mine)) count += 1;
  }
  return count;
}

function getCurrentCoordinationStreak(settledGames) {
  let streak = 0;
  for (let index = settledGames - 1; index >= 0; index--) {
    const mine = getMyRound(S.gameHistory[index]);
    if (!mine?.earnsCoordinationCredit) break;
    streak += 1;
  }
  return streak;
}

// ── Player events ───────────────────────────────────────────────
function onPlayerDisconnected(msg) {
  S.playerStatuses[msg.displayName] = 'disconnected';
  notify(msg.displayName + ' disconnected (' + msg.graceSeconds + 's grace)', 'warn');
  updatePlayerDots();
}

function onPlayerReconnected(msg) {
  S.playerStatuses[msg.displayName] = 'connected';
  notify(msg.displayName + ' reconnected', 'success');
  updatePlayerDots();
}

function onPlayerForfeited(msg) {
  S.playerStatuses[msg.displayName] = 'forfeited';
  if (msg.futureGamesPenaltyApplied) {
    const player = S.players.find((entry) => entry.displayName === msg.displayName);
    if (player) {
      const futureGames = Math.max(0, (S.totalGames || 10) - S.game);
      const currentBalance = player.currentBalance !== undefined
        ? player.currentBalance
        : player.startingBalance;
      player.currentBalance = currentBalance - futureGames * 2520;
      if (msg.displayName === S.displayName) {
        S.tokenBalance = player.currentBalance;
        $('#header-balance').textContent = S.tokenBalance + ' tokens';
      }
    }
  }
  if (msg.displayName === S.displayName) {
    $('#commit-area').classList.add('hidden');
    $('#reveal-area').classList.add('hidden');
    $$('.opt-btn').forEach((btn) => btn.classList.add('disabled'));
    clearInterval(S.timerInterval);
    $('#phase-timer-label').textContent = 'Status';
    $('#timer-bar').style.width = '100%';
    $('#timer-bar').style.background = 'rgba(229,57,53,.45)';
    $('#timer-num').textContent = '--';
    $('#timer-num').classList.remove('urgent');
    notify(
      msg.futureGamesPenaltyApplied
        ? 'You forfeited the match. Final standings will open automatically when the run ends.'
        : 'You forfeited this AI-assisted match. Final standings will open automatically when the run ends.',
      'warn',
    );
  } else if (msg.futureGamesPenaltyApplied) {
    notify(msg.displayName + ' forfeited', 'error');
  } else {
    notify(msg.displayName + ' forfeited. This off-the-record AI match applies no remaining-game penalty.', 'warn');
  }
  renderPlayers();
  renderLiveReadout();
  syncForfeitUi();
  if (msg.displayName === S.displayName && S.view === 'play') {
    showView('queue');
  }
}

// ── Timer ────────────────────────────────────────────────────────
function startTimer(seconds) {
  clearInterval(S.timerInterval);
  S.timerDuration = seconds;
  S.timerEnd = Date.now() + seconds * 1000;
  const progress = $('#timer-progress');
  progress.setAttribute('aria-valuemax', String(seconds));
  progress.setAttribute('aria-valuenow', String(seconds));
  progress.setAttribute('aria-valuetext', `${seconds} seconds remaining`);
  tickTimer();
  S.timerInterval = setInterval(tickTimer, 250);
}

function tickTimer() {
  const remaining = Math.max(0, (S.timerEnd - Date.now()) / 1000);
  const pct = Math.max(0, remaining / S.timerDuration * 100);
  const bar = $('#timer-bar');
  const num = $('#timer-num');
  const progress = $('#timer-progress');
  const remainingSeconds = Math.ceil(remaining);
  bar.style.width = pct + '%';
  num.textContent = remainingSeconds;
  progress.setAttribute('aria-valuenow', String(remainingSeconds));
  progress.setAttribute('aria-valuetext', `${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'} remaining`);
  if (remaining <= 5) {
    bar.style.background = 'var(--red)';
    num.classList.add('urgent');
  } else {
    bar.style.background = 'var(--accent)';
    num.classList.remove('urgent');
  }
  if (remaining <= 0) clearInterval(S.timerInterval);
}

function getPlayerStatusInfo(name) {
  if (S.playerStatuses[name] === 'forfeited') {
    return { className: 'forfeited', label: 'Forfeited' };
  }
  if (S.playerStatuses[name] === 'disconnected') {
    return { className: 'disconnected', label: 'Disconnected' };
  }

  const revealed = S.revealStatuses.find((s) => s.displayName === name);
  if (revealed && revealed.hasRevealed) {
    return { className: 'revealed', label: 'Revealed' };
  }

  const committed = S.commitStatuses.find((s) => s.displayName === name);
  if (committed && committed.hasCommitted) {
    return { className: 'committed', label: 'Committed' };
  }

  return { className: '', label: 'Connected' };
}

function announcePhase(message) {
  $('#phase-announcer').textContent = message;
}

// ── Prompt rating ───────────────────────────────────────────────
function sendRating(rating) {
  if (S.myRating === rating) return; // already voted this
  S.myRating = rating;
  wsSend({ type: 'prompt_rating', rating });
  // Optimistic highlight
  $('#rating-like').classList.toggle('btn-primary', rating === 'like');
  $('#rating-dislike').classList.toggle('btn-primary', rating === 'dislike');
}

function onPromptRatingTally(msg) {
  $('#rating-likes').textContent = msg.likes ?? 0;
  $('#rating-dislikes').textContent = msg.dislikes ?? 0;
  // Restore player's own rating on reconnect replay
  if (msg.yourRating !== undefined) {
    S.myRating = msg.yourRating;
    $('#rating-like').classList.toggle('btn-primary', msg.yourRating === 'like');
    $('#rating-dislike').classList.toggle('btn-primary', msg.yourRating === 'dislike');
  }
}

$('#rating-like').addEventListener('click', () => sendRating('like'));
$('#rating-dislike').addEventListener('click', () => sendRating('dislike'));

// ═══════════════════════════════════════════════════════════════
//  GAME OVER / SUMMARY
// ═══════════════════════════════════════════════════════════════
function onMatchOver(msg) {
  const finishedMatchId = S.matchId;
  S.aiAssistedMatch = !!msg.aiAssisted;
  S.summary = msg.summary;
  S.matchId = null;
  S.phase = null;
  clearInterval(S.timerInterval);
  clearPersistedGameHistory(finishedMatchId);

  // Update own balance from summary
  const me = msg.summary.players.find(p => p.displayName === S.displayName);
  if (me) {
    S.tokenBalance = me.endingBalance;
    $('#header-balance').textContent = S.tokenBalance + ' tokens';
  }

  showView('summary');
  syncAiAssistedUi();
  syncForfeitUi();
  renderSummary(msg.summary);
}

function renderSummary(summary) {
  const standings = [...summary.players].sort((a, b) =>
    b.endingBalance - a.endingBalance
    || b.netDelta - a.netDelta
    || a.displayName.localeCompare(b.displayName)
  );
  const capturedRounds = S.gameHistory.filter(Boolean).length;
  const totalGames = S.totalGames || S.gameHistory.length || capturedRounds;
  const me = standings.find(p => p.displayName === S.displayName) || null;
  const placement = me ? getPlacement(standings, me) : null;
  const wins = countMyGameResults((p) => p.wonGame);
  const coordinationHits = countMyGameResults((p) => p.earnsCoordinationCredit);
  const rawBestRound = getMyExtremeRound((a, b) => b.netDelta - a.netDelta);
  const rawRoughestRound = getMyExtremeRound((a, b) => a.netDelta - b.netDelta);
  const bestRound = rawBestRound && rawBestRound.netDelta > 0 ? rawBestRound : null;
  const roughestRound = rawRoughestRound && rawRoughestRound.netDelta < 0 ? rawRoughestRound : null;
  const leaders = getLeaders(standings);
  const tightestConvergence = getTightestConvergence();
  const runway = me ? getSummaryRunway(me, totalGames) : null;

  $('#summary-title').textContent = me
    ? me.result === 'forfeited'
      ? 'Forfeited'
      : placement
        ? `${placement.tied ? 'Tied ' : ''}${ordinal(placement.rank)} Place`
        : 'Match Closed'
    : 'Match Closed';
  $('#summary-placement').textContent = placement
    ? `${placement.tied ? 'T-' : ''}${ordinal(placement.rank)}`
    : 'Final';
  if (S.aiAssistedMatch) {
    $('#summary-headline').textContent = me
      ? `Standings only. Your stack stayed at ${formatCompactNumber(me.endingBalance)} tokens.`
      : 'Standings only. This AI-assisted match did not move balances.';
  } else {
    $('#summary-headline').textContent = me
      ? me.result === 'forfeited'
        ? `Locked out early. Final stack ${formatCompactNumber(me.endingBalance)} tokens.`
        : `${wins} wins, ${coordinationHits} crowd hits, ${formatDelta(me.netDelta)} on this run.`
      : `Final balances settled for ${standings.length} players.`;
  }

  $('#summary-balance-value').textContent = me ? formatCompactNumber(me.endingBalance) : '—';
  const netPill = $('#summary-net-pill');
  netPill.textContent = me ? formatDelta(me.netDelta) : '—';
  netPill.className = `summary-net-pill${me ? ` ${deltaClassName(me.netDelta)}` : ''}`;
  $('#summary-starting-balance').textContent = me
    ? `Start ${formatCompactNumber(me.startingBalance)}`
    : `${standings.length} players`;

  const leadRatio = me && leaders.balance > 0
    ? me.endingBalance / leaders.balance
    : 0;
  const rings = [
    {
      label: 'Wins',
      value: capturedRounds ? `${wins}` : '—',
      detail: capturedRounds ? `of ${capturedRounds}` : 'no data',
      ratio: capturedRounds ? wins / capturedRounds : 0,
      color: 'var(--green)',
    },
    {
      label: 'Coord',
      value: capturedRounds ? `${coordinationHits}` : '—',
      detail: capturedRounds ? `of ${capturedRounds}` : 'no data',
      ratio: capturedRounds ? coordinationHits / capturedRounds : 0,
      color: 'var(--accent2)',
    },
    {
      label: 'Seen',
      value: totalGames ? `${capturedRounds}` : '—',
      detail: totalGames ? `of ${totalGames}` : 'rounds',
      ratio: totalGames ? capturedRounds / totalGames : 0,
      color: 'var(--accent)',
    },
    {
      label: 'Stack',
      value: me && leaders.balance ? `${Math.round(leadRatio * 100)}%` : '—',
      detail: leaders.balance ? 'of lead' : 'field',
      ratio: leadRatio,
      color: 'var(--accent2)',
    },
  ];
  $('#summary-rings').innerHTML = rings.map(buildSummaryRing).join('');

  const leaderNames = leaders.names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const statCards = [
    {
      label: 'Leader',
      value: standings.length ? formatCompactNumber(leaders.balance) : '—',
      copy: leaderNames.length > 1 ? `${leaderNames.length} tied` : (leaderNames[0] || 'No players'),
      className: '',
    },
    {
      label: 'Best swing',
      value: bestRound ? formatDelta(bestRound.netDelta) : '—',
      copy: bestRound ? `G${bestRound.gameNum}` : 'No spike',
      className: bestRound ? deltaClassName(bestRound.netDelta) : '',
    },
    {
      label: 'Roughest',
      value: roughestRound ? formatDelta(roughestRound.netDelta) : '—',
      copy: roughestRound ? `G${roughestRound.gameNum}` : 'No dip',
      className: roughestRound ? deltaClassName(roughestRound.netDelta) : '',
    },
    {
      label: 'Crowd peak',
      value: tightestConvergence ? `${tightestConvergence.topCount}-way` : '—',
      copy: tightestConvergence ? `G${tightestConvergence.gameNum}` : 'No cluster',
      className: '',
    },
  ];
  $('#summary-stats').innerHTML = statCards.map((card) => `
    <div class="summary-stat">
      <div class="summary-stat-label">${esc(card.label)}</div>
      <div class="summary-stat-value ${card.className}">${esc(card.value)}</div>
      <div class="summary-stat-copy">${esc(card.copy)}</div>
    </div>
  `).join('');

  renderSummaryRunway(runway, totalGames);
  renderSummaryRounds(totalGames, me);
  renderSummaryStandings(standings);
}

function buildSummaryRing(ring) {
  const ratio = Math.max(0, Math.min(1, ring.ratio || 0));
  return `
    <div class="summary-ring-card">
      <div class="summary-ring" style="--ratio:${ratio};--ring-color:${ring.color}">
        <div class="summary-ring-center">
          <strong>${esc(ring.value)}</strong>
          <span>${esc(ring.detail)}</span>
        </div>
      </div>
      <div class="summary-ring-label">${esc(ring.label)}</div>
    </div>
  `;
}

function renderSummaryRunway(runway, totalGames) {
  const section = $('#summary-runway-section');
  const container = $('#summary-runway');
  const note = $('#summary-runway-note');

  if (!runway || runway.points.length < 2) {
    section.classList.add('hidden');
    container.innerHTML = '';
    note.textContent = '';
    return;
  }

  const values = runway.points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const chartTop = 10;
  const chartBottom = 88;
  const chartHeight = chartBottom - chartTop;
  const plotted = runway.points.map((point, index) => {
    const x = runway.points.length === 1
      ? 50
      : (index / (runway.points.length - 1)) * 100;
    const normalized = (point.value - min) / range;
    return {
      ...point,
      x,
      y: chartBottom - (normalized * chartHeight),
    };
  });
  const linePath = plotted.map((point, index) =>
    `${index === 0 ? 'M' : 'L'} ${point.x},${point.y}`
  ).join(' ');
  const areaPath = [
    `M ${plotted[0].x},${chartBottom}`,
    `L ${plotted[0].x},${plotted[0].y}`,
    ...plotted.slice(1).map((point) => `L ${point.x},${point.y}`),
    `L ${plotted[plotted.length - 1].x},${chartBottom}`,
    'Z',
  ].join(' ');

  container.innerHTML = `
    <div class="summary-runway-chart">
      <svg class="summary-runway-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Balance runway">
        <defs>
          <linearGradient id="summary-runway-fill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="rgba(223,192,106,.35)"></stop>
            <stop offset="100%" stop-color="rgba(223,192,106,0)"></stop>
          </linearGradient>
        </defs>
        <line class="summary-runway-grid" x1="0" y1="24" x2="100" y2="24"></line>
        <line class="summary-runway-grid" x1="0" y1="48" x2="100" y2="48"></line>
        <line class="summary-runway-grid" x1="0" y1="72" x2="100" y2="72"></line>
        <path class="summary-runway-fill" d="${areaPath}"></path>
        <path class="summary-runway-line" d="${linePath}"></path>
        ${plotted.map((point, index) => `
          <circle class="summary-runway-point" cx="${point.x}" cy="${point.y}" r="${index === plotted.length - 1 ? 3.3 : 2.6}"></circle>
        `).join('')}
      </svg>
    </div>
    <div class="summary-runway-axis" style="--axis-count:${runway.points.length}">
      ${runway.points.map((point) => `<span class="summary-runway-tick">${esc(point.label)}</span>`).join('')}
    </div>
    <div class="summary-runway-highlow">
      <span class="summary-chip">High ${formatCompactNumber(max)}</span>
      <span class="summary-chip">Low ${formatCompactNumber(min)}</span>
      <span class="summary-chip">Close ${formatCompactNumber(runway.points[runway.points.length - 1].value)}</span>
    </div>
  `;
  note.textContent = runway.complete
    ? `Full ${totalGames}-game swing.`
    : runway.stoppedAtForfeit
      ? 'Locked at your forfeit game.'
      : `First ${runway.captured} rounds stayed consecutive in this tab.`;
  section.classList.remove('hidden');
}

function renderSummaryRounds(totalGames, summaryPlayer) {
  const section = $('#summary-rounds-section');
  const grid = $('#summary-round-grid');
  const note = $('#summary-rounds-note');

  if (!totalGames) {
    section.classList.add('hidden');
    grid.innerHTML = '';
    note.textContent = '';
    return;
  }

  const lastVisibleMyRound = S.gameHistory.reduce((latest, game) => {
    const mine = getMyRound(game);
    return game && mine ? Math.max(latest, game.gameNum) : latest;
  }, 0);

  let captured = 0;
  const tiles = [];
  for (let gameNumber = 1; gameNumber <= totalGames; gameNumber++) {
    const game = S.gameHistory[gameNumber - 1];
    const mine = getMyRound(game);
    if (!game || !mine) {
      const isAfterForfeit = summaryPlayer?.result === 'forfeited'
        && lastVisibleMyRound
        && gameNumber > lastVisibleMyRound;
      tiles.push(`
        <div class="summary-round missing">
          <div class="summary-round-top">
            <span class="summary-round-num">G${gameNumber}</span>
            <span class="summary-round-state">${isAfterForfeit ? 'Out' : 'Off-tab'}</span>
          </div>
          <div class="summary-round-delta delta-zero">—</div>
          <div class="summary-round-pick is-muted">${isAfterForfeit ? 'Detached after your forfeit.' : 'Result not captured in this browser.'}</div>
          <div class="summary-round-meter"><span style="width:0%"></span></div>
          <div class="summary-round-foot"><span>Hidden</span><span>G${gameNumber}</span></div>
        </div>
      `);
      continue;
    }

    captured += 1;
    const roundStatus = getSummaryRoundStatus(game, mine);
    const pickLabel = mine.revealedChoiceLabel || (roundStatus.status === 'forfeited' ? 'Forfeited' : 'No valid reveal');
    const strength = game.voided || !game.validRevealCount
      ? 0
      : Math.max(8, Math.round((game.topCount / game.validRevealCount) * 100));
    tiles.push(`
      <div class="summary-round ${roundStatus.status}" title="${esc(game.promptText)}">
        <div class="summary-round-top">
          <span class="summary-round-num">G${game.gameNum}</span>
          <span class="summary-round-state">${roundStatus.label}</span>
        </div>
        <div class="summary-round-delta ${deltaClassName(mine.netDelta)}">${esc(formatDelta(mine.netDelta))}</div>
        <div class="summary-round-pick${pickLabel === 'No valid reveal' ? ' is-muted' : ''}">${esc(pickLabel)}</div>
        <div class="summary-round-meter"><span style="width:${strength}%"></span></div>
        <div class="summary-round-foot">
          <span>${game.voided ? 'Refunded' : `Peak ${game.topCount}`}</span>
          <span>${game.validRevealCount} live</span>
        </div>
      </div>
    `);
  }

  note.textContent = captured === totalGames
    ? 'Every round visible.'
    : `${captured} of ${totalGames} rounds visible in this tab.`;
  grid.innerHTML = tiles.join('');
  section.classList.remove('hidden');
}

function getSummaryRoundStatus(game, mine) {
  if (game.voided) return { status: 'void', label: 'Void' };
  if (mine.result === 'forfeited') return { status: 'forfeited', label: 'Out' };
  if (mine.wonGame) return { status: 'won', label: 'Won' };
  return { status: 'lost', label: 'Missed' };
}

function renderSummaryStandings(standings) {
  const podium = $('#summary-podium');
  const chart = $('#summary-standings');
  const topBalance = standings[0]?.endingBalance || 0;

  podium.innerHTML = [1, 0, 2]
    .map((index) => ({ player: standings[index], rank: index + 1 }))
    .filter((entry) => entry.player)
    .map(({ player, rank }) => {
      const height = topBalance
        ? Math.max(126, Math.round((player.endingBalance / topBalance) * 220))
        : 126;
      return `
        <div class="summary-podium-slot">
          <div class="summary-podium-step${player.displayName === S.displayName ? ' me' : ''}" style="--podium-height:${height}px">
            <div class="summary-podium-rank">#${rank}</div>
            <div class="summary-podium-name">${esc(player.displayName)}</div>
            <div class="summary-podium-balance">${formatCompactNumber(player.endingBalance)} tokens</div>
            <div class="summary-podium-net ${deltaClassName(player.netDelta)}">${esc(formatDelta(player.netDelta))}</div>
          </div>
        </div>
      `;
    })
    .join('');

  chart.innerHTML = standings.map((player, index) => {
    const width = topBalance
      ? Math.max(6, Math.round((player.endingBalance / topBalance) * 100))
      : 0;
    return `
      <div class="summary-standing${player.displayName === S.displayName ? ' me' : ''}">
        <div class="summary-standing-rank">#${index + 1}</div>
        <div class="summary-standing-main">
          <div class="summary-standing-top">
            <div class="summary-standing-name">${esc(player.displayName)}</div>
            <div class="summary-standing-status">${player.result === 'forfeited' ? 'Forfeited' : 'Completed'}</div>
          </div>
          <div class="summary-standing-bar">
            <span class="summary-standing-fill" style="width:${width}%"></span>
          </div>
        </div>
        <div class="summary-standing-values">
          <div class="summary-standing-balance">${formatCompactNumber(player.endingBalance)}</div>
          <div class="summary-standing-net ${deltaClassName(player.netDelta)}">${esc(formatDelta(player.netDelta))}</div>
        </div>
      </div>
    `;
  }).join('');
}

function getSummaryRunway(player, totalGames) {
  const visibleRounds = S.gameHistory.filter(Boolean);
  if (!visibleRounds.length) return null;
  const capturedFromStart = visibleRounds.every((game, index) => game.gameNum === index + 1);
  if (!capturedFromStart) return null;

  const points = [{
    label: 'Start',
    value: player.startingBalance,
  }];
  let balance = player.startingBalance;

  for (const game of visibleRounds) {
    const mine = getMyRound(game);
    if (!mine) {
      return player.result === 'forfeited'
        ? {
            points,
            captured: points.length - 1,
            complete: false,
            stoppedAtForfeit: true,
          }
        : null;
    }

    balance += mine.netDelta;
    points.push({
      label: `G${game.gameNum}`,
      value: balance,
    });

    if (mine.result === 'forfeited') {
      return {
        points,
        captured: game.gameNum,
        complete: game.gameNum === totalGames,
        stoppedAtForfeit: true,
      };
    }
  }

  return {
    points,
    captured: points.length - 1,
    complete: points.length - 1 === totalGames,
    stoppedAtForfeit: false,
  };
}

function storeGameHistoryEntry(result) {
  const winningOptions = result.winningBucketKeys && result.winningBucketKeys.length
    ? Array.from(
        new Set(
          result.players
            .filter((player) => result.winningBucketKeys.includes(player.revealedBucketKey))
            .map((player) => player.revealedBucketLabel || player.revealedOptionLabel || player.revealedInputText)
            .filter(Boolean)
        ),
      )
    : (result.winningOptionIndexes || []).map((idx) =>
        result.players.find((player) => player.revealedOptionIndex === idx)?.revealedOptionLabel
        || (S.prompt && S.prompt.type === 'select' ? S.prompt.options[idx] : null)
        || `Option ${idx + 1}`
      );

  S.gameHistory[result.gameNum - 1] = {
    gameNum: result.gameNum,
    promptText: S.prompt?.text || `Game ${result.gameNum}`,
    validRevealCount: result.validRevealCount,
    topCount: result.topCount,
    dustBurned: result.dustBurned,
    voided: result.voided,
    voidReason: result.voidReason,
    normalizationMode: result.normalizationMode,
    winningOptions,
    players: result.players.map((player) => ({
      displayName: player.displayName,
      revealedChoiceLabel: getRevealLabel(player),
      wonGame: player.wonGame,
      earnsCoordinationCredit: player.earnsCoordinationCredit,
      netDelta: player.netDelta,
      result: S.playerStatuses[player.displayName] === 'forfeited' ? 'forfeited' : 'completed',
    })),
  };
  persistGameHistory();
}

function getPlacement(standings, player) {
  const higherStacks = standings.filter((entry) => entry.endingBalance > player.endingBalance).length;
  const tiedStacks = standings.filter((entry) => entry.endingBalance === player.endingBalance).length;
  return {
    rank: higherStacks + 1,
    tied: tiedStacks > 1,
  };
}

function getLeaders(standings) {
  if (!standings.length) {
    return { names: 'No players', balance: 0 };
  }
  const topBalance = standings[0].endingBalance;
  const leaders = standings.filter((player) => player.endingBalance === topBalance);
  return {
    names: leaders.map((player) => player.displayName).join(', '),
    balance: topBalance,
  };
}

function getTightestConvergence() {
  return S.gameHistory
    .filter((game) => game && !game.voided && game.validRevealCount > 0)
    .sort((a, b) => b.topCount - a.topCount || b.validRevealCount - a.validRevealCount || a.gameNum - b.gameNum)[0] || null;
}

function countMyGameResults(predicate) {
  return S.gameHistory.reduce((count, game) => {
    const mine = getMyRound(game);
    return mine && predicate(mine) ? count + 1 : count;
  }, 0);
}

function getMyExtremeRound(sorter) {
  return S.gameHistory
    .map((game) => {
      const mine = getMyRound(game);
      return game && mine ? { gameNum: game.gameNum, ...mine } : null;
    })
    .filter(Boolean)
    .sort(sorter)[0] || null;
}

function getMyRound(game) {
  if (!game) return null;
  return game.players.find((player) => player.displayName === S.displayName) || null;
}

function deltaClassName(delta) {
  return delta > 0 ? 'delta-pos' : (delta < 0 ? 'delta-neg' : 'delta-zero');
}

function formatDelta(delta) {
  return delta > 0 ? `+${delta}` : String(delta);
}

function ordinal(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
}

function quoteLabel(label) {
  return `"${label}"`;
}

$('#requeue-btn').addEventListener('click', () => {
  S.startNow = false;
  syncStartNowUI();
  if (!wsSend({ type: 'join_queue' })) {
    queueQueueAction('join');
  }
  showView('queue');
});

$('#summary-lb-btn').addEventListener('click', () => {
  S.previousView = 'summary';
  loadLeaderboard();
});

// ═══════════════════════════════════════════════════════════════
//  LEADERBOARD
// ═══════════════════════════════════════════════════════════════
$('#nav-leaderboard').addEventListener('click', () => {
  S.previousView = S.view;
  loadLeaderboard();
});

$('#nav-return-game').addEventListener('click', returnToGame);

$('#lb-back-btn').addEventListener('click', () => {
  showView(S.previousView || 'queue');
});

$('#nav-queue').addEventListener('click', () => {
  showView('queue');
});

async function loadLeaderboard() {
  showView('leaderboard');
  try {
    const [entries, myRank] = await Promise.all([
      api('GET', '/api/leaderboard'),
      api('GET', '/api/leaderboard/me').catch(() => null),
    ]);

    renderLeaderboard(entries, myRank);
  } catch (err) {
    notify('Failed to load leaderboard: ' + err.message, 'error');
  }
}

function renderLeaderboard(entries, myRank) {
  const tbody = $('#lb-tbody');
  tbody.innerHTML = '';

  if (!entries || entries.length === 0) {
    $('#my-rank-card').classList.add('hidden');
    $('#lb-empty').classList.remove('hidden');
    return;
  }
  $('#lb-empty').classList.add('hidden');

  entries.forEach(e => {
    const tr = document.createElement('tr');
    const cls = [];
    if (e.displayName === S.displayName) cls.push('me');
    if (e.provisional) cls.push('provisional');
    tr.className = cls.join(' ');
    const provTip = e.provisional ? ` title="Provisional: fewer than ${MIN_ESTABLISHED} matches played"` : '';
    tr.innerHTML = `
      <td>${e.rank}</td>
      <td>${esc(e.displayName)}</td>
      <td>${e.tokenBalance}</td>
      <td>${e.matchesPlayed}</td>
      <td class="stat-metric"${provTip}>${e.avgNetTokensPerMatch !== undefined ? e.avgNetTokensPerMatch.toFixed(1) : '-'}</td>
      <td class="stat-metric"${provTip}>${e.coherentPct !== undefined ? e.coherentPct + '%' : '-'}</td>
      <td class="stat-metric"${provTip}>${e.currentStreak || 0}</td>
      <td class="stat-metric"${provTip}>${e.longestStreak || 0}</td>
    `;
    tbody.appendChild(tr);
  });

  // My rank card
  const card = $('#my-rank-card');
  if (myRank && myRank.rank != null && myRank.leaderboardEligible) {
    card.classList.remove('hidden');
    const remaining = MIN_ESTABLISHED - myRank.matchesPlayed;
    const provNote = myRank.provisional
      ? `<div class="provisional-note">Stats are provisional until ${remaining} more match${remaining === 1 ? '' : 'es'}</div>`
      : '';
    const rankScopeNote = myRank.rank > LEADERBOARD_LIMIT
      ? `<div class="provisional-note">You are outside the visible top ${LEADERBOARD_LIMIT} table, but this is still your full leaderboard rank.</div>`
      : '';
    card.innerHTML = `
      <div style="font-size:.9rem">
        Your global rank: <strong>#${myRank.rank}</strong>
        | Balance: <strong>${myRank.tokenBalance}</strong>
        | Coordination: <strong>${myRank.coherentPct || 0}%</strong>
        | Streak: <strong>${myRank.currentStreak || 0}</strong> (best: ${myRank.longestStreak || 0})
      </div>
      ${rankScopeNote}
      ${provNote}
    `;
  } else {
    card.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatCompactNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

function formatBuildStamp() {
  const stamp = document.querySelector('.build-stamp');
  if (!stamp) return;

  const hash = stamp.getAttribute('data-build-hash');
  const rawDate = stamp.getAttribute('data-build-date');
  if (!hash || !rawDate) return;

  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return;

  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  stamp.textContent = `${hash} · ${formatter.format(parsed)}`;
  stamp.title = `${rawDate} UTC`;
}

// ── Boot ─────────────────────────────────────────────────────────
formatBuildStamp();
checkSession();

})();
