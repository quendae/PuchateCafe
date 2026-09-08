/**
 * Shared QQND multiplayer transport for Puchate Café.
 *
 * Sessions, rooms, reconnect, action routing and reconnect snapshots live on
 * qqnd-game-server. Until the Puchate rules reducer is moved server-side, the
 * current room host remains the only browser allowed to mutate canonical game
 * state and publishes a separate filtered projection for every remote human.
 */

export const PROTOCOL_VERSION = 1;
export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const BOT_DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);
export const DEFAULT_SERVER_URL = "wss://api.qqnd.fyi/api/v1/ws";

const GAME_ID = "puchate";
const SESSION_STORAGE_KEY = "puchate.qqnd.server-session.v1";
const MAX_NAME_LENGTH = 20;
const REQUEST_TIMEOUT_MS = 12_000;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export class ProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addListener(target, event, listener) {
  if (typeof target?.addEventListener === "function") {
    target.addEventListener(event, listener);
    return () => target.removeEventListener?.(event, listener);
  }
  const property = `on${event}`;
  const previous = target?.[property];
  const wrapped = (...args) => {
    if (typeof previous === "function") previous(...args);
    listener(...args);
  };
  target[property] = wrapped;
  return () => {
    if (target[property] === wrapped) target[property] = previous ?? null;
  };
}

function socketOpen(socket) {
  return socket?.readyState === 1;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeServerUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "/api") return DEFAULT_SERVER_URL;
  let url;
  try {
    url = new URL(raw, typeof location !== "undefined" ? location.href : undefined);
  } catch {
    fail("INVALID_SERVER_URL", "Nieprawidłowy adres wspólnego serwera multiplayer.");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!["ws:", "wss:"].includes(url.protocol)) {
    fail("INVALID_SERVER_URL", "Serwer multiplayer musi używać WebSocket (ws/wss).");
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/api/v1/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function normalizeRoomCode(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (!ROOM_CODE_PATTERN.test(raw)) {
    fail("INVALID_ROOM", "Kod pokoju powinien mieć osiem znaków.");
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizePlayerName(value) {
  const name = String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < 2) fail("INVALID_NAME", "Imię musi mieć co najmniej dwa znaki.");
  if (name.length > MAX_NAME_LENGTH) fail("INVALID_NAME", `Imię może mieć maksymalnie ${MAX_NAME_LENGTH} znaków.`);
  if (!/^[\p{L}\p{N} _-]+$/u.test(name)) fail("INVALID_NAME", "Imię zawiera niedozwolone znaki.");
  return name;
}

export function normalizeBotDifficulty(value) {
  const difficulty = String(value ?? "normal").trim().toLowerCase();
  if (!BOT_DIFFICULTIES.includes(difficulty)) {
    fail("INVALID_LOBBY", `Poziom bota musi być jednym z: ${BOT_DIFFICULTIES.join(", ")}.`);
  }
  return difficulty;
}

export function validateSeatCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < MIN_SEATS || count > MAX_SEATS) {
    fail("INVALID_LOBBY", `Stolik musi mieć od ${MIN_SEATS} do ${MAX_SEATS} miejsc.`);
  }
  return count;
}

function emptySeat(seat) {
  return { seat, kind: "empty", name: "", connected: false, ready: false };
}

export class MultiplayerSession {
  constructor(options = {}) {
    this.serverUrl = normalizeServerUrl(options.serverUrl ?? options.signalingUrl ?? DEFAULT_SERVER_URL);
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.filterState = options.filterState ?? options.stateForSeat ?? null;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
    this.callbacks = { ...(options.callbacks ?? {}) };
    for (const name of ["onLobby", "onStart", "onAction", "onState", "onResolution", "onError", "onConnection", "onPeerChange"]) {
      if (typeof options[name] === "function") this.callbacks[name] = options[name];
    }

    this.socket = null;
    this.socketPromise = null;
    this.waiters = [];
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this._closing = false;

    this.session = null;
    this.resumeToken = "";
    this.roomObj = null;
    this.roomCode = "";
    this.localName = "";
    this.localSeat = null;
    this.hostSessionId = "";
    this.role = null;
    this.lobby = null;
    this.maxSeats = 3;
    this.botSpecs = [];
    this.botSeats = [];
    this.inGame = false;
    this.paused = false;
    this.pauseReason = null;
    this.revision = 0;
    this.lastRevision = -1;
    this.actionSequence = 0;
  }

