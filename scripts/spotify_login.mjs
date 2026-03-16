import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  DEFAULT_COOKIE_FILE,
  DEFAULT_REDIS_PREFIX,
  DEFAULT_SCREENSHOT_DIR,
  DEFAULT_STATUS_FILE,
  createStorage,
  mergeCookies,
  normalizeCookies,
  parseCookiePayload,
  summarizeCookies,
} from "./service_state.mjs";

const DEFAULT_CONTINUE_URL = "https://open.spotify.com/";
const DEFAULT_VALIDATE_URL = "https://www.spotify.com/account/overview/";
const DEFAULT_LOCALE = "zh-CN";

const COOKIE_BUTTON_PATTERNS = [
  /accept all/i,
  /accept cookies/i,
  /accept/i,
  /\u63a5\u53d7/i,
  /\u540c\u610f/i,
];

const PASSWORD_ENTRY_PATTERNS = [
  /log in with password/i,
  /use password/i,
  /password login/i,
  /\u4f7f\u7528\u5bc6\u7801/i,
  /\u5bc6\u7801\u767b\u5f55/i,
];

const CONTINUE_PATTERNS = [
  /continue/i,
  /next/i,
  /\u7ee7\u7eed/i,
  /\u4e0b\u4e00\u6b65/i,
];

const SUBMIT_PATTERNS = [
  /log in/i,
  /login/i,
  /\u767b\u5f55/i,
  /\u7ee7\u7eed/i,
];

const USERNAME_SELECTORS = [
  'input[name="username"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  "#login-username",
];

const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
  "#login-password",
];

const ERROR_SELECTORS = [
  '[data-testid="login-error-message"]',
  '[role="alert"]',
];

function parseArgs(argv) {
  const args = {
    username: process.env.SPOTIFY_USERNAME ?? "",
    password: process.env.SPOTIFY_PASSWORD ?? "",
    locale: process.env.SPOTIFY_LOCALE ?? DEFAULT_LOCALE,
    continueUrl: process.env.SPOTIFY_CONTINUE_URL ?? DEFAULT_CONTINUE_URL,
    cookieIn: process.env.SPOTIFY_COOKIE_IN ?? "",
    cookieOut: process.env.SPOTIFY_COOKIE_OUT ?? "",
    screenshotDir: process.env.SPOTIFY_SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR,
    statusFile: process.env.SERVICE_STATUS_FILE ?? DEFAULT_STATUS_FILE,
    redisUrl: process.env.REDIS_URL ?? "",
    redisPrefix: process.env.REDIS_PREFIX ?? DEFAULT_REDIS_PREFIX,
    proxy: process.env.SPOTIFY_PROXY || process.env.HTTPS_PROXY || "",
    headless: process.env.SPOTIFY_HEADLESS !== "0",
    loginTimeout: Number(process.env.SPOTIFY_LOGIN_TIMEOUT || 120),
    manualTimeout: Number(process.env.SPOTIFY_MANUAL_TIMEOUT || 180),
    skipIfValid: false,
    refreshOnly: false,
    keepOpen: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--username":
        args.username = next ?? "";
        i += 1;
        break;
      case "--password":
        args.password = next ?? "";
        i += 1;
        break;
      case "--locale":
        args.locale = next ?? DEFAULT_LOCALE;
        i += 1;
        break;
      case "--continue-url":
        args.continueUrl = next ?? DEFAULT_CONTINUE_URL;
        i += 1;
        break;
      case "--cookie-in":
        args.cookieIn = next ?? "";
        i += 1;
        break;
      case "--cookie-out":
        args.cookieOut = next ?? "";
        i += 1;
        break;
      case "--status-file":
        args.statusFile = next ?? DEFAULT_STATUS_FILE;
        i += 1;
        break;
      case "--screenshot-dir":
        args.screenshotDir = next ?? DEFAULT_SCREENSHOT_DIR;
        i += 1;
        break;
      case "--redis-url":
        args.redisUrl = next ?? "";
        i += 1;
        break;
      case "--redis-prefix":
        args.redisPrefix = next ?? DEFAULT_REDIS_PREFIX;
        i += 1;
        break;
      case "--proxy":
        args.proxy = next ?? "";
        i += 1;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--no-headless":
        args.headless = false;
        break;
      case "--login-timeout":
        args.loginTimeout = Number(next ?? 120);
        i += 1;
        break;
      case "--manual-timeout":
        args.manualTimeout = Number(next ?? 180);
        i += 1;
        break;
      case "--skip-if-valid":
        args.skipIfValid = true;
        break;
      case "--refresh-only":
        args.refreshOnly = true;
        break;
      case "--keep-open":
        args.keepOpen = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`usage: node scripts/spotify_login.mjs [options]

Options:
  --username <value>
  --password <value>
  --locale <value>
  --continue-url <value>
  --cookie-in <value>
  --cookie-out <value>
  --status-file <value>
  --screenshot-dir <value>
  --redis-url <value>
  --redis-prefix <value>
  --proxy <value>
  --headless | --no-headless
  --login-timeout <seconds>
  --manual-timeout <seconds>
  --skip-if-valid
  --refresh-only
  --keep-open`);
}

