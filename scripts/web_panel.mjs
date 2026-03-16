import process from "node:process";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  DEFAULT_SCREENSHOT_DIR,
  DEFAULT_STATUS_FILE,
  DEFAULT_REDIS_PREFIX,
  collectStatusSnapshot,
  createStorage,
  mergeCookies,
  parseCookiePayload,
  summarizeCookies,
} from "./service_state.mjs";

const HOST = process.env.PANEL_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 8080);
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const STATUS_FILE = process.env.SERVICE_STATUS_FILE || DEFAULT_STATUS_FILE;
const SCREENSHOT_DIR = process.env.SPOTIFY_SCREENSHOT_DIR || DEFAULT_SCREENSHOT_DIR;
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_PREFIX = process.env.REDIS_PREFIX || DEFAULT_REDIS_PREFIX;
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS || 0);
const CHECK_ON_START = process.env.CHECK_ON_START === "1";
const PANEL_HEADLESS = process.env.SPOTIFY_HEADLESS !== "0";
const AUTO_REFRESH_ENABLED = process.env.AUTO_REFRESH_ENABLED !== "0";
const AUTO_REFRESH_MIN_PER_DAY = Number(process.env.AUTO_REFRESH_MIN_PER_DAY || 2);
const AUTO_REFRESH_MAX_PER_DAY = Number(process.env.AUTO_REFRESH_MAX_PER_DAY || 3);
const AUTO_REFRESH_MIN_GAP_SECONDS = Number(process.env.AUTO_REFRESH_MIN_GAP_SECONDS || 1800);

let storage = null;
let currentCheck = null;
let isShuttingDown = false;
let autoRefreshTimer = null;
let lastCheckProcess = {
  action: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stdout: "",
  stderr: "",
  reason: null,
};
let autoRefreshState = {
  enabled: AUTO_REFRESH_ENABLED,
  minPerDay: AUTO_REFRESH_MIN_PER_DAY,
  maxPerDay: AUTO_REFRESH_MAX_PER_DAY,
  minGapSeconds: AUTO_REFRESH_MIN_GAP_SECONDS,
  dayKey: null,
  plannedRuns: [],
  upcomingRuns: [],
  nextRunAt: null,
  lastTriggeredAt: null,
  lastTriggerResult: null,
};

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function text(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(payload);
}

function isAuthorized(request) {
  if (!PANEL_TOKEN) {
    return true;
  }
  const bearer = request.headers.authorization || "";
  const headerToken = request.headers["x-panel-token"] || "";
  return headerToken === PANEL_TOKEN || bearer === `Bearer ${PANEL_TOKEN}`;
}

function buildLoginArgs({
  skipIfValid = false,
  refreshOnly = false,
  playUrl = "",
  playAfterLogin = false,
  headless = PANEL_HEADLESS,
} = {}) {
  const args = [
    "scripts/spotify_login.mjs",
    "--status-file",
    STATUS_FILE,
    "--screenshot-dir",
    SCREENSHOT_DIR,
    "--redis-prefix",
    REDIS_PREFIX,
    headless ? "--headless" : "--no-headless",
  ];
  if (skipIfValid) {
    args.push("--skip-if-valid");
  }
  if (refreshOnly) {
    args.push("--refresh-only");
  }
  if (playUrl) {
    args.push("--play-url", playUrl);
  }
  if (playAfterLogin) {
    args.push("--play-after-login");
  }
  return args;
}

function spawnLoginProcess({
  action,
  reason,
  args,
  env = {},
}) {
  if (currentCheck) {
    return { started: false, reason: "already_running" };
  }

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REDIS_URL,
      REDIS_PREFIX,
      SERVICE_STATUS_FILE: STATUS_FILE,
      SPOTIFY_SCREENSHOT_DIR: SCREENSHOT_DIR,
      SPOTIFY_HEADLESS: PANEL_HEADLESS ? "1" : "0",
      ...env,
    },
    windowsHide: true,
  });

  currentCheck = {
    pid: child.pid,
    action,
    startedAt: new Date().toISOString(),
    reason,
  };
  lastCheckProcess = {
    action,
    startedAt: currentCheck.startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    reason,
  };

  child.stdout.on("data", (chunk) => {
    lastCheckProcess.stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    lastCheckProcess.stderr += chunk.toString();
  });

  child.on("exit", (code) => {
    lastCheckProcess.exitCode = code;
    lastCheckProcess.finishedAt = new Date().toISOString();
    currentCheck = null;
  });

  child.on("error", (error) => {
    lastCheckProcess.stderr += `${error.message}\n`;
    lastCheckProcess.exitCode = -1;
    lastCheckProcess.finishedAt = new Date().toISOString();
    currentCheck = null;
  });

  return { started: true, pid: child.pid };
}

