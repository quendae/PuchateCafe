import {
  createGame,
  dispatchAction,
  dispatchSpecialAction,
  getPlayerView,
  scoreRound,
} from './core.js';
import { chooseBotAction } from './bots.js';
import { MultiplayerSession } from './multiplayer.js';
import { getMenuLanguage, peerNotice } from './online-ux.js';
import {
  CARD_PRESENTATION,
  createCard,
  createOpponent,
  escapeHTML,
  icon,
  setScreen,
  openDialog,
  closeDialog,
  showToast,
} from './ui.js';
import { sound } from './sound.js';

const BOT_NAMES = ['Mokka', 'Kruszonka', 'Pestka', 'Pianka', 'Karmel', 'Biszkopt', 'Trufla'];
const SIGNALING_KEY = 'puchate-cafe-signaling-url';

const app = {
  mode: null,
  state: null,
  view: null,
  localSeat: 0,
  selectedIds: [],
  useExtraPaws: false,
  useSpoon: false,
  requestedType: '',
  tableauTargetIds: [],
  multiplayer: null,
  lobby: null,
  config: null,
  lastRound: 1,
  shownFinal: false,
  busy: false,
  lastEventSeq: -1,
};

const byId = (id) => document.getElementById(id);
const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function randomSeed() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function playerConfig(name, count, difficulty) {
  return Array.from({ length: count }, (_, seat) => seat === 0
    ? { id: 'local', name, kind: 'human' }
    : { id: `bot-${seat}`, name: BOT_NAMES[(seat - 1) % BOT_NAMES.length], kind: 'bot', difficulty });
}

function normalizeDifficulty(value) {
  return value === 'easy' ? 'easy' : 'normal';
}

function showError(error) {
  console.error(error);
  void sound.play('error');
  const messages = {
    INVALID_SIGNALING_URL: 'Podaj prawidłowy adres serwera pokoju.',
    INVALID_ROOM: 'Kod pokoju powinien mieć sześć znaków.',
    ROOM_FULL: 'Przy tym stoliku nie ma już wolnych miejsc.',
    HOST_UNAVAILABLE: 'Nie udało się połączyć z gospodarzem.',
    SIGNALING_TIMEOUT: 'Serwer pokoju nie odpowiedział. Sprawdź adres i spróbuj ponownie.',
  };
  showToast(messages[error?.code] ?? error?.message ?? 'Coś poszło nie tak. Spróbuj ponownie.', { type: 'error', duration: 5000 });
}

function syncPlayerCountControls(source) {
  const value = String(source.value);
  const select = byId('player-count');
  if (select && select !== source) select.value = value;
  document.querySelectorAll('input[name="playerCount"]').forEach((radio) => { radio.checked = radio.value === value; });
  updatePartyMenuCompatibility('local');
}

const PARTY_MENU_LIMITS = Object.freeze({
  sampler: [2, 6],
  clever: [3, 6],
  lively: [3, 8],
  cozy: [2, 8],
});

const PARTY_MENU_HELP = Object.freeze({
  sampler: 'Łatwe na start: rożki, serniczki, Menu dnia i tort lodowy.',
  clever: 'Więcej planowania: tace, kanapki, posypka i kopiowanie zamówień.',
  lively: 'Dużo interakcji: karmelki, zupa, lojalność i srebrna łyżeczka.',
  cozy: 'Spokojne, czytelne menu odpowiednie także dla 2 oraz 7–8 graczy.',
});

function updatePartyMenuCompatibility(scope = 'local') {
  const local = scope === 'local';
  const select = byId(local ? 'party-menu' : 'host-party-menu');
  const count = local
    ? Number(document.querySelector('input[name="playerCount"]:checked')?.value ?? byId('player-count')?.value ?? 3)
    : Number(byId('host-player-count')?.value ?? 3);
  if (!select) return;
  [...select.options].forEach((option) => {
    const [minimum, maximum] = PARTY_MENU_LIMITS[option.value] ?? [2, 8];
    option.disabled = count < minimum || count > maximum;
  });
  if (select.selectedOptions[0]?.disabled) select.value = 'cozy';
  if (local) byId('party-menu-description').textContent = PARTY_MENU_HELP[select.value];
}

function startLocalGame(config = app.config) {
  app.multiplayer?.close();
  app.multiplayer = null;
  app.mode = 'local';
  app.config = config;
  app.state = createGame({ ...config, seed: randomSeed(), players: playerConfig(config.name, config.count, config.difficulty) });
  app.localSeat = 0;
  app.lastRound = 1;
  app.shownFinal = false;
  app.selectedIds = [];
  app.useExtraPaws = false;
  app.useSpoon = false;
  app.requestedType = '';
  app.tableauTargetIds = [];
  app.handSignature = null;
  app.tableauSignature = null;
  app.lastEventSeq = -1;
  setScreen('game');
  updateFromState();
}

function updateFromState() {
  if (!app.state) return;
  app.view = getPlayerView(app.state, app.localSeat);
  renderGame(app.view);
  handleMilestone(app.view);
}

function updateFromView(view) {
  app.view = view;
  renderGame(view);
  handleMilestone(view);
}