function buildLoginUrl(locale, continueUrl, username) {
  const pathname = locale ? `/${locale}/login` : "/login";
  const url = new URL(`https://accounts.spotify.com${pathname}`);
  url.searchParams.set("continue", continueUrl);
  url.searchParams.set("allow_password", "1");
  if (username) {
    url.searchParams.set("login_hint", username);
  }
  return url.toString();
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return locator;
      }
    } catch {}
  }
  return null;
}

async function clickByPatterns(page, patterns) {
  for (const pattern of patterns) {
    const candidates = [
      page.getByRole("button", { name: pattern }).first(),
      page.getByRole("link", { name: pattern }).first(),
    ];
    for (const locator of candidates) {
      try {
        if ((await locator.count()) > 0 && (await locator.isVisible())) {
          await locator.click();
          return true;
        }
      } catch {}
    }
  }
  return false;
}

async function fillFirst(page, selectors, value) {
  const locator = await firstVisible(page, selectors);
  if (!locator) {
    return false;
  }
  await locator.fill(value);
  return true;
}

async function dismissBanners(page) {
  await clickByPatterns(page, COOKIE_BUTTON_PATTERNS);
}

async function looksLoggedIn(context, page) {
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes("spotify.com/account/overview")) {
    return true;
  }
  const cookies = await context.cookies();
  return cookies.some(
    (cookie) => (cookie.name === "sp_dc" || cookie.name === "sp_key") && cookie.value,
  );
}

async function pageText(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        const text = (await locator.innerText()).trim();
        if (text) {
          return text;
        }
      }
    } catch {}
  }
  return "";
}

async function trySwitchToPassword(page, username) {
  await dismissBanners(page);
  if (await firstVisible(page, PASSWORD_SELECTORS)) {
    return;
  }
  if (await clickByPatterns(page, PASSWORD_ENTRY_PATTERNS)) {
    await page.waitForTimeout(1000);
  }
  if (await firstVisible(page, PASSWORD_SELECTORS)) {
    return;
  }
  const usernameField = await firstVisible(page, USERNAME_SELECTORS);
  if (usernameField) {
    const current = (await usernameField.inputValue()).trim();
    if (!current && username) {
      await usernameField.fill(username);
    }
    if (await clickByPatterns(page, CONTINUE_PATTERNS)) {
      await page.waitForTimeout(1000);
    }
  }
  await clickByPatterns(page, PASSWORD_ENTRY_PATTERNS);
}

async function submitLogin(page, username, password) {
  const hasUsername = await fillFirst(page, USERNAME_SELECTORS, username);
  if (!hasUsername) {
    log("Username field not found; continuing in case Spotify prefilled it.");
  }
  const hasPassword = await fillFirst(page, PASSWORD_SELECTORS, password);
  if (!hasPassword) {
    throw new Error("Password field not found.");
  }
  if (await clickByPatterns(page, SUBMIT_PATTERNS)) {
    return;
  }
  const submit = page.locator('button[type="submit"]').first();
  if ((await submit.count()) > 0) {
    await submit.click();
    return;
  }
  throw new Error("Could not find a login submit button.");
}

