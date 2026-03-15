import argparse
import json
import sys
from typing import Any

import requests

try:
    from scripts.redis_store import load_cookies, redis_enabled
except ImportError:
    from redis_store import load_cookies, redis_enabled


DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Check if Spotify web session is logged in.")
    parser.add_argument("--cookie-in", required=True, help="Cookie JSON file from spotify_login.py.")
    parser.add_argument("--timeout", type=float, default=15.0, help="Request timeout in seconds.")
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": DEFAULT_UA, "Accept": "application/json"})
    try:
        if redis_enabled():
            cookies = load_cookies()
            if not cookies:
                print("No cookies in Redis.", file=sys.stderr)
                return 1
        else:
            cookies = load_cookies_from_file(args.cookie_in)
        apply_cookies(session, cookies)
    except (OSError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"Failed to load cookies: {exc}", file=sys.stderr)
        return 1

    url = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player"
    try:
        response = session.get(url, timeout=args.timeout)
    except requests.RequestException as exc:
        print(f"Check request failed: {exc}", file=sys.stderr)
        return 1

    if response.status_code != 200:
        print("NOT_LOGGED_IN")
        return 2

    try:
        payload = response.json()
    except ValueError:
        print("NOT_LOGGED_IN")
        return 2

    if payload.get("accessToken") and payload.get("isAnonymous") is False:
        print("LOGGED_IN")
        return 0

    print("NOT_LOGGED_IN")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
