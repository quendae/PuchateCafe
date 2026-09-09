import {
  clearSavedOnlineSession,
  getMenuLanguage,
  hasSavedOnlineSession,
  resumeSavedOnlineGame,
  setMenuLanguage,
} from './online-ux.js';

const bridge = globalThis.__puchateApp;
if (!bridge) throw new Error('Puchate app bridge is unavailable');

const MENU_COPY = {
  pl: {
    language: 'Język menu',
    eyebrow: 'Puchata kawiarnia czeka na gości',
    title: 'Zagraj swoją najlepszą kartę.',
    lead: 'Zbieraj słodkości, przyjmuj puchatych gości i buduj najprzytulniejszą kawiarnię — sam albo ze znajomymi.',
    solo: 'Graj z botami',
    multiplayer: 'Graj online',
    players: 'graczy',
    rounds: 'rundy',
    minutes: 'min',
    rules: 'Zasady',
    resumeKicker: 'Poprzednia sesja online',
    resumeTitle: 'Twój stolik może nadal czekać',
    resumeBody: 'Wróć do zapisanej gry. Jeśli bot chwilowo przejął Twoje miejsce, serwer spróbuje oddać je po ponownym połączeniu.',
    resumeAction: 'Kontynuuj grę',
    resuming: 'Łączenie ze stolikiem…',
    resumed: 'Połączono ponownie. Pobieramy aktualny stan stolika.',
    resumeMissing: 'Ta sesja nie ma już aktywnej gry. Możesz utworzyć nowy stolik.',
    resumeFailed: 'Nie udało się wznowić poprzedniej sesji.',
    leaveTitle: 'Opuścić trwającą grę?',
    leaveBody: 'Jeśli opuścisz stolik, Twoje miejsce natychmiast przejmie bot, a zapis sesji zostanie usunięty z tej przeglądarki.',
    leaveHint: 'Jeśli chcesz wrócić później, po prostu zamknij kartę lub przeglądarkę — nie używaj przycisku „Opuść grę”.',
    cancel: 'Zostań w grze',
    leave: 'Opuść grę',
    sceneLabel: 'Karty Puchatego Café',
    ticket: 'Dzisiejsze menu',
    ticketLine: 'Słodkości · goście · serduszka',
  },
  en: {
    language: 'Menu language',
    eyebrow: 'The fluffy café is ready for guests',
    title: 'Play your best card.',
    lead: 'Collect treats, welcome fluffy guests and build the coziest café — solo or with friends.',
    solo: 'Play with bots',
    multiplayer: 'Play online',
    players: 'players',
    rounds: 'rounds',
    minutes: 'min',
    rules: 'Rules',
    resumeKicker: 'Previous online session',
    resumeTitle: 'Your table may still be waiting',
    resumeBody: 'Return to the saved game. If a bot temporarily took your seat, the server will try to give it back after reconnecting.',
    resumeAction: 'Continue game',
    resuming: 'Reconnecting to the table…',
    resumed: 'Reconnected. Fetching the latest table state.',
    resumeMissing: 'This session no longer has an active game. You can start a new table.',
    resumeFailed: 'The previous session could not be resumed.',
    leaveTitle: 'Leave the current game?',
    leaveBody: 'If you leave the table, a bot immediately takes your seat and this browser forgets the saved session.',
    leaveHint: 'If you want to return later, simply close the tab or browser — do not use “Leave game”.',
    cancel: 'Stay in game',
    leave: 'Leave game',
    sceneLabel: 'Puchate Café cards',
    ticket: "Today's menu",
    ticketLine: 'Treats · guests · hearts',
  },
  de: {
    language: 'Menüsprache',
    eyebrow: 'Das flauschige Café wartet auf Gäste',
    title: 'Spiel deine beste Karte.',
    lead: 'Sammle Leckereien, begrüße flauschige Gäste und baue das gemütlichste Café — allein oder mit Freunden.',
    solo: 'Mit Bots spielen',
    multiplayer: 'Online spielen',
    players: 'Spieler',
    rounds: 'Runden',
    minutes: 'Min.',
    rules: 'Regeln',
    resumeKicker: 'Vorherige Online-Sitzung',
    resumeTitle: 'Dein Tisch könnte noch warten',
    resumeBody: 'Kehre zum gespeicherten Spiel zurück. Falls ein Bot vorübergehend deinen Platz übernommen hat, versucht der Server ihn nach der Verbindung zurückzugeben.',
    resumeAction: 'Spiel fortsetzen',
    resuming: 'Verbindung zum Tisch wird hergestellt…',
    resumed: 'Wieder verbunden. Der aktuelle Spielstand wird geladen.',
    resumeMissing: 'Diese Sitzung hat kein aktives Spiel mehr. Du kannst einen neuen Tisch eröffnen.',
    resumeFailed: 'Die vorherige Sitzung konnte nicht fortgesetzt werden.',
    leaveTitle: 'Laufendes Spiel verlassen?',
    leaveBody: 'Wenn du den Tisch verlässt, übernimmt sofort ein Bot deinen Platz und die gespeicherte Sitzung wird aus diesem Browser entfernt.',
    leaveHint: 'Wenn du später zurückkehren möchtest, schließe einfach den Tab oder Browser — nutze nicht „Spiel verlassen“.',
    cancel: 'Im Spiel bleiben',
    leave: 'Spiel verlassen',
    sceneLabel: 'Puchate-Café-Karten',
    ticket: 'Heutiges Menü',
    ticketLine: 'Leckereien · Gäste · Herzen',
  },
};