async function waitForResult(page, context, timeoutSeconds, manualTimeoutSeconds, allowManual) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await looksLoggedIn(context, page)) {
      return;
    }
    const error = await pageText(page, ERROR_SELECTORS);
    if (error) {
      throw new Error(error);
    }
    await page.waitForTimeout(1000);
  }

  if (allowManual) {
    log("Spotify did not finish automatically. If a verification page is visible, complete it in the opened browser window.");
    const manualDeadline = Date.now() + manualTimeoutSeconds * 1000;
    while (Date.now() < manualDeadline) {
      if (await looksLoggedIn(context, page)) {
        return;
      }
      const error = await pageText(page, ERROR_SELECTORS);
      if (error) {
        throw new Error(error);
      }
      await page.waitForTimeout(1000);
    }
  }

  throw new Error(`Login did not complete within ${timeoutSeconds + manualTimeoutSeconds} seconds.`);
}

async function touchSession(page, context) {
  await page.goto(DEFAULT_VALIDATE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes("accounts.spotify.com") || currentUrl.includes("/login")) {
    throw new Error("Stored session redirected to Spotify login.");
  }
  if (!(await looksLoggedIn(context, page))) {
    throw new Error("Stored session is not logged in.");
  }
}

async function exportCookiesToFile(cookies, outputPath) {
  ensureParent(outputPath);
  fs.writeFileSync(outputPath, JSON.stringify(cookies, null, 2), "utf8");
}

async function persistCookies(context, storage, outputPath = "") {
  const cookies = await context.cookies();
  await storage.writeCookies(cookies);
  if (outputPath) {
    await exportCookiesToFile(cookies, outputPath);
  }
  return summarizeCookies(cookies);
}

async function importCookiesFromFile(inputPath) {
  const cookiePath = path.resolve(inputPath);
  const payload = fs.readFileSync(cookiePath, "utf8");
  return parseCookiePayload(payload);
}

async function captureDebug(page, storage, name) {
  try {
    const buffer = await page.screenshot({ fullPage: true, type: "png" });
    await storage.writeArtifact(`${name}.png`, buffer, "image/png");
  } catch {}
}

