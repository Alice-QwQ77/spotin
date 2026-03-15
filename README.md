# Spotify Login Keeper

这是一个用于定期刷新 Spotify 登录状态的服务，支持 Web 面板管理、Redis 持久化、无头浏览器登录，以及用户态 WireGuard 代理方案。

## 纯用户态 WireGuard 代理方案

本项目只使用 `wireproxy` 在用户态建立 WireGuard 会话并暴露本地代理，不创建系统网卡，不修改路由表，不依赖 `NET_ADMIN`、`/dev/net/tun` 或任何特权容器能力，适用于 Render 等不支持特权网络的容器平台。

重要说明：
- 不使用 `warp-cli`、`warp-svc`、`wg-quick` 等方案
- 不引入任何需要特权容器的方案
- 只保留 `wireproxy`，不做多代理后端或回退逻辑

### 启动流程

容器入口脚本 `entrypoint.sh` 负责全部初始化逻辑：
1. 选择配置来源并生成 `wireproxy.conf`
2. 校验配置
3. 启动 wireproxy（默认监听 `127.0.0.1`）
4. 设置 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等环境变量

### 配置来源优先级

1. `WIREPROXY_CONFIG`（完整 wireproxy.conf 内容）
2. `WIREPROXY_CONFIG_PATH`（挂载 wireproxy.conf 文件）
3. `WIREGUARD_CONFIG`（完整 WireGuard 配置内容）
4. `WIREGUARD_CONFIG_PATH`（挂载 WireGuard 配置文件）
5. WireGuard 必要字段（`WIREGUARD_PRIVATE_KEY` 等）
6. 可选自动生成 WARP 配置（`WGCF_AUTO=1`）

### 关键环境变量

通用：
- `WIREPROXY_ENABLED=1` 是否启用 wireproxy
- `WIREPROXY_MODE=socks5` 代理模式（`socks5` 或 `http`）
- `WIREPROXY_LISTEN_HOST=127.0.0.1`
- `WIREPROXY_LISTEN_PORT=1080`
- `WIREPROXY_INFO_HOST=127.0.0.1`
- `WIREPROXY_INFO_PORT=9080`
- `WIREPROXY_CONFIG_PATH=/data/wireproxy.conf`
- `WIREPROXY_CONFIG` 直接提供完整配置

WireGuard 字段：
- `WIREGUARD_PRIVATE_KEY`
- `WIREGUARD_ADDRESS`（建议 `/32`）
- `WIREGUARD_DNS`（可选）
- `WIREGUARD_PUBLIC_KEY`
- `WIREGUARD_PRESHARED_KEY`（可选）
- `WIREGUARD_ENDPOINT`（host:port）
- `WIREGUARD_ALLOWED_IPS=0.0.0.0/0`
- `WIREGUARD_PERSISTENT_KEEPALIVE`（可选）
- `WIREGUARD_CONFIG_PATH=/data/wireguard.conf`
- `WIREGUARD_CONFIG` 直接提供完整 WireGuard 配置

自动生成 WARP：
- `WGCF_AUTO=1`
- `WGCF_DIR=/data/wgcf`

### 健康与诊断

Web 面板提供 `/api/diagnostics`，用于检测：
- 服务是否存活
- 当前出口 IP
- 是否已经走 WireGuard 代理

该接口需要通过面板口令认证（`PANEL_TOKEN`），可用 `X-Panel-Token` 或 `Authorization: Bearer` 方式访问。

## 运行方式（Docker）

```bash
docker run -d -p 8080:8080 \
  -e PANEL_TOKEN="your_token" \
  -e REDIS_URL="redis://:password@redis:6379/0" \
  -e WIREPROXY_MODE="socks5" \
  -e WIREGUARD_PRIVATE_KEY="..." \
  -e WIREGUARD_ADDRESS="10.0.0.2/32" \
  -e WIREGUARD_PUBLIC_KEY="..." \
  -e WIREGUARD_ENDPOINT="example.com:51820" \
  -v /data:/data \
  ghcr.io/<owner>/<repo>:latest
```

如果你没有 WireGuard 配置，也可以使用自动 WARP：

```bash
docker run -d -p 8080:8080 \
  -e PANEL_TOKEN="your_token" \
  -e REDIS_URL="redis://:password@redis:6379/0" \
  -e WGCF_AUTO=1 \
  -v /data:/data \
  ghcr.io/<owner>/<repo>:latest
```

## 说明

本方案是纯用户态 WireGuard 代理，不需要任何额外系统权限。所有外部请求默认通过 `wireproxy` 代理发起（Web 诊断中的出口 IP 测试除外）。
