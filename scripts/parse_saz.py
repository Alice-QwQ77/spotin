import argparse
import html
import json
import re
import urllib.parse
import zipfile


SENSITIVE_HEADER_NAMES = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-csrf-token",
    "x-xsrf-token",
    "x-csrf",
    "x-xsrf",
    "client-token",
}

SENSITIVE_KEY_SUBSTRINGS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "csrf",
    "session",
    "cookie",
    "auth",
    "key",
    "email",
    "username",
    "login_hint",
    "device_id",
    "recaptcha",
)


def is_sensitive_key(name: str) -> bool:
    if not name:
        return False
    lowered = name.lower()
    if lowered in SENSITIVE_HEADER_NAMES:
        return True
    return any(part in lowered for part in SENSITIVE_KEY_SUBSTRINGS)


def redact_value(value: str) -> str:
    if value is None:
        return value
    return "<REDACTED>"


def redact_cookie_header(value: str) -> str:
    if not value:
        return value
    parts = [p.strip() for p in value.split(";")]
    redacted = []
    for part in parts:
        if "=" in part:
            name, _ = part.split("=", 1)
            redacted.append(f"{name}=<REDACTED>")
        else:
            redacted.append(part)
    return "; ".join(redacted)


def redact_set_cookie(value: str) -> str:
    if not value:
        return value
    segments = [s.strip() for s in value.split(";")]
    if segments and "=" in segments[0]:
        name, _ = segments[0].split("=", 1)
        segments[0] = f"{name}=<REDACTED>"
    return "; ".join(segments)


def redact_url(url: str) -> str:
    if not url:
        return url
    parts = urllib.parse.urlsplit(url)
    if not parts.query:
        return url
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    redacted_query = []
    for key, value in query:
        if is_sensitive_key(key):
            redacted_query.append((key, "<REDACTED>"))
        else:
            redacted_query.append((key, value))
    new_query = urllib.parse.urlencode(redacted_query, doseq=True)
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, new_query, parts.fragment)
    )


def safe_decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def read_entry_text(zf: zipfile.ZipFile, name: str) -> str | None:
    try:
        entry = zf.getinfo(name)
    except KeyError:
        return None
    with zf.open(entry) as handle:
        return safe_decode(handle.read())


def strip_tags(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]*>", "", text)
    return html.unescape(cleaned).replace("\xa0", " ").strip()


def parse_index(index_html: str) -> list[dict]:
    rows = re.findall(r"<tr>(.*?)</tr>", index_html, re.IGNORECASE | re.DOTALL)
    results = []
    for row in rows:
        cells = re.findall(r"<td>(.*?)</td>", row, re.IGNORECASE | re.DOTALL)
        if len(cells) < 6:
            continue
        file_match = re.search(r"raw\\(\d+)_c\.txt", cells[0])
        if not file_match:
            continue
        session_id = int(file_match.group(1))
        results.append(
            {
                "session": session_id,
                "result": strip_tags(cells[2]),
                "protocol": strip_tags(cells[3]),
                "host": strip_tags(cells[4]),
                "url": strip_tags(cells[5]),
            }
        )
    return results


def parse_headers(lines: list[str]) -> tuple[list[tuple[str, str]], int]:
    headers = []
    index = 0
    for index, line in enumerate(lines):
        if line.strip() == "":
            return headers, index + 1
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers.append((name.strip(), value.strip()))
    return headers, len(lines)


def normalize_headers(headers: list[tuple[str, str]], is_response: bool) -> dict:
    normalized = {}
    for name, value in headers:
        lowered = name.lower()
        if lowered == "cookie":
            normalized[name] = redact_cookie_header(value)
            continue
        if lowered == "set-cookie":
            existing = normalized.get(name, [])
            existing.append(redact_set_cookie(value))
            normalized[name] = existing
            continue
        if is_sensitive_key(lowered):
            normalized[name] = redact_value(value)
            continue
        normalized[name] = value
    if is_response and "set-cookie" in {k.lower() for k in normalized.keys()}:
        for key in list(normalized.keys()):
            if key.lower() == "set-cookie" and not isinstance(normalized[key], list):
                normalized[key] = [normalized[key]]
    return normalized


def parse_request(text: str) -> dict | None:
    if not text:
        return None
    lines = text.splitlines()
    if not lines:
        return None
    request_line = lines[0].strip()
    parts = request_line.split()
    if len(parts) < 2:
        return None
    method = parts[0]
    url = redact_url(parts[1])
    headers, body_start = parse_headers(lines[1:])
    raw_body = "\n".join(lines[1 + body_start :]).strip()
    headers_dict = normalize_headers(headers, is_response=False)
    body = parse_body(raw_body, headers_dict.get("content-type") or headers_dict.get("Content-Type"))
    return {
        "method": method,
        "url": url,
        "headers": headers_dict,
        "body": body,
    }