  get snapshot() {
    return Object.freeze({
      role: this.role,
      roomCode: this.roomCode,
      localSeat: this.localSeat,
      localName: this.localName,
      inGame: this.inGame,
      paused: this.paused,
      pauseReason: cloneJson(this.pauseReason),
      revision: this.revision,
      lobby: cloneJson(this.lobby),
      sessionId: this.session?.id ?? null,
    });
  }

  async createRoom({ name = "Gospodarz", maxSeats = 3 } = {}) {
    await this._leaveCurrentRoom();
    this._closing = false;
    this.localName = normalizePlayerName(name);
    this.maxSeats = validateSeatCount(maxSeats);
    await this._ensureSession(this.localName);

    const response = await this._request({
      type: "room.create",
      game: GAME_ID,
      name: "Puchate Café",
      visibility: "private",
      maxPlayers: this.maxSeats,
    }, ["room.created"]);
    this._syncRoom(response.room);
    this._emit("onConnection", { status: "room-created", roomCode: this.roomCode });
    return { roomCode: this.roomCode, seat: this.localSeat, lobby: cloneJson(this.lobby) };
  }

  async joinRoom(roomCode, { name = "Gość" } = {}) {
    await this._leaveCurrentRoom();
    this._closing = false;
    this.localName = normalizePlayerName(name);
    const normalized = normalizeRoomCode(roomCode);
    await this._ensureSession(this.localName);
    const response = await this._request({ type: "room.join", roomId: normalized }, ["room.joined"]);
    this._syncRoom(response.room);
    this._emit("onConnection", { status: "connected", roomCode: this.roomCode, seat: this.localSeat });
    return { roomCode: this.roomCode, seat: this.localSeat, lobby: cloneJson(this.lobby) };
  }

  configureLobby(configuration = {}) {
    this._requireHost("Tylko gospodarz może konfigurować stolik.");
    if (this.inGame) fail("GAME_STARTED", "Nie można zmieniać miejsc po rozpoczęciu gry.");
    if (configuration.maxSeats !== undefined && Number(configuration.maxSeats) !== this.maxSeats) {
      fail("INVALID_LOBBY", "Liczby miejsc nie można zmienić po utworzeniu pokoju.");
    }
    const requested = configuration.bots ?? configuration.botSeats ?? [];
    if (!Array.isArray(requested)) fail("INVALID_LOBBY", "Lista botów musi być tablicą.");
    const humanCount = this.roomObj?.players?.length ?? 1;
    const capacity = Math.max(0, this.maxSeats - humanCount);
    const specs = requested.slice(0, capacity).map((item, index) => {
      const source = Number.isInteger(item) ? { seat: item } : (item ?? {});
      return {
        name: normalizePlayerName(source.name ?? `Bot ${index + 1}`),
        difficulty: normalizeBotDifficulty(source.difficulty ?? configuration.botDifficulty ?? "normal"),
      };
    });
    this.botSpecs = specs;
    this._rebuildLobby();
    this._broadcastLobbyMetadata();
    return cloneJson(this.lobby);
  }

