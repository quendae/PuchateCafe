import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  dispatchAction,
  dispatchSpecialAction,
  getPlayerView,
} from '../src/core.js';
import { chooseBotAction } from '../src/bots.js';
import {
  MultiplayerSession,
  ProtocolError,
  normalizeBotDifficulty,
} from '../src/multiplayer.js';
import signalingWorker, { normalizeApiPath } from '../worker/src/index.js';

function openChannel() {
  return {
    readyState: 'open',
    sent: [],
    send(packet) { this.sent.push(JSON.parse(packet)); },
    close() { this.readyState = 'closed'; },
  };
}

function hostLobby(maxSeats = 3) {
  return {
    maxSeats,
    seats: Array.from({ length: maxSeats }, (_, seat) => seat === 0
      ? { seat, kind: 'human', name: 'Host', connected: true, ready: true }
      : { seat, kind: 'empty', name: '', connected: false, ready: false }),
  };
}

function botPlayers(count, difficulty = 'normal') {
  return Array.from({ length: count }, (_, seat) => ({
    id: `bot-${seat}`,
    name: `Bot ${seat + 1}`,
    kind: 'bot',
    difficulty,
  }));
}

function finishBotGame(config) {
  let state = createGame({ seed: `regression-${config.variant ?? 'classic'}-${config.playerCount}`, ...config });
  let steps = 0;
  while (state.phase !== 'game_over' && steps < 2000) {
    steps += 1;
    if (state.phase === 'draft') {
      const waiting = state.players.find((player) => !state.pendingSelections[String(player.seat)]);
      assert.ok(waiting, `draft phase must have a waiting seat at step ${steps}`);
      const view = getPlayerView(state, waiting.seat);
      const action = chooseBotAction(view, waiting.difficulty);
      assert.ok(action, `bot ${waiting.seat} must have a legal draft action`);
      state = dispatchAction(state, waiting.seat, action);
      continue;
    }
    if (state.phase === 'special_action') {
      const waiting = state.players.find((player) => state.pendingSpecials?.[String(player.seat)] && !state.pendingSpecials[String(player.seat)].choice);
      assert.ok(waiting, `special phase must have a waiting seat at step ${steps}`);
      const view = getPlayerView(state, waiting.seat);
      const action = chooseBotAction(view, waiting.difficulty);
      assert.equal(action?.type, 'choose_menu_card');
      state = dispatchSpecialAction(state, waiting.seat, action);
      continue;
    }
    assert.fail(`unexpected phase ${state.phase}`);
  }
  assert.equal(state.phase, 'game_over', `game should finish in fewer than ${steps} steps`);
  assert.ok(steps < 2000, 'gameplay regression must not deadlock');
  assert.equal(state.result.players.length, config.players.length);
  for (const result of state.result.players) assert.ok(Number.isFinite(result.total));
  return state;
}

test('player views never expose shuffle state or another hand', () => {
  const state = createGame({ seed: 'hidden-seed', players: botPlayers(4) });
  for (let seat = 0; seat < state.players.length; seat += 1) {
    const view = getPlayerView(state, seat);
    assert.equal('seed' in view, false);
    assert.equal('rngState' in view, false);
    assert.equal('deck' in view, false);
    assert.ok(Array.isArray(view.me.hand));
    for (const player of view.players) {
      if (player.seat === seat) assert.ok(Array.isArray(player.hand));
      else assert.equal('hand' in player, false);
    }
  }
});

test('classic and Party bot tables finish complete games without deadlock', () => {
  for (const count of [2, 3, 4, 5]) {
    finishBotGame({ playerCount: count, players: botPlayers(count, count % 2 ? 'easy' : 'normal') });
  }
  const partyCases = [
    ['sampler', 2], ['sampler', 6],
    ['clever', 3], ['clever', 6],
    ['lively', 3], ['lively', 8],
    ['cozy', 2], ['cozy', 8],
  ];
  for (const [partyMenu, count] of partyCases) {
    finishBotGame({ variant: 'party', partyMenu, playerCount: count, players: botPlayers(count, 'normal') });
  }
});

test('host can reserve a concrete seat for a bot and choose its difficulty', () => {
  const session = new MultiplayerSession();
  session.role = 'host';
  session.localSeat = 0;
  session.localName = 'Host';
  session.peerId = 'host';
  session.lobby = hostLobby(4);

  session.setBotSeat(2, { name: 'Karmel', difficulty: 'hard' });
  assert.deepEqual(session.lobby.seats[2], {
    seat: 2,
    kind: 'bot',
    name: 'Karmel',
    connected: false,
    ready: true,
    difficulty: 'hard',
  });
  assert.equal(normalizeBotDifficulty('EASY'), 'easy');
  assert.throws(() => normalizeBotDifficulty('impossible'), (error) => error instanceof ProtocolError && error.code === 'INVALID_LOBBY');

  session.clearBotSeat(2);
  assert.equal(session.lobby.seats[2].kind, 'empty');
});

test('disconnect during a match pauses authority and blocks every later action', () => {
  const remainingChannel = openChannel();
  const disconnectedChannel = openChannel();
  const session = new MultiplayerSession({ onAction: () => ({ ok: true }) });
  session.role = 'host';
  session.peerId = 'host';
  session.localSeat = 0;
  session.localName = 'Host';
  session.inGame = true;
  session.lobby = hostLobby(3);
  session.lobby.seats[1] = { seat: 1, kind: 'human', name: 'Maja', connected: true, ready: true };
  session.lobby.seats[2] = { seat: 2, kind: 'human', name: 'Olek', connected: true, ready: true };
  session.peers.set('maja', { id: 'maja', seat: 1, channel: disconnectedChannel, pc: { close() {} } });
  session.peers.set('olek', { id: 'olek', seat: 2, channel: remainingChannel, pc: { close() {} } });

  session._removePeer('maja');

  assert.equal(session.paused, true);
  assert.equal(session.lobby.seats[1].kind, 'human', 'stable seat identity is preserved');
  assert.equal(session.lobby.seats[1].connected, false);
  assert.equal(session.lobby.seats[1].ready, false);
  assert.equal(remainingChannel.sent.at(-1).type, 'error');
  assert.equal(remainingChannel.sent.at(-1).code, 'PLAYER_DISCONNECTED');
  assert.throws(() => session.sendAction('play_cards', { cardIds: ['x'] }), (error) => error.code === 'GAME_PAUSED');
});

test('guest enters paused state when host reports a player disconnect', () => {
  const errors = [];
  const session = new MultiplayerSession({ onError: (error) => errors.push(error.code) });
  session.role = 'guest';
  session.inGame = true;
  session._acceptHostMessage({ type: 'error', code: 'PLAYER_DISCONNECTED', message: 'Maja lost connection.' });
  assert.equal(session.paused, true);
  assert.equal(session.pauseReason.code, 'PLAYER_DISCONNECTED');
  assert.deepEqual(errors, ['PLAYER_DISCONNECTED']);
});

test('signaling Worker accepts both direct and same-origin /api health routes', async () => {
  assert.equal(normalizeApiPath('/api/room/ABC234/join'), '/room/ABC234/join');
  assert.equal(normalizeApiPath('/room/create'), '/room/create');

  for (const path of ['/health', '/api/health']) {
    const response = await signalingWorker.fetch(new Request(`https://puchate.qqnd.fyi${path}`), {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'puchate-cafe-signaling');
    assert.equal(body.maxGuests, 7);
  }
});