function handleMilestone(view) {
  const newest = view.events?.at(-1);
  if (newest && newest.seq > app.lastEventSeq) {
    const previous = app.lastEventSeq;
    app.lastEventSeq = newest.seq;
    if (previous >= 0 && newest.type === 'cards_revealed') void sound.play('reveal');
    else if (newest.type === 'menu_choice_started') void sound.play('menu');
    else if (newest.type === 'soups_discarded') void sound.play('error');
  }
  if (view.phase === 'game_over') {
    if (!app.shownFinal) {
      app.shownFinal = true;
      fillFinalDialog(view);
      void sound.play('victory');
      window.setTimeout(() => openDialog('final-dialog'), 350);
    }
    return;
  }
  if (view.round > app.lastRound) {
    const completedRound = view.round - 1;
    app.lastRound = view.round;
    fillRoundDialog(view, completedRound);
    void sound.play('round');
    window.setTimeout(() => openDialog('round-dialog'), 300);
  }
}

function renderGame(view) {
  if (!view?.me) return;
  hideTableauPreview();
  const ownLocked = Boolean(view.selections?.find((selection) => selection.seat === view.seat)?.locked);
  const handSignature = `${view.round}:${view.turn}:${view.me.hand?.map((card) => card.id).join(',')}`;
  const handChanged = app.handSignature !== handSignature;
  if (handChanged || ownLocked) {
    app.handSignature = handSignature;
    app.selectedIds = [];
    app.useExtraPaws = false;
    app.useSpoon = false;
    app.requestedType = '';
    app.tableauTargetIds = [];
  }

  document.body.dataset.gameVariant = view.variant ?? 'classic';

  byId('round-label').textContent = `Runda ${view.round} z ${view.totalRounds}`;
  document.querySelectorAll('.round-progress i').forEach((dot, index) => dot.classList.toggle('is-filled', index < view.round));
  byId('score-label').textContent = String(view.me.score ?? 0);
  byId('hand-count').textContent = `${view.me.handCount} ${view.me.handCount === 1 ? 'karta' : view.me.handCount < 5 ? 'karty' : 'kart'}`;

  const status = byId('turn-status');
  status.innerHTML = view.phase === 'special_action'
    ? (view.specialChoice && !view.specialChoice.chosen ? `${icon('sparkle')} Wybierz z menu` : `${icon('check')} Czekamy na wybór z menu`)
    : ownLocked
    ? `${icon('check')} Wybór zapisany — czekamy`
    : `${icon('sparkle')} Wybierz kartę`;
  status.classList.toggle('is-locked', ownLocked);

  const opponents = byId('opponents');
  opponents.replaceChildren(...view.players
    .filter((player) => player.seat !== view.seat)
    .map((player) => {
      const locked = Boolean(view.selections?.find((selection) => selection.seat === player.seat)?.locked);
      return createOpponent({
        ...player,
        isBot: player.kind === 'bot',
        avatar: ['bunny', 'cat', 'dog', 'fox'][player.seat % 4],
        status: locked ? 'ready' : 'choosing',
      });
    }));

  const tableau = byId('tableau');
  const dessertCards = view.me.desserts ?? view.me.adoptionPets ?? [];
  const cards = [...(view.me.playedThisRound ?? []), ...dessertCards];
  const tableauSignature = cards.map((card) => `${card.id}:${card.copiedType ?? ''}:${card.flipped ? 1 : 0}`).join(',');
  const tableauChanged = app.tableauSignature !== tableauSignature;
  app.tableauSignature = tableauSignature;
  const selectedHandCard = view.me.hand?.find((card) => app.selectedIds.includes(card.id));
  const targetsTableau = selectedHandCard?.type === 'special_order' || selectedHandCard?.type === 'takeout_box';
  if (cards.length) {
    tableau.replaceChildren(...cards.map((card, index) => {
      const canTarget = targetsTableau && !card.endGameScoring && !card.flipped;
      const element = createCard(card, {
        selectable: canTarget,
        compact: true,
        action: 'tableau-card',
        selected: app.tableauTargetIds.includes(card.id),
      });
      element.style.setProperty('--card-index', index);
      if (tableauChanged) element.classList.add('is-landing');
      if (card.flipped) element.classList.add('is-flipped');
      if (!canTarget) element.tabIndex = 0;
      return element;
    }));
  } else {
    tableau.innerHTML = '<p class="empty-tableau">Zagrane karty pojawią się tutaj</p>';
  }
  const liveRound = scoreRound(view.me, view.players).total;
  byId('tableau-score').textContent = `${liveRound} pkt w rundzie`;

  const hand = byId('hand');
  const disabled = ownLocked || view.phase !== 'draft';
  hand.replaceChildren(...(view.me.hand ?? []).map((card, index) => {
    const element = createCard(card, { selected: app.selectedIds.includes(card.id), disabled });
    element.style.setProperty('--card-index', index);
    if (handChanged) element.classList.add('is-dealing');
    return element;
  }));

  const canUsePaws = (view.legalActions ?? []).some((action) => action.useExtraPaws);
  renderPawsControl(canUsePaws, disabled);
  const canUseSpoon = (view.legalActions ?? []).some((action) => action.useSpoon);
  renderSpoonControl(canUseSpoon, disabled, view);
  const required = app.useExtraPaws ? 2 : 1;
  const confirm = byId('confirm-card');
  const targetReady = selectedHandCard?.type === 'special_order'
    ? (cards.filter((card) => !card.endGameScoring && !card.flipped).length === 0 || app.tableauTargetIds.length === 1)
    : true;
  const spoonReady = !app.useSpoon || Boolean(app.requestedType);
  confirm.disabled = disabled || app.selectedIds.length !== required || !targetReady || !spoonReady;
  confirm.innerHTML = `${icon('check')} ${app.useExtraPaws ? 'Zagraj dwie karty' : 'Zagraj kartę'}`;
  byId('hand-title').textContent = app.useExtraPaws ? 'Wybierz dwie karty po kolei' : 'Wybierz jedną kartę';
  byId('selection-hint').innerHTML = selectedHandCard?.type === 'special_order'
    ? `${icon('info')} Wskaż jedną ze swoich zagranych kart do skopiowania.`
    : selectedHandCard?.type === 'takeout_box'
      ? `${icon('info')} Wskaż dowolne karty na stole — po odwróceniu każda będzie warta 2 punkty.`
      : app.useSpoon
        ? `${icon('info')} Wybierz rodzinę, o którą poprosisz pierwszego gracza po lewej.`
        : app.useExtraPaws
    ? `${icon('info')} Kolejność ma znaczenie: pierwsza Polewa może wzmocnić drugiego Gościa.`
    : `${icon('info')} Wybór zostanie odkryty dopiero, gdy wszyscy będą gotowi.`;

  renderMenuChoice(view);
}

