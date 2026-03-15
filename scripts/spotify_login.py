import argparse
import json
import sys
from typing import Any
from urllib.parse import urlencode

import requests


DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


def export_cookies(cookie_jar: requests.cookies.RequestsCookieJar) -> list[dict[str, Any]]:
    cookies = []
    for cookie in cookie_jar:
        cookies.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "secure": cookie.secure,
            }
        )
    return cookies


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


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Automate Spotify login using the captured flow. "
        "Requires a valid recaptcha token from a real login page."
    )
    parser.add_argument("--username", required=True, help="Spotify account username/email.")
    parser.add_argument("--password", required=True, help="Spotify account password.")
    parser.add_argument(
        "--recaptcha",
        required=True,
        help="Recaptcha token from the login page session.",
    )
    parser.add_argument("--continue-url", default="https://open.spotify.com/", help="Continue URL.")
    parser.add_argument("--login-hint", default=None, help="Optional login hint.")
    parser.add_argument("--locale", default="zh-CN", help="Locale segment used in the login page.")
    parser.add_argument("--login-url", default="", help="Override full login URL (without query).")
    parser.add_argument("--timeout", type=float, default=20.0, help="Request timeout in seconds.")
    parser.add_argument("--cookie-out", default="", help="Write cookie jar to this JSON file.")
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": DEFAULT_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )

    login_page_url = build_login_url(
        args.login_url, args.locale, args.continue_url, args.login_hint
    )
    try:
        login_page = session.get(login_page_url, timeout=args.timeout)
    except requests.RequestException as exc:
        print(f"Failed to load login page: {exc}", file=sys.stderr)
        return 1

    if login_page.status_code >= 400:
        print(f"Login page returned {login_page.status_code}", file=sys.stderr)
        return 1

    csrf_token = session.cookies.get("sp_sso_csrf_token")
    if not csrf_token:
        print("Missing sp_sso_csrf_token cookie from login page.", file=sys.stderr)
        return 1

    payload = {
        "username": args.username,
        "password": args.password,
        "remember": "true",
        "automationKey": "",
        "recaptchaToken": args.recaptcha,
    }

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://accounts.spotify.com",
        "Referer": login_page.url,
        "x-csrf-token": csrf_token,
    }

    try:
        response = session.post(
            "https://accounts.spotify.com/login/password",
            data=payload,
            headers=headers,
            timeout=args.timeout,
        )
    except requests.RequestException as exc:
        print(f"Login request failed: {exc}", file=sys.stderr)
        return 1

    result = None
    try:
        result = response.json()
    except ValueError:
        result = {"raw": response.text}

    if response.status_code != 200:
        print(f"Login failed with {response.status_code}: {result}", file=sys.stderr)
        return 1

    if isinstance(result, dict) and result.get("result") != "ok":
        print(f"Login response not ok: {result}", file=sys.stderr)
        return 1

    print("Login succeeded.")

    if args.cookie_out:
        cookies = export_cookies(session.cookies)
        with open(args.cookie_out, "w", encoding="utf-8") as handle:
            json.dump(cookies, handle, indent=2, ensure_ascii=False)
        print(f"Wrote cookies to {args.cookie_out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
