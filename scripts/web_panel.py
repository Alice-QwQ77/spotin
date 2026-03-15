import json
import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request, redirect, make_response

try:
    from scripts.loop_login import check_logged_in, run_browser_login
    from scripts.redis_store import (
        DEFAULT_CONFIG_KEY,
        DEFAULT_COOKIE_KEY,
        DEFAULT_STATE_KEY,
        load_config,
        load_cookies as redis_load_cookies,
        load_json,
        redis_enabled,
        save_config,
        save_cookies as redis_save_cookies,
        save_json,
    )
except ImportError:
    from loop_login import check_logged_in, run_browser_login
    from redis_store import (
        DEFAULT_CONFIG_KEY,
        DEFAULT_COOKIE_KEY,
        DEFAULT_STATE_KEY,
        load_config,
        load_cookies as redis_load_cookies,
        load_json,
        redis_enabled,
        save_config,
        save_cookies as redis_save_cookies,
        save_json,
    )


APP_PORT = int(os.getenv("PORT", "8080"))
COOKIE_FILE = os.getenv("COOKIE_FILE", "/data/cookies.json")
STATE_FILE = os.getenv("STATE_FILE", "/data/state.json")
INTERVAL_HOURS = float(os.getenv("LOGIN_INTERVAL_HOURS", "72"))
RETRY_DELAY_SECONDS = float(os.getenv("RETRY_DELAY_SECONDS", "600"))
HEADLESS = os.getenv("HEADLESS", "true").strip().lower() in {"1", "true", "yes", "y"}
ENABLE_LOOP = os.getenv("ENABLE_LOOP", "true").strip().lower() in {"1", "true", "yes", "y"}
PANEL_TOKEN = os.getenv("PANEL_TOKEN")
PANEL_COOKIE_NAME = "panel_token"
PROXY_URL = os.getenv("PROXY_URL")
WIREPROXY_INFO_HOST = os.getenv("WIREPROXY_INFO_HOST", "127.0.0.1")
WIREPROXY_INFO_PORT = os.getenv("WIREPROXY_INFO_PORT", "9080")

SPOTIFY_USERNAME = os.getenv("SPOTIFY_USERNAME")
SPOTIFY_PASSWORD = os.getenv("SPOTIFY_PASSWORD")
SPOTIFY_LOCALE = os.getenv("SPOTIFY_LOCALE", "zh-CN")
SPOTIFY_CONTINUE_URL = os.getenv("SPOTIFY_CONTINUE_URL", "https://open.spotify.com/")
SPOTIFY_LOGIN_HINT = os.getenv("SPOTIFY_LOGIN_HINT")
SPOTIFY_LOGIN_URL = os.getenv("SPOTIFY_LOGIN_URL", "")
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "20"))


def get_config() -> dict[str, Any]:
    config: dict[str, Any] = {}
    if redis_enabled():
        saved = load_config() or {}
        config.update(saved)
    config.setdefault("username", SPOTIFY_USERNAME)
    config.setdefault("password", SPOTIFY_PASSWORD)
    config.setdefault("locale", SPOTIFY_LOCALE)
    config.setdefault("continue_url", SPOTIFY_CONTINUE_URL)
    config.setdefault("login_hint", SPOTIFY_LOGIN_HINT)
    config.setdefault("login_url", SPOTIFY_LOGIN_URL)
    config.setdefault("interval_hours", INTERVAL_HOURS)
    config.setdefault("retry_delay_seconds", RETRY_DELAY_SECONDS)
    config.setdefault("headless", HEADLESS)
    return config


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)
state_lock = threading.Lock()
run_lock = threading.Lock()
force_event = threading.Event()


state: dict[str, Any] = {
    "logged_in": False,
    "last_checked_at": None,
    "last_login_at": None,
    "last_login_result": None,
    "last_message": None,
    "next_run_at": None,
    "loop_enabled": ENABLE_LOOP,
}


def now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def load_state() -> None:
    if redis_enabled():
        data = load_json(DEFAULT_STATE_KEY)
        if not data:
            return
        with state_lock:
            state.update(data)
        return

    if not os.path.exists(STATE_FILE):
        return
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return
    with state_lock:
        state.update(data)


def persist_state() -> None:
    with state_lock:
        snapshot = dict(state)
    if redis_enabled():
        save_json(DEFAULT_STATE_KEY, snapshot)
        return
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, indent=2, ensure_ascii=False)


def update_state(**changes: Any) -> None:
    with state_lock:
        state.update(changes)
    persist_state()


def append_message(message: str) -> None:
    update_state(last_message=message)