function activeMenuFamilies(view) {
  const menu = view.partyMenu;
  if (!menu) return [];
  return ['bunny_guest', 'cat_guest', 'dog_guest', menu.roll, ...menu.appetizers, ...menu.specials, menu.dessert]
    .filter((value) => value !== 'silver_spoon');
}

function familyLabel(value) {
  const labels = {
    drink: 'Kakao', tray_race: 'Taca ekspresowa', sandwich: 'Kanapka', cone_race: 'Rożek waflowy',
    cookie_set: 'Ciasteczka', afternoon_set: 'Podwieczorek', sweet_bun: 'Bułeczki', caramel_twist: 'Karmelki',
    cheesecake: 'Serniczki', shared_sprinkles: 'Wspólna posypka', soup_special: 'Zupa dnia', cream_topping: 'Kremowa polewa',
    extra_paws: 'Dodatkowe łapki', loyalty_card: 'Stały gość', tea_pot: 'Dzbanek herbaty', menu_card: 'Menu dnia',
    special_order: 'Specjalne zamówienie', takeout_box: 'Pudełko na wynos', icecream_cake: 'Tort lodowy',
    fruit_basket: 'Owocowy koszyk', adoption_pet: 'Adopcja', bunny_guest: 'Króliczek', cat_guest: 'Kotek', dog_guest: 'Piesek',
  };
  return labels[value] ?? CARD_PRESENTATION[value]?.name ?? value;
}

const FAMILY_CARD_TYPES = Object.freeze({
  drink: ['drink_1', 'drink_2', 'drink_3'],
  tray_race: ['tray_race_1', 'tray_race_2', 'tray_race_3'],
  sandwich: ['sandwich_circle', 'sandwich_triangle', 'sandwich_square', 'sandwich_rectangle'],
});

function expandGuideFamilies(families) {
  return [...new Set(families.flatMap((family) => FAMILY_CARD_TYPES[family] ?? [family]))];
}

function currentGuideGroups(view) {
  if (view.variant !== 'party' || !view.partyMenu) {
    return [
      { title: 'Zestawy i kolekcje', types: ['cookie_set', 'afternoon_set', 'sweet_bun'] },
      { title: 'Kakao i popularność', types: ['drink_1', 'drink_2', 'drink_3'] },
      { title: 'Goście', types: ['bunny_guest', 'cat_guest', 'dog_guest'] },
      { title: 'Dodatki specjalne', types: ['cream_topping', 'extra_paws'] },
      { title: 'Punktacja na koniec gry', types: ['adoption_pet'] },
    ];
  }
  const menu = view.partyMenu;
  return [
    { title: 'Goście — są w każdym menu', types: ['bunny_guest', 'cat_guest', 'dog_guest'] },
    { title: 'Wyścig', types: expandGuideFamilies([menu.roll]) },
    { title: 'Przekąski', types: expandGuideFamilies(menu.appetizers ?? []) },
    { title: 'Dodatki specjalne', types: expandGuideFamilies(menu.specials ?? []) },
    { title: 'Deser — punktuje na koniec gry', types: expandGuideFamilies([menu.dessert]) },
  ];
}

