import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, getPlayerView } from '../src/core.js';
import { MultiplayerSession, normalizeRoomCode } from '../src/multiplayer.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';

class FakeSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.emit('open', {});
      this.server({ type: 'hello', protocol: 1, service: 'qqnd-game-server' });
    });
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== fn));
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  server(message) {
    queueMicrotask(() => this.emit('message', { data: JSON.stringify(message) }));
  }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === 'session.create') {
      this.server({
        type: 'session.created',
        session: { id: HOST_ID, nickname: message.nickname, connected: true },
        resumeToken: 'r'.repeat(40),
      });
    } else if (message.type === 'room.create') {
      const room = {
        id: 'CAFE-2345',
        game: 'puchate',
        name: 'Puchate Café table',
        visibility: 'private',
        status: 'waiting',
        ownerSessionId: HOST_ID,
        minPlayers: 2,
        maxPlayers: message.maxPlayers,
        players: [{ id: HOST_ID, nickname: 'Maja', connected: true }],
      };
      this.room = room;
      this.server({ type: 'room.created', room });
    } else if (message.type === 'game.start') {
      const humanCount = this.room.players.length;
      const botSeats = Array.from({ length: message.botCount }, (_, index) => humanCount + index);
      this.server({
        type: 'game.started',
        room: { ...this.room, status: 'in_game' },
        game: 'puchate',
        seat: 0,
        hostSessionId: HOST_ID,
        botSeats,
        seatCount: humanCount + message.botCount,
        revision: 0,
        authoritative: false,
        presence: [],
      });
    } else if (message.type === 'game.state.commit') {
      this.server({ type: 'game.state.committed', roomId: message.roomId, revision: message.revision });
    }
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

function setup(options = {}) {
  let socket;
  const lobbies = [];
  const states = [];
  const peers = [];
  const session = new MultiplayerSession({
    serverUrl: 'wss://api.qqnd.fyi/api/v1/ws',
    storage: null,
    webSocketFactory(url) {
      socket = new FakeSocket(url);
      return socket;
    },
    filterState: options.filterState ?? ((state, seat) => ({
      seat,
      ownHand: state.hands[seat],
      opponentCounts: state.hands.map((hand, index) => index === seat ? null : hand.length),
    })),
    onLobby: (lobby) => lobbies.push(lobby),
    onState: (state, meta) => states.push({ state, meta }),
    onPeerChange: (event) => peers.push(event),
  });
  return { session, get socket() { return socket; }, lobbies, states, peers };
}

