/**
 * Host-authoritative WebRTC multiplayer for Puchate Cafe.
 *
 * The signaling service only forwards SDP/ICE. Once connected, every guest has
 * one reliable, ordered DataChannel to the host. Guests send intents; only the
 * host's game engine may change authoritative state.
 */

export const PROTOCOL_VERSION = 1;
export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const BOT_DIFFICULTIES = Object.freeze(["easy", "normal", "hard"]);
export const MESSAGE_TYPES = Object.freeze([
  "hello",
  "welcome",
  "lobby",
  "start",
  "action",
  "state",
  "resolution",
  "error",
  "ping",
]);

const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 24;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const DEFAULT_SIGNALING_KEY = "puchate-cafe-signaling-url";

// Production follows the same deployment pattern as Skat: the signaling Worker
// lives under /api on the game's own origin. Keep any user supplied override.
if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
  try {
    if (!window.localStorage.getItem(DEFAULT_SIGNALING_KEY)) {
      window.localStorage.setItem(DEFAULT_SIGNALING_KEY, "/api");
    }
  } catch {
    // Storage can be blocked in privacy modes; the advanced connection field
    // remains available in the UI in that case.
  }
}

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isShortString(value, max = 80) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function assertJsonSafe(value, label = "payload") {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) fail("INVALID_MESSAGE", `${label} is not JSON serializable.`);
    if (new TextEncoder().encode(json).byteLength > MAX_MESSAGE_BYTES) {
      fail("MESSAGE_TOO_LARGE", `${label} exceeds ${MAX_MESSAGE_BYTES} bytes.`);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    fail("INVALID_MESSAGE", `${label} is not JSON serializable.`);
  }
}

export function normalizeRoomCode(value) {
  const code = String(value ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!ROOM_CODE_PATTERN.test(code)) {
    fail("INVALID_ROOM", "Room code must contain six letters or digits (without 0, 1, I or O).");
  }
  return code;
}