function renderCardGuide(view) {
  const groups = byId('card-guide-groups');
  if (!groups || !view) return;
  const party = view.variant === 'party' && view.partyMenu;
  byId('card-guide-title').textContent = party ? view.partyMenu.name : 'Klasyczne Puchate Café';
  byId('card-guide-subtitle').textContent = party
    ? 'To wszystkie rodziny kart używane w bieżącym menu. Symbole na kartach pokazują dokładnie, ile zebrać i ile punktów zdobyć.'
    : 'To wszystkie karty klasycznego wariantu. Symbole na kartach pokazują dokładnie, ile zebrać i ile punktów zdobyć.';
  groups.replaceChildren(...currentGuideGroups(view).map((definition) => {
    const section = document.createElement('section');
    section.className = 'card-guide-group';
    const heading = document.createElement('h3');
    heading.textContent = definition.title;
    const grid = document.createElement('div');
    grid.className = 'card-guide-grid';
    grid.replaceChildren(...definition.types.map((type) => {
      const meta = CARD_PRESENTATION[type];
      const item = document.createElement('article');
      item.className = 'card-guide-item';
      const example = createCard(type, { selectable: false });
      example.removeAttribute('title');
      example.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('div');
      copy.className = 'card-guide-copy';
      copy.innerHTML = `<strong>${escapeHTML(meta?.name ?? familyLabel(type))}</strong><p>${escapeHTML(meta?.description ?? '')}</p>`;
      item.append(example, copy);
      return item;
    }));
    section.append(heading, grid);
    return section;
  }));
}

function currentTableauCards() {
  if (!app.view?.me) return [];
  return [...(app.view.me.playedThisRound ?? []), ...(app.view.me.desserts ?? app.view.me.adoptionPets ?? [])];
}

function hideTableauPreview() {
  const preview = byId('tableau-preview');
  if (!preview) return;
  preview.hidden = true;
  preview.replaceChildren();
}

function showTableauPreview(cardId, anchor) {
  const preview = byId('tableau-preview');
  const card = currentTableauCards().find((candidate) => candidate.id === cardId);
  if (!preview || !card || !anchor) return;
  const largeCard = createCard(card, { selectable: false });
  largeCard.classList.add('tableau-preview-card');
  if (card.flipped) largeCard.classList.add('is-flipped');
  largeCard.removeAttribute('title');
  preview.replaceChildren(largeCard);
  preview.hidden = false;

  const anchorBox = anchor.getBoundingClientRect();
  const previewBox = preview.getBoundingClientRect();
  const gap = 12;
  const left = Math.max(gap, Math.min(window.innerWidth - previewBox.width - gap, anchorBox.left + (anchorBox.width - previewBox.width) / 2));
  const top = anchorBox.top > previewBox.height + gap * 2
    ? anchorBox.top - previewBox.height - gap
    : Math.min(window.innerHeight - previewBox.height - gap, anchorBox.bottom + gap);
  preview.style.left = `${Math.round(left)}px`;
  preview.style.top = `${Math.max(gap, Math.round(top))}px`;
}

function renderSpoonControl(available, disabled, view) {
  let wrap = byId('spoon-control');
  if (!available) {
    wrap?.remove();
    app.useSpoon = false;
    app.requestedType = '';
    return;
  }
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'spoon-control';
    wrap.className = 'bonus-control';
    document.querySelector('.hand-actions')?.prepend(wrap);
  }
  const families = activeMenuFamilies(view);
  wrap.innerHTML = `<button type="button" class="soft-button${app.useSpoon ? ' is-active' : ''}" data-action="toggle-spoon" aria-pressed="${app.useSpoon}">${icon('sparkle')} ${app.useSpoon ? 'Łyżeczka aktywna' : 'Użyj łyżeczki'}</button>${app.useSpoon ? `<select id="spoon-request" aria-label="Poproś o rodzinę kart"><option value="">Wybierz kartę…</option>${families.map((family) => `<option value="${escapeHTML(family)}"${app.requestedType === family ? ' selected' : ''}>${escapeHTML(familyLabel(family))}</option>`).join('')}</select>` : ''}`;
  wrap.querySelector('button').disabled = disabled;
}

function renderMenuChoice(view) {
  const dialog = byId('menu-dialog');
  if (view.phase !== 'special_action' || !view.specialChoice || view.specialChoice.chosen) {
    if (dialog?.open) closeDialog(dialog);
    return;
  }
  const options = byId('menu-options');
  options.replaceChildren(...view.specialChoice.options.map((card, index) => {
    const element = createCard(card, { action: 'choose-menu-card' });
    element.style.setProperty('--card-index', index);
    element.classList.add('is-dealing');
    return element;
  }));
  if (!dialog.open) openDialog(dialog);
}

function renderPawsControl(available, disabled) {
  let button = byId('paws-toggle');
  if (!available) {
    button?.remove();
    app.useExtraPaws = false;
    return;
  }
  if (!button) {
    button = document.createElement('button');
    button.id = 'paws-toggle';
    button.type = 'button';
    button.className = 'soft-button paws-toggle';
    button.dataset.action = 'toggle-paws';
    document.querySelector('.hand-actions')?.prepend(button);
  }
  button.disabled = disabled;
  button.classList.toggle('is-active', app.useExtraPaws);
  button.setAttribute('aria-pressed', String(app.useExtraPaws));
  button.innerHTML = `${icon('paws')} ${app.useExtraPaws ? 'Łapki aktywne' : 'Użyj dodatkowych łapek'}`;
}

function toggleCard(cardId) {
  if (!cardId || app.view?.phase !== 'draft') return;
  const ownLocked = app.view.selections?.find((selection) => selection.seat === app.view.seat)?.locked;
  if (ownLocked) return;
  const position = app.selectedIds.indexOf(cardId);
  if (position >= 0) app.selectedIds.splice(position, 1);
  else {
    const limit = app.useExtraPaws ? 2 : 1;
    if (app.selectedIds.length >= limit) app.selectedIds.shift();
    app.selectedIds.push(cardId);
  }
  app.tableauTargetIds = [];
  void sound.play('select');
  renderGame(app.view);
}