let language = getMenuLanguage();
let resumeBusy = false;

function copy() {
  return MENU_COPY[language] ?? MENU_COPY.pl;
}

function installStylesheet() {
  if (document.querySelector('link[data-menu-experience]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'menu.css';
  link.dataset.menuExperience = 'true';
  document.head.append(link);
}

function buildLanguageControl() {
  if (document.getElementById('menu-language')) return;
  const actions = document.querySelector('.topbar-actions');
  if (!actions) return;
  const label = document.createElement('label');
  label.className = 'language-control';
  label.innerHTML = `
    <span class="visually-hidden" data-menu-copy="language"></span>
    <select id="menu-language" aria-label="${copy().language}">
      <option value="pl">PL</option>
      <option value="en">EN</option>
      <option value="de">DE</option>
    </select>`;
  label.querySelector('select').value = language;
  actions.prepend(label);
}

function buildCardArtStage() {
  const scene = document.querySelector('.hero-scene');
  if (!scene || scene.classList.contains('card-art-stage')) return;
  scene.className = 'hero-scene card-art-stage';
  scene.setAttribute('aria-label', copy().sceneLabel);
  scene.innerHTML = `
    <div class="card-stage-halo" aria-hidden="true"></div>
    <figure class="hero-art-card hero-art-card-left" aria-hidden="true"><img src="assets/cards/cookie-set.webp" alt=""></figure>
    <figure class="hero-art-card hero-art-card-center" aria-hidden="true"><img src="assets/cards/bunny-guest.webp" alt=""></figure>
    <figure class="hero-art-card hero-art-card-right" aria-hidden="true"><img src="assets/cards/drink-1.webp" alt=""></figure>
    <div class="cafe-ticket" aria-hidden="true">
      <span data-menu-copy="ticket"></span>
      <strong data-menu-copy="ticketLine"></strong>
    </div>`;
}

function buildResumeCard() {
  const heroCopy = document.querySelector('.hero-copy');
  const heroActions = document.querySelector('.hero-actions');
  if (!heroCopy || !heroActions || document.getElementById('resume-session-card')) return;
  const card = document.createElement('aside');
  card.id = 'resume-session-card';
  card.className = 'resume-session-card';
  card.hidden = true;
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div class="resume-card-art" aria-hidden="true"><img src="assets/cards/cat-guest.webp" alt=""></div>
    <div class="resume-card-copy">
      <span class="resume-kicker" data-menu-copy="resumeKicker"></span>
      <strong data-menu-copy="resumeTitle"></strong>
      <p data-menu-copy="resumeBody"></p>
    </div>
    <button class="resume-action" type="button" data-menu-action="resume-online">
      <span class="resume-action-mark" aria-hidden="true">↻</span>
      <span data-menu-copy="resumeAction"></span>
    </button>`;
  heroCopy.insertBefore(card, heroActions);
}

function buildLeaveDialog() {
  if (document.getElementById('leave-online-dialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'leave-online-dialog';
  dialog.className = 'game-dialog leave-game-dialog';
  dialog.setAttribute('aria-labelledby', 'leave-online-title');
  dialog.innerHTML = `
    <div class="leave-game-illustration" aria-hidden="true">
      <img src="assets/cards/adoption-pet.webp" alt="">
    </div>
    <div class="dialog-header">
      <div>
        <p class="eyebrow" data-menu-copy="resumeKicker"></p>
        <h2 id="leave-online-title" data-menu-copy="leaveTitle"></h2>
      </div>
    </div>
    <div class="dialog-body leave-game-copy">
      <p data-menu-copy="leaveBody"></p>
      <p class="leave-game-hint" data-menu-copy="leaveHint"></p>
    </div>
    <div class="dialog-footer leave-game-actions">
      <button class="secondary-button" type="button" data-menu-action="cancel-leave" data-menu-copy="cancel"></button>
      <button class="primary-button danger-button" type="button" data-menu-action="confirm-leave" data-menu-copy="leave"></button>
    </div>`;
  document.body.append(dialog);
}

function refreshResumeCard() {
  const card = document.getElementById('resume-session-card');
  if (!card) return;
  card.hidden = !hasSavedOnlineSession();
}

function translateHome() {
  const c = copy();
  document.documentElement.lang = language;
  const mapping = [
    ['#home-screen .eyebrow', c.eyebrow],
    ['#home-title', c.title],
    ['.hero-lead', c.lead],
    ['[data-action="solo"]', c.solo],
    ['[data-action="multiplayer"]', c.multiplayer],
    ['.rules-button span:last-child', c.rules],
  ];
  for (const [selector, text] of mapping) {
    const node = document.querySelector(selector);
    if (!node) continue;
    if (selector.includes('data-action')) {
      const icon = node.querySelector('.ui-icon');
      node.replaceChildren();
      if (icon) node.append(icon);
      node.append(document.createTextNode(text));
    } else node.textContent = text;
  }

  const facts = document.querySelectorAll('.quick-facts span');
  if (facts[0]) facts[0].innerHTML = `<b>2–8</b> ${c.players}`;
  if (facts[1]) facts[1].innerHTML = `<b>3</b> ${c.rounds}`;
  if (facts[2]) facts[2].innerHTML = `<b>15</b> ${c.minutes}`;

  document.querySelectorAll('[data-menu-copy]').forEach((node) => {
    const value = c[node.dataset.menuCopy];
    if (value !== undefined) node.textContent = value;
  });
  const select = document.getElementById('menu-language');
  if (select) {
    select.value = language;
    select.setAttribute('aria-label', c.language);
  }
  const scene = document.querySelector('.card-art-stage');
  if (scene) scene.setAttribute('aria-label', c.sceneLabel);
}

function isActiveOnlineGame() {
  const mode = String(bridge.app?.mode ?? '');
  return mode.startsWith('online') && Boolean(bridge.app?.multiplayer?.inGame) && bridge.app?.view?.phase !== 'game_over';
}

function openLeaveDialog() {
  const dialog = document.getElementById('leave-online-dialog');
  if (!dialog || dialog.open) return;
  dialog.showModal();
  queueMicrotask(() => dialog.querySelector('[data-menu-action="cancel-leave"]')?.focus());
}

async function resumeOnlineGame(button) {
  if (resumeBusy) return;
  resumeBusy = true;
  const originalDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const label = button.querySelector('[data-menu-copy="resumeAction"]');
  if (label) label.textContent = copy().resuming;
  try {
    const session = bridge.createOnlineSession('resume');
    const recovered = await resumeSavedOnlineGame(session);
    if (!recovered) {
      session.close();
      bridge.app.multiplayer = null;
      clearSavedOnlineSession();
      refreshResumeCard();
      bridge.showToast(copy().resumeMissing, { type: 'info', duration: 7000 });
      return;
    }
    bridge.app.localSeat = Number.isInteger(recovered.localSeat) ? recovered.localSeat : 0;
    bridge.app.mode = recovered.role === 'host' ? 'online-host' : 'online-guest';
    bridge.setScreen('game');
    const status = document.getElementById('turn-status');
    if (status && !bridge.app.view) status.textContent = copy().resuming;
    bridge.showToast(copy().resumed, { type: 'success', duration: 6500 });
  } catch (error) {
    console.error(error);
    try { bridge.app.multiplayer?.close(); } catch { /* best effort */ }
    bridge.app.multiplayer = null;
    clearSavedOnlineSession();
    refreshResumeCard();
    bridge.showToast(copy().resumeFailed, { type: 'error', duration: 7500 });
  } finally {
    resumeBusy = false;
    button.disabled = originalDisabled;
    button.removeAttribute('aria-busy');
    if (label) label.textContent = copy().resumeAction;
  }
}

function installEvents() {
  document.addEventListener('change', (event) => {
    if (event.target?.id !== 'menu-language') return;
    language = setMenuLanguage(event.target.value);
    translateHome();
  });

  document.addEventListener('click', (event) => {
    const menuTarget = event.target.closest?.('[data-menu-action]');
    if (menuTarget) {
      const action = menuTarget.dataset.menuAction;
      if (action === 'resume-online') {
        event.preventDefault();
        void resumeOnlineGame(menuTarget);
        return;
      }
      if (action === 'cancel-leave') {
        event.preventDefault();
        document.getElementById('leave-online-dialog')?.close();
        return;
      }
      if (action === 'confirm-leave') {
        event.preventDefault();
        document.getElementById('leave-online-dialog')?.close();
        bridge.goHome();
        refreshResumeCard();
      }
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest?.('[data-action="home"]');
    if (!target || !isActiveOnlineGame()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openLeaveDialog();
  }, true);
}

installStylesheet();
buildLanguageControl();
buildCardArtStage();
buildResumeCard();
buildLeaveDialog();
installEvents();
translateHome();
refreshResumeCard();