def run_cycle() -> float:
    config = get_config()
    username = config.get("username")
    password = config.get("password")
    if not username or not password:
        update_state(
            last_checked_at=now_iso(),
            last_login_result="missing_credentials",
            last_message="Missing username or password in config.",
            logged_in=False,
        )
        return max(60.0, RETRY_DELAY_SECONDS)

    with run_lock:
        logged_in = check_logged_in(COOKIE_FILE, REQUEST_TIMEOUT)
        update_state(logged_in=logged_in, last_checked_at=now_iso())
        if logged_in:
            interval_hours = float(config.get("interval_hours") or INTERVAL_HOURS)
            next_run = datetime.utcnow() + timedelta(hours=interval_hours)
            update_state(
                last_login_result="already_logged_in",
                next_run_at=next_run.isoformat() + "Z",
            )
            interval_hours = float(config.get("interval_hours") or INTERVAL_HOURS)
            return max(60.0, interval_hours * 3600.0)

        update_state(last_login_at=now_iso(), last_login_result="login_started", last_message=None)
        ok = run_browser_login(
            username,
            password,
            COOKIE_FILE,
            config.get("locale"),
            config.get("continue_url"),
            config.get("login_hint"),
            bool(config.get("headless")),
            REQUEST_TIMEOUT,
            config.get("login_url") or "",
            logger=append_message,
        )

        if ok:
            interval_hours = float(config.get("interval_hours") or INTERVAL_HOURS)
            next_run = datetime.utcnow() + timedelta(hours=interval_hours)
            update_state(
                logged_in=True,
                last_login_result="login_success",
                next_run_at=next_run.isoformat() + "Z",
            )
            interval_hours = float(config.get("interval_hours") or INTERVAL_HOURS)
            return max(60.0, interval_hours * 3600.0)

        update_state(
            logged_in=False,
            last_login_result="login_failed",
            next_run_at=None,
        )
        retry_delay = float(config.get("retry_delay_seconds") or RETRY_DELAY_SECONDS)
        return max(60.0, retry_delay)


def scheduler_loop() -> None:
    while True:
        with state_lock:
            loop_enabled = bool(state.get("loop_enabled"))

        if force_event.is_set():
            force_event.clear()
            run_cycle()
            continue

        if not loop_enabled:
            force_event.wait(timeout=60.0)
            continue

        sleep_seconds = run_cycle()
        force_event.wait(timeout=sleep_seconds)