function toggleTableauTarget(cardId) {
  const selected = app.view?.me?.hand?.find((card) => app.selectedIds.includes(card.id));
  if (!selected || !['special_order', 'takeout_box'].includes(selected.type)) return;
  const index = app.tableauTargetIds.indexOf(cardId);
  if (index >= 0) app.tableauTargetIds.splice(index, 1);
  else {
    if (selected.type === 'special_order') app.tableauTargetIds = [];
    app.tableauTargetIds.push(cardId);
  }
  void sound.play('select');
  renderGame(app.view);
}

function selectedAction() {
  const actions = app.view?.legalActions ?? [];
  const base = actions.find((action) => {
    if (Boolean(action.useExtraPaws) !== app.useExtraPaws) return false;
    if (Boolean(action.useSpoon) !== app.useSpoon) return false;
    return action.cardIds.length === app.selectedIds.length && action.cardIds.every((id, index) => id === app.selectedIds[index]);
  });
  if (!base) return null;
  const action = { ...base };
  if (app.useSpoon) action.requestedType = app.requestedType;
  const selected = app.view.me.hand.find((card) => card.id === app.selectedIds[0]);
  if (selected?.type === 'special_order' && app.tableauTargetIds[0]) action.specialOrderTargetId = app.tableauTargetIds[0];
  if (selected?.type === 'takeout_box') action.takeoutTargetIds = [...app.tableauTargetIds];
  return action;
}

async function commitSelection() {
  if (app.busy) return;
  const action = selectedAction();
  if (!action) {
    showToast('Wybierz poprawną kartę lub kolejność kart.', { type: 'error' });
    return;
  }
  app.busy = true;
  try {
    void sound.play('confirm');
    if (app.mode === 'local') {
      app.state = dispatchAction(app.state, 0, action);
      updateFromState();
      await sleep(280);
      await runHostBots();
    } else if (app.multiplayer) {
      app.multiplayer.sendAction('play_cards', action);
    }
  } catch (error) {
    showError(error);
  } finally {
    app.busy = false;
  }
}

async function runHostBots() {
  if (!app.state || !['draft', 'special_action'].includes(app.state.phase)) return;
  const maximumSteps = app.state.players.length * 4;
  for (let step = 0; step < maximumSteps; step += 1) {
    if (app.state.phase === 'draft') {
      const bot = app.state.players.find((player) => player.kind === 'bot' && !app.state.pendingSelections[String(player.seat)]);
      if (!bot) break;
      const action = chooseBotAction(getPlayerView(app.state, bot.seat), bot.difficulty);
      if (!action) break;
      app.state = dispatchAction(app.state, bot.seat, action);
      continue;
    }
    if (app.state.phase === 'special_action') {
      const waitingBot = app.state.players.find((player) => player.kind === 'bot' && app.state.pendingSpecials[String(player.seat)] && !app.state.pendingSpecials[String(player.seat)].choice);
      if (!waitingBot) break;
      const action = chooseBotAction(getPlayerView(app.state, waitingBot.seat), waitingBot.difficulty);
      if (!action || action.type !== 'choose_menu_card') break;
      app.state = dispatchSpecialAction(app.state, waitingBot.seat, action);
      continue;
    }
    break;
  }
  updateFromState();
}

async function chooseMenuCard(cardId) {
  if (app.busy || !cardId) return;
  app.busy = true;
  try {
    void sound.play('confirm');
    const action = { type: 'choose_menu_card', cardId };
    if (app.mode === 'local') {
      app.state = dispatchSpecialAction(app.state, app.localSeat, action);
      closeDialog('menu-dialog');
      await runHostBots();
      updateFromState();
    } else app.multiplayer?.sendAction('choose_menu_card', action);
  } catch (error) { showError(error); }
  finally { app.busy = false; }
}

function fillRoundDialog(view, roundNumber) {
  const scored = view.players.map((player) => ({ player, result: player.roundScores?.[roundNumber - 1] ?? { total: 0 } }));
  const winner = [...scored].sort((a, b) => b.result.total - a.result.total)[0];
  byId('round-result-title').textContent = `Podsumowanie rundy ${roundNumber}`;
  byId('round-winner').innerHTML = `<span class="avatar avatar-bunny">${escapeHTML(winner.player.name.charAt(0))}</span><div><small>Gwiazda rundy</small><strong>${escapeHTML(winner.player.name)}</strong></div><b>+${winner.result.total} ${icon('heart')}</b>`;
  const own = scored.find((entry) => entry.player.seat === view.seat)?.result ?? {};
  const labels = view.variant === 'party'
    ? [['sets', 'Zestawy'], ['guests', 'Goście i polewy'], ['drinks', 'Kakao'], ['coneRace', 'Rożki'], ['trayRace', 'Tace ekspresowe'], ['caramel', 'Karmelki'], ['cheesecake', 'Serniczki'], ['sandwiches', 'Kanapki'], ['sprinkles', 'Posypki'], ['soup', 'Zupy'], ['loyalty', 'Stali goście'], ['tea', 'Herbata'], ['takeout', 'Na wynos']]
    : [['cookies', 'Ciasteczka'], ['afternoonSets', 'Podwieczorki'], ['sweetBuns', 'Bułeczki'], ['guests', 'Goście'], ['creamTopping', 'Polewa'], ['drinks', 'Napoje']];
  byId('round-breakdown').innerHTML = labels.filter(([key]) => Number(own[key] ?? 0) !== 0).map(([key, label]) => {
    const value = Number(own[key] ?? 0);
    return `<div><span>${escapeHTML(label)}</span><strong>${value >= 0 ? '+' : ''}${value}</strong></div>`;
  }).join('') || '<div><span>Ta runda</span><strong>0</strong></div>';
  byId('round-ranking').innerHTML = [...scored].sort((a, b) => b.player.score - a.player.score).map((entry, index) => `<div><span>${index + 1}</span><strong>${escapeHTML(entry.player.name)}</strong><b>${entry.player.score} ${icon('heart')}</b></div>`).join('');
}