function triggerCheck(reason = "manual") {
  return spawnLoginProcess({
    action: "check",
    reason,
    args: buildLoginArgs({ skipIfValid: true }),
  });
}

function triggerRefresh(reason = "manual_refresh", options = {}) {
  return spawnLoginProcess({
    action: "refresh",
    reason,
    args: buildLoginArgs({ refreshOnly: true, ...options }),
  });
}

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createDailyRefreshPlan(targetDate) {
  const planStart = startOfLocalDay(targetDate);
  const dayStart = planStart.getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const minPerDay = Math.max(1, AUTO_REFRESH_MIN_PER_DAY);
  const maxPerDay = Math.max(minPerDay, AUTO_REFRESH_MAX_PER_DAY);
  const count = randomIntInclusive(minPerDay, maxPerDay);
  const minGapMs = Math.max(0, AUTO_REFRESH_MIN_GAP_SECONDS) * 1000;
  const timestamps = [];
  const maxAttempts = 500;
  let attempts = 0;

  while (timestamps.length < count && attempts < maxAttempts) {
    attempts += 1;
    const candidate = dayStart + Math.floor(Math.random() * (dayEnd - dayStart));
    if (timestamps.every((value) => Math.abs(value - candidate) >= minGapMs)) {
      timestamps.push(candidate);
    }
  }

  while (timestamps.length < count) {
    timestamps.push(dayStart + ((timestamps.length + 1) * (dayEnd - dayStart)) / (count + 1));
  }

  timestamps.sort((left, right) => left - right);
  return timestamps.map((value) => new Date(value).toISOString());
}