def parse_response(text: str) -> dict | None:
    if not text:
        return None
    lines = text.splitlines()
    if not lines:
        return None
    status_line = lines[0].strip()
    status_code = None
    parts = status_line.split()
    if len(parts) >= 2 and parts[1].isdigit():
        status_code = int(parts[1])
    headers, body_start = parse_headers(lines[1:])
    raw_body = "\n".join(lines[1 + body_start :]).strip()
    headers_dict = normalize_headers(headers, is_response=True)
    body = parse_body(raw_body, headers_dict.get("content-type") or headers_dict.get("Content-Type"))
    return {
        "status": status_code,
        "headers": headers_dict,
        "body": body,
    }


def parse_body(raw_body: str, content_type: str | None) -> dict | str | None:
    if not raw_body:
        return None
    content_type = (content_type or "").lower()
    if "application/x-www-form-urlencoded" in content_type:
        pairs = urllib.parse.parse_qsl(raw_body, keep_blank_values=True)
        redacted = {}
        for key, value in pairs:
            if is_sensitive_key(key):
                redacted[key] = "<REDACTED>"
            else:
                redacted[key] = value
        return {"form": redacted}
    if "application/json" in content_type:
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            return {"text": redact_text(raw_body)}
        return {"json": redact_json(payload)}
    if len(raw_body) > 1024:
        return {"note": "body omitted", "length": len(raw_body)}
    return {"text": redact_text(raw_body)}


def redact_text(text: str) -> str:
    if not text:
        return text
    if any(token in text.lower() for token in SENSITIVE_KEY_SUBSTRINGS):
        return "<REDACTED>"
    return text


def redact_json(payload):
    if isinstance(payload, dict):
        return {
            key: ("<REDACTED>" if is_sensitive_key(key) else redact_json(value))
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [redact_json(value) for value in payload]
    return payload


def is_login_related(entry: dict) -> bool:
    host = (entry.get("host") or "").lower()
    url = (entry.get("url") or "").lower()
    if "accounts.spotify.com" in host or "accounts.spotify.com" in url:
        return True
    return any(part in url for part in ("/login", "/otc", "challenge"))


def build_login_flow(sessions: list[dict]) -> list[dict]:
    flow = []
    for session in sessions:
        request = session.get("request") or {}
        url = (request.get("url") or "").lower()
        method = (request.get("method") or "").upper()
        if "/login/password" in url and method == "POST":
            step = "submit_password"
        elif "/login/otc" in url:
            step = "otc_flow"
        elif "/login" in url and method == "GET":
            step = "load_login_page"
        elif "accounts.spotify.com" in url:
            step = "accounts_request"
        else:
            continue
        flow.append(
            {
                "session": session.get("session"),
                "step": step,
                "method": request.get("method"),
                "url": request.get("url"),
            }
        )
    return flow


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse a SAZ file and extract login flow.")
    parser.add_argument("--saz", default="singin.saz", help="Path to the SAZ capture.")
    parser.add_argument("--out", default="login_flow.json", help="Output JSON path.")
    parser.add_argument("--include-all", action="store_true", help="Include all sessions in output.")
    args = parser.parse_args()

    with zipfile.ZipFile(args.saz, "r") as zf:
        index_html = read_entry_text(zf, "_index.htm")
        if not index_html:
            raise SystemExit("Missing _index.htm in SAZ archive.")

        index_rows = parse_index(index_html)
        selected_rows = index_rows if args.include_all else [r for r in index_rows if is_login_related(r)]

        sessions = []
        for row in selected_rows:
            session_id = row["session"]
            request_text = read_entry_text(zf, f"raw/{session_id:03d}_c.txt")
            response_text = read_entry_text(zf, f"raw/{session_id:03d}_s.txt")
            sessions.append(
                {
                    **row,
                    "request": parse_request(request_text),
                    "response": parse_response(response_text),
                }
            )

    output = {
        "login_flow": build_login_flow(sessions),
        "sessions": sessions,
        "notes": [
            "Sensitive fields and cookies are redacted.",
            "Login flow often requires CSRF cookies and a recaptcha token.",
        ],
    }

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2, ensure_ascii=False)

    print(f"Wrote {args.out} with {len(sessions)} sessions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
