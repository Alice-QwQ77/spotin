const statusText = document.getElementById("statusText");
const loggedInValue = document.getElementById("loggedInValue");
const lastCheckedValue = document.getElementById("lastCheckedValue");
const lastLoginValue = document.getElementById("lastLoginValue");
const lastResultValue = document.getElementById("lastResultValue");
const lastMessage = document.getElementById("lastMessage");
const loopValue = document.getElementById("loopValue");
const intervalValue = document.getElementById("intervalValue");
const retryValue = document.getElementById("retryValue");
const nextRunValue = document.getElementById("nextRunValue");
const headlessBadge = document.getElementById("headlessBadge");
const usernameBadge = document.getElementById("usernameBadge");
const cookieValue = document.getElementById("cookieValue");
const redisValue = document.getElementById("redisValue");
const busyValue = document.getElementById("busyValue");
const diagnosticsValue = document.getElementById("diagnosticsValue");
const loginNowBtn = document.getElementById("loginNowBtn");
const toggleLoopBtn = document.getElementById("toggleLoopBtn");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const localeInput = document.getElementById("localeInput");
const loginHintInput = document.getElementById("loginHintInput");
const continueUrlInput = document.getElementById("continueUrlInput");
const loginUrlInput = document.getElementById("loginUrlInput");
const intervalInput = document.getElementById("intervalInput");
const retryInput = document.getElementById("retryInput");
const headlessToggle = document.getElementById("headlessToggle");
const cookieTextInput = document.getElementById("cookieTextInput");
const cookieDomainInput = document.getElementById("cookieDomainInput");
const saveCookiesBtn = document.getElementById("saveCookiesBtn");

const formatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const formatTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatter.format(date);
};

const updateStatus = (data) => {
  const loggedIn = Boolean(data.logged_in);
  statusText.textContent = loggedIn ? "已登录" : "未登录";
  loggedInValue.textContent = loggedIn ? "正常" : "未登录";
  lastCheckedValue.textContent = formatTime(data.last_checked_at);
  lastLoginValue.textContent = formatTime(data.last_login_at);
  lastResultValue.textContent = data.last_login_result || "-";
  lastMessage.textContent = data.last_message || "暂无提示信息。";
  loopValue.textContent = data.loop_enabled ? "运行中" : "已暂停";
  intervalValue.textContent = `${data.interval_hours} 小时`;
  retryValue.textContent = `${data.retry_delay_seconds} 秒`;
  nextRunValue.textContent = formatTime(data.next_run_at);
  headlessBadge.textContent = data.headless ? "Headless" : "非无头";
  usernameBadge.textContent = data.username_set ? "用户名已配置" : "用户名未配置";
  cookieValue.textContent = data.cookie_file || "-";
  if (data.redis_enabled) {
    redisValue.textContent = `${data.redis_state_key || "-"} | ${
      data.redis_cookie_key || "-"
    }`;
  } else {
    redisValue.textContent = "未启用";
  }
  if (data.cookie_count !== null && data.cookie_count !== undefined) {
    cookieValue.textContent = `${cookieValue.textContent} (Redis: ${data.cookie_count} 个)`;
  }
  busyValue.textContent = data.busy ? "运行中" : "空闲";
  toggleLoopBtn.textContent = data.loop_enabled ? "暂停循环" : "恢复循环";
  loginNowBtn.disabled = data.busy;

  if (data.config) {
    localeInput.value = data.config.locale || "";
    loginHintInput.value = data.config.login_hint || "";
    continueUrlInput.value = data.config.continue_url || "";
    loginUrlInput.value = data.config.login_url || "";
  }
  intervalInput.value = data.interval_hours || "";
  retryInput.value = data.retry_delay_seconds || "";
  headlessToggle.checked = Boolean(data.headless);
};

const authorizedFetch = (url, options = {}) => {
  const headers = options.headers ? { ...options.headers } : {};
  return fetch(url, { ...options, headers });
};

const fetchStatus = async () => {
  const response = await authorizedFetch("/api/status");
  if (!response.ok) {
    statusText.textContent = "状态获取失败";
    return;
  }
  const data = await response.json();
  updateStatus(data);
};

loginNowBtn.addEventListener("click", async () => {
  loginNowBtn.disabled = true;
  const response = await authorizedFetch("/api/login-now", { method: "POST" });
  if (!response.ok) {
    statusText.textContent = "登录触发失败";
  }
  setTimeout(fetchStatus, 1200);
});

toggleLoopBtn.addEventListener("click", async () => {
  const response = await authorizedFetch("/api/loop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: toggleLoopBtn.textContent === "恢复循环" }),
  });
  if (!response.ok) {
    statusText.textContent = "操作失败";
  }
  setTimeout(fetchStatus, 800);
});

saveConfigBtn.addEventListener("click", async () => {
  const payload = {
    username: usernameInput.value.trim(),
    password: passwordInput.value.trim(),
    locale: localeInput.value.trim(),
    login_hint: loginHintInput.value.trim(),
    continue_url: continueUrlInput.value.trim(),
    login_url: loginUrlInput.value.trim(),
    interval_hours: Number(intervalInput.value || 0) || undefined,
    retry_delay_seconds: Number(retryInput.value || 0) || undefined,
    headless: headlessToggle.checked,
  };
  const response = await authorizedFetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    statusText.textContent = "配置保存失败";
  } else {
    statusText.textContent = "配置已保存";
  }
  setTimeout(fetchStatus, 800);
});

saveCookiesBtn.addEventListener("click", async () => {
  const payload = {
    cookie_text: cookieTextInput.value.trim(),
    domain: cookieDomainInput.value.trim(),
  };
  const response = await authorizedFetch("/api/cookies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    statusText.textContent = "Cookie 保存失败";
  } else {
    statusText.textContent = "Cookie 已保存";
  }
  setTimeout(fetchStatus, 800);
});

const boot = async () => {
  const authResponse = await authorizedFetch("/api/auth");
  if (!authResponse.ok) {
    statusText.textContent = "未登录，请先登录";
    return;
  }
  fetchStatus();
  fetchDiagnostics();
  setInterval(fetchStatus, 5000);
  setInterval(fetchDiagnostics, 15000);
};

boot();

const fetchDiagnostics = async () => {
  if (!diagnosticsValue) return;
  const response = await authorizedFetch("/api/diagnostics");
  if (!response.ok) {
    diagnosticsValue.textContent = "诊断失败";
    return;
  }
  const data = await response.json();
  const wireguardState = data.using_wireguard ? "已走 WireGuard" : "未走 WireGuard";
  diagnosticsValue.textContent = `${wireguardState} | 出口IP: ${data.proxy_ip || "-"}`;
};
