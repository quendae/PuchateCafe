export const SESSION_STORAGE_KEY = 'puchate.qqnd.server-session.v1';
export const LANGUAGE_STORAGE_KEY = 'puchate-cafe-language';

function safeStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}

export function readSavedOnlineSession(storage = undefined) {
  const target = safeStorage(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(SESSION_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value?.sessionId || !value?.resumeToken) return null;
    return { sessionId: String(value.sessionId), resumeToken: String(value.resumeToken) };
  } catch {
    return null;
  }
}

export function hasSavedOnlineSession(storage = undefined) {
  return Boolean(readSavedOnlineSession(storage));
}

export function clearSavedOnlineSession(storage = undefined) {
  const target = safeStorage(storage);
  try { target?.removeItem(SESSION_STORAGE_KEY); } catch { /* optional storage */ }
}

export function getMenuLanguage(storage = undefined) {
  const target = safeStorage(storage);
  let saved = '';
  try { saved = String(target?.getItem(LANGUAGE_STORAGE_KEY) ?? '').toLowerCase(); } catch { /* optional storage */ }
  if (['pl', 'en', 'de'].includes(saved)) return saved;
  const browserLanguage = String(globalThis.navigator?.language ?? '').toLowerCase();
  if (browserLanguage.startsWith('de')) return 'de';
  if (browserLanguage.startsWith('en')) return 'en';
  return 'pl';
}

export function setMenuLanguage(language, storage = undefined) {
  const normalized = ['pl', 'en', 'de'].includes(language) ? language : 'pl';
  const target = safeStorage(storage);
  try { target?.setItem(LANGUAGE_STORAGE_KEY, normalized); } catch { /* optional storage */ }
  return normalized;
}

export async function resumeSavedOnlineGame(session) {
  if (!session || typeof session._resumeConnection !== 'function') throw new TypeError('resume-capable MultiplayerSession required');
  await session._resumeConnection();
  const snapshot = session.snapshot ?? {};
  if (!snapshot.inGame || !snapshot.roomCode) return null;
  return {
    roomCode: snapshot.roomCode,
    localSeat: snapshot.localSeat,
    role: snapshot.role,
    nickname: session.session?.nickname ?? snapshot.localName ?? '',
  };
}

const NOTICE_COPY = {
  pl: {
    reconnecting: ({ nickname, seconds }) => `${nickname || 'Gracz'} stracił połączenie. Czekamy ${seconds} s na powrót, potem miejsce przejmie bot.`,
    takeover: ({ nickname }) => `${nickname || 'Gracz'} opuścił stolik — bot przejął jego miejsce i gra toczy się dalej.`,
    localHost: () => 'Poprzedni gospodarz odszedł. Od teraz prowadzisz stolik i gra jest kontynuowana.',
    hostChanged: () => 'Gospodarz się zmienił. Gra została przekazana innemu graczowi i może być kontynuowana.',
    reclaimed: ({ nickname }) => `${nickname || 'Gracz'} wrócił i odzyskał swoje miejsce od bota.`,
  },
  en: {
    reconnecting: ({ nickname, seconds }) => `${nickname || 'A player'} lost connection. Waiting ${seconds}s for them to return before a bot takes the seat.`,
    takeover: ({ nickname }) => `${nickname || 'A player'} left the table — a bot took over the seat and the game continues.`,
    localHost: () => 'The previous host left. You are now running the table and the game can continue.',
    hostChanged: () => 'The host changed. Control was handed to another player and the game can continue.',
    reclaimed: ({ nickname }) => `${nickname || 'A player'} returned and reclaimed the seat from the bot.`,
  },
  de: {
    reconnecting: ({ nickname, seconds }) => `${nickname || 'Ein Spieler'} hat die Verbindung verloren. Wir warten ${seconds} s auf die Rückkehr, danach übernimmt ein Bot den Platz.`,
    takeover: ({ nickname }) => `${nickname || 'Ein Spieler'} hat den Tisch verlassen — ein Bot übernimmt den Platz und das Spiel läuft weiter.`,
    localHost: () => 'Der bisherige Host ist weg. Du übernimmst jetzt die Spielleitung und kannst weiterspielen.',
    hostChanged: () => 'Der Host hat gewechselt. Die Spielleitung wurde an einen anderen Spieler übergeben.',
    reclaimed: ({ nickname }) => `${nickname || 'Ein Spieler'} ist zurück und hat den Platz vom Bot zurückerhalten.`,
  },
};

export function peerNotice(event, language = 'pl') {
  if (!event?.status) return null;
  const copy = NOTICE_COPY[language] ?? NOTICE_COPY.pl;
  if (event.status === 'reconnecting') {
    const seconds = Math.max(1, Math.round(Number(event.graceMs ?? 60_000) / 1000));
    return { message: copy.reconnecting({ nickname: event.nickname, seconds }), type: 'info', duration: Math.min(9000, Math.max(5000, seconds * 100)) };
  }
  if (event.status === 'bot-takeover') {
    return { message: copy.takeover({ nickname: event.nickname }), type: 'info', duration: 8000 };
  }
  if (event.status === 'host-changed') {
    return { message: event.isLocalHost ? copy.localHost({}) : copy.hostChanged({}), type: event.isLocalHost ? 'success' : 'info', duration: 8000 };
  }
  if (event.status === 'connected' && event.reclaimedFromBot) {
    return { message: copy.reclaimed({ nickname: event.nickname }), type: 'success', duration: 7000 };
  }
  return null;
}