function fillFinalDialog(view) {
  const result = view.result;
  if (!result) return;
  const ranking = [...result.players].sort((a, b) => b.total - a.total);
  const winners = ranking.filter((entry) => entry.total === result.winningScore);
  byId('final-title').textContent = winners.length > 1 ? 'Wspólne zwycięstwo!' : `${winners[0].name} wygrywa!`;
  byId('final-subtitle').textContent = `Najlepsza kawiarnia zdobyła ${result.winningScore} serduszek.`;
  byId('final-podium').innerHTML = ranking.slice(0, 3).map((entry, index) => `<article class="podium-place podium-${index + 1}"><span>${index + 1}</span><strong>${escapeHTML(entry.name)}</strong><b>${entry.total} ${icon('heart')}</b></article>`).join('');
  byId('final-ranking').innerHTML = ranking.map((entry, index) => {
    const detail = view.variant === 'party'
      ? `Desery: ${entry.dessertCount} · premia ${entry.adoptionPoints + entry.icecream + entry.fruit >= 0 ? '+' : ''}${entry.adoptionPoints + entry.icecream + entry.fruit}`
      : `Adopcje: ${entry.adoptionPets} (${entry.adoptionPoints >= 0 ? '+' : ''}${entry.adoptionPoints})`;
    return `<div><span>${index + 1}</span><strong>${escapeHTML(entry.name)}</strong><small>${escapeHTML(detail)}</small><b>${entry.total} ${icon('heart')}</b></div>`;
  }).join('');
}

function signalingUrl() {
  const input = byId('signaling-url');
  const value = input?.value?.trim() || localStorage.getItem(SIGNALING_KEY) || '';
  if (value) localStorage.setItem(SIGNALING_KEY, value);
  return value;
}

function createOnlineSession(role) {
  app.multiplayer?.close();
  app.multiplayer = new MultiplayerSession({
    signalingUrl: signalingUrl(),
    filterState: (state, seat) => getPlayerView(state, seat),
    onLobby: (lobby) => {
      app.lobby = lobby;
      renderLobby();
    },
    onStart: () => {
      if (role === 'guest') {
        app.mode = 'online-guest';
        setScreen('game');
        byId('turn-status').textContent = 'Czekamy na stan gospodarza…';
      }
    },
    onAction: async (request) => {
      if (app.mode !== 'online-host' || !['play_cards', 'choose_menu_card'].includes(request.action)) throw new Error('Nieobsługiwana akcja.');
      app.state = request.action === 'choose_menu_card'
        ? dispatchSpecialAction(app.state, request.seat, request.payload)
        : dispatchAction(app.state, request.seat, request.payload);
      await runHostBots();
      app.multiplayer.broadcastViews(app.state);
      updateFromState();
      return { ok: true };
    },
    onState: (stateOrView, meta) => {
      if (meta.authoritative) return;
      updateFromView(stateOrView);
    },
    onError: showError,
    onPeerChange: (event) => {
      if (app.multiplayer?.inGame) app.mode = app.multiplayer.role === 'host' ? 'online-host' : 'online-guest';
      const notice = peerNotice(event, getMenuLanguage());
      if (notice) showToast(notice.message, { type: notice.type, duration: notice.duration });
    },
  });
  return app.multiplayer;
}

function ensureSignaling() {
  if (signalingUrl()) return true;
  showToast('Najpierw wpisz adres wdrożonego serwera pokoju.', { type: 'error', duration: 5000 });
  byId('signaling-url')?.focus();
  return false;
}

async function hostRoom(form) {
  if (!ensureSignaling()) return;
  const session = createOnlineSession('host');
  const name = byId('host-name').value.trim();
  const maxSeats = Number(byId('host-player-count').value);
  app.onlineConfig = {
    variant: byId('host-variant').value,
    partyMenu: byId('host-party-menu').value,
  };
  app.mode = 'online-host';
  app.localSeat = 0;
  setScreen('lobby');
  try {
    await session.createRoom({ name, maxSeats });
  } catch (error) {
    showError(error);
    setScreen('multiplayer');
  }
}

async function joinRoom() {
  if (!ensureSignaling()) return;
  const session = createOnlineSession('guest');
  app.mode = 'online-guest';
  setScreen('lobby');
  try {
    await session.joinRoom(byId('room-code').value, { name: byId('join-name').value });
  } catch (error) {
    showError(error);
    setScreen('multiplayer');
  }
}