  setBotSeat(seat, { name, difficulty = "normal" } = {}) {
    this._requireHost("Tylko gospodarz może konfigurować boty.");
    if (!Number.isInteger(seat) || seat <= 0 || seat >= this.maxSeats) fail("INVALID_LOBBY", "Nieprawidłowe miejsce bota.");
    const humanCount = this.roomObj?.players?.length ?? 1;
    if (seat < humanCount) fail("SEAT_IN_USE", "To miejsce zajmuje połączony gracz.");
    const targetCount = Math.min(this.maxSeats - humanCount, Math.max(this.botSpecs.length, seat - humanCount + 1));
    const next = Array.from({ length: targetCount }, (_, index) => this.botSpecs[index] ?? {
      name: `Bot ${index + 1}`,
      difficulty: "normal",
    });
    next[seat - humanCount] = { name: normalizePlayerName(name ?? `Bot ${seat}`), difficulty: normalizeBotDifficulty(difficulty) };
    return this.configureLobby({ bots: next });
  }

  clearBotSeat(seat) {
    this._requireHost("Tylko gospodarz może konfigurować boty.");
    const humanCount = this.roomObj?.players?.length ?? 1;
    const index = seat - humanCount;
    if (index < 0 || index >= this.botSpecs.length) return cloneJson(this.lobby);
    const next = this.botSpecs.filter((_, candidate) => candidate !== index);
    return this.configureLobby({ bots: next });
  }

  async startGame(payload = undefined) {
    this._requireHost("Tylko gospodarz może rozpocząć grę.");
    if (this.inGame) fail("GAME_STARTED", "Gra już się rozpoczęła.");
    const humans = this.roomObj?.players?.length ?? 0;
    const botCount = this.botSpecs.length;
    const seatCount = humans + botCount;
    if (seatCount < MIN_SEATS || seatCount > this.maxSeats) fail("LOBBY_NOT_READY", "Stolik nie ma poprawnej liczby graczy.");

    const response = await this._request({
      type: "game.start",
      roomId: this.roomCode,
      botCount,
    }, ["game.started"]);
    if (payload !== undefined) this.startPayload = cloneJson(payload);
    return response.revision ?? this.revision;
  }

  sendAction(action, payload = {}) {
    if (!this.inGame) fail("GAME_NOT_STARTED", "Gra jeszcze się nie rozpoczęła.");
    if (this.paused) fail("GAME_PAUSED", this.pauseReason?.message ?? "Gra jest wstrzymana.");
    if (typeof action !== "string" || !action.trim() || action.length > 64) fail("INVALID_ACTION", "Nieprawidłowa akcja.");
    const actionId = `${this.session?.id ?? "session"}:${++this.actionSequence}`;
    this._send({
      type: "game.action",
      roomId: this.roomCode,
      action: action.trim(),
      actionId,
      payload: cloneJson(payload),
    });
    return actionId;
  }

  broadcastViews(authoritativeState) {
    this._requireHost("Tylko gospodarz może publikować stan gry.");
    if (!this.inGame) fail("GAME_NOT_STARTED", "Gra jeszcze się nie rozpoczęła.");
    if (typeof this.filterState !== "function") fail("FILTER_REQUIRED", "Brak filtra prywatnego widoku gracza.");

    this.revision = Math.max(0, this.revision) + 1;
    this._send({
      type: "game.state.commit",
      roomId: this.roomCode,
      revision: this.revision,
      state: cloneJson(authoritativeState),
    });

    const players = this.roomObj?.players ?? [];
    players.forEach((player, seat) => {
      if (player.id === this.session?.id || !player.connected) return;
      const view = this.filterState(authoritativeState, seat, { revision: this.revision, roomCode: this.roomCode });
      if (view === undefined) fail("FILTER_FAILED", `Brak prywatnego widoku dla miejsca ${seat}.`);
      this._send({
        type: "game.state.publish",
        roomId: this.roomCode,
        revision: this.revision,
        toSessionId: player.id,
        state: cloneJson(view),
      });
    });
    this._emit("onState", authoritativeState, { revision: this.revision, authoritative: true, seat: this.localSeat });
    return this.revision;
  }

  pauseGame({ code = "GAME_PAUSED", message = "Gra jest wstrzymana.", seat = null } = {}) {
    this.paused = true;
    this.pauseReason = { code, message, seat };
    this._emit("onConnection", { status: "game-paused", ...this.pauseReason });
    return true;
  }