def is_authorized() -> bool:
    if not PANEL_TOKEN:
        return True
    cookie_token = request.cookies.get(PANEL_COOKIE_NAME, "").strip()
    if cookie_token == PANEL_TOKEN:
        return True
    header_token = request.headers.get("X-Panel-Token", "").strip()
    if header_token == PANEL_TOKEN:
        return True
    auth = request.headers.get("Authorization", "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() == PANEL_TOKEN
    query_token = request.args.get("token", "").strip()
    return bool(query_token) and query_token == PANEL_TOKEN


def require_auth_json():
    if not is_authorized():
        return jsonify({"ok": False, "message": "Unauthorized"}), 401
    return None


@app.get("/")
def index():
    if not is_authorized():
        return redirect("/login")
    return render_template("index.html")


@app.get("/api/auth")
def api_auth():
    auth = require_auth_json()
    if auth:
        return auth
    return jsonify({"ok": True})


@app.get("/login")
def login_page():
    return render_template("login.html", token_required=bool(PANEL_TOKEN))


@app.post("/login")
def login_submit():
    if not PANEL_TOKEN:
        return redirect("/")
    token = (request.form.get("token") or "").strip()
    if token != PANEL_TOKEN:
        return render_template("login.html", token_required=True, error="口令错误")
    response = make_response(redirect("/"))
    response.set_cookie(
        PANEL_COOKIE_NAME,
        token,
        httponly=True,
        samesite="Lax",
    )
    return response


@app.get("/api/status")
def api_status():
    auth = require_auth_json()
    if auth:
        return auth
    with state_lock:
        snapshot = dict(state)
    config = get_config()
    cookie_count = None
    if redis_enabled():
        cookies = redis_load_cookies()
        cookie_count = len(cookies) if cookies else 0
    snapshot.update(
        {
            "busy": run_lock.locked(),
            "interval_hours": config.get("interval_hours"),
            "retry_delay_seconds": config.get("retry_delay_seconds"),
            "headless": bool(config.get("headless")),
            "username_set": bool(config.get("username")),
            "cookie_file": COOKIE_FILE,
            "redis_enabled": redis_enabled(),
            "redis_state_key": DEFAULT_STATE_KEY if redis_enabled() else None,
            "redis_cookie_key": DEFAULT_COOKIE_KEY if redis_enabled() else None,
            "redis_config_key": DEFAULT_CONFIG_KEY if redis_enabled() else None,
            "cookie_count": cookie_count,
            "config": {
                "locale": config.get("locale"),
                "continue_url": config.get("continue_url"),
                "login_hint": config.get("login_hint"),
                "login_url": config.get("login_url"),
            },
        }
    )
    return jsonify(snapshot)


def fetch_ip(proxies: dict[str, str] | None, trust_env: bool) -> str | None:
    session = requests.Session()
    session.trust_env = trust_env
    try:
        response = session.get(
            "https://api.ipify.org?format=json",
            timeout=8.0,
            proxies=proxies,
        )
        response.raise_for_status()
        return response.json().get("ip")
    except Exception:
        return None


def get_wireproxy_ready() -> bool | None:
    try:
        response = requests.get(
            f"http://{WIREPROXY_INFO_HOST}:{WIREPROXY_INFO_PORT}/readyz",
            timeout=3.0,
        )
        return response.status_code == 200
    except Exception:
        return None


@app.get("/api/diagnostics")
def api_diagnostics():
    auth = require_auth_json()
    if auth:
        return auth
    proxy_ip = None
    proxy_url = PROXY_URL
    if proxy_url:
        proxy_ip = fetch_ip({"http": proxy_url, "https": proxy_url}, trust_env=False)
    using_wireguard = proxy_ip is not None and get_wireproxy_ready() is True
    payload = {
        "service_alive": True,
        "proxy_url": proxy_url,
        "proxy_ip": proxy_ip,
        "wireproxy_ready": get_wireproxy_ready(),
        "using_wireguard": using_wireguard,
    }
    return jsonify(payload)


@app.post("/api/login-now")
def api_login_now():
    auth = require_auth_json()
    if auth:
        return auth
    if run_lock.locked():
        return jsonify({"queued": False, "message": "Login is already running."}), 409
    force_event.set()
    return jsonify({"queued": True})


@app.post("/api/loop")
def api_loop_toggle():
    auth = require_auth_json()
    if auth:
        return auth
    payload = request.get_json(silent=True) or {}
    enabled = bool(payload.get("enabled"))
    update_state(loop_enabled=enabled)
    return jsonify({"loop_enabled": enabled})


@app.post("/api/config")
def api_update_config():
    auth = require_auth_json()
    if auth:
        return auth
    if not redis_enabled():
        return jsonify({"ok": False, "message": "Redis is not enabled."}), 400
    payload = request.get_json(silent=True) or {}
    allowed = {
        "username",
        "password",
        "locale",
        "continue_url",
        "login_hint",
        "login_url",
        "interval_hours",
        "retry_delay_seconds",
        "headless",
    }
    sanitized: dict[str, Any] = {}
    for key, value in payload.items():
        if key in allowed:
            sanitized[key] = value
    current = load_config() or {}
    if "password" in sanitized and not sanitized["password"]:
        sanitized.pop("password")
    current.update(sanitized)
    save_config(current)
    return jsonify({"ok": True})


def parse_cookie_text(text: str, domain: str) -> list[dict[str, Any]]:
    text = (text or "").strip()
    if not text:
        return []

    if text.startswith("[") or text.startswith("{"):
        value = json.loads(text)
        if isinstance(value, dict):
            value = [value]
        if not isinstance(value, list):
            raise ValueError("Cookie JSON must be a list.")
        cookies = []
        for item in value:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            cookie_value = item.get("value")
            if not name or cookie_value is None:
                continue
            cookies.append(
                {
                    "name": name,
                    "value": cookie_value,
                    "domain": item.get("domain") or domain,
                    "path": item.get("path") or "/",
                    "secure": bool(item.get("secure", True)),
                }
            )
        return cookies

    cookies = []
    parts = [p.strip() for p in text.split(";") if p.strip()]
    for part in parts:
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        cookies.append(
            {
                "name": name.strip(),
                "value": value.strip(),
                "domain": domain,
                "path": "/",
                "secure": True,
            }
        )
    return cookies


@app.post("/api/cookies")
def api_save_cookies():
    auth = require_auth_json()
    if auth:
        return auth
    payload = request.get_json(silent=True) or {}
    cookie_text = payload.get("cookie_text") or ""
    domain = (payload.get("domain") or ".spotify.com").strip()
    if not domain:
        domain = ".spotify.com"

    try:
        cookies = parse_cookie_text(cookie_text, domain)
    except (ValueError, json.JSONDecodeError) as exc:
        return jsonify({"ok": False, "message": str(exc)}), 400

    if not cookies:
        return jsonify({"ok": False, "message": "No cookies parsed."}), 400

    if redis_enabled():
        redis_save_cookies(cookies)
    else:
        os.makedirs(os.path.dirname(COOKIE_FILE) or ".", exist_ok=True)
        with open(COOKIE_FILE, "w", encoding="utf-8") as handle:
            json.dump(cookies, handle, indent=2, ensure_ascii=False)

    update_state(last_message="Cookies saved from panel.")
    return jsonify({"ok": True, "count": len(cookies)})


def start_scheduler() -> None:
    load_state()
    thread = threading.Thread(target=scheduler_loop, daemon=True)
    thread.start()


if __name__ == "__main__":
    start_scheduler()
    app.run(host="0.0.0.0", port=APP_PORT)