async function addGuest(env) {
  env.socket.room = {
    ...env.socket.room,
    players: [
      { id: HOST_ID, nickname: 'Maja', connected: true },
      { id: GUEST_ID, nickname: 'Olek', connected: true },
    ],
  };
  env.socket.server({ type: 'room.updated', room: env.socket.room });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('QQND room codes use the shared eight-character room format', () => {
  assert.equal(normalizeRoomCode(' cafe2345 '), 'CAFE-2345');
  assert.equal(normalizeRoomCode('CAFE-2345'), 'CAFE-2345');
});

test('creating a Puchate room uses QQND session + room.create, not signaling/WebRTC', async () => {
  const env = setup();
  const created = await env.session.createRoom({ name: 'Maja', maxSeats: 3 });
  assert.equal(created.roomCode, 'CAFE-2345');
  assert.equal(env.socket.url, 'wss://api.qqnd.fyi/api/v1/ws');
  assert.ok(env.socket.sent.some((frame) => frame.type === 'session.create' && frame.nickname === 'Maja'));
  assert.ok(env.socket.sent.some((frame) => frame.type === 'room.create' && frame.game === 'puchate' && frame.maxPlayers === 3));
  assert.equal(env.socket.sent.some((frame) => frame.type === 'relay'), false);
});

test('host commits canonical state and publishes a private projection through the shared runtime', async () => {
  const env = setup();
  await env.session.createRoom({ name: 'Maja', maxSeats: 3 });
  await addGuest(env);

  env.session.configureLobby({ bots: [{ seat: 2, name: 'Pianka', difficulty: 'normal' }] });
  await env.session.startGame({ gameId: 'room-CAFE-2345' });
  env.session.broadcastViews({
    deck: ['secret-next'],
    hands: [['host-secret'], ['guest-secret'], ['bot-secret']],
  });

  const commit = env.socket.sent.find((frame) => frame.type === 'game.state.commit');
  const publish = env.socket.sent.find((frame) => frame.type === 'game.state.publish' && frame.toSessionId === GUEST_ID);
  assert.ok(commit, 'host must commit canonical state to reconnect storage');
  assert.ok(publish, 'host must publish a guest-private view');
  assert.deepEqual(publish.state, { seat: 1, ownHand: ['guest-secret'], opponentCounts: [1, null, 1] });
  assert.equal(JSON.stringify(publish.state).includes('secret-next'), false);
});

test('start opens the bridge synchronously so the existing controller can publish its first snapshot', async () => {
  const env = setup();
  await env.session.createRoom({ name: 'Maja', maxSeats: 2 });
  await addGuest(env);

  const started = env.session.startGame();
  assert.equal(env.session.inGame, true, 'game.start must reserve the bridge before the server acknowledgement microtask');
  assert.doesNotThrow(() => env.session.broadcastViews({ hands: [['a'], ['b']] }));
  await started;
});

test('current host applies authenticated game.action with the Puchate reducer and publishes the next revision', async () => {
  const env = setup({ filterState: (state, seat) => getPlayerView(state, seat) });
  await env.session.createRoom({ name: 'Maja', maxSeats: 2 });
  await addGuest(env);
  await env.session.startGame();

  const initial = createGame({
    seed: 'shared-server-action',
    players: [
      { id: 'host', name: 'Maja', kind: 'human' },
      { id: 'guest', name: 'Olek', kind: 'human' },
    ],
  });
  env.session.broadcastViews(initial);
  const guestAction = getPlayerView(initial, 1).legalActions[0];
  const commitsBefore = env.socket.sent.filter((frame) => frame.type === 'game.state.commit').length;

  env.socket.server({
    type: 'game.action',
    roomId: 'CAFE-2345',
    game: 'puchate',
    fromSessionId: GUEST_ID,
    seat: 1,
    actionSeq: 1,
    actionId: 'guest:1',
    action: guestAction.type,
    payload: guestAction,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const commitsAfter = env.socket.sent.filter((frame) => frame.type === 'game.state.commit').length;
  assert.equal(commitsAfter, commitsBefore + 1, 'host should publish a new canonical revision after the routed action');
  assert.equal(env.session.authoritativeState.pendingSelections['1'].cardIds[0], guestAction.cardIds[0]);
  assert.ok(env.states.some(({ meta }) => meta.authoritative === false && meta.seat === 0), 'host UI receives its own private projection after reduction');
});

test('Puchate host turns a takeover seat into a bot, executes its move, and republishes state', async () => {
  const env = setup({ filterState: (state, seat) => getPlayerView(state, seat) });
  await env.session.createRoom({ name: 'Maja', maxSeats: 2 });
  await addGuest(env);
  await env.session.startGame();

  const initial = createGame({
    seed: 'shared-server-takeover',
    players: [
      { id: 'host', name: 'Maja', kind: 'human' },
      { id: 'guest', name: 'Olek', kind: 'human' },
    ],
  });
  env.session.broadcastViews(initial);
  const commitsBefore = env.socket.sent.filter((frame) => frame.type === 'game.state.commit').length;

  env.socket.server({
    type: 'game.player.bot_takeover',
    roomId: 'CAFE-2345',
    sessionId: GUEST_ID,
    seat: 1,
    nickname: 'Olek',
    botSeats: [1],
    hostSessionId: HOST_ID,
    authoritative: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = env.session.authoritativeState;
  assert.equal(state.players[1].kind, 'bot', 'departed human seat must become a bot in canonical state');
  assert.ok(state.pendingSelections['1'], 'substitute bot must immediately make its pending draft choice');
  assert.equal(env.socket.sent.filter((frame) => frame.type === 'game.state.commit').length, commitsBefore + 1, 'host must persist the state after bot takeover');
  assert.ok(env.peers.some((event) => event.status === 'bot-takeover' && event.seat === 1), 'client should expose takeover to the UI');
});

test('a migrated Puchate host keeps runtime host authority across later room.updated frames', async () => {
  const env = setup({ filterState: (state, seat) => getPlayerView(state, seat) });
  await env.session.createRoom({ name: 'Maja', maxSeats: 2 });
  await addGuest(env);
  await env.session.startGame();

  const canonical = createGame({
    seed: 'shared-server-host-migration',
    players: [
      { id: 'host', name: 'Maja', kind: 'human' },
      { id: 'guest', name: 'Olek', kind: 'human' },
    ],
  });

  // Recast this transport as the surviving guest, matching the state of a real
  // guest session immediately before the server promotes it to browser host.
  env.session.session = { id: GUEST_ID, nickname: 'Olek', connected: true };
  env.session.localSeat = 1;
  env.session.role = 'guest';
  env.session.authoritativeState = null;

  env.socket.server({
    type: 'game.player.bot_takeover',
    roomId: 'CAFE-2345',
    sessionId: HOST_ID,
    seat: 0,
    nickname: 'Maja',
    botSeats: [0],
    hostSessionId: GUEST_ID,
    authoritative: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(env.socket.sent.some((frame) => frame.type === 'game.state.get'), 'new browser host must request the canonical server snapshot');

  env.socket.server({
    type: 'game.state',
    roomId: 'CAFE-2345',
    revision: 1,
    botSeats: [0],
    hostSessionId: GUEST_ID,
    authoritative: false,
    viewerSeat: 1,
    state: canonical,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.session.role, 'host');
  assert.equal(env.session.authoritativeState.players[0].kind, 'bot');

  env.socket.room = {
    ...env.socket.room,
    status: 'in_game',
    ownerSessionId: HOST_ID,
    players: [
      { id: HOST_ID, nickname: 'Maja', connected: false },
      { id: GUEST_ID, nickname: 'Olek', connected: true },
    ],
  };
  env.socket.server({ type: 'room.updated', room: env.socket.room });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(env.session.hostSessionId, GUEST_ID, 'lobby owner must not overwrite the migrated runtime host during a game');
  assert.equal(env.session.role, 'host', 'surviving player must keep browser-host authority after room presence updates');
});