  resolveAction(actionId, ok = true, result = null, options = {}) {
    const resolution = {
      actionId,
      ok: Boolean(ok),
      revision: this.revision,
      ...(ok ? { result } : { error: { code: options.code ?? "ACTION_REJECTED", message: options.message ?? "Akcja odrzucona." } }),
    };
    this._emit("onResolution", resolution, { authoritative: this.role === "host" });
    return resolution;
  }

  close() {
    this._closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (socketOpen(this.socket) && this.roomCode) {
      try { this._send({ type: "room.leave", roomId: this.roomCode }); } catch { /* best effort */ }
    }
    try { this.socket?.close(1000, "session closed"); } catch { /* best effort */ }
    this.socket = null;
    this.socketPromise = null;
    this.waiters.splice(0).forEach((waiter) => waiter.reject(new ProtocolError("CONNECTION_CLOSED", "Połączenie zostało zamknięte.")));
    this._clearRoomState();
  }

  async _leaveCurrentRoom() {
    if (!this.roomCode) return;
    if (socketOpen(this.socket)) {
      try {
        await this._request({ type: "room.leave", roomId: this.roomCode }, ["room.left"], 2000);
      } catch {
        // A stale room from a previous tab must not prevent creating/joining a new one.
      }
    }
    this._clearRoomState();
  }

  _clearRoomState() {
    this.roomObj = null;
    this.roomCode = "";
    this.localSeat = null;
    this.hostSessionId = "";
    this.role = null;
    this.lobby = null;
    this.botSpecs = [];
    this.botSeats = [];
    this.inGame = false;
    this.paused = false;
    this.pauseReason = null;
    this.revision = 0;
    this.lastRevision = -1;
    this.actionSequence = 0;
  }

  async _ensureSession(name) {
    await this._connectSocket();
    const saved = this._loadCredentials();
    if (saved?.sessionId && saved?.resumeToken) {
      try {
        const resumed = await this._request({
          type: "session.resume",
          sessionId: saved.sessionId,
          resumeToken: saved.resumeToken,
        }, ["session.resumed"]);
        this.session = resumed.session;
        this.resumeToken = saved.resumeToken;
        const existing = (resumed.rooms ?? []).find((room) => room.game === GAME_ID);
        if (existing) this._syncRoom(existing);
        return this.session;
      } catch (error) {
        if (!new Set(["invalid_session_credentials", "session_expired"]).has(error?.code)) throw error;
        this._clearCredentials();
      }
    }

    const created = await this._request({ type: "session.create", nickname: name }, ["session.created"]);
    this.session = created.session;
    this.resumeToken = created.resumeToken;
    this._saveCredentials();
    return this.session;
  }

