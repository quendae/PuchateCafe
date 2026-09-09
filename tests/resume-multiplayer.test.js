import test from 'node:test';
import assert from 'node:assert/strict';

import { createGame, getPlayerView } from '../src/core.js';
import { MultiplayerSession } from '../src/multiplayer.js';
import { SESSION_STORAGE_KEY, resumeSavedOnlineGame } from '../src/online-ux.js';

const OLD_HOST_ID = '11111111-1111-4111-8111-111111111111';
const NEW_HOST_ID = '22222222-2222-4222-8222-222222222222';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class ResumeSocket {
  static OPEN = 1;
  constructor(url, view) {
    this.url = url;
    this.view = view;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = ResumeSocket.OPEN;
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
    if (message.type === 'session.resume') {
      this.server({
        type: 'session.resumed',
        session: { id: OLD_HOST_ID, nickname: 'Maja', connected: true },
        rooms: [{
          id: 'CAFE-2345',
          game: 'puchate',
          name: 'Puchate Café table',
          visibility: 'private',
          status: 'in_game',
          ownerSessionId: OLD_HOST_ID,
          minPlayers: 2,
          maxPlayers: 2,
          players: [
            { id: OLD_HOST_ID, nickname: 'Maja', connected: true },
            { id: NEW_HOST_ID, nickname: 'Olek', connected: true },
          ],
        }],
      });
    } else if (message.type === 'game.state.get') {
      // Runtime truth differs from the static lobby owner: Olek took browser-host
      // authority while Maja was away. Returning Maja must therefore be a guest.
      this.server({
        type: 'game.state',
        roomId: 'CAFE-2345',
        revision: 7,
        botSeats: [],
        hostSessionId: NEW_HOST_ID,
        authoritative: false,
        viewerSeat: 0,
        presence: [],
        state: this.view,
      });
    }
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition_timeout');
}

test('saved browser session resumes the active room, fetches state, and adopts runtime host truth', async () => {
  const canonical = createGame({
    seed: 'resume-after-host-migration',
    players: [
      { id: 'seat-0', name: 'Maja', kind: 'human' },
      { id: 'seat-1', name: 'Olek', kind: 'human' },
    ],
  });
  const ownView = getPlayerView(canonical, 0);
  const storage = new MemoryStorage({
    [SESSION_STORAGE_KEY]: JSON.stringify({ sessionId: OLD_HOST_ID, resumeToken: 'r'.repeat(40) }),
  });
  let socket;
  const received = [];
  const session = new MultiplayerSession({
    serverUrl: 'wss://api.qqnd.fyi/api/v1/ws',
    storage,
    webSocketFactory(url) {
      socket = new ResumeSocket(url, ownView);
      return socket;
    },
    filterState: (state, seat) => getPlayerView(state, seat),
    onState: (state, meta) => received.push({ state, meta }),
  });

  const recovered = await resumeSavedOnlineGame(session);
  assert.equal(recovered.roomCode, 'CAFE-2345');
  assert.equal(recovered.localSeat, 0);
  assert.ok(socket.sent.some((frame) => frame.type === 'session.resume'), 'saved credentials must be resumed');
  assert.equal(socket.sent.some((frame) => frame.type === 'session.create'), false, 'resume must not create a new identity');
  assert.ok(socket.sent.some((frame) => frame.type === 'game.state.get'), 'active room resume must request the latest game state');

  await waitFor(() => received.length > 0);
  assert.equal(session.hostSessionId, NEW_HOST_ID, 'runtime host must override the old lobby owner');
  assert.equal(session.role, 'guest', 'returning former host must not regain host authority implicitly');
  assert.equal(session.localSeat, 0);
  assert.deepEqual(received.at(-1).state.me.hand, ownView.me.hand);
});