export function normalizePlayerName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) fail("INVALID_NAME", "Player name cannot be empty.");
  if (name.length > MAX_NAME_LENGTH) {
    fail("INVALID_NAME", `Player name may contain at most ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

export function normalizeBotDifficulty(value) {
  const difficulty = String(value ?? "normal").trim().toLowerCase();
  if (!BOT_DIFFICULTIES.includes(difficulty)) {
    fail("INVALID_LOBBY", `Bot difficulty must be one of: ${BOT_DIFFICULTIES.join(", ")}.`);
  }
  return difficulty;
}

export function validateSeatCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < MIN_SEATS || count > MAX_SEATS) {
    fail("INVALID_LOBBY", `A room must have between ${MIN_SEATS} and ${MAX_SEATS} seats.`);
  }
  return count;
}

export function validateLobby(value) {
  if (!isRecord(value)) fail("INVALID_LOBBY", "Lobby must be an object.");
  const maxSeats = validateSeatCount(value.maxSeats);
  if (!Array.isArray(value.seats) || value.seats.length !== maxSeats) {
    fail("INVALID_LOBBY", "Lobby must describe every seat exactly once.");
  }
  const seen = new Set();
  for (const entry of value.seats) {
    if (!isRecord(entry) || !Number.isInteger(entry.seat) || entry.seat < 0 || entry.seat >= maxSeats) {
      fail("INVALID_LOBBY", "Lobby contains an invalid seat.");
    }
    if (seen.has(entry.seat)) fail("INVALID_LOBBY", "Lobby contains a duplicate seat.");
    seen.add(entry.seat);
    if (!["human", "bot", "empty"].includes(entry.kind)) {
      fail("INVALID_LOBBY", "Seat kind must be human, bot or empty.");
    }
    if (entry.kind !== "empty" && !isShortString(entry.name, MAX_NAME_LENGTH)) {
      fail("INVALID_LOBBY", "Occupied seats require a valid name.");
    }
    if (entry.kind === "bot") {
      if (entry.connected) fail("INVALID_LOBBY", "A bot seat cannot be marked as connected.");
      normalizeBotDifficulty(entry.difficulty ?? "normal");
    }
  }
  const host = value.seats.find((seat) => seat.seat === 0);
  if (!host || host.kind !== "human" || !host.connected) {
    fail("INVALID_LOBBY", "Seat zero must be the connected host.");
  }
  assertJsonSafe(value, "lobby");
  return value;
}

/** Parse and validate an application-level DataChannel packet. */
export function parseProtocolMessage(raw) {
  let message = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      fail("MESSAGE_TOO_LARGE", "Message is too large.");
    }
    try {
      message = JSON.parse(raw);
    } catch {
      fail("INVALID_JSON", "Message is not valid JSON.");
    }
  }
  if (!isRecord(message) || !MESSAGE_TYPE_SET.has(message.type)) {
    fail("INVALID_MESSAGE", "Unknown or missing message type.");
  }

  switch (message.type) {
    case "hello":
      if (message.protocol !== PROTOCOL_VERSION || !isShortString(message.name, MAX_NAME_LENGTH)) {
        fail("PROTOCOL_MISMATCH", "Invalid hello packet or incompatible protocol.");
      }
      break;
    case "welcome":
      if (message.protocol !== PROTOCOL_VERSION || !Number.isInteger(message.seat) || message.seat < 1 || message.seat >= MAX_SEATS) {
        fail("INVALID_MESSAGE", "Invalid welcome packet.");
      }
      validateLobby(message.lobby);
      if (message.seat >= message.lobby.maxSeats) fail("INVALID_MESSAGE", "Welcome seat is outside the lobby.");
      if (!isRevision(message.revision)) fail("INVALID_MESSAGE", "Welcome revision is invalid.");
      break;
    case "lobby":
      validateLobby(message.lobby);
      if (!isRevision(message.revision)) fail("INVALID_MESSAGE", "Lobby revision is invalid.");
      break;
    case "start":
      if (!isRevision(message.revision)) fail("INVALID_MESSAGE", "Start revision is invalid.");
      assertJsonSafe(message.payload ?? null, "start payload");
      break;
    case "action":
      if (!isShortString(message.action, 64) || !isShortString(message.actionId, 128) || !isRevision(message.revision)) {
        fail("INVALID_ACTION", "Action packet is incomplete.");
      }
      assertJsonSafe(message.payload ?? null, "action payload");
      break;
    case "state":
      if (!isRevision(message.revision)) fail("INVALID_MESSAGE", "State revision is invalid.");
      assertJsonSafe(message.state, "state");
      break;
    case "resolution":
      if (!isShortString(message.actionId, 128) || typeof message.ok !== "boolean" || !isRevision(message.revision)) {
        fail("INVALID_MESSAGE", "Resolution packet is incomplete.");
      }
      if (!message.ok && (!isRecord(message.error) || !isShortString(message.error.code, 64))) {
        fail("INVALID_MESSAGE", "Rejected resolutions require an error code.");
      }
      assertJsonSafe(message.result ?? message.error ?? null, "resolution");
      break;
    case "error":
      if (!isShortString(message.code, 64) || !isShortString(message.message, 240)) {
        fail("INVALID_MESSAGE", "Error packet is incomplete.");
      }
      break;
    case "ping":
      if (!Number.isFinite(message.at) || (message.reply !== undefined && typeof message.reply !== "boolean")) {
        fail("INVALID_MESSAGE", "Ping packet is invalid.");
      }
      break;
  }
  assertJsonSafe(message, "message");
  return message;
}

export function encodeProtocolMessage(message) {
  return JSON.stringify(parseProtocolMessage(message));
}

export function makeActionId(peerId = "local", sequence = 0) {
  const safePeer = String(peerId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "local";
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("INVALID_ACTION", "Action sequence is invalid.");
  return `${safePeer}:${sequence}`;
}

function cloneJson(value) {
  assertJsonSafe(value);
  return JSON.parse(JSON.stringify(value));
}

function emptySeat(seat) {
  return { seat, kind: "empty", name: "", connected: false, ready: false };
}

function createLobby(name, maxSeats) {
  const seats = Array.from({ length: maxSeats }, (_, seat) => emptySeat(seat));
  seats[0] = { seat: 0, kind: "human", name, connected: true, ready: true };
  return { maxSeats, seats };
}

function addListener(target, event, listener) {
  if (typeof target.addEventListener === "function") {
    target.addEventListener(event, listener);
    return () => target.removeEventListener?.(event, listener);
  }
  const property = `on${event}`;
  const previous = target[property];
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
  return socket?.readyState === 1 || socket?.readyState === socket?.OPEN;
}

function channelOpen(channel) {
  return channel?.readyState === "open";
}

function websocketUrl(base, path) {
  const fallback = typeof location !== "undefined" ? location.href : undefined;
  let url;
  try {
    url = new URL(base, fallback);
  } catch {
    fail("INVALID_SIGNALING_URL", "A valid signaling WebSocket URL is required.");
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    fail("INVALID_SIGNALING_URL", "Signaling URL must use ws, wss, http or https.");
  }
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @typedef {object} MultiplayerOptions
 * @property {string} signalingUrl Base URL of the signaling Worker.
 * @property {(state: any, seat: number, meta: object) => any} filterState
 * Required host callback. It must return only information legally visible to
 * `seat`; the networking layer never guesses a card game's hidden information.
 */

export class MultiplayerSession {
  constructor(options = {}) {
    this.signalingUrl = options.signalingUrl ?? "";
    this.rtcConfig = options.rtcConfig ?? { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.peerConnectionFactory = options.peerConnectionFactory ?? ((config) => new RTCPeerConnection(config));
    this.filterState = options.filterState ?? options.stateForSeat ?? null;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.callbacks = { ...(options.callbacks ?? {}) };
    for (const name of ["onLobby", "onStart", "onAction", "onState", "onResolution", "onError", "onConnection", "onPeerChange"]) {
      if (typeof options[name] === "function") this.callbacks[name] = options[name];
    }

    this.role = null;
    this.roomCode = "";
    this.localSeat = null;
    this.localName = "";
    this.peerId = "";
    this.lobby = null;
    this.inGame = false;
    this.paused = false;
    this.pauseReason = null;
    this.revision = 0;
    this.lastRevision = -1;
    this.actionSequence = 0;
    this.peers = new Map();
    this.signalSocket = null;
    this._seenActions = new Set();
    this._actionOrigins = new Map();
    this._closing = false;
  }

  get snapshot() {
    return Object.freeze({
      role: this.role,
      roomCode: this.roomCode,
      localSeat: this.localSeat,
      localName: this.localName,
      inGame: this.inGame,
      paused: this.paused,
      pauseReason: this.pauseReason ? cloneJson(this.pauseReason) : null,
      revision: this.revision,
      lobby: this.lobby ? cloneJson(this.lobby) : null,
    });
  }

  async createRoom({ name = "Gospodarz", maxSeats = 3 } = {}) {
    this.close();
    this._closing = false;
    this.role = "host";
    this.localSeat = 0;
    this.localName = normalizePlayerName(name);
    this.lobby = createLobby(this.localName, validateSeatCount(maxSeats));
    const ready = await this._openSignal("/room/create", "created");
    this.roomCode = normalizeRoomCode(ready.roomCode);
    this.peerId = String(ready.peerId ?? "host");
    this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
    this._emit("onConnection", { status: "room-created", roomCode: this.roomCode });
    return { roomCode: this.roomCode, seat: 0, lobby: cloneJson(this.lobby) };
  }

  async joinRoom(roomCode, { name = "Gość" } = {}) {
    this.close();
    this._closing = false;
    this.role = "guest";
    this.localName = normalizePlayerName(name);
    this.roomCode = normalizeRoomCode(roomCode);
    const ready = await this._openSignal(`/room/${encodeURIComponent(this.roomCode)}/join`, "joined");
    this.peerId = String(ready.peerId);
    await this._createGuestOffer();
    this._emit("onConnection", { status: "signaling-connected", roomCode: this.roomCode });
    return { roomCode: this.roomCode };
  }

  configureLobby(configuration = {}) {
    this._requireHost("Only the host can configure the lobby.");
    if (this.inGame) fail("GAME_STARTED", "The lobby cannot be changed after the game starts.");
    const nextCount = configuration.maxSeats === undefined
      ? this.lobby.maxSeats
      : validateSeatCount(configuration.maxSeats);
    const occupiedHumans = this.lobby.seats.filter((seat) => seat.kind === "human" && seat.connected);
    if (occupiedHumans.some((seat) => seat.seat >= nextCount)) {
      fail("SEAT_IN_USE", "Cannot remove a seat occupied by a connected player.");
    }

    const seats = Array.from({ length: nextCount }, (_, seat) => emptySeat(seat));
    for (const human of occupiedHumans) seats[human.seat] = { ...human };
    const requestedBots = configuration.bots ?? configuration.botSeats ?? this.lobby.seats
      .filter((seat) => seat.kind === "bot")
      .map((seat) => ({ seat: seat.seat, name: seat.name, difficulty: seat.difficulty }));
    if (!Array.isArray(requestedBots)) fail("INVALID_LOBBY", "bots must be an array.");
    for (const item of requestedBots) {
      const spec = Number.isInteger(item) ? { seat: item } : item;
      if (!isRecord(spec) || !Number.isInteger(spec.seat) || spec.seat <= 0 || spec.seat >= nextCount) {
        fail("INVALID_LOBBY", "Bot seat is outside the lobby.");
      }
      if (seats[spec.seat].kind === "human") fail("SEAT_IN_USE", "A connected player already occupies that seat.");
      seats[spec.seat] = {
        seat: spec.seat,
        kind: "bot",
        name: normalizePlayerName(spec.name ?? `Bot ${spec.seat}`),
        connected: false,
        ready: true,
        difficulty: normalizeBotDifficulty(spec.difficulty ?? configuration.botDifficulty ?? "normal"),
      };
    }
    this.lobby = validateLobby({ maxSeats: nextCount, seats });
    this.revision += 1;
    this._broadcast({ type: "lobby", lobby: this.lobby, revision: this.revision });
    this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
    return cloneJson(this.lobby);
  }

  setBotSeat(seat, { name, difficulty = "normal" } = {}) {
    this._requireHost("Only the host can configure bot seats.");
    if (!Number.isInteger(seat) || seat <= 0 || seat >= this.lobby.maxSeats) {
      fail("INVALID_LOBBY", "Bot seat is outside the lobby.");
    }
    const existing = this.lobby.seats[seat];
    if (existing.kind === "human" && existing.connected) fail("SEAT_IN_USE", "A connected player already occupies that seat.");
    const bots = this.lobby.seats
      .filter((entry) => entry.kind === "bot" && entry.seat !== seat)
      .map((entry) => ({ seat: entry.seat, name: entry.name, difficulty: entry.difficulty }));
    bots.push({ seat, name: name ?? `Bot ${seat}`, difficulty });
    return this.configureLobby({ maxSeats: this.lobby.maxSeats, bots });
  }

  clearBotSeat(seat) {
    this._requireHost("Only the host can configure bot seats.");
    const bots = this.lobby.seats
      .filter((entry) => entry.kind === "bot" && entry.seat !== seat)
      .map((entry) => ({ seat: entry.seat, name: entry.name, difficulty: entry.difficulty }));
    return this.configureLobby({ maxSeats: this.lobby.maxSeats, bots });
  }

  startGame(payload = undefined) {
    this._requireHost("Only the host can start the game.");
    if (this.inGame) fail("GAME_STARTED", "The game has already started.");
    const unready = this.lobby.seats.filter((seat) => seat.kind === "empty" || (seat.kind === "human" && !seat.connected));
    if (unready.length) fail("LOBBY_NOT_READY", "Every seat must contain a connected player or a bot.");
    this.inGame = true;
    this.paused = false;
    this.pauseReason = null;
    this.revision += 1;
    const message = { type: "start", revision: this.revision };
    if (payload !== undefined) {
      assertJsonSafe(payload, "start payload");
      message.payload = payload;
    }
    this._broadcast(message);
    this._emit("onStart", cloneJson(message), this.snapshot);
    return this.revision;
  }

  pauseGame({ code = "GAME_PAUSED", message = "The game is paused.", seat = null } = {}) {
    this._requireHost("Only the host can pause the game.");
    if (!this.inGame) return false;
    if (this.paused) return true;
    this.paused = true;
    this.pauseReason = { code: String(code).slice(0, 64), message: String(message).slice(0, 240), seat };
    this._broadcast({ type: "error", code: this.pauseReason.code, message: this.pauseReason.message });
    this._emit("onConnection", { status: "game-paused", ...this.pauseReason });
    return true;
  }

  sendAction(action, payload = {}) {
    if (!this.inGame) fail("GAME_NOT_STARTED", "Actions can only be sent after the game starts.");
    if (this.paused) fail("GAME_PAUSED", this.pauseReason?.message ?? "The game is paused.");
    if (!isShortString(action, 64)) fail("INVALID_ACTION", "Action name is invalid.");
    assertJsonSafe(payload, "action payload");
    const actionId = makeActionId(this.peerId || "local", ++this.actionSequence);
    const message = { type: "action", action, payload, actionId, revision: Math.max(0, this.lastRevision, this.revision) };
    if (this.role === "guest") {
      const host = this.peers.get("host");
      if (!host || !channelOpen(host.channel)) fail("HOST_UNAVAILABLE", "The host connection is not open.");
      this._sendChannel(host.channel, message);
    } else if (this.role === "host") {
      void this._dispatchHostAction({ ...message, seat: 0, peerId: this.peerId, local: true });
    } else {
      fail("NOT_CONNECTED", "Join or create a room first.");
    }
    return actionId;
  }

  /**
   * Increment the authoritative revision and send a distinct filtered view to
   * every guest. `filterState` is deliberately required: silently broadcasting
   * the full state would leak hands, deck order and RNG data.
   */
  broadcastViews(authoritativeState, resolution = null) {
    this._requireHost("Only the host can broadcast state.");
    if (typeof this.filterState !== "function") {
      fail("FILTER_REQUIRED", "Provide filterState(state, seat) before broadcasting card-game state.");
    }
    this.revision += 1;
    for (const peer of this.peers.values()) {
      if (!Number.isInteger(peer.seat) || !channelOpen(peer.channel)) continue;
      const view = this.filterState(authoritativeState, peer.seat, {
        revision: this.revision,
        roomCode: this.roomCode,
      });
      if (view === undefined) fail("FILTER_FAILED", `filterState returned undefined for seat ${peer.seat}.`);
      this._sendChannel(peer.channel, { type: "state", revision: this.revision, state: view });
    }
    this._emit("onState", authoritativeState, { revision: this.revision, authoritative: true, seat: 0 });
    if (resolution) {
      this.resolveAction(resolution.actionId, resolution.ok !== false, resolution.result, resolution);
    }
    return this.revision;
  }

  resolveAction(actionId, ok = true, result = null, options = {}) {
    this._requireHost("Only the host can resolve actions.");
    if (!isShortString(actionId, 128)) fail("INVALID_ACTION", "Action ID is invalid.");
    const message = { type: "resolution", actionId, ok: Boolean(ok), revision: this.revision };
    if (message.ok) {
      message.result = result;
    } else {
      message.error = {
        code: String(options.code ?? options.error?.code ?? "ACTION_REJECTED").slice(0, 64),
        message: String(options.message ?? options.error?.message ?? "Action was rejected.").slice(0, 240),
      };
    }
    const target = options.peerId
      ? this.peers.get(options.peerId)
      : options.seat !== undefined
        ? [...this.peers.values()].find((peer) => peer.seat === options.seat)
        : this.peers.get(this._actionOrigins.get(actionId));
    if (target?.channel && channelOpen(target.channel)) this._sendChannel(target.channel, message);
    if (!target && options.broadcast) this._broadcast(message);
    this._actionOrigins.delete(actionId);
    this._emit("onResolution", cloneJson(message), { authoritative: true });
    return message;
  }

  close() {
    this._closing = true;
    for (const peer of this.peers.values()) {
      try { peer.channel?.close(); } catch { /* best effort */ }
      try { peer.pc?.close(); } catch { /* best effort */ }
    }
    this.peers.clear();
    try { this.signalSocket?.close(1000, "session closed"); } catch { /* best effort */ }
    this.signalSocket = null;
    this.role = null;
    this.roomCode = "";
    this.localSeat = null;
    this.peerId = "";
    this.lobby = null;
    this.inGame = false;
    this.paused = false;
    this.pauseReason = null;
    this.revision = 0;
    this.lastRevision = -1;
    this.actionSequence = 0;
    this._seenActions.clear();
    this._actionOrigins.clear();
  }

  async _openSignal(path, expectedType) {
    if (!this.signalingUrl) fail("INVALID_SIGNALING_URL", "signalingUrl is required for online play.");
    const socket = this.webSocketFactory(websocketUrl(this.signalingUrl, path));
    this.signalSocket = socket;
    addListener(socket, "message", (event) => this._handleSignalMessage(event.data));
    addListener(socket, "close", () => {
      if (!this._closing) {
        this._emit("onConnection", { status: "signaling-closed" });
        this._reportError(new ProtocolError("SIGNALING_CLOSED", "The signaling connection closed."));
      }
    });
    addListener(socket, "error", () => this._reportError(new ProtocolError("SIGNALING_FAILED", "Could not connect to signaling.")));

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleaners = [];
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        for (const cleanup of cleaners) cleanup();
        callback(value);
      };
      const timeout = setTimeout(() => finish(
        reject,
        new ProtocolError("SIGNALING_TIMEOUT", "Signaling did not respond in time."),
      ), 10_000);
      cleaners.push(addListener(socket, "message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === expectedType) {
          finish(resolve, message);
        } else if (message.type === "error") {
          finish(reject, new ProtocolError(message.code ?? "SIGNALING_ERROR", message.message ?? "Signaling failed."));
        }
      }));
      cleaners.push(addListener(socket, "error", () => finish(
        reject,
        new ProtocolError("SIGNALING_FAILED", "Could not connect to signaling."),
      )));
      cleaners.push(addListener(socket, "close", () => finish(
        reject,
        new ProtocolError("SIGNALING_CLOSED", "Signaling closed before the room was ready."),
      )));
    });
  }

  _handleSignalMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!isRecord(message)) return;
    if (message.type === "relay" && isRecord(message.signal)) {
      void this._handleRelay(String(message.from), message.signal).catch((error) => this._reportError(error));
    } else if (message.type === "peer-left" && this.role === "host") {
      this._removePeer(String(message.peerId));
    } else if (message.type === "host-left" && this.role === "guest") {
      this.paused = true;
      this.pauseReason = { code: "HOST_UNAVAILABLE", message: "The host left the room.", seat: 0 };
      this._emit("onConnection", { status: "host-disconnected" });
      this._reportError(new ProtocolError("HOST_UNAVAILABLE", "The host left the room."));
    } else if (message.type === "error") {
      this._reportError(new ProtocolError(message.code ?? "SIGNALING_ERROR", message.message ?? "Signaling error."));
    }
  }

  async _createGuestOffer() {
    const pc = this.peerConnectionFactory(this.rtcConfig);
    const channel = pc.createDataChannel("puchate-cafe", { ordered: true });
    const peer = { id: "host", pc, channel, seat: 0, pendingCandidates: [], remoteDescriptionSet: false };
    this.peers.set("host", peer);
    this._wirePeer(peer);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._relay("host", { description: pc.localDescription ?? offer });
  }

  async _handleRelay(from, signal) {
    if (signal.description) {
      if (this.role === "host" && signal.description.type === "offer") {
        let peer = this.peers.get(from);
        if (!peer) peer = this._createHostPeer(from);
        await peer.pc.setRemoteDescription(signal.description);
        peer.remoteDescriptionSet = true;
        await this._flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this._relay(from, { description: peer.pc.localDescription ?? answer });
      } else if (this.role === "guest" && signal.description.type === "answer") {
        const peer = this.peers.get("host");
        if (!peer) return;
        await peer.pc.setRemoteDescription(signal.description);
        peer.remoteDescriptionSet = true;
        await this._flushCandidates(peer);
      }
    } else if (signal.candidate) {
      let peer = this.role === "host" ? this.peers.get(from) : this.peers.get("host");
      if (!peer && this.role === "host") peer = this._createHostPeer(from);
      if (!peer) return;
      if (!peer.remoteDescriptionSet) peer.pendingCandidates.push(signal.candidate);
      else await peer.pc.addIceCandidate(signal.candidate);
    }
  }

  async _flushCandidates(peer) {
    for (const candidate of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  }

  _createHostPeer(peerId) {
    const pc = this.peerConnectionFactory(this.rtcConfig);
    const peer = { id: peerId, pc, channel: null, seat: null, pendingCandidates: [], remoteDescriptionSet: false };
    this.peers.set(peerId, peer);
    this._wirePeer(peer);
    return peer;
  }

  _wirePeer(peer) {
    peer.pc.onicecandidate = (event) => {
      if (event.candidate) this._relay(peer.id, { candidate: event.candidate });
    };
    peer.pc.onconnectionstatechange = () => {
      const status = peer.pc.connectionState;
      this._emit("onPeerChange", { peerId: peer.id, seat: peer.seat, status });
      if (["failed", "closed", "disconnected"].includes(status) && this.role === "host") this._removePeer(peer.id);
    };
    if (this.role === "host") {
      peer.pc.ondatachannel = (event) => {
        const unreliable = event.channel.ordered === false
          || event.channel.maxRetransmits != null
          || event.channel.maxPacketLifeTime != null;
        if (event.channel.label !== "puchate-cafe" || unreliable) {
          event.channel.close();
          return;
        }
        peer.channel = event.channel;
        this._wireChannel(peer);
      };
    } else {
      this._wireChannel(peer);
    }
  }

  _wireChannel(peer) {
    const channel = peer.channel;
    if (!channel) return;
    addListener(channel, "open", () => {
      if (this.role === "guest") {
        this._sendChannel(channel, { type: "hello", protocol: PROTOCOL_VERSION, name: this.localName });
      }
      this._emit("onPeerChange", { peerId: peer.id, seat: peer.seat, status: "connected" });
    });
    addListener(channel, "message", (event) => this._handleChannelMessage(peer, event.data));
    addListener(channel, "close", () => {
      if (this.role === "host") this._removePeer(peer.id);
      else {
        this.paused = true;
        this.pauseReason = { code: "HOST_UNAVAILABLE", message: "The host connection closed.", seat: 0 };
        this._emit("onConnection", { status: "host-disconnected" });
      }
    });
  }

  _handleChannelMessage(peer, raw) {
    let message;
    try {
      message = parseProtocolMessage(raw);
    } catch (error) {
      this._sendError(peer, error.code ?? "INVALID_MESSAGE", error.message);
      this._reportError(error);
      return;
    }
    const hostAllowed = new Set(["hello", "action", "ping"]);
    const guestAllowed = new Set(["welcome", "lobby", "start", "state", "resolution", "error", "ping"]);
    if ((this.role === "host" && !hostAllowed.has(message.type)) || (this.role === "guest" && !guestAllowed.has(message.type))) {
      this._sendError(peer, "UNEXPECTED_MESSAGE", `Unexpected ${message.type} packet.`);
      return;
    }

    if (message.type === "ping") {
      if (!message.reply) this._sendChannel(peer.channel, { type: "ping", at: message.at, reply: true });
      return;
    }
    if (this.role === "host") {
      if (message.type === "hello") this._acceptHello(peer, message);
      if (message.type === "action") void this._acceptRemoteAction(peer, message);
      return;
    }
    this._acceptHostMessage(message);
  }

  _acceptHello(peer, message) {
    if (this.inGame) {
      this._sendError(peer, "GAME_STARTED", "This game has already started.");
      peer.channel?.close();
      return;
    }
    if (!Number.isInteger(peer.seat)) {
      const seat = this.lobby.seats.find((entry) => entry.seat > 0 && entry.kind === "empty");
      if (!seat) {
        this._sendError(peer, "ROOM_FULL", "No human seat is available.");
        peer.channel?.close();
        return;
      }
      peer.seat = seat.seat;
    }
    const seat = this.lobby.seats[peer.seat];
    seat.kind = "human";
    seat.name = normalizePlayerName(message.name);
    seat.connected = true;
    seat.ready = true;
    this.revision += 1;
    this._sendChannel(peer.channel, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      seat: peer.seat,
      lobby: this.lobby,
      revision: this.revision,
    });
    this._broadcast({ type: "lobby", lobby: this.lobby, revision: this.revision });
    this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
  }

  async _acceptRemoteAction(peer, message) {
    if (!this.inGame || !Number.isInteger(peer.seat)) {
      this._sendError(peer, "GAME_NOT_STARTED", "The game is not ready for actions.", message.actionId);
      return;
    }
    if (this.paused) {
      this._sendError(peer, "GAME_PAUSED", this.pauseReason?.message ?? "The game is paused.", message.actionId);
      return;
    }
    if (message.revision > this.revision) {
      this._sendError(peer, "INVALID_REVISION", "The action references a future state revision.", message.actionId);
      return;
    }
    if (this._seenActions.has(message.actionId)) {
      this._sendError(peer, "DUPLICATE_ACTION", "This action was already received.", message.actionId);
      return;
    }
    this._rememberAction(message.actionId);
    this._actionOrigins.set(message.actionId, peer.id);
    await this._dispatchHostAction({ ...message, seat: peer.seat, peerId: peer.id, local: false });
  }

  async _dispatchHostAction(request) {
    if (this.paused) {
      if (!request.local) {
        this.resolveAction(request.actionId, false, null, {
          peerId: request.peerId,
          code: "GAME_PAUSED",
          message: this.pauseReason?.message ?? "The game is paused.",
        });
      }
      return;
    }
    const handler = this.callbacks.onAction;
    if (typeof handler !== "function") {
      if (!request.local) this._sendError(this.peers.get(request.peerId), "NO_ACTION_HANDLER", "Host cannot process actions.", request.actionId);
      return;
    }
    try {
      const outcome = await handler({
        seat: request.seat,
        action: request.action,
        payload: cloneJson(request.payload),
        actionId: request.actionId,
        clientRevision: request.revision,
        hostRevision: this.revision,
        local: request.local,
      }, this);
      if (outcome !== undefined && !request.local) {
        const normalized = isRecord(outcome) ? outcome : { result: outcome };
        this.resolveAction(request.actionId, normalized.ok !== false, normalized.result ?? null, {
          ...normalized,
          peerId: request.peerId,
        });
      }
    } catch (error) {
      if (!request.local) {
        this.resolveAction(request.actionId, false, null, {
          peerId: request.peerId,
          code: error.code ?? "ACTION_FAILED",
          message: error.message ?? "Action failed.",
        });
      }
      this._reportError(error);
    }
  }

  _acceptHostMessage(message) {
    if (message.type === "welcome") {
      this.localSeat = message.seat;
      this.lobby = cloneJson(message.lobby);
      this.revision = Math.max(this.revision, message.revision);
      this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
      this._emit("onConnection", { status: "connected", seat: this.localSeat, roomCode: this.roomCode });
    } else if (message.type === "lobby") {
      if (message.revision < this.revision) return;
      this.revision = message.revision;
      this.lobby = cloneJson(message.lobby);
      this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
    } else if (message.type === "start") {
      if (message.revision < this.revision) return;
      this.revision = message.revision;
      this.inGame = true;
      this.paused = false;
      this.pauseReason = null;
      this._emit("onStart", cloneJson(message), this.snapshot);
    } else if (message.type === "state") {
      if (message.revision <= this.lastRevision) return;
      this.lastRevision = message.revision;
      this.revision = Math.max(this.revision, message.revision);
      this._emit("onState", message.state, { revision: message.revision, authoritative: false, seat: this.localSeat });
    } else if (message.type === "resolution") {
      this._emit("onResolution", cloneJson(message), { authoritative: false });
    } else if (message.type === "error") {
      if (["PLAYER_DISCONNECTED", "GAME_PAUSED", "HOST_UNAVAILABLE"].includes(message.code)) {
        this.paused = true;
        this.pauseReason = { code: message.code, message: message.message, seat: null };
        this._emit("onConnection", { status: "game-paused", ...this.pauseReason });
      }
      this._reportError(new ProtocolError(message.code, message.message));
    }
  }

  _rememberAction(actionId) {
    this._seenActions.add(actionId);
    if (this._seenActions.size > 1024) this._seenActions.delete(this._seenActions.values().next().value);
  }

  _removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try { peer.pc?.close(); } catch { /* best effort */ }
    const disconnectedSeat = Number.isInteger(peer.seat) ? peer.seat : null;
    const occupied = disconnectedSeat !== null && this.lobby?.seats[disconnectedSeat]?.kind === "human";
    if (occupied) {
      if (this.inGame) {
        const seat = this.lobby.seats[disconnectedSeat];
        seat.connected = false;
        seat.ready = false;
        this.revision += 1;
        this.pauseGame({
          code: "PLAYER_DISCONNECTED",
          message: `${seat.name || "A player"} lost the connection. The game is paused.`,
          seat: disconnectedSeat,
        });
      } else {
        this.lobby.seats[disconnectedSeat] = emptySeat(disconnectedSeat);
        this.revision += 1;
        this._broadcast({ type: "lobby", lobby: this.lobby, revision: this.revision });
        this._emit("onLobby", cloneJson(this.lobby), this.snapshot);
      }
    }
    this._emit("onPeerChange", { peerId, seat: disconnectedSeat, status: "disconnected" });
  }

  _relay(target, signal) {
    if (!socketOpen(this.signalSocket)) fail("SIGNALING_CLOSED", "Signaling connection is not open.");
    this.signalSocket.send(JSON.stringify({ type: "relay", target, signal }));
  }

  _broadcast(message) {
    for (const peer of this.peers.values()) {
      if (channelOpen(peer.channel)) this._sendChannel(peer.channel, message);
    }
  }

  _sendChannel(channel, message) {
    if (!channelOpen(channel)) fail("PEER_UNAVAILABLE", "Peer channel is not open.");
    channel.send(encodeProtocolMessage(message));
  }

  _sendError(peer, code, message, actionId = undefined) {
    if (!peer?.channel || !channelOpen(peer.channel)) return;
    const packet = { type: "error", code: String(code).slice(0, 64), message: String(message).slice(0, 240) };
    if (actionId) packet.actionId = actionId;
    this._sendChannel(peer.channel, packet);
  }

  _requireHost(message) {
    if (this.role !== "host") fail("HOST_ONLY", message);
  }

  _emit(name, ...args) {
    const callback = this.callbacks[name];
    if (typeof callback !== "function") return;
    try { callback(...args); } catch (error) {
      if (name !== "onError") this._reportError(error);
    }
  }

  _reportError(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (typeof this.callbacks.onError === "function") {
      try { this.callbacks.onError(normalized, this.snapshot); } catch { /* user callback */ }
    }
  }
}

export default MultiplayerSession;