  _connectSocket() {
    if (socketOpen(this.socket)) return Promise.resolve(this.socket);
    if (this.socketPromise) return this.socketPromise;
    this._closing = false;
    this.socketPromise = new Promise((resolve, reject) => {
      let socket;
      try { socket = this.webSocketFactory(this.serverUrl); }
      catch (error) { reject(error); return; }
      this.socket = socket;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new ProtocolError("SERVER_TIMEOUT", "Serwer multiplayer nie odpowiedział."));
        }
      }, REQUEST_TIMEOUT_MS);
      addListener(socket, "open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.reconnectAttempt = 0;
        this._emit("onConnection", { status: "server-connected" });
        resolve(socket);
      });
      addListener(socket, "message", (event) => this._handleMessage(event.data));
      addListener(socket, "error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new ProtocolError("SERVER_UNAVAILABLE", "Nie udało się połączyć ze wspólnym serwerem QQND."));
        }
      });
      addListener(socket, "close", () => {
        this.socketPromise = null;
        this.socket = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new ProtocolError("SERVER_UNAVAILABLE", "Połączenie z serwerem zostało zamknięte."));
        }
        if (!this._closing) {
          this._emit("onConnection", { status: "server-disconnected" });
          this._scheduleReconnect();
        }
      });
    }).finally(() => {
      if (!socketOpen(this.socket)) this.socketPromise = null;
    });
    return this.socketPromise;
  }

  _scheduleReconnect() {
    if (this._closing || this.reconnectTimer || !this._loadCredentials()) return;
    const delay = Math.min(5000, 500 * 2 ** Math.min(this.reconnectAttempt++, 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._resumeConnection().catch((error) => {
        this._reportError(error);
        this._scheduleReconnect();
      });
    }, delay);
  }

  async _resumeConnection() {
    const saved = this._loadCredentials();
    if (!saved) return;
    await this._connectSocket();
    const resumed = await this._request({
      type: "session.resume",
      sessionId: saved.sessionId,
      resumeToken: saved.resumeToken,
    }, ["session.resumed"]);
    this.session = resumed.session;
    this.resumeToken = saved.resumeToken;
    const room = (resumed.rooms ?? []).find((entry) => entry.game === GAME_ID && (!this.roomCode || entry.id === this.roomCode));
    if (room) {
      this._syncRoom(room);
      if (room.status === "in_game") {
        this.inGame = true;
        this._send({ type: "game.state.get", roomId: room.id });
      }
    }
    this._emit("onConnection", { status: "reconnected", roomCode: this.roomCode });
  }

  _request(message, responseTypes, timeoutMs = REQUEST_TIMEOUT_MS) {
    const types = new Set(responseTypes);
    return new Promise((resolve, reject) => {
      const waiter = { types, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new ProtocolError("SERVER_TIMEOUT", `Brak odpowiedzi: ${[...types].join(", ")}.`));
      }, timeoutMs);
      this.waiters.push(waiter);
      try { this._send(message); }
      catch (error) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(error);
      }
    });
  }

  _send(message) {
    if (!socketOpen(this.socket)) fail("SERVER_UNAVAILABLE", "Brak połączenia ze wspólnym serwerem QQND.");
    this.socket.send(JSON.stringify(message));
  }

  _handleMessage(raw) {
    let message;
    try { message = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw)); }
    catch { this._reportError(new ProtocolError("INVALID_JSON", "Serwer wysłał nieprawidłową wiadomość.")); return; }
    if (!isRecord(message) || typeof message.type !== "string") return;

    if (message.type === "error") {
      const error = new ProtocolError(String(message.code ?? "SERVER_ERROR"), String(message.message ?? message.code ?? "Błąd serwera."));
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      } else this._reportError(error);
      return;
    }

    this._processMessage(message);
    const index = this.waiters.findIndex((waiter) => waiter.types.has(message.type));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  _processMessage(message) {
    if (message.type === "session.created" || message.type === "session.resumed") {
      if (message.session) this.session = cloneJson(message.session);
      if (message.resumeToken) {
        this.resumeToken = message.resumeToken;
        this._saveCredentials();
      }
      return;
    }

    if (["room.created", "room.joined", "room.updated"].includes(message.type) && message.room?.game === GAME_ID) {
      this._syncRoom(message.room);
      return;
    }

    if (message.type === "room.message" && message.roomId === this.roomCode) {
      const payload = message.payload;
      if (payload?.type === "puchate.lobby" && message.fromSessionId === this.hostSessionId) {
        this.botSpecs = Array.isArray(payload.bots) ? payload.bots.slice(0, MAX_SEATS).map((bot, index) => ({
          name: normalizePlayerName(bot?.name ?? `Bot ${index + 1}`),
          difficulty: normalizeBotDifficulty(bot?.difficulty ?? "normal"),
        })) : [];
        this._rebuildLobby();
      }
      return;
    }

    if (message.type === "game.started" && message.game === GAME_ID) {
      if (message.room?.game === GAME_ID) this._syncRoom(message.room);
      this.inGame = true;
      this.paused = false;
      this.pauseReason = null;
      if (Number.isInteger(message.seat)) this.localSeat = message.seat;
      this.hostSessionId = String(message.hostSessionId ?? this.hostSessionId);
      this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      this.botSeats = Array.isArray(message.botSeats) ? message.botSeats.filter(Number.isInteger) : [];
      this.revision = Number.isInteger(message.revision) ? message.revision : this.revision;
      this._rebuildLobby(true);
      this._emit("onStart", cloneJson(message), this.snapshot);
      return;
    }

    if (message.type === "game.action" && message.roomId === this.roomCode) {
      if (this.role !== "host") return;
      const request = {
        seat: message.seat,
        action: message.action,
        payload: cloneJson(message.payload ?? {}),
        actionId: message.actionId ?? `${message.fromSessionId}:${message.actionSeq}`,
        clientRevision: this.revision,
        hostRevision: this.revision,
        peerId: message.fromSessionId,
        local: message.fromSessionId === this.session?.id,
      };
      Promise.resolve(this.callbacks.onAction?.(request, this))
        .then((result) => {
          if (result !== undefined) this._emit("onResolution", { actionId: request.actionId, ok: result?.ok !== false, result: result?.result ?? null, revision: this.revision }, { authoritative: true });
        })
        .catch((error) => this._reportError(error));
      return;
    }

    if (message.type === "game.state.committed" && message.roomId === this.roomCode) {
      this.revision = Math.max(this.revision, Number(message.revision) || 0);
      return;
    }

    if (message.type === "game.state" && message.roomId === this.roomCode) {
      const revision = Number(message.revision) || 0;
      if (revision < this.lastRevision) return;
      this.lastRevision = revision;
      this.revision = Math.max(this.revision, revision);
      if (Number.isInteger(message.viewerSeat)) this.localSeat = message.viewerSeat;
      if (Array.isArray(message.botSeats)) this.botSeats = message.botSeats.filter(Number.isInteger);
      if (message.hostSessionId) {
        this.hostSessionId = String(message.hostSessionId);
        this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      }
      const canonicalForHost = this.role === "host" && message.authoritative !== true;
      this._emit("onState", cloneJson(message.state), {
        revision,
        authoritative: canonicalForHost,
        serverAuthoritative: Boolean(message.authoritative),
        seat: this.localSeat,
      });
      return;
    }

    if (message.type === "game.state.empty" && message.roomId === this.roomCode) {
      if (Number.isInteger(message.viewerSeat)) this.localSeat = message.viewerSeat;
      return;
    }

    if (message.type === "game.player.connection" && message.roomId === this.roomCode) {
      if (Array.isArray(message.botSeats)) this.botSeats = message.botSeats.filter(Number.isInteger);
      if (message.hostSessionId) {
        this.hostSessionId = String(message.hostSessionId);
        this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      }
      this._emit("onPeerChange", {
        status: message.connected ? "connected" : "disconnected",
        seat: message.seat,
        nickname: message.nickname,
        graceMs: message.graceMs,
        graceDeadline: message.graceDeadline,
        reclaimedFromBot: Boolean(message.reclaimedFromBot),
      });
      return;
    }

    if (message.type === "game.player.bot_takeover" && message.roomId === this.roomCode) {
      if (Array.isArray(message.botSeats)) this.botSeats = message.botSeats.filter(Number.isInteger);
      if (message.hostSessionId) {
        this.hostSessionId = String(message.hostSessionId);
        this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      }
      this._emit("onPeerChange", {
        status: "bot-takeover",
        seat: message.seat,
        nickname: message.nickname,
        botSeats: cloneJson(this.botSeats),
      });
      return;
    }

    if (message.type === "game.host.changed" && message.roomId === this.roomCode) {
      this.hostSessionId = String(message.hostSessionId ?? "");
      this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      this._emit("onPeerChange", { status: "host-changed", hostSessionId: this.hostSessionId, isLocalHost: this.role === "host" });
      if (this.role === "host") this._send({ type: "game.state.get", roomId: this.roomCode });
      return;
    }

    if (message.type === "game.presence" && message.roomId === this.roomCode) {
      if (message.hostSessionId) {
        this.hostSessionId = String(message.hostSessionId);
        this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
      }
      if (Array.isArray(message.botSeats)) this.botSeats = message.botSeats.filter(Number.isInteger);
      return;
    }

    if (message.type === "room.closed" && message.roomId === this.roomCode) {
      this._reportError(new ProtocolError("ROOM_CLOSED", "Pokój został zamknięty."));
      this._clearRoomState();
    }
  }

  _syncRoom(room) {
    if (!room || room.game !== GAME_ID) return;
    this.roomObj = cloneJson(room);
    this.roomCode = normalizeRoomCode(room.id);
    this.maxSeats = validateSeatCount(room.maxPlayers ?? this.maxSeats ?? MAX_SEATS);
    this.hostSessionId = String(room.ownerSessionId ?? this.hostSessionId);
    this.localSeat = this.session ? (room.players ?? []).findIndex((player) => player.id === this.session.id) : this.localSeat;
    this.role = this.session?.id === this.hostSessionId ? "host" : "guest";
    if (room.status === "in_game") this.inGame = true;
    const availableBotSlots = Math.max(0, this.maxSeats - (room.players?.length ?? 0));
    if (!this.inGame && this.botSpecs.length > availableBotSlots) this.botSpecs = this.botSpecs.slice(0, availableBotSlots);
    this._rebuildLobby(this.inGame);
  }

  _rebuildLobby(useRuntimeBots = false) {
    if (!this.roomObj) return;
    const seats = Array.from({ length: this.maxSeats }, (_, seat) => emptySeat(seat));
    const humans = this.roomObj.players ?? [];
    humans.forEach((player, seat) => {
      if (seat >= seats.length) return;
      seats[seat] = {
        seat,
        kind: "human",
        name: String(player.nickname ?? `Gracz ${seat + 1}`),
        sessionId: player.id,
        connected: Boolean(player.connected),
        ready: Boolean(player.connected),
        isHost: player.id === this.hostSessionId,
      };
    });

    const runtimeBotSeats = useRuntimeBots && this.botSeats.length
      ? this.botSeats
      : this.botSpecs.map((_, index) => humans.length + index);
    runtimeBotSeats.forEach((seat, index) => {
      if (!Number.isInteger(seat) || seat < humans.length || seat >= seats.length) return;
      const spec = this.botSpecs[index] ?? { name: `Bot ${index + 1}`, difficulty: "normal" };
      seats[seat] = {
        seat,
        kind: "bot",
        name: spec.name,
        connected: false,
        ready: true,
        difficulty: spec.difficulty,
      };
    });

    this.lobby = { maxSeats: this.maxSeats, seats };
    this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
  }

  _broadcastLobbyMetadata() {
    if (this.role !== "host" || !this.roomCode || !socketOpen(this.socket)) return;
    this._send({
      type: "room.send",
      roomId: this.roomCode,
      payload: { type: "puchate.lobby", bots: cloneJson(this.botSpecs), maxSeats: this.maxSeats },
    });
  }

  _requireHost(message) {
    if (this.role !== "host") fail("HOST_ONLY", message);
  }

  _loadCredentials() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY);
      const value = raw ? JSON.parse(raw) : null;
      if (!value?.sessionId || !value?.resumeToken) return null;
      return value;
    } catch {
      return null;
    }
  }

  _saveCredentials() {
    if (!this.storage || !this.session?.id || !this.resumeToken) return;
    try {
      this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ sessionId: this.session.id, resumeToken: this.resumeToken }));
    } catch { /* storage is optional */ }
  }

  _clearCredentials() {
    if (!this.storage) return;
    try { this.storage.removeItem(SESSION_STORAGE_KEY); } catch { /* storage is optional */ }
  }

  _emit(name, ...args) {
    const callback = this.callbacks[name];
    if (typeof callback !== "function") return;
    try { callback(...args); }
    catch (error) { if (name !== "onError") this._reportError(error); }
  }

  _reportError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (typeof this.callbacks.onError === "function") {
      try { this.callbacks.onError(normalized, this.snapshot); } catch { /* callback error */ }
    }
  }
}

export default MultiplayerSession;
