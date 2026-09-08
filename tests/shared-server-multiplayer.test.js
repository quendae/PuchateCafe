import test from 'node:test';
import assert from 'node:assert/strict';

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
      this.server({
        type: 'game.started',
        room: this.room,
        game: 'puchate',
        seat: 0,
        hostSessionId: HOST_ID,
        botSeats: [2],
        seatCount: 3,
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

function setup() {
  let socket;
  const lobbies = [];
  const session = new MultiplayerSession({
    serverUrl: 'wss://api.qqnd.fyi/api/v1/ws',
    storage: null,
    webSocketFactory(url) {
      socket = new FakeSocket(url);
      return socket;
    },
    filterState(state, seat) {
      return { seat, ownHand: state.hands[seat], opponentCounts: state.hands.map((hand, index) => index === seat ? null : hand.length) };
    },
    onLobby: (lobby) => lobbies.push(lobby),
  });
  return { session, get socket() { return socket; }, lobbies };
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
  env.socket.room = {
    ...env.socket.room,
    players: [
      { id: HOST_ID, nickname: 'Maja', connected: true },
      { id: GUEST_ID, nickname: 'Olek', connected: true },
    ],
  };
  env.socket.server({ type: 'room.updated', room: env.socket.room });
  await new Promise((resolve) => setTimeout(resolve, 0));

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
