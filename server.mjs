import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { networkInterfaces } from "node:os";
import { execSync } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const USE_HTTPS = process.env.HTTPS === "1";
const DIST = join(process.cwd(), "dist");
const lobbies = new Map();
const BUILD_IDS = new Set(["default", "mcroar", "big_bryce", "chef_scott", "the_tiger", "x_shuffle"]);

function normalizeBuildId(value) {
  return BUILD_IDS.has(value) ? value : "default";
}

function normalizeControllerMount(value) {
  if (value === "forearm") return "forearm";
  if (value === "grip_butt" || value === "gripEnd" || value === "butt_grip") return "grip_butt";
  return "club";
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function publicOrigin(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || (USE_HTTPS ? "https" : "http");
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function id(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function lobbyCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (lobbies.has(code));
  return code;
}

function getLobby(code) {
  return lobbies.get(String(code || "").trim().toUpperCase());
}

function sendEvent(client, event, data) {
  client.write(`event: ${event}\n`);
  client.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(lobby, event, data) {
  for (const client of lobby.clients.values()) {
    sendEvent(client, event, data);
  }
}

function localAddresses() {
  const out = [];
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cleanPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, cleanPath);
  if (url.pathname === "/" || !existsSync(file)) file = join(DIST, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found. Run `npm run build` before starting the server.");
  }
}

function ensureSelfSignedCert() {
  const dir = join(process.cwd(), ".cert");
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const configPath = join(dir, "openssl.cnf");
  const addrs = localAddresses();
  const sans = ["DNS:localhost", "IP:127.0.0.1", ...addrs.map((a) => `IP:${a}`)];
  const sanLine = sans.join(",");
  const forceRegen = process.env.REGEN_CERT === "1";

  // Reuse existing cert only if it covers every current local-network IP via SAN.
  if (!forceRegen && existsSync(keyPath) && existsSync(certPath)) {
    try {
      const info = execSync(`openssl x509 -in "${certPath}" -noout -text`).toString();
      const hasSan = info.includes("Subject Alternative Name");
      const allCovered = addrs.every((a) => info.includes(`IP Address:${a}`));
      if (hasSan && allCovered) return { keyPath, certPath };
      console.log("Existing cert missing current local-network IP(s) in SAN - regenerating.");
    } catch {
      console.log("Could not inspect existing cert — regenerating.");
    }
  }

  mkdirSync(dir, { recursive: true });
  // Config-file form works on both OpenSSL and LibreSSL (macOS default).
  // LibreSSL's `req` does NOT support `-addext`, so a config file is required to embed SANs.
  // iOS rejects certs without a subjectAltName covering the host (CN-only matching was removed in iOS 13).
  writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_req",
      "prompt = no",
      "",
      "[dn]",
      "CN = dsgolf-network",
      "",
      "[v3_req]",
      `subjectAltName = ${sanLine}`,
      "extendedKeyUsage = serverAuth",
      "basicConstraints = CA:FALSE",
      "",
    ].join("\n"),
  );

  try {
    rmSync(keyPath, { force: true });
    rmSync(certPath, { force: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 365 ` +
        `-keyout "${keyPath}" -out "${certPath}" ` +
        `-config "${configPath}" -extensions v3_req`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    console.log(`Generated self-signed cert in .cert/ — SANs: ${sanLine}`);
  } catch {
    console.error(
      "Failed to generate self-signed cert. Install openssl, or run without HTTPS=1.",
    );
    throw new Error("openssl unavailable");
  }
  return { keyPath, certPath };
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/session") {
    return json(res, 200, { clientId: id("client") });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const origin = publicOrigin(req);
    return json(res, 200, {
      publicBaseUrl: origin,
      networkMode: origin.includes("localhost") || origin.includes("127.0.0.1") ? "local" : "online",
    });
  }

  if (req.method === "POST" && url.pathname === "/api/lobbies/create") {
    const body = await readJson(req);
    const code = lobbyCode();
    const lobby = {
      code,
      hostId: body.clientId,
      clients: new Map(),
      players: new Map(), // clientId → player profile
      state: null,
      createdAt: Date.now(),
    };
    lobbies.set(code, lobby);
    return json(res, 200, { ok: true, lobby: { code } });
  }

  if (req.method === "POST" && url.pathname === "/api/lobbies/join") {
    const body = await readJson(req);
    const lobby = getLobby(body.code);
    if (!lobby) return json(res, 404, { ok: false, error: "Lobby not found" });
    const profile = {
      id: body.clientId,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 18) : "Player",
      shirtColor: body.shirtColor || "#d63a3a",
      pantsColor: body.pantsColor || "#1f2733",
      hatColor: body.hatColor || "#1a3a8c",
      buildId: normalizeBuildId(body.buildId),
      handedness: body.handedness === "left" ? "left" : "right",
      controllerMount: normalizeControllerMount(body.controllerMount),
      source: "phone",
    };
    lobby.players.set(body.clientId, profile);
    broadcast(lobby, "controller_joined", { clientId: body.clientId, name: profile.name });
    broadcast(lobby, "players_changed", { players: Array.from(lobby.players.values()) });
    return json(res, 200, { ok: true, lobby: { code: lobby.code }, profile });
  }

  if (req.method === "POST" && url.pathname === "/api/lobbies/player_update") {
    const body = await readJson(req);
    const lobby = getLobby(body.code);
    if (!lobby) return json(res, 404, { ok: false, error: "Lobby not found" });
    const existing = lobby.players.get(body.clientId);
    if (!existing) return json(res, 404, { ok: false, error: "Player not in lobby" });
    if (typeof body.name === "string" && body.name.trim()) existing.name = body.name.trim().slice(0, 18);
    if (typeof body.shirtColor === "string") existing.shirtColor = body.shirtColor;
    if (typeof body.pantsColor === "string") existing.pantsColor = body.pantsColor;
    if (typeof body.hatColor === "string") existing.hatColor = body.hatColor;
    if (typeof body.buildId === "string") existing.buildId = normalizeBuildId(body.buildId);
    if (body.handedness === "left" || body.handedness === "right") existing.handedness = body.handedness;
    if (typeof body.controllerMount === "string") existing.controllerMount = normalizeControllerMount(body.controllerMount);
    broadcast(lobby, "players_changed", { players: Array.from(lobby.players.values()) });
    return json(res, 200, { ok: true, profile: existing });
  }

  if (req.method === "POST" && url.pathname === "/api/lobbies/action") {
    const body = await readJson(req);
    const lobby = getLobby(body.code);
    if (!lobby) return json(res, 404, { ok: false, error: "Lobby not found" });
    const clientId = String(body.clientId || "").trim();
    if (!clientId || !lobby.players.has(clientId)) {
      return json(res, 403, { ok: false, error: "Player not in lobby" });
    }
    const activePlayerId = typeof lobby.state?.currentPlayerId === "string"
      ? lobby.state.currentPlayerId
      : "";
    if (activePlayerId && clientId !== activePlayerId) {
      return json(res, 200, { ok: true, ignored: true, reason: "not_your_turn" });
    }
    broadcast(lobby, "controller_action", {
      clientId,
      action: body.action,
    });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/lobbies/state") {
    const body = await readJson(req);
    const lobby = getLobby(body.code);
    if (!lobby) return json(res, 404, { ok: false, error: "Lobby not found" });
    if (body.clientId !== lobby.hostId) {
      return json(res, 403, { ok: false, error: "Only the host can publish state" });
    }
    lobby.state = body.state || null;
    broadcast(lobby, "host_state", { state: lobby.state });
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const lobby = getLobby(url.searchParams.get("code"));
    const clientId = url.searchParams.get("clientId");
    if (!lobby || !clientId) {
      res.writeHead(404);
      return res.end("Lobby not found");
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    lobby.clients.set(clientId, res);
    sendEvent(res, "connected", { code: lobby.code });
    if (lobby.state) {
      sendEvent(res, "host_state", { state: lobby.state });
    }
    sendEvent(res, "players_changed", { players: Array.from(lobby.players.values()) });
    const heartbeat = setInterval(() => {
      sendEvent(res, "ping", { t: Date.now() });
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      // Only drop the entry if it still refers to *this* response.
      // A reconnect from the same clientId (e.g. host moving from lobby
      // screen to game screen) will have already replaced lobby.clients[id].
      if (lobby.clients.get(clientId) === res) {
        lobby.clients.delete(clientId);
      }
      // Remove the player profile only on a real disconnect — give the
      // client a brief grace window so a reconnect doesn't wipe them.
      if (lobby.players.has(clientId)) {
        setTimeout(() => {
          if (!lobby.clients.has(clientId) && lobby.players.has(clientId)) {
            lobby.players.delete(clientId);
            broadcast(lobby, "players_changed", { players: Array.from(lobby.players.values()) });
          }
        }, 1500);
      }
    });
    return;
  }

  return serveStatic(req, res);
};

const httpServer = createHttpServer(handler);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`DSGolf network server (HTTP)  on http://localhost:${PORT}`);
  if (!USE_HTTPS) {
    for (const addr of localAddresses()) {
      console.log(`Phone/controller URL: http://${addr}:${PORT}/?controller=1`);
    }
    console.log("For friends on cellular, deploy this server to a public HTTPS host and set PUBLIC_BASE_URL.");
    console.log("Local iOS motion sensors need HTTPS. Re-run with `HTTPS=1 npm run network`.");
  }
});

if (USE_HTTPS) {
  const { keyPath, certPath } = ensureSelfSignedCert();
  const httpsServer = createHttpsServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    handler,
  );
  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`DSGolf network server (HTTPS) on https://localhost:${HTTPS_PORT}`);
    for (const addr of localAddresses()) {
      console.log(`Phone/controller URL: https://${addr}:${HTTPS_PORT}/?controller=1`);
    }
    console.log("Local HTTPS uses a self-signed cert. Public deployments should use the host's normal HTTPS.");
  });
}
