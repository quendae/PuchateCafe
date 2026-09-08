const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_GUESTS = 7; // host + seven guests = the eight-seat Party table
const MAX_SIGNAL_BYTES = 64 * 1024;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function errorResponse(code, message, status = 400) {
  return json({ type: "error", code, message }, status);
}

function roomCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function isWebSocketRequest(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function isSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.description) {
    return value.description && ["offer", "answer"].includes(value.description.type)
      && typeof value.description.sdp === "string";
  }
  return Boolean(value.candidate && typeof value.candidate.candidate === "string");
}

function safeSend(socket, message) {
  try { socket.send(JSON.stringify(message)); } catch { /* the close hook cleans it up */ }
}

function attachment(socket) {
  try { return socket.deserializeAttachment() ?? {}; } catch { return {}; }
}

export function normalizeApiPath(pathname) {
  if (pathname === "/api") return "/";
  return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

/**
 * A deliberately dumb signaling room. It authenticates topology (guest -> host,
 * host -> guest) and forwards SDP/ICE, but never receives game packets.
 */
export class SignalingRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (!isWebSocketRequest(request)) return errorResponse("UPGRADE_REQUIRED", "Use a WebSocket connection.", 426);
    const role = request.headers.get("X-Puchate-Role");
    const code = request.headers.get("X-Puchate-Room");
    if (!code || !["host", "guest"].includes(role)) return this._reject("BAD_REQUEST", "Invalid room request.");

    const now = Date.now();
    let metadata = await this.state.storage.get("metadata");
    if (metadata && metadata.expiresAt <= now) {
      for (const stale of this.state.getWebSockets()) {
        try { stale.close(1001, "room expired"); } catch { /* best effort */ }
      }
      await this.state.storage.delete("metadata");
      metadata = undefined;
    }
    if (role === "host") {
      if (metadata && metadata.expiresAt > now) return this._reject("ROOM_EXISTS", "Room already exists.");
      metadata = { code, createdAt: now, expiresAt: now + ROOM_TTL_MS };
      await this.state.storage.put("metadata", metadata);
      await this.state.storage.setAlarm(metadata.expiresAt);
    } else if (!metadata || metadata.expiresAt <= now) {
      return this._reject("ROOM_EXPIRED", "Room does not exist or has expired.");
    }

    const sockets = this.state.getWebSockets();
    const host = sockets.find((socket) => attachment(socket).role === "host");
    const guests = sockets.filter((socket) => attachment(socket).role === "guest");
    if (role === "host" && host) return this._reject("HOST_EXISTS", "Room already has a host.");
    if (role === "guest" && !host) return this._reject("HOST_UNAVAILABLE", "Room host is unavailable.");
    if (role === "guest" && guests.length >= MAX_GUESTS) return this._reject("ROOM_FULL", "Room is full.");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peerId = role === "host" ? "host" : crypto.randomUUID();
    server.serializeAttachment({ peerId, role });
    this.state.acceptWebSocket(server);
    safeSend(server, {
      type: role === "host" ? "created" : "joined",
      roomCode: code,
      peerId,
      ...(role === "guest" ? { hostId: "host" } : {}),
      expiresAt: metadata.expiresAt,
    });
    if (role === "guest") safeSend(host, { type: "peer-joined", peerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  _reject(code, message) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ peerId: "", role: "rejected" });
    this.state.acceptWebSocket(server);
    safeSend(server, { type: "error", code, message });
    try { server.close(1008, message.slice(0, 100)); } catch { /* best effort */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_SIGNAL_BYTES) {
      safeSend(socket, { type: "error", code: "INVALID_SIGNAL", message: "Signal is too large or not text." });
      return;
    }
    let message;
    try { message = JSON.parse(raw); } catch {
      safeSend(socket, { type: "error", code: "INVALID_JSON", message: "Signal is not valid JSON." });
      return;
    }
    if (message?.type === "ping") {
      safeSend(socket, { type: "pong", at: message.at ?? Date.now() });
      return;
    }
    if (message?.type !== "relay" || typeof message.target !== "string" || !isSignal(message.signal)) {
      safeSend(socket, { type: "error", code: "INVALID_SIGNAL", message: "Only SDP and ICE relay packets are accepted." });
      return;
    }

    const sender = attachment(socket);
    if ((sender.role === "guest" && message.target !== "host")
      || (sender.role === "host" && message.target === "host")) {
      safeSend(socket, { type: "error", code: "INVALID_TARGET", message: "Relay target violates the star topology." });
      return;
    }
    const target = this.state.getWebSockets().find((candidate) => attachment(candidate).peerId === message.target);
    if (!target) {
      safeSend(socket, { type: "error", code: "PEER_UNAVAILABLE", message: "Relay target is not connected." });
      return;
    }
    safeSend(target, { type: "relay", from: sender.peerId, signal: message.signal });
  }

  async webSocketClose(socket) {
    const peer = attachment(socket);
    if (peer.role === "rejected") return;
    const sockets = this.state.getWebSockets();
    if (peer.role === "host") {
      for (const candidate of sockets) {
        if (candidate !== socket) {
          safeSend(candidate, { type: "host-left" });
          try { candidate.close(1012, "host left"); } catch { /* best effort */ }
        }
      }
      await this.state.storage.delete("metadata");
      return;
    }
    const host = sockets.find((candidate) => attachment(candidate).role === "host");
    if (host) safeSend(host, { type: "peer-left", peerId: peer.peerId });
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }

  async alarm() {
    for (const socket of this.state.getWebSockets()) {
      safeSend(socket, { type: "error", code: "ROOM_EXPIRED", message: "Room expired." });
      try { socket.close(1001, "room expired"); } catch { /* best effort */ }
    }
    await this.state.storage.deleteAll();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizeApiPath(url.pathname);
    if (path === "/health") {
      return json({ ok: true, service: "puchate-cafe-signaling", maxGuests: MAX_GUESTS });
    }
    if (!isWebSocketRequest(request)) return errorResponse("UPGRADE_REQUIRED", "Use a WebSocket connection.", 426);

    let code;
    let role;
    if (path === "/room/create") {
      code = roomCode();
      role = "host";
    } else {
      const match = path.match(/^\/room\/([A-Z2-9]{6})\/join$/i);
      if (!match) return errorResponse("NOT_FOUND", "Unknown endpoint.", 404);
      code = match[1].toUpperCase();
      role = "guest";
    }

    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    const headers = new Headers(request.headers);
    headers.set("X-Puchate-Role", role);
    headers.set("X-Puchate-Room", code);
    return stub.fetch(new Request(request, { headers }));
  },
};
