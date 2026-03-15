import argparse
import json
import os
import sys
import time
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import requests
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

try:
    from scripts.redis_store import load_cookies as redis_load_cookies
    from scripts.redis_store import redis_enabled, save_cookies as redis_save_cookies
except ImportError:
    from redis_store import load_cookies as redis_load_cookies
    from redis_store import redis_enabled, save_cookies as redis_save_cookies


DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)

AUTH_COOKIE_NAMES = {"sp_dc", "sp_key"}
PLAYWRIGHT_PROXY_SERVER = os.getenv("PLAYWRIGHT_PROXY_SERVER") or os.getenv("PROXY_URL")


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y"}


def build_login_url(base_url: str, locale: str | None, continue_url: str, login_hint: str | None) -> str:
    if base_url:
        login_url = base_url.rstrip("/")
    else:
        if locale:
            login_url = f"https://accounts.spotify.com/{locale}/login"
        else:
            login_url = "https://accounts.spotify.com/login"
    params = {"continue": continue_url}
    if login_hint:
        params["login_hint"] = login_hint
        params["allow_password"] = "1"
    return f"{login_url}?{urlencode(params)}"


def load_cookies_from_file(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        data: list[dict[str, Any]] = json.load(handle)
    return data


def apply_cookies(session: requests.Session, cookies: list[dict[str, Any]]) -> None:
    for item in cookies:
        session.cookies.set(
            item.get("name"),
            item.get("value"),
            domain=item.get("domain"),
            path=item.get("path") or "/",
            secure=bool(item.get("secure")),
        )


def check_logged_in(cookie_file: str, timeout: float) -> bool:
    if not redis_enabled() and not os.path.exists(cookie_file):
        return False
    session = requests.Session()
    session.headers.update({"User-Agent": DEFAULT_UA, "Accept": "application/json"})
    try:
        if redis_enabled():
            cookies = redis_load_cookies()
            if not cookies:
                return False
        else:
            cookies = load_cookies_from_file(cookie_file)
        apply_cookies(session, cookies)
    except (OSError, json.JSONDecodeError, RuntimeError):
        return False

    url = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player"
    try:
        response = session.get(url, timeout=timeout)
    except requests.RequestException:
        return False

    if response.status_code != 200:
        return False

    try:
        payload = response.json()
    except ValueError:
        return False

    return bool(payload.get("accessToken")) and payload.get("isAnonymous") is False


def save_cookies(cookies: list[dict[str, Any]], path: str) -> None:
    normalized = []
    for cookie in cookies:
        normalized.append(
            {
                "name": cookie.get("name"),
                "value": cookie.get("value"),
                "domain": cookie.get("domain"),
                "path": cookie.get("path"),
                "secure": bool(cookie.get("secure")),
            }
        )
    if redis_enabled():
        redis_save_cookies(normalized)
        return
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(normalized, handle, indent=2, ensure_ascii=False)


def has_auth_cookie(cookies: list[dict[str, Any]]) -> bool:
    for cookie in cookies:
        name = (cookie.get("name") or "").lower()
        domain = (cookie.get("domain") or "").lower()
        if name in AUTH_COOKIE_NAMES and "spotify.com" in domain:
            return True
    return False


def detect_recaptcha(page) -> bool:
    try:
        return (
            page.locator("iframe[src*='recaptcha']").count() > 0
            or page.locator("div.g-recaptcha").count() > 0
        )
    except Exception:
        return False


def run_browser_login(
    username: str,
    password: str,
    cookie_file: str,
    locale: str | None,
    continue_url: str,
    login_hint: str | None,
    headless: bool,
    timeout: float,
    login_url: str,
    logger=log,
) -> bool:
    login_page_url = build_login_url(login_url, locale, continue_url, login_hint)
    timeout_ms = int(timeout * 1000)

    with sync_playwright() as playwright:
        proxy_settings = None
        if PLAYWRIGHT_PROXY_SERVER:
            proxy_settings = {"server": PLAYWRIGHT_PROXY_SERVER}
        browser = playwright.chromium.launch(headless=headless, proxy=proxy_settings)
        context = browser.new_context(user_agent=DEFAULT_UA)
        page = context.new_page()
        try:
            page.goto(login_page_url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_selector(
                "input[name='username'], input#login-username", timeout=timeout_ms
            )
            page.fill("input[name='username'], input#login-username", username)
            page.fill("input[name='password'], input#login-password", password)
            page.click("button[type='submit'], #login-button")
            page.wait_for_load_state("networkidle", timeout=timeout_ms)
        except PlaywrightTimeoutError:
            logger("Login page timed out.")
            browser.close()
            return False

        if detect_recaptcha(page) and headless:
            logger("Detected recaptcha. Run with HEADLESS=0 to solve it manually.")
            browser.close()
            return False

        try:
            if "open.spotify.com" not in page.url:
                page.goto(continue_url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_load_state("networkidle", timeout=timeout_ms)
        except PlaywrightTimeoutError:
            logger("Continue URL timed out.")

        cookies = context.cookies()
        browser.close()
        if not has_auth_cookie(cookies):
            logger("Login did not produce expected auth cookies.")
            return False

        os.makedirs(os.path.dirname(cookie_file) or ".", exist_ok=True)
        save_cookies(cookies, cookie_file)
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Looped Spotify login refresher.")
    parser.add_argument("--username", default=os.getenv("SPOTIFY_USERNAME"))
    parser.add_argument("--password", default=os.getenv("SPOTIFY_PASSWORD"))
    parser.add_argument("--cookie-file", default=os.getenv("COOKIE_FILE", "/data/cookies.json"))
    parser.add_argument("--interval-hours", type=float, default=float(os.getenv("LOGIN_INTERVAL_HOURS", "72")))
    parser.add_argument("--retry-delay", type=float, default=float(os.getenv("RETRY_DELAY_SECONDS", "600")))
    parser.add_argument("--locale", default=os.getenv("SPOTIFY_LOCALE", "zh-CN"))
    parser.add_argument("--continue-url", default=os.getenv("SPOTIFY_CONTINUE_URL", "https://open.spotify.com/"))
    parser.add_argument("--login-hint", default=os.getenv("SPOTIFY_LOGIN_HINT"))
    parser.add_argument("--login-url", default=os.getenv("SPOTIFY_LOGIN_URL", ""))
    parser.add_argument("--timeout", type=float, default=float(os.getenv("REQUEST_TIMEOUT", "20")))
    parser.add_argument("--headless", type=lambda v: v.lower() in {"1", "true", "yes"}, default=env_bool("HEADLESS", True))
    parser.add_argument("--once", action="store_true", help="Run a single check/login cycle.")
    args = parser.parse_args()

    if not args.username or not args.password:
        print("Missing SPOTIFY_USERNAME or SPOTIFY_PASSWORD.", file=sys.stderr)
        return 1

    while True:
        login_ok = False
        if check_logged_in(args.cookie_file, args.timeout):
            login_ok = True
            log("Already logged in.")
        else:
            log("Not logged in. Starting browser login.")
            login_ok = run_browser_login(
                args.username,
                args.password,
                args.cookie_file,
                args.locale,
                args.continue_url,
                args.login_hint,
                args.headless,
                args.timeout,
                args.login_url,
            )
            if login_ok:
                log("Login succeeded and cookies saved.")
            else:
                log("Login failed. Will retry later.")

        if args.once:
            return 0

        if login_ok:
            sleep_seconds = max(60.0, args.interval_hours * 3600.0)
        else:
            sleep_seconds = max(60.0, args.retry_delay)
        log(f"Sleeping for {int(sleep_seconds)} seconds.")
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
