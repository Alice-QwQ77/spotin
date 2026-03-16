import fs from "node:fs";
import path from "node:path";
import { createClient } from "redis";

export const DEFAULT_STATUS_FILE = path.resolve("data", "service_status.json");
export const DEFAULT_COOKIE_FILE = path.resolve("data", "cookies.json");
export const DEFAULT_SCREENSHOT_DIR = path.resolve("data", "screenshots");
export const DEFAULT_REDIS_PREFIX = process.env.REDIS_PREFIX || "spotify:autosignin";

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function fileInfo(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      path: filePath,
      size: stats.size,
      updatedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      path: filePath,
      size: 0,
      updatedAt: null,
    };
  }
}

function redactRedisUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "redis://***";
  }
}

class FileStorage {
  constructor({ statusFile, cookieFile, screenshotDir }) {
    this.statusFile = statusFile;
    this.cookieFile = cookieFile;
    this.screenshotDir = screenshotDir;
    this.backend = {
      type: "file",
      statusFile,
      cookieFile,
      screenshotDir,
    };
  }

  async readStatus() {
    return readJson(this.statusFile, {});
  }

  async writeStatus(payload) {
    writeJson(this.statusFile, payload);
  }

  async readCookies() {
    return readJson(this.cookieFile, []);
  }

  async writeCookies(cookies) {
    writeJson(this.cookieFile, cookies);
  }

  async readArtifactMeta(name) {
    return fileInfo(path.join(this.screenshotDir, name));
  }

  async readArtifactContent(name) {
    const target = path.join(this.screenshotDir, name);
    const info = fileInfo(target);
    if (!info.exists) {
      return null;
    }
    return {
      ...info,
      contentType: guessContentType(name),
      body: fs.readFileSync(target),
    };
  }

  async writeArtifact(name, buffer, contentType = guessContentType(name)) {
    const target = path.join(this.screenshotDir, name);
    ensureParent(target);
    fs.writeFileSync(target, buffer);
    const info = fileInfo(target);
    return {
      ...info,
      contentType,
    };
  }

  async deleteArtifact(name) {
    const target = path.join(this.screenshotDir, name);
    try {
      fs.unlinkSync(target);
    } catch {}
  }

  async close() {}
}

class RedisStorage {
  constructor({ redisUrl, redisPrefix, screenshotDir }) {
    this.redisUrl = redisUrl;
    this.redisPrefix = redisPrefix;
    this.screenshotDir = screenshotDir;
    this.client = createClient({ url: redisUrl });
    this.connecting = null;
    this.backend = {
      type: "redis",
      redisUrl: redactRedisUrl(redisUrl),
      redisPrefix,
      screenshotDir,
    };
  }

  key(name) {
    return `${this.redisPrefix}:${name}`;
  }

