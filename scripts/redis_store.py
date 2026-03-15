import json
import os
from typing import Any

import redis


DEFAULT_STATE_KEY = os.getenv("REDIS_STATE_KEY", "spotify_login_keeper:state")
DEFAULT_COOKIE_KEY = os.getenv("REDIS_COOKIE_KEY", "spotify_login_keeper:cookies")
DEFAULT_CONFIG_KEY = os.getenv("REDIS_CONFIG_KEY", "spotify_login_keeper:config")
REDIS_URL = os.getenv("REDIS_URL")


def redis_enabled() -> bool:
    return bool(REDIS_URL)


def get_client() -> redis.Redis:
    if not REDIS_URL:
        raise RuntimeError("REDIS_URL is not set.")
    return redis.from_url(REDIS_URL, decode_responses=True)


def load_json(key: str) -> dict[str, Any] | None:
    try:
        client = get_client()
        payload = client.get(key)
        if not payload:
            return None
        return json.loads(payload)
    except (redis.RedisError, json.JSONDecodeError, OSError):
        return None


def save_json(key: str, data: dict[str, Any]) -> None:
    try:
        client = get_client()
        client.set(key, json.dumps(data, ensure_ascii=False))
    except (redis.RedisError, OSError):
        return


def load_cookies() -> list[dict[str, Any]] | None:
    try:
        client = get_client()
        payload = client.get(DEFAULT_COOKIE_KEY)
        if not payload:
            return None
        value = json.loads(payload)
        if isinstance(value, list):
            return value
        return None
    except (redis.RedisError, json.JSONDecodeError, OSError):
        return None


def save_cookies(cookies: list[dict[str, Any]]) -> None:
    try:
        client = get_client()
        client.set(DEFAULT_COOKIE_KEY, json.dumps(cookies, ensure_ascii=False))
    except (redis.RedisError, OSError):
        return


def load_config() -> dict[str, Any] | None:
    return load_json(DEFAULT_CONFIG_KEY)


def save_config(config: dict[str, Any]) -> None:
    save_json(DEFAULT_CONFIG_KEY, config)