function renderLobby() {
  const lobby = app.lobby;
  if (!lobby) return;
  byId('lobby-code').textContent = app.multiplayer.roomCode || 'ŁĄCZENIE';
  byId('lobby-count').textContent = `${lobby.seats.filter((seat) => seat.kind !== 'empty').length} / ${lobby.maxSeats}`;
  byId('lobby-seats').innerHTML = lobby.seats.map((seat) => {
    if (seat.kind === 'empty') return `<article class="seat-card is-waiting"><span class="avatar avatar-empty">${icon('plus')}</span><div><strong>Wolne miejsce</strong><small>Czekamy na gracza…</small></div><span class="waiting-dots"><i></i><i></i><i></i></span></article>`;
    const detail = seat.kind === 'bot' ? `Bot · ${seat.difficulty === 'easy' ? 'łagodny' : 'bystry'}` : seat.seat === 0 ? 'Gospodarz · gotowy' : 'Gość · gotowy';
    return `<article class="seat-card is-ready"><span class="avatar avatar-${seat.kind === 'bot' ? 'cat' : 'bunny'}">${escapeHTML(seat.name.charAt(0))}</span><div><strong>${escapeHTML(seat.name)}</strong><small>${escapeHTML(detail)}</small></div><span class="status-pill">Gotowy</span></article>`;
  }).join('');
  const ready = lobby.seats.every((seat) => seat.kind !== 'empty' && (seat.kind === 'bot' || seat.connected));
  const start = byId('lobby-start');
  start.hidden = app.mode !== 'online-host';
  start.disabled = !ready;
  byId('lobby-status').innerHTML = ready ? `${icon('check')} Wszyscy są gotowi` : '<span class="spinner" aria-hidden="true"></span> Czekamy na pozostałych gości';
  ensureFillBotsButton();
}

function ensureFillBotsButton() {
  let button = byId('fill-bots');
  if (!button) {
    button = document.createElement('button');
    button.id = 'fill-bots';
    button.type = 'button';
    button.className = 'soft-button';
    button.dataset.action = 'fill-bots';
    button.innerHTML = `${icon('bot')} Wypełnij botami`;
    document.querySelector('.lobby-footer')?.prepend(button);
  }
  button.hidden = app.mode !== 'online-host' || !app.lobby?.seats.some((seat) => seat.kind === 'empty');
}

function fillLobbyBots() {
  if (app.mode !== 'online-host' || !app.lobby) return;
  const bots = app.lobby.seats.filter((seat) => seat.kind === 'bot').map((seat) => ({ seat: seat.seat, name: seat.name, difficulty: seat.difficulty }));
  app.lobby.seats.filter((seat) => seat.kind === 'empty').forEach((seat) => bots.push({ seat: seat.seat, name: BOT_NAMES[(seat.seat - 1) % BOT_NAMES.length], difficulty: 'normal' }));
  app.multiplayer.configureLobby({ maxSeats: app.lobby.maxSeats, bots });
}

function startOnlineGame() {
  if (app.mode !== 'online-host' || !app.lobby) return;
  const players = app.lobby.seats.map((seat) => ({
    id: `seat-${seat.seat}`,
    name: seat.name,
    kind: seat.kind === 'bot' ? 'bot' : 'human',
    difficulty: normalizeDifficulty(seat.difficulty),
  }));
  app.state = createGame({ gameId: `room-${app.multiplayer.roomCode}`, seed: randomSeed(), players, ...app.onlineConfig });
  app.localSeat = 0;
  app.lastRound = 1;
  app.shownFinal = false;
  app.multiplayer.startGame({ gameId: app.state.gameId });
  setScreen('game');
  app.multiplayer.broadcastViews(app.state);
  updateFromState();
}

function goHome() {
  hideTableauPreview();
  app.multiplayer?.close();
  app.multiplayer = null;
  app.state = null;
  app.view = null;
  app.mode = null;
  app.selectedIds = [];
  document.querySelectorAll('dialog[open]').forEach((dialog) => closeDialog(dialog));
  setScreen('home');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'solo') setScreen('setup');
  else if (action === 'multiplayer') {
    setScreen('multiplayer');
    const input = byId('signaling-url');
    if (input && !input.value) input.value = localStorage.getItem(SIGNALING_KEY) || '';
  } else if (action === 'back-home' || action === 'home' || action === 'leave-lobby') goHome();
  else if (action === 'rules') openDialog('rules-dialog');
  else if (action === 'card-guide') {
    hideTableauPreview();
    renderCardGuide(app.view);
    void sound.play('menu');
    openDialog('card-guide-dialog');
  }
  else if (action === 'play-card') toggleCard(target.dataset.cardId);
  else if (action === 'tableau-card') toggleTableauTarget(target.dataset.cardId);
  else if (action === 'choose-menu-card') await chooseMenuCard(target.dataset.cardId);
  else if (action === 'toggle-paws') {
    app.useExtraPaws = !app.useExtraPaws;
    app.useSpoon = false;
    app.requestedType = '';
    app.selectedIds = app.selectedIds.slice(0, app.useExtraPaws ? 2 : 1);
    renderGame(app.view);
  } else if (action === 'toggle-spoon') {
    app.useSpoon = !app.useSpoon;
    app.useExtraPaws = false;
    app.selectedIds = app.selectedIds.slice(0, 1);
    app.requestedType = '';
    void sound.play('select');
    renderGame(app.view);
  } else if (action === 'confirm-card') await commitSelection();
  else if (action === 'next-round') closeDialog('round-dialog');
  else if (action === 'rematch') {
    closeDialog('final-dialog');
    if (app.mode === 'local') startLocalGame(); else goHome();
  } else if (action === 'copy-code') {
    await navigator.clipboard?.writeText(app.multiplayer?.roomCode ?? '');
    showToast('Kod pokoju skopiowany.', { type: 'success' });
  } else if (action === 'fill-bots') fillLobbyBots();
  else if (action === 'start-multiplayer') startOnlineGame();
  else if (action === 'toggle-sound') {
    const muted = sound.toggle();
    target.setAttribute('aria-pressed', String(!muted));
    target.setAttribute('aria-label', muted ? 'Włącz dźwięki' : 'Wycisz dźwięki');
    target.innerHTML = icon(muted ? 'sound-off' : 'sound');
    showToast(muted ? 'Dźwięki wyłączone.' : 'Dźwięki włączone.');
  }
});