  async connect() {
    if (this.client.isOpen) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.client.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async readStatus() {
    await this.connect();
    const value = await this.client.get(this.key("status"));
    return value ? JSON.parse(value) : {};
  }

  async writeStatus(payload) {
    await this.connect();
    await this.client.set(this.key("status"), JSON.stringify(payload));
  }

  async readCookies() {
    await this.connect();
    const value = await this.client.get(this.key("cookies"));
    return value ? JSON.parse(value) : [];
  }

  async writeCookies(cookies) {
    await this.connect();
    await this.client.set(this.key("cookies"), JSON.stringify(cookies));
  }

  async readArtifactMeta(name) {
    return fileInfo(path.join(this.screenshotDir, name));
  }

  async readArtifactContent(name) {
    const target = path.join(this.screenshotDir, name);
    const info = fileInfo(target);
    if (!info.exists) {
      return null;
    }
    return {
      ...info,
      contentType: guessContentType(name),
      body: fs.readFileSync(target),
    };
  }

  async writeArtifact(name, buffer, contentType = guessContentType(name)) {
    const target = path.join(this.screenshotDir, name);
    ensureParent(target);
    fs.writeFileSync(target, buffer);
    const info = fileInfo(target);
    return {
      ...info,
      contentType,
    };
  }

  async deleteArtifact(name) {
    const target = path.join(this.screenshotDir, name);
    try {
      fs.unlinkSync(target);
    } catch {}
  }

  async close() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}

function guessContentType(name) {
  if (name.endsWith(".png")) {
    return "image/png";
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function normalizeSameSite(value) {
  if (!value) {
    return undefined;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === "lax") {
    return "Lax";
  }
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "none") {
    return "None";
  }
  return undefined;
}

function cookieOrigin(cookie) {
  if (!cookie?.url) {
    return {};
  }
  try {
    const parsed = new URL(cookie.url);
    return {
      domain: parsed.hostname,
      path: cookie.path || parsed.pathname || "/",
      secure: parsed.protocol === "https:",
    };
  } catch {
    return {};
  }
}

export function normalizeCookies(payload) {
  const now = Date.now() / 1000;
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((cookie) => cookie && typeof cookie === "object")
    .filter((cookie) => !cookie.expires || cookie.expires === -1 || cookie.expires > now)
    .map((cookie) => {
      const origin = cookieOrigin(cookie);
      const normalized = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || origin.domain,
        path: cookie.path || origin.path || "/",
        httpOnly: Boolean(cookie.httpOnly),
        secure: typeof cookie.secure === "boolean" ? cookie.secure : Boolean(origin.secure),
      };

      const sameSite = normalizeSameSite(cookie.sameSite);
      if (sameSite) {
        normalized.sameSite = sameSite;
      }
      if (cookie.expires && cookie.expires !== -1) {
        normalized.expires = cookie.expires;
      }
      return normalized;
    })
    .filter((cookie) => cookie.name && cookie.value && cookie.domain);
}

export function mergeCookies(...groups) {
  const merged = new Map();
  for (const cookies of groups) {
    for (const cookie of cookies || []) {
      const key = `${cookie.name}|${cookie.domain}|${cookie.path || "/"}`;
      merged.set(key, cookie);
    }
  }
  return [...merged.values()];
}

export function parseCookiePayload(payload) {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      const error = new Error("Cookie payload must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  }

  const cookies = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
      ? parsed.cookies
      : Array.isArray(parsed?.storageState?.cookies)
        ? parsed.storageState.cookies
        : null;

  if (!cookies) {
    const error = new Error("Cookie payload must be a JSON array or an object containing a cookies array.");
    error.statusCode = 400;
    throw error;
  }

  const normalized = normalizeCookies(cookies);
  if (normalized.length === 0) {
    const error = new Error("No usable cookies found in the submitted payload.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function summarizeCookies(cookies) {
  const names = ["sp_dc", "sp_key", "sp_t", "__Host-sp_csrf_sid"];
  const summary = {
    total: Array.isArray(cookies) ? cookies.length : 0,
    hasSessionCookies: false,
    cookies: {},
    sessionExpiresAt: null,
    sessionExpiresInSeconds: null,
  };

  if (!Array.isArray(cookies)) {
    return summary;
  }

  let latestSessionExpiry = null;
  for (const name of names) {
    const cookie = cookies.find((item) => item?.name === name);
    if (!cookie) {
      continue;
    }
    const expiresAt =
      cookie.expires && cookie.expires !== -1
        ? new Date(cookie.expires * 1000).toISOString()
        : null;
    summary.cookies[name] = {
      domain: cookie.domain,
      expiresAt,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
    };
    if ((name === "sp_dc" || name === "sp_key") && cookie.value) {
      summary.hasSessionCookies = true;
    }
    if ((name === "sp_dc" || name === "sp_key") && cookie.expires && cookie.expires !== -1) {
      latestSessionExpiry = Math.max(latestSessionExpiry ?? 0, cookie.expires);
    }
  }

  if (latestSessionExpiry) {
    summary.sessionExpiresAt = new Date(latestSessionExpiry * 1000).toISOString();
    summary.sessionExpiresInSeconds = Math.max(
      0,
      Math.round(latestSessionExpiry - Date.now() / 1000),
    );
  }

  return summary;
}

export async function createStorage({
  redisUrl = process.env.REDIS_URL || "",
  redisPrefix = process.env.REDIS_PREFIX || DEFAULT_REDIS_PREFIX,
  statusFile = DEFAULT_STATUS_FILE,
  cookieFile = DEFAULT_COOKIE_FILE,
  screenshotDir = DEFAULT_SCREENSHOT_DIR,
} = {}) {
  if (redisUrl) {
    const storage = new RedisStorage({ redisUrl, redisPrefix, screenshotDir });
    await storage.connect();
    return storage;
  }
  return new FileStorage({ statusFile, cookieFile, screenshotDir });
}

export async function collectStatusSnapshot(storage) {
  const service = await storage.readStatus();
  const cookies = await storage.readCookies();
  const latestSuccessScreenshot = await storage.readArtifactMeta("login_success.png");
  const latestFailureScreenshot = await storage.readArtifactMeta("login_failed.png");
  const latestFormScreenshot = await storage.readArtifactMeta("password_form_not_found.png");

  return {
    now: new Date().toISOString(),
    backend: storage.backend,
    cookieSummary: summarizeCookies(cookies),
    screenshots: {
      loginSuccess: latestSuccessScreenshot,
      loginFailed: latestFailureScreenshot,
      passwordFormNotFound: latestFormScreenshot,
    },
    service,
  };
}