function clearAutoRefreshTimer() {
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function updateAutoRefreshPlan(now = new Date()) {
  if (!AUTO_REFRESH_ENABLED) {
    autoRefreshState = {
      ...autoRefreshState,
      enabled: false,
      upcomingRuns: [],
      nextRunAt: null,
    };
    return;
  }

  let planDate = startOfLocalDay(now);
  while (true) {
    const dayKey = localDayKey(planDate);
    if (autoRefreshState.dayKey !== dayKey) {
      autoRefreshState = {
        ...autoRefreshState,
        dayKey,
        plannedRuns: createDailyRefreshPlan(planDate),
      };
    }

    const upcomingRuns = autoRefreshState.plannedRuns.filter(
      (value) => new Date(value).getTime() > now.getTime() + 1000,
    );

    if (upcomingRuns.length > 0) {
      autoRefreshState = {
        ...autoRefreshState,
        enabled: true,
        upcomingRuns,
        nextRunAt: upcomingRuns[0],
      };
      return;
    }

    planDate.setDate(planDate.getDate() + 1);
    autoRefreshState = {
      ...autoRefreshState,
      dayKey: null,
      plannedRuns: [],
      upcomingRuns: [],
      nextRunAt: null,
    };
  }
}

function scheduleNextAutoRefresh() {
  clearAutoRefreshTimer();
  updateAutoRefreshPlan(new Date());

  if (!AUTO_REFRESH_ENABLED || !autoRefreshState.nextRunAt) {
    return;
  }

  const delay = Math.max(1000, new Date(autoRefreshState.nextRunAt).getTime() - Date.now());
  autoRefreshTimer = setTimeout(() => {
    const result = triggerRefresh("auto_refresh");
    autoRefreshState = {
      ...autoRefreshState,
      lastTriggeredAt: new Date().toISOString(),
      lastTriggerResult: result.started ? "started" : result.reason || "skipped",
    };
    scheduleNextAutoRefresh();
  }, delay);
}

async function writeStatusPatch(patch) {
  const currentStatus = await storage.readStatus();
  await storage.writeStatus({
    ...currentStatus,
    ...patch,
    updatedAt: new Date().toISOString(),
    backend: storage.backend,
  });
}

async function parseJsonBody(request) {
  const raw = await requestBody(request);
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Spotify Service Panel</title>
  <style>
    :root {
      --bg: #f4efe6;
      --card: rgba(255,255,255,0.78);
      --ink: #18211b;
      --muted: #5c675f;
      --accent: #1db954;
      --warn: #d47a00;
      --danger: #bb2d3b;
      --line: rgba(24,33,27,0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Noto Serif SC", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(29,185,84,0.16), transparent 28%),
        radial-gradient(circle at right, rgba(24,33,27,0.10), transparent 24%),
        linear-gradient(135deg, #f7f2e8 0%, #efe7da 100%);
      min-height: 100vh;
    }
    .wrap { width: min(1180px, calc(100% - 32px)); margin: 32px auto; }
    .hero { display: grid; gap: 16px; grid-template-columns: 1.25fr 0.75fr; margin-bottom: 20px; }
    .card {
      background: var(--card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 18px 40px rgba(24,33,27,0.08);
    }
    .title { margin: 0; font-size: clamp(30px, 5vw, 48px); line-height: .95; letter-spacing: -.03em; }
    .subtitle { margin: 10px 0 0; color: var(--muted); font-size: 15px; }
    .pill { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 12px; font-size: 13px; background: rgba(24,33,27,0.06); }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
    .dot.ok { background: var(--accent); }
    .dot.warn { background: var(--warn); }
    .dot.error { background: var(--danger); }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
    button, input, textarea { font: inherit; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: var(--ink);
      color: #fff;
      cursor: pointer;
    }
    button.secondary { background: rgba(24,33,27,0.08); color: var(--ink); }
    input, textarea {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,0.75);
      color: var(--ink);
    }
    input.token { border-radius: 999px; }
    textarea {
      min-height: 190px;
      resize: vertical;
      font: 12px/1.5 "Cascadia Code", Consolas, monospace;
    }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric { font-size: 13px; color: var(--muted); }
    .value { margin-top: 8px; font-size: 24px; font-weight: 700; }
    .meta { margin-top: 8px; color: var(--muted); font-size: 13px; word-break: break-word; }
    .section-title { margin: 0 0 12px; font-size: 18px; }
    .form-grid { display: grid; gap: 12px; }
    .inline-actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .feedback {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(29,185,84,0.10);
      color: #0b6c2d;
      font-size: 14px;
    }
    .feedback.error {
      background: rgba(187,45,59,0.12);
      color: #8d1e2a;
    }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: rgba(24,33,27,0.05);
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.5 "Cascadia Code", Consolas, monospace;
    }
    img { display: block; width: 100%; border-radius: 16px; border: 1px solid var(--line); }
    .span-2 { grid-column: span 2; }
    .span-3 { grid-column: span 3; }
    @media (max-width: 960px) {
      .hero, .grid { grid-template-columns: 1fr; }
      .span-2, .span-3 { grid-column: auto; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="card">
        <div class="pill"><span class="dot" id="hero-dot"></span><span id="hero-status">Loading</span></div>
        <h1 class="title">Spotify Session Monitor</h1>
        <p class="subtitle">Boot the container with Redis and a panel key, initialize the Spotify session from this panel, and let the container randomly refresh the stored session two to three times each day.</p>
        <div class="actions">
          <button id="refresh-now-btn">Refresh Session Now</button>
          <button id="check-btn">Run Health Check</button>
          <button id="refresh-btn" class="secondary">Refresh</button>
          <input id="token-input" class="token" placeholder="Optional panel token" />
        </div>
        <div id="panel-feedback" class="feedback" style="display:none;"></div>
      </div>
      <div class="card">
        <h2 class="section-title">Quick Facts</h2>
        <div class="metric">Storage backend</div>
        <div class="meta" id="backend-type">-</div>
        <div class="metric" style="margin-top:12px;">Redis prefix</div>
        <div class="meta" id="redis-prefix">-</div>
        <div class="metric" style="margin-top:12px;">Next auto refresh</div>
        <div class="meta" id="next-auto-refresh">-</div>
        <div class="metric" style="margin-top:12px;">Refresh cadence</div>
        <div class="meta" id="refresh-cadence">-</div>
        <div class="metric" style="margin-top:12px;">Last playback</div>
        <div class="meta" id="last-playback">-</div>
        <div class="metric" style="margin-top:12px;">Last message</div>
        <div class="meta" id="last-message">-</div>
      </div>
    </section>
    <section class="grid">
      <div class="card">
        <div class="metric">Service State</div>
        <div class="value" id="service-state">-</div>
        <div class="meta" id="service-meta">-</div>
      </div>
      <div class="card">
        <div class="metric">Session Cookies</div>
        <div class="value" id="session-valid">-</div>
        <div class="meta" id="session-meta">-</div>
      </div>
      <div class="card">
        <div class="metric">Current Job</div>
        <div class="value" id="check-state">Idle</div>
        <div class="meta" id="check-meta">-</div>
      </div>
      <div class="card span-2">
        <h2 class="section-title">Import Cookies</h2>
        <div class="form-grid">
          <input id="cookie-file" type="file" accept=".json,application/json" />
          <textarea id="cookie-input" placeholder='Paste a Playwright cookie array or {"cookies":[...]} payload here'></textarea>
          <div class="inline-actions">
            <button id="cookie-save-btn" class="secondary">Save Cookies</button>
            <button id="cookie-check-btn">Save And Validate</button>
          </div>
          <div class="meta">Cookies are stored in Redis. Screenshots remain on the local volume.</div>
        </div>
      </div>
      <div class="card">
        <h2 class="section-title">Credential Login</h2>
        <div class="form-grid">
          <input id="username-input" type="text" autocomplete="username" placeholder="Spotify email or username" />
          <input id="password-input" type="password" autocomplete="current-password" placeholder="Spotify password" />
          <input id="play-url-input" type="text" placeholder="Optional Spotify track / album / playlist URL for playback" />
          <div class="inline-actions">
            <button id="login-btn">Start Login</button>
            <button id="play-now-btn" class="secondary">Play On Current Session</button>
          </div>
          <div class="meta">Credentials are passed only to the login child process and are not written to Redis.</div>
        </div>
      </div>
      <div class="card">
        <h2 class="section-title">Artifacts</h2>
        <div class="meta" id="artifact-meta">-</div>
      </div>
      <div class="card span-2">
        <h2 class="section-title">Process Output</h2>
        <pre id="process-output">Loading...</pre>
      </div>
      <div class="card span-2">
        <h2 class="section-title">Cookie Summary</h2>
        <pre id="cookie-summary">Loading...</pre>
      </div>
      <div class="card">
        <h2 class="section-title">Success Screenshot</h2>
        <div id="success-screenshot-wrap" class="meta">No success screenshot yet.</div>
      </div>
      <div class="card">
        <h2 class="section-title">Failure Screenshot</h2>
        <div id="screenshot-wrap" class="meta">No screenshot yet.</div>
      </div>
    </section>
  </div>
  <script>
    const tokenInput = document.getElementById("token-input");
    const playUrlInput = document.getElementById("play-url-input");
    const feedback = document.getElementById("panel-feedback");
    const artifactUrls = new Map();
    const savedToken = localStorage.getItem("panelToken") || "";
    const savedPlayUrl = localStorage.getItem("playUrl") || "";
    tokenInput.value = savedToken;
    playUrlInput.value = savedPlayUrl;
    tokenInput.addEventListener("change", () => localStorage.setItem("panelToken", tokenInput.value.trim()));
    playUrlInput.addEventListener("change", () => localStorage.setItem("playUrl", playUrlInput.value.trim()));

    function headers() {
      const token = tokenInput.value.trim();
      return token ? { "X-Panel-Token": token } : {};
    }

    function fmt(value) {
      return value || "-";
    }

    function dotClass(state) {
      if (state === "ok") return "dot ok";
      if (state === "error") return "dot error";
      return "dot warn";
    }

    function stringify(value) {
      return JSON.stringify(value, null, 2);
    }

    function showFeedback(message, isError = false) {
      feedback.style.display = "block";
      feedback.className = isError ? "feedback error" : "feedback";
      feedback.textContent = message;
    }

    function clearArtifact(containerId, emptyText) {
      const previousUrl = artifactUrls.get(containerId);
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        artifactUrls.delete(containerId);
      }
      document.getElementById(containerId).textContent = emptyText;
    }

    async function renderArtifact(containerId, path, altText, emptyText) {
      const response = await fetch(path, { headers: headers() });
      if (!response.ok) {
        clearArtifact(containerId, emptyText);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const previousUrl = artifactUrls.get(containerId);
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      artifactUrls.set(containerId, url);
      document.getElementById(containerId).innerHTML =
        '<img alt="' + altText + '" src="' + url + '" />';
    }

    async function submitJson(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(payload || {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }
      return data;
    }

    async function loadStatus() {
      const response = await fetch("/api/status", { headers: headers() });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load status");
      }

      const serviceState = payload.service?.state || "unknown";
      const currentJob = payload.currentCheck;
      const actionLabel =
        currentJob?.action === "login"
          ? "Login Running"
          : currentJob?.action === "refresh"
            ? "Refresh Running"
          : currentJob?.action === "check"
            ? "Health Check Running"
            : "Idle";

      document.getElementById("hero-dot").className = dotClass(serviceState);
      document.getElementById("hero-status").textContent = serviceState.toUpperCase();
      document.getElementById("service-state").textContent = serviceState;
      document.getElementById("service-meta").textContent =
        "Last success: " + fmt(payload.service?.lastSuccessAt) +
        " | Last failure: " + fmt(payload.service?.lastFailureAt);
      document.getElementById("session-valid").textContent =
        payload.cookieSummary?.hasSessionCookies ? "Present" : "Missing";
      document.getElementById("session-meta").textContent =
        "Expires: " + fmt(payload.cookieSummary?.sessionExpiresAt) +
        " | Total: " + fmt(payload.cookieSummary?.total);
      document.getElementById("check-state").textContent = actionLabel;
      document.getElementById("check-meta").textContent = currentJob
        ? "Started: " + fmt(currentJob.startedAt) + " | Reason: " + fmt(currentJob.reason)
        : "Last action: " + fmt(payload.lastCheckProcess?.action) + " | Last exit: " + fmt(payload.lastCheckProcess?.exitCode);
      document.getElementById("backend-type").textContent = payload.backend?.type || "-";
      document.getElementById("redis-prefix").textContent = payload.backend?.redisPrefix || "-";
      document.getElementById("next-auto-refresh").textContent = payload.autoRefresh?.nextRunAt || "Disabled";
      document.getElementById("refresh-cadence").textContent = payload.autoRefresh?.enabled
        ? (payload.autoRefresh.minPerDay + " to " + payload.autoRefresh.maxPerDay + " runs/day")
        : "Disabled";
      document.getElementById("last-playback").textContent = payload.service?.playback?.requested
        ? (payload.service?.playback?.success === false
            ? "Failed: " + fmt(payload.service?.playback?.error)
            : "OK: " + fmt(payload.service?.playback?.url))
        : "Not requested";
      document.getElementById("last-message").textContent = payload.service?.lastMessage || "-";
      document.getElementById("artifact-meta").textContent =
        "Screenshot dir: " + fmt(payload.backend?.screenshotDir || payload.screenshots?.loginFailed?.path);
      document.getElementById("process-output").textContent =
        [payload.lastCheckProcess?.stdout || "", payload.lastCheckProcess?.stderr || ""]
          .filter(Boolean)
          .join("\\n") || "No process output yet.";
      document.getElementById("cookie-summary").textContent = stringify(payload.cookieSummary || {});

      const successWrap = document.getElementById("success-screenshot-wrap");
      if (payload.screenshots?.loginSuccess?.exists) {
        await renderArtifact(
          "success-screenshot-wrap",
          "/artifacts/login_success.png",
          "Latest success screenshot",
          "No success screenshot yet.",
        );
      } else {
        clearArtifact("success-screenshot-wrap", "No success screenshot yet.");
      }

      const screenshotWrap = document.getElementById("screenshot-wrap");
      if (payload.screenshots?.loginFailed?.exists) {
        await renderArtifact(
          "screenshot-wrap",
          "/artifacts/login_failed.png",
          "Latest failure screenshot",
          "No screenshot yet.",
        );
      } else {
        clearArtifact("screenshot-wrap", "No screenshot yet.");
      }
    }

    async function runCheck() {
      const payload = await submitJson("/api/check", {});
      showFeedback(
        payload.started
          ? "Health check started."
          : "A job is already running.",
        !payload.started,
      );
      await loadStatus();
    }

    async function runRefreshNow() {
      const playUrl = playUrlInput.value.trim();
      const payload = await submitJson("/api/refresh", {
        playUrl,
        playAfterLogin: Boolean(playUrl),
      });
      showFeedback(
        payload.started
          ? (playUrl ? "Session refresh and playback started." : "Session refresh started.")
          : "A job is already running.",
        !payload.started,
      );
      await loadStatus();
    }

    async function playNow() {
      const playUrl = playUrlInput.value.trim();
      if (!playUrl) {
        throw new Error("Enter a Spotify track, album, or playlist URL first.");
      }
      const payload = await submitJson("/api/refresh", {
        playUrl,
        playAfterLogin: true,
      });
      showFeedback(payload.started ? "Playback request started." : "A job is already running.");
      await loadStatus();
    }

    async function importCookies(runCheckAfterImport) {
      const raw = document.getElementById("cookie-input").value.trim();
      if (!raw) {
        throw new Error("Paste a cookie payload or load a JSON file first.");
      }
      const payload = await submitJson("/api/cookies/import", {
        text: raw,
        runCheck: runCheckAfterImport,
      });
      const validationText = payload.validation?.started
        ? " Validation started."
        : payload.validation?.reason === "already_running"
          ? " Validation skipped because another job is already running."
          : "";
      showFeedback("Imported " + payload.importedCount + " cookies." + validationText);
      await loadStatus();
    }

    async function startLogin() {
      const username = document.getElementById("username-input").value.trim();
      const password = document.getElementById("password-input").value;
      const playUrl = playUrlInput.value.trim();
      if (!username || !password) {
        throw new Error("Username and password are required.");
      }
      const payload = await submitJson("/api/login", {
        username,
        password,
        playUrl,
        playAfterLogin: Boolean(playUrl),
      });
      document.getElementById("password-input").value = "";
      showFeedback(
        payload.started
          ? (playUrl ? "Credential login and playback started." : "Credential login started.")
          : "A job is already running.",
      );
      await loadStatus();
    }

    function showError(error) {
      showFeedback(error.message, true);
      document.getElementById("process-output").textContent = error.message;
    }

    document.getElementById("refresh-btn").addEventListener("click", () => loadStatus().catch(showError));
    document.getElementById("refresh-now-btn").addEventListener("click", () => runRefreshNow().catch(showError));
    document.getElementById("check-btn").addEventListener("click", () => runCheck().catch(showError));
    document.getElementById("play-now-btn").addEventListener("click", () => playNow().catch(showError));
    document.getElementById("cookie-save-btn").addEventListener("click", () => importCookies(false).catch(showError));
    document.getElementById("cookie-check-btn").addEventListener("click", () => importCookies(true).catch(showError));
    document.getElementById("login-btn").addEventListener("click", () => startLogin().catch(showError));
    document.getElementById("cookie-file").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      document.getElementById("cookie-input").value = await file.text();
      showFeedback("Loaded " + file.name + " into the cookie editor.");
    });

    loadStatus().catch(showError);
    setInterval(() => loadStatus().catch(() => {}), 10000);
  </script>
</body>
</html>`;
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString();
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/artifacts/")) {
      if (!isAuthorized(request)) {
        return json(response, 401, { error: "Unauthorized" });
      }
    }

    if (request.method === "GET" && url.pathname === "/") {
      return text(response, 200, renderHtml(), "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return json(response, 200, {
        ...(await collectStatusSnapshot(storage)),
        currentCheck,
        lastCheckProcess,
        autoRefresh: autoRefreshState,
        config: {
          host: HOST,
          port: PORT,
          checkIntervalSeconds: CHECK_INTERVAL_SECONDS,
          checkOnStart: CHECK_ON_START,
          tokenEnabled: Boolean(PANEL_TOKEN),
          autoRefreshEnabled: AUTO_REFRESH_ENABLED,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/refresh") {
      const body = await parseJsonBody(request);
      const playUrl = String(body.playUrl || "").trim();
      const result = triggerRefresh("manual_refresh", {
        playUrl,
        playAfterLogin: body.playAfterLogin === true || Boolean(playUrl),
      });
      if (!result.started) {
        return json(response, 409, { error: "Another job is already running." });
      }
      return json(response, 202, { ok: true, ...result });
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      await requestBody(request);
      const result = triggerCheck("manual");
      if (!result.started) {
        return json(response, 409, { error: "Another job is already running." });
      }
      return json(response, 202, { ok: true, ...result });
    }

    if (request.method === "POST" && url.pathname === "/api/cookies/import") {
      const body = await parseJsonBody(request);
      const rawPayload =
        typeof body.text === "string" && body.text.trim()
          ? body.text.trim()
          : body.cookies ?? body.payload ?? body;
      const importedCookies = parseCookiePayload(rawPayload);
      const existingCookies = body.merge === false ? [] : await storage.readCookies();
      const cookiesToStore = mergeCookies(existingCookies, importedCookies);
      const cookieSummary = summarizeCookies(cookiesToStore);

      await storage.writeCookies(cookiesToStore);
      await writeStatusPatch({
        phase: "cookies_imported",
        lastMessage: `Imported ${importedCookies.length} cookies from panel.`,
        cookieSummary,
      });

      let validation = null;
      if (body.runCheck) {
        validation = triggerCheck("cookie_import");
      }

      return json(response, 202, {
        ok: true,
        importedCount: importedCookies.length,
        totalCount: cookiesToStore.length,
        cookieSummary,
        validation,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await parseJsonBody(request);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const playUrl = String(body.playUrl || "").trim();
      const headless = body.headless === false ? false : PANEL_HEADLESS;

      if (!username || !password) {
        return json(response, 400, { error: "username and password are required." });
      }

      const result = spawnLoginProcess({
        action: "login",
        reason: "panel_login",
        args: buildLoginArgs({
          headless,
          playUrl,
          playAfterLogin: body.playAfterLogin === true || Boolean(playUrl),
        }),
        env: {
          SPOTIFY_USERNAME: username,
          SPOTIFY_PASSWORD: password,
          SPOTIFY_HEADLESS: headless ? "1" : "0",
          ...(playUrl ? { SPOTIFY_PLAY_URL: playUrl, SPOTIFY_PLAY_AFTER_LOGIN: "1" } : {}),
        },
      });

      if (!result.started) {
        return json(response, 409, { error: "Another job is already running." });
      }

      await writeStatusPatch({
        state: "running",
        phase: "queued_from_panel",
        lastMessage: "Credential login was started from the web panel.",
      });

      return json(response, 202, { ok: true, ...result });
    }

    if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const name = url.pathname.replace("/artifacts/", "");
      const allowedArtifacts = new Set([
        "login_success.png",
        "login_failed.png",
        "password_form_not_found.png",
      ]);
      if (!allowedArtifacts.has(name)) {
        return text(response, 404, "Not found");
      }
      const artifact = await storage.readArtifactContent(name);
      if (!artifact) {
        return text(response, 404, "Not found");
      }
      response.writeHead(200, { "content-type": artifact.contentType || "image/png" });
      response.end(artifact.body);
      return;
    }

    return text(response, 404, "Not found");
  } catch (error) {
    return json(response, error.statusCode || 500, { error: error.message });
  }
});

async function main() {
  storage = await createStorage({
    redisUrl: REDIS_URL,
    redisPrefix: REDIS_PREFIX,
    statusFile: STATUS_FILE,
    screenshotDir: SCREENSHOT_DIR,
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`Web panel listening on http://${HOST}:${PORT}\n`);
    scheduleNextAutoRefresh();
    if (CHECK_ON_START) {
      triggerCheck("startup");
    }
    if (CHECK_INTERVAL_SECONDS > 0) {
      setInterval(() => {
        triggerCheck("interval");
      }, CHECK_INTERVAL_SECONDS * 1000);
    }
  });
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  process.stdout.write(`Shutting down web panel (${signal})\n`);
  clearAutoRefreshTimer();
  server.close();
  if (storage) {
    await storage.close();
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    process.stderr.write(`Shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    process.stderr.write(`Shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

main().catch((error) => {
  process.stderr.write(`Panel failed: ${error.message}\n`);
  process.exit(1);
});
