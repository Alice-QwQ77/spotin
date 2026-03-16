# spotify-autosignin

Spotify session refresh service built with Node.js, Playwright, Redis, and a small web panel.

## Features

- Redis-backed cookie and status storage
- Local screenshot artifacts for failed login attempts
- Web panel for status checks, cookie import, manual login, and immediate refresh
- Automatic random session refresh 2 to 3 times per day inside the container

## Environment

- `REDIS_URL`: Redis connection string
- `PANEL_TOKEN`: optional web panel access token
- `PORT`: web panel port, default `8080`
- `AUTO_REFRESH_ENABLED`: enable random scheduled refresh, default `1`
- `AUTO_REFRESH_MIN_PER_DAY`: minimum scheduled refresh count, default `2`
- `AUTO_REFRESH_MAX_PER_DAY`: maximum scheduled refresh count, default `3`

## Run locally

```bash
npm install
npm run panel
```

## Run with Docker

```bash
docker build -t spotify-autosignin .
docker run --rm -p 8080:8080 -e REDIS_URL=redis://host:6379 -e PANEL_TOKEN=your-token -v /your/screenshots:/data spotify-autosignin
```
