import json
import os
import sys

import requests


def fetch_json(
    url: str,
    proxies: dict[str, str] | None = None,
    timeout: float = 10.0,
    trust_env: bool = True,
):
    session = requests.Session()
    session.trust_env = trust_env
    response = session.get(url, timeout=timeout, proxies=proxies)
    response.raise_for_status()
    return response.json()


def main() -> int:
    proxy_url = os.getenv("PROXY_URL")
    info_host = os.getenv("WIREPROXY_INFO_HOST", "127.0.0.1")
    info_port = os.getenv("WIREPROXY_INFO_PORT", "9080")
    info_base = f"http://{info_host}:{info_port}"

    direct_ip = None
    proxy_ip = None

    try:
        direct_ip = fetch_json(
            "https://api.ipify.org?format=json", trust_env=False
        ).get("ip")
    except Exception:
        pass

    proxies = None
    if proxy_url:
        proxies = {
            "http": proxy_url,
            "https": proxy_url,
        }
        try:
            proxy_ip = fetch_json(
                "https://api.ipify.org?format=json",
                proxies=proxies,
                trust_env=False,
            ).get("ip")
        except Exception:
            proxy_ip = None

    wireproxy_ready = None
    try:
        ready = requests.get(f"{info_base}/readyz", timeout=3.0)
        wireproxy_ready = ready.status_code == 200
    except Exception:
        wireproxy_ready = None

    diagnosis = {
        "proxy_url": proxy_url,
        "direct_ip": direct_ip,
        "proxy_ip": proxy_ip,
        "wireproxy_ready": wireproxy_ready,
        "using_wireguard": proxy_ip is not None and direct_ip is not None and proxy_ip != direct_ip,
    }
    print("[diagnostics] " + json.dumps(diagnosis, ensure_ascii=False))

    if proxy_url and proxy_ip is None:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
