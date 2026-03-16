/**
 * web3-auth-svc — HTTPS signing server for web3 authentication.
 *
 * Serves the signing page and provides callback endpoints for the PAM module's
 * session-based authentication flow. Bundled with esbuild for deployment.
 *
 * Routes:
 *   GET /                           — Serve signing page HTML
 *   GET /auth/pending/:session_id   — Return session JSON from pending dir
 *   POST /auth/callback/:session_id — Accept signature, write .sig file
 *
 * Config: /etc/web3-auth/config.toml (TOML, [https] section)
 */

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────

const PENDING_DIR = "/run/libpam-web3/pending";
const MAX_BODY_SIZE = 256;
const DEFAULT_CONFIG_PATH = "/etc/web3-auth/config.toml";

// Session ID: exactly 32 lowercase hex characters
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

// EVM signature: optional 0x prefix + 130 hex chars (65 bytes secp256k1)
const EVM_SIG_RE = /^(0x)?[0-9a-fA-F]{130}$/;

// ── Config ─────────────────────────────────────────────────────────────

interface HttpsConfig {
  port: number;
  bind: string;
  cert_path: string;
  key_path: string;
  signing_page_path: string;
}

/**
 * Minimal TOML parser for the [https] section. Handles string values,
 * integers, and single-line string arrays. No external dependencies.
 */
function parseToml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let section = "";

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Section header
    const secMatch = line.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\]$/);
    if (secMatch) {
      section = secMatch[1];
      result[section] = result[section] || {};
      continue;
    }

    // Key = value (only within a section)
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (!kvMatch || !section) continue;

    const key = kvMatch[1];
    const val = kvMatch[2].trim();

    if (val.startsWith('"') && val.endsWith('"')) {
      // String value
      result[section][key] = val.slice(1, -1);
    } else if (val.startsWith("[")) {
      // Array of strings: ["a", "b"]
      const inner = val.slice(1, val.lastIndexOf("]"));
      result[section][key] = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s));
    } else {
      // Integer or bare value
      const num = Number(val);
      result[section][key] = Number.isNaN(num) ? val : num;
    }
  }

  return result;
}

function loadConfig(configPath: string): HttpsConfig {
  const content = fs.readFileSync(configPath, "utf8");
  const toml = parseToml(content);
  const sec = toml["https"];

  if (!sec) {
    throw new Error(`missing [https] section in ${configPath}`);
  }

  const port = typeof sec.port === "number" ? sec.port : 8443;
  const bind = Array.isArray(sec.bind) && sec.bind.length > 0
    ? String(sec.bind[0])
    : "::";
  const cert_path = String(sec.cert_path || "");
  const key_path = String(sec.key_path || "");
  const signing_page_path = String(
    sec.signing_page_path || "/usr/share/blockhost/signing-page/index.html"
  );

  if (!cert_path) throw new Error("https.cert_path is required");
  if (!key_path) throw new Error("https.key_path is required");

  return { port, bind, cert_path, key_path, signing_page_path };
}

// ── Validation ─────────────────────────────────────────────────────────

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Validate signature format. Accepts two formats (content-based detection):
 *   EVM:   optional 0x prefix + 130 hex chars (65-byte secp256k1 signature)
 *   OPNet: JSON object with otp, machine_id, wallet_address fields
 */
function isValidSignature(sig: string): boolean {
  if (EVM_SIG_RE.test(sig)) return true;

  // OPNet: valid JSON with required fields
  if (sig.startsWith("{")) {
    try {
      const obj = JSON.parse(sig);
      return (
        typeof obj === "object" &&
        obj !== null &&
        typeof obj.otp === "string" &&
        typeof obj.machine_id === "string" &&
        typeof obj.wallet_address === "string"
      );
    } catch {
      return false;
    }
  }

  return false;
}

// ── Route Handlers ─────────────────────────────────────────────────────

