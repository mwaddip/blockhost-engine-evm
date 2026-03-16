/**
 * Anti-replay nonce tracking for admin commands
 *
 * Stores seen nonces with timestamps to prevent replay attacks.
 * Nonces older than max_command_age are periodically pruned.
 */

import * as fs from "fs";
import * as path from "path";

const NONCE_FILE = "/var/lib/blockhost/admin-nonces.json";
const NONCE_DIR = path.dirname(NONCE_FILE);

interface NonceEntry {
  timestamp: number;  // When the nonce was first seen
}

interface NonceStore {
  nonces: Record<string, NonceEntry>;
}

// In-memory cache of seen nonces
let seenNonces: Map<string, number> = new Map();
let loaded = false;

/**
 * Ensure the nonce directory exists
 */
function ensureDir(): void {
  if (!fs.existsSync(NONCE_DIR)) {
    fs.mkdirSync(NONCE_DIR, { recursive: true });
  }
}

/**
 * Load nonces from persistent storage on startup
 */
export function loadNonces(): void {
  if (loaded) return;

  try {
    ensureDir();

    if (fs.existsSync(NONCE_FILE)) {
      const data = fs.readFileSync(NONCE_FILE, "utf8");
      const store: NonceStore = JSON.parse(data);

      seenNonces.clear();
      for (const [nonce, entry] of Object.entries(store.nonces)) {
        seenNonces.set(nonce, entry.timestamp);
      }

      console.log(`[ADMIN] Loaded ${seenNonces.size} nonces from storage`);
    }
  } catch (err) {
    console.error(`[ADMIN] Error loading nonces: ${err}`);
    seenNonces = new Map();
  }

  loaded = true;
}

/**
 * Save nonces to persistent storage
 */
function saveNonces(): void {
  try {
    ensureDir();

    const store: NonceStore = {
      nonces: {},
    };

    for (const [nonce, timestamp] of seenNonces.entries()) {
      store.nonces[nonce] = { timestamp };
    }

    const tmpFile = `${NONCE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2));
    fs.renameSync(tmpFile, NONCE_FILE);
  } catch (err) {
    console.error(`[ADMIN] Error saving nonces: ${err}`);
  }
}

/**
 * Check if a nonce has already been used
 */
export function isNonceUsed(nonce: string): boolean {
  loadNonces();
  return seenNonces.has(nonce);
}

/**
 * Mark a nonce as used (call BEFORE executing command)
 */
export function markNonceUsed(nonce: string): void {
  loadNonces();
  seenNonces.set(nonce, Math.floor(Date.now() / 1000));
  saveNonces();
}

/**
 * Prune nonces older than maxAgeSeconds
 * Should be called periodically to prevent unbounded growth
 */
export function pruneOldNonces(maxAgeSeconds: number): void {
  loadNonces();

  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  let pruned = 0;

  for (const [nonce, timestamp] of seenNonces.entries()) {
    if (timestamp < cutoff) {
      seenNonces.delete(nonce);
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`[ADMIN] Pruned ${pruned} old nonces`);
    saveNonces();
  }
}
