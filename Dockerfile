FROM python:3.11-slim

ARG WIREPROXY_VERSION=v1.1.2
ARG WGCF_VERSION=v2.2.30
ARG TARGETARCH

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxshmfence1 \
      libxtst6 \
      libatspi2.0-0 \
      libvulkan1 \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -r /app/requirements.txt \
    && python -m playwright install chromium

RUN set -euo pipefail; \
    arch="$TARGETARCH"; \
    if [ -z "$arch" ]; then arch="$(uname -m)"; fi; \
    case "$arch" in \
      amd64|x86_64) wire_arch="amd64"; wgcf_arch="amd64" ;; \
      arm64|aarch64) wire_arch="arm64"; wgcf_arch="arm64" ;; \
      *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/windtf/wireproxy/releases/download/${WIREPROXY_VERSION}/wireproxy_linux_${wire_arch}.tar.gz" \
      | tar -xz -C /usr/local/bin wireproxy; \
    wgcf_version_no_v="${WGCF_VERSION#v}"; \
    curl -fsSL "https://github.com/ViRb3/wgcf/releases/download/${WGCF_VERSION}/wgcf_${wgcf_version_no_v}_linux_${wgcf_arch}" \
      -o /usr/local/bin/wgcf; \
    chmod +x /usr/local/bin/wgcf

COPY scripts /app/scripts
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "/app/scripts/web_panel.py"]