async function run(args, storage) {
  const loginUrl = buildLoginUrl(args.locale, args.continueUrl, args.username);
  const sanitizedArgs = {
    locale: args.locale,
    continueUrl: args.continueUrl,
    cookieIn: args.cookieIn ? path.resolve(args.cookieIn) : "",
    cookieOut: args.cookieOut ? path.resolve(args.cookieOut) : "",
    screenshotDir: path.resolve(args.screenshotDir),
    redisEnabled: Boolean(args.redisUrl),
    redisPrefix: args.redisPrefix,
    headless: args.headless,
    loginTimeout: args.loginTimeout,
    manualTimeout: args.manualTimeout,
    skipIfValid: args.skipIfValid,
    refreshOnly: args.refreshOnly,
  };

  const updateStatus = async (payload) => {
    await storage.writeStatus({
      updatedAt: new Date().toISOString(),
      ...payload,
    });
  };

  await updateStatus({
    state: "running",
    phase: "starting",
    startedAt: new Date().toISOString(),
    lastMessage: "Launching browser context",
    args: sanitizedArgs,
  });

  const launchOptions = {
    headless: args.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  };

  if (args.proxy) {
    launchOptions.proxy = { server: args.proxy };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    locale: args.locale,
    viewport: { width: 1440, height: 1100 },
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);

    const storedCookies = normalizeCookies(await storage.readCookies());
    const fileCookies = args.cookieIn ? await importCookiesFromFile(args.cookieIn) : [];
    const combinedCookies = mergeCookies(storedCookies, fileCookies);

    if (combinedCookies.length > 0) {
      log("Importing cookies into browser context...");
      await context.addCookies(combinedCookies);
      await updateStatus({
        state: "running",
        phase: "cookie_imported",
        startedAt: new Date().toISOString(),
        lastMessage: "Imported cookies into browser context",
        args: sanitizedArgs,
      });
    }

    if (args.skipIfValid || args.refreshOnly) {
      log("Checking stored session...");
      try {
        await touchSession(page, context);
        await captureDebug(page, storage, "login_success");
        const cookieSummary = await persistCookies(
          context,
          storage,
          args.cookieOut ? path.resolve(args.cookieOut) : "",
        );
        log("Existing Spotify session is still valid.");
        await updateStatus({
          state: "ok",
          phase: args.refreshOnly ? "refresh_only" : "skip_if_valid",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          lastSuccessAt: new Date().toISOString(),
          lastMessage: args.refreshOnly
            ? "Stored Spotify session was refreshed successfully."
            : "Existing Spotify session is still valid.",
          args: sanitizedArgs,
          cookieSummary,
          backend: storage.backend,
        });
        if (args.keepOpen && !args.headless) {
          await page.pause();
        }
        return;
      } catch (error) {
        log(`Stored session is not valid: ${error.message}`);
        await updateStatus({
          state: "running",
          phase: args.refreshOnly ? "refresh_only_failed" : "skip_if_valid_failed",
          startedAt: new Date().toISOString(),
          lastMessage: `Stored session is not valid: ${error.message}`,
          args: sanitizedArgs,
          backend: storage.backend,
        });
        if (args.refreshOnly) {
          throw new Error(`Stored session refresh failed: ${error.message}`);
        }
      }
    }

    if (!args.username || !args.password) {
      throw new Error("Missing credentials. Provide --username/--password or set SPOTIFY_USERNAME and SPOTIFY_PASSWORD.");
    }

    log("Opening Spotify password login page...");
    await updateStatus({
      state: "running",
      phase: "login_page",
      startedAt: new Date().toISOString(),
      lastMessage: "Opening Spotify password login page",
      args: sanitizedArgs,
      backend: storage.backend,
    });
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await dismissBanners(page);

    for (let i = 0; i < 5; i += 1) {
      await trySwitchToPassword(page, args.username);
      if (await firstVisible(page, PASSWORD_SELECTORS)) {
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!(await firstVisible(page, PASSWORD_SELECTORS))) {
      await captureDebug(page, storage, "password_form_not_found");
      throw new Error("Could not reach the Spotify password login form.");
    }

    log("Submitting credentials...");
    await updateStatus({
      state: "running",
      phase: "submitting_credentials",
      startedAt: new Date().toISOString(),
      lastMessage: "Submitting credentials",
      args: sanitizedArgs,
      backend: storage.backend,
    });
    await submitLogin(page, args.username, args.password);

    try {
      await waitForResult(page, context, args.loginTimeout, args.manualTimeout, !args.headless);
    } catch (error) {
      await captureDebug(page, storage, "login_failed");
      throw error;
    }

    log("Spotify login succeeded, refreshing target page...");
    await touchSession(page, context);
    await captureDebug(page, storage, "login_success");
    const cookieSummary = await persistCookies(
      context,
      storage,
      args.cookieOut ? path.resolve(args.cookieOut) : "",
    );
    log("Stored session updated.");
    await updateStatus({
      state: "ok",
      phase: "login_succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastMessage: "Stored session updated.",
      args: sanitizedArgs,
      cookieSummary,
      backend: storage.backend,
    });

    if (args.keepOpen && !args.headless) {
      await page.pause();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storage = await createStorage({
    redisUrl: args.redisUrl,
    redisPrefix: args.redisPrefix,
    statusFile: path.resolve(args.statusFile),
    cookieFile: DEFAULT_COOKIE_FILE,
    screenshotDir: path.resolve(args.screenshotDir),
  });

  try {
    await run(args, storage);
  } catch (error) {
    await storage.writeStatus({
      updatedAt: new Date().toISOString(),
      state: "error",
      phase: "failed",
      finishedAt: new Date().toISOString(),
      lastFailureAt: new Date().toISOString(),
      lastMessage: error.message,
      backend: storage.backend,
    });
    process.stderr.write(`Login failed: ${error.message}\n`);
    process.exit(1);
  } finally {
    await storage.close();
  }
}

main();
