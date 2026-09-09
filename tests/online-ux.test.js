import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_STORAGE_KEY,
  hasSavedOnlineSession,
  resumeSavedOnlineGame,
  peerNotice,
} from '../src/online-ux.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('saved online session is detected only for usable credentials', () => {
  const valid = new MemoryStorage({
    [SESSION_STORAGE_KEY]: JSON.stringify({
      sessionId: '11111111-1111-4111-8111-111111111111',
      resumeToken: 'r'.repeat(40),
    }),
  });
  assert.equal(hasSavedOnlineSession(valid), true);
  assert.equal(hasSavedOnlineSession(new MemoryStorage()), false);
  assert.equal(hasSavedOnlineSession(new MemoryStorage({ [SESSION_STORAGE_KEY]: '{broken' })), false);
  assert.equal(hasSavedOnlineSession(new MemoryStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ sessionId: 'x' }) })), false);
});

test('resumeSavedOnlineGame restores an active table and returns the recovered seat/role', async () => {
  let resumeCalls = 0;
  const session = {
    session: { nickname: 'Maja' },
    snapshot: { inGame: false, roomCode: '', localSeat: null, role: null },
    async _resumeConnection() {
      resumeCalls += 1;
      this.snapshot = { inGame: true, roomCode: 'CAFE-2345', localSeat: 0, role: 'guest' };
      this.session = { nickname: 'Maja' };
    },
  };

  const recovered = await resumeSavedOnlineGame(session);
  assert.equal(resumeCalls, 1);
  assert.deepEqual(recovered, {
    roomCode: 'CAFE-2345',
    localSeat: 0,
    role: 'guest',
    nickname: 'Maja',
  });
});

test('resumeSavedOnlineGame returns null when the saved session no longer has an active game', async () => {
  const session = {
    snapshot: { inGame: false, roomCode: '', localSeat: null, role: null },
    async _resumeConnection() {},
  };
  assert.equal(await resumeSavedOnlineGame(session), null);
});

test('peer notices explain reconnect grace, bot takeover, host migration and seat reclaim', () => {
  assert.match(peerNotice({ status: 'reconnecting', nickname: 'Olek', graceMs: 60_000 }, 'pl').message, /Olek/);
  assert.match(peerNotice({ status: 'reconnecting', nickname: 'Olek', graceMs: 60_000 }, 'pl').message, /60/);
  assert.match(peerNotice({ status: 'bot-takeover', nickname: 'Olek' }, 'pl').message, /bot/i);
  assert.match(peerNotice({ status: 'host-changed', isLocalHost: true }, 'pl').message, /prowadzisz/i);
  assert.match(peerNotice({ status: 'connected', nickname: 'Maja', reclaimedFromBot: true }, 'pl').message, /odzysk/i);
  assert.equal(peerNotice({ status: 'connected', nickname: 'Maja' }, 'pl'), null);
});

test('peer notices support the menu languages without losing the event meaning', () => {
  assert.match(peerNotice({ status: 'bot-takeover', nickname: 'Olek' }, 'en').message, /bot/i);
  assert.match(peerNotice({ status: 'host-changed', isLocalHost: true }, 'de').message, /Spielleitung|leitest/i);
});