document.addEventListener('pointerover', (event) => {
  const card = event.target.closest?.('#tableau .game-card');
  if (card && !card.contains(event.relatedTarget)) showTableauPreview(card.dataset.cardId, card);
});

document.addEventListener('pointerout', (event) => {
  const card = event.target.closest?.('#tableau .game-card');
  if (card && !card.contains(event.relatedTarget)) hideTableauPreview();
});

document.addEventListener('focusin', (event) => {
  const card = event.target.closest?.('#tableau .game-card');
  if (card) showTableauPreview(card.dataset.cardId, card);
});

document.addEventListener('focusout', (event) => {
  const card = event.target.closest?.('#tableau .game-card');
  if (card && !card.contains(event.relatedTarget)) hideTableauPreview();
});

document.addEventListener('pointerdown', () => { void sound.unlock(); }, { capture: true });

document.addEventListener('change', (event) => {
  if (event.target.id === 'spoon-request') {
    app.requestedType = event.target.value;
    renderGame(app.view);
  }
});

function updateVariantControls(variant, scope = 'local') {
  const party = variant === 'party';
  if (scope === 'local') {
    byId('party-menu-field').hidden = !party;
    document.querySelectorAll('#setup-form .party-player').forEach((node) => { node.hidden = !party; });
    const checked = document.querySelector('input[name="playerCount"]:checked');
    if (!party && Number(checked?.value) > 5) {
      const fallback = document.querySelector('input[name="playerCount"][value="5"]');
      fallback.checked = true;
      syncPlayerCountControls(fallback);
    }
    updatePartyMenuCompatibility('local');
  } else {
    byId('host-party-menu').disabled = !party;
    document.querySelectorAll('#host-player-count .party-player').forEach((node) => { node.hidden = !party; });
    if (!party && Number(byId('host-player-count').value) > 5) byId('host-player-count').value = '5';
    updatePartyMenuCompatibility('host');
  }
}

byId('setup-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const checked = document.querySelector('input[name="playerCount"]:checked');
  startLocalGame({
    name: byId('player-name').value.trim() || 'Barista',
    count: Number(checked?.value ?? byId('player-count').value),
    difficulty: normalizeDifficulty(byId('bot-difficulty').value),
    variant: document.querySelector('input[name="gameVariant"]:checked')?.value ?? 'classic',
    partyMenu: byId('party-menu').value,
  });
});

document.querySelectorAll('input[name="playerCount"]').forEach((radio) => radio.addEventListener('change', () => syncPlayerCountControls(radio)));
byId('player-count')?.addEventListener('change', (event) => syncPlayerCountControls(event.target));
byId('party-menu')?.addEventListener('change', () => updatePartyMenuCompatibility('local'));
document.querySelectorAll('input[name="gameVariant"]').forEach((radio) => radio.addEventListener('change', () => updateVariantControls(radio.value, 'local')));
byId('host-variant')?.addEventListener('change', (event) => updateVariantControls(event.target.value, 'host'));
byId('host-player-count')?.addEventListener('change', () => updatePartyMenuCompatibility('host'));
byId('host-party-menu')?.addEventListener('change', () => updatePartyMenuCompatibility('host'));
byId('host-form')?.addEventListener('submit', (event) => { event.preventDefault(); void hostRoom(event.currentTarget); });
byId('join-form')?.addEventListener('submit', (event) => { event.preventDefault(); void joinRoom(); });

const soundToggle = document.querySelector('[data-action="toggle-sound"]');
soundToggle?.setAttribute('aria-pressed', String(!sound.muted));
if (soundToggle) {
  soundToggle.setAttribute('aria-label', sound.muted ? 'Włącz dźwięki' : 'Wycisz dźwięki');
  soundToggle.innerHTML = icon(sound.muted ? 'sound-off' : 'sound');
}
updateVariantControls('classic', 'local');
updateVariantControls('classic', 'host');
setScreen('home');

globalThis.__puchateApp = { app, createOnlineSession, goHome, setScreen, showToast, showError };
void import('./menu-experience.js').catch(showError);
