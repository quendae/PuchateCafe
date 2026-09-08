import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  dispatchAction,
  dispatchSpecialAction,
  getPlayerView,
} from '../src/core.js';
import { chooseBotAction } from '../src/bots.js';

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