function sendResponse(
  res: import("node:http").ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain"
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function handleGetPending(
  sessionId: string,
  res: import("node:http").ServerResponse
): void {
  if (!isValidSessionId(sessionId)) {
    sendResponse(res, 404, "Not Found");
    return;
  }

  const jsonPath = path.join(PENDING_DIR, `${sessionId}.json`);

  let contents: string;
  try {
    contents = fs.readFileSync(jsonPath, "utf8");
  } catch {
    sendResponse(res, 404, "Not Found");
    return;
  }

  sendResponse(res, 200, contents, "application/json");
}

function handlePostCallback(
  sessionId: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse
): void {
  if (!isValidSessionId(sessionId)) {
    sendResponse(res, 404, "Not Found");
    return;
  }

  const chunks: Buffer[] = [];
  let bodySize = 0;
  let aborted = false;

  req.on("data", (chunk: Buffer) => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      if (!aborted) {
        aborted = true;
        sendResponse(res, 413, "body too large");
        req.destroy();
      }
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (aborted) return;

    const body = Buffer.concat(chunks).toString("utf8").trim();

    const jsonPath = path.join(PENDING_DIR, `${sessionId}.json`);
    const sigPath = path.join(PENDING_DIR, `${sessionId}.sig`);
    const tmpPath = path.join(PENDING_DIR, `${sessionId}.sig.tmp`);

    // Session must exist
    if (!fs.existsSync(jsonPath)) {
      sendResponse(res, 404, "Not Found");
      return;
    }

    // Prevent overwrite of existing .sig
    if (fs.existsSync(sigPath)) {
      sendResponse(res, 409, "Conflict");
      return;
    }

    // Validate signature format
    if (!isValidSignature(body)) {
      sendResponse(res, 400, "invalid signature format");
      return;
    }

    // Atomic write: .sig.tmp → rename → .sig
    try {
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, sigPath);
    } catch (err) {
      console.error(`Failed to write sig for session ${sessionId}: ${err}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // tmp may not exist
      }
      sendResponse(res, 500, "Internal Server Error");
      return;
    }

    console.log(`[AUTH] Callback signature received for session ${sessionId}`);
    sendResponse(res, 200, "OK");
  });

  req.on("error", () => {
    // Connection closed by client, nothing to do
  });
}

// ── Server ─────────────────────────────────────────────────────────────

function main(): void {
  const configPath = process.argv[2] || DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);

  // Read signing page HTML once at startup
  let signingPageHtml: string;
  try {
    signingPageHtml = fs.readFileSync(config.signing_page_path, "utf8");
  } catch (err) {
    console.error(`Failed to read signing page: ${config.signing_page_path}: ${err}`);
    process.exit(1);
  }

  const tlsOptions: https.ServerOptions = {
    cert: fs.readFileSync(config.cert_path),
    key: fs.readFileSync(config.key_path),
  };

  const server = https.createServer(tlsOptions, (req, res) => {
    // Security headers on all responses
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url || "/", `https://localhost`);
    const pathname = url.pathname;

    // GET / — serve signing page
    if (req.method === "GET" && pathname === "/") {
      sendResponse(res, 200, signingPageHtml, "text/html; charset=utf-8");
      return;
    }

    // GET /auth/pending/:session_id
    const pendingMatch = pathname.match(/^\/auth\/pending\/([^/]+)$/);
    if (req.method === "GET" && pendingMatch) {
      handleGetPending(pendingMatch[1], res);
      return;
    }

    // POST /auth/callback/:session_id
    const callbackMatch = pathname.match(/^\/auth\/callback\/([^/]+)$/);
    if (req.method === "POST" && callbackMatch) {
      handlePostCallback(callbackMatch[1], req, res);
      return;
    }

    sendResponse(res, 404, "Not Found");
  });

  server.listen(config.port, config.bind, () => {
    console.log(`[AUTH] web3-auth-svc listening on [${config.bind}]:${config.port}`);
    console.log(`[AUTH] Signing page: ${config.signing_page_path}`);
    console.log(`[AUTH] Pending dir: ${PENDING_DIR}`);
  });

  server.on("error", (err) => {
    console.error(`[AUTH] Server error: ${err}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[AUTH] Shutting down...");
    server.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    console.log("[AUTH] Shutting down...");
    server.close(() => process.exit(0));
  });
}

main();
