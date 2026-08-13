import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net as electronNet,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";

import { UnixWebSocketClient } from "./unixWebSocket.js";
import {
  clearDesktopNotificationBadge,
  handleDesktopNotificationFrame,
} from "./notifications.js";

type EngineStatus = "starting" | "ready" | "restarting" | "stopped" | "crashed";

// D1: the gateway is an external, launchd-managed service. The shell keeps
// only the fields it still needs; it never spawns or owns the engine.
type HostRuntime = {
  configPath: string;
  logsDir: string;
  secret: string;
  status: EngineStatus;
};

let runtime: HostRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
const hostSockets = new Map<string, UnixWebSocketClient>();
const APP_PROTOCOL = "nanobot-app:";
const APP_HOST = "app";
const HOST_SOCKET_PROTOCOL = "nanobot-host:";
const HOST_SOCKET_HOST = "engine";
const SAFE_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);
const GATEWAY_REQUEST_TIMEOUT_MS = 12_000;
const GATEWAY_REQUEST_RETRIES = 2;
const GATEWAY_RETRY_DELAY_MS = 80;
const OFFLINE_PAGE_PATH = "/__offline__";

// D2: the shell proxies to the local nanobot gateway over TCP (127.0.0.1:8765)
// instead of a private Unix socket. Overridable via env for future port moves.
const GATEWAY_HOST = process.env.NANOBOT_DESKTOP_GATEWAY_HOST?.trim() || "127.0.0.1";
const GATEWAY_PORT = Number(process.env.NANOBOT_DESKTOP_GATEWAY_PORT || 8765);

// D3: rewrite surface/capabilities to the native profile (mirrors
// nanobot/webui/settings_api.py native capabilities).
const NATIVE_RUNTIME_CAPABILITIES = {
  can_restart_engine: true,
  can_pick_folder: true,
  can_open_logs: true,
  can_export_diagnostics: true,
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "nanobot-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

function repoRoot(): string {
  return process.env.NANOBOT_DESKTOP_REPO_ROOT
    ? path.resolve(process.env.NANOBOT_DESKTOP_REPO_ROOT)
    : path.resolve(app.getAppPath(), "..");
}

function webDistPath(root: string): string {
  if (process.env.NANOBOT_DESKTOP_WEB_DIST) {
    return path.resolve(process.env.NANOBOT_DESKTOP_WEB_DIST);
  }
  const bundled = path.join(process.resourcesPath, "nanobot-webui");
  if (app.isPackaged && existsSync(path.join(bundled, "index.html"))) {
    return bundled;
  }
  return path.join(root, "nanobot", "web", "dist");
}

function webDevUrl(): string | null {
  const value = process.env.NANOBOT_DESKTOP_WEB_DEV_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

function isTrustedAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === APP_PROTOCOL && url.host === APP_HOST;
  } catch {
    return false;
  }
}

function isTrustedPermissionRequest(
  webContents: WebContents | null,
  details: unknown,
): boolean {
  return [
    permissionDetail(details, "requestingUrl"),
    permissionDetail(details, "securityOrigin"),
    webContents?.getURL(),
  ].some((url) => typeof url === "string" && isTrustedAppUrl(url));
}

function permissionDetail(details: unknown, key: string): unknown {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

function isAudioOnlyMediaRequest(details: unknown): boolean {
  const mediaTypes = permissionDetail(details, "mediaTypes");
  if (Array.isArray(mediaTypes)) {
    return mediaTypes.includes("audio") && !mediaTypes.includes("video");
  }
  return permissionDetail(details, "mediaType") === "audio";
}

async function requestNativeMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  return await systemPreferences.askForMediaAccess("microphone");
}

function registerPermissionHandlers(): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    permission === "media"
    && isTrustedPermissionRequest(webContents, details)
    && isAudioOnlyMediaRequest(details)
  ));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (
      permission !== "media"
      || !isTrustedPermissionRequest(webContents, details)
      || !isAudioOnlyMediaRequest(details)
    ) {
      callback(false);
      return;
    }
    void requestNativeMicrophoneAccess().then(callback, () => callback(false));
  });
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedAppUrl(frameUrl)) {
    throw new Error("Blocked host API call from an untrusted renderer");
  }
}

// Keep the nanobot-host://engine contract: the renderer (and preload.cts)
// stay unchanged; the shell maps every such URL onto the TCP gateway below.
function parseHostSocketUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string") {
    throw new Error("Host socket URL must be a string");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== HOST_SOCKET_PROTOCOL || url.host !== HOST_SOCKET_HOST) {
    throw new Error("Host socket URL is not allowed");
  }
  if (url.username || url.password) {
    throw new Error("Host socket URL credentials are not allowed");
  }
  return url.toString();
}

function openExternalIfSafe(rawUrl: string): void {
  try {
    const url = new URL(rawUrl);
    if (SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      void shell.openExternal(url.toString());
    }
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function desktopContentSecurityPolicy(devUrl: string | null): string {
  const connectSrc = ["'self'", "nanobot-host:"];
  if (devUrl) {
    const url = new URL(devUrl);
    connectSrc.push(url.origin, url.origin.replace(/^http/, "ws"));
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: nanobot-app:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc.join(" ")}`,
  ].join("; ");
}

function withSecurityHeaders(response: Response, devUrl: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", desktopContentSecurityPolicy(devUrl));
  headers.set("X-Content-Type-Options", "nosniff");
  if (devUrl) {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleHostIpc(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpc(event);
    return await handler(event, ...args);
  });
}

function userDataPath(name: string): string {
  return path.join(app.getPath("userData"), name);
}

// D5: read the gateway auth secret from the local nanobot config. The secret
// is used only for the local request header — never logged or committed.
function defaultConfigPath(): string {
  return path.join(os.homedir(), ".nanobot", "config.json");
}

function loadGatewaySecret(): string {
  try {
    const configPath = process.env.NANOBOT_DESKTOP_CONFIG
      ? path.resolve(process.env.NANOBOT_DESKTOP_CONFIG)
      : defaultConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const channels = (config.channels ?? {}) as Record<string, unknown>;
    const websocket = (channels.websocket ?? {}) as Record<string, unknown>;
    const secret = typeof websocket.tokenIssueSecret === "string"
      ? websocket.tokenIssueSecret
      : "";
    return secret.trim();
  } catch {
    return "";
  }
}

function notifyRuntimeStatus(status: EngineStatus): void {
  if (runtime) runtime.status = status;
  sendToRenderer(mainWindow?.webContents, "nanobot:runtime-status", status);
}

function sendToRenderer(
  sender: WebContents | null | undefined,
  channel: string,
  payload: unknown,
): void {
  if (!sender || sender.isDestroyed()) return;
  sender.send(channel, payload);
}

function closeHostSockets(): void {
  for (const [id, socket] of hostSockets) {
    socket.close();
    hostSockets.delete(id);
  }
}

async function fetchGateway(
  requestPath: string,
  init: {
    body?: ArrayBuffer;
    headers?: Headers | Record<string, string>;
    method: string;
  },
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GATEWAY_REQUEST_RETRIES; attempt += 1) {
    try {
      return await fetchGatewayOnce(requestPath, init);
    } catch (error) {
      lastError = error;
      if (!isTransientGatewayError(error) || attempt >= GATEWAY_REQUEST_RETRIES) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("gateway request failed");
}

async function fetchGatewayOnce(
  requestPath: string,
  init: {
    body?: ArrayBuffer;
    headers?: Headers | Record<string, string>;
    method: string;
  },
): Promise<Response> {
  const body = init.body ? Buffer.from(init.body) : undefined;
  const headers: http.OutgoingHttpHeaders = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } else {
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      headers[key] = value;
    }
  }
  if (body) headers["content-length"] = String(body.length);

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = http.request(
      {
        host: GATEWAY_HOST,
        port: GATEWAY_PORT,
        path: requestPath,
        method: init.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else if (value !== undefined) {
              responseHeaders.set(key, String(value));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.setTimeout(GATEWAY_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`gateway request timed out after ${GATEWAY_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", fail);
    if (body) req.write(body);
    req.end();
  });
}

function isTransientGatewayError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return message.includes("socket hang up") || message.includes("timed out");
}

// D6: probe the gateway on startup. Any HTTP response (including 401/403)
// means the service is up — auth failures surface in the WebUI login flow.
// Only a transport-level failure means "gateway not running".
async function gatewayIsUp(): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (runtime?.secret) headers["X-Nanobot-Auth"] = runtime.secret;
    await fetchGateway("/webui/bootstrap", { method: "GET", headers });
    return true;
  } catch {
    return false;
  }
}

// D3/D5: proxy every request to the local gateway, inject the auth header for
// bootstrap/settings, and rewrite surface/capabilities to the native profile.
async function proxyToGateway(request: Request): Promise<Response> {
  if (!runtime) {
    return new Response("Engine unavailable", { status: 503 });
  }
  const requestUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const isBootstrap = requestUrl.pathname === "/webui/bootstrap";
  const isSettingsRead = requestUrl.pathname === "/api/settings" && request.method === "GET";
  if ((isBootstrap || isSettingsRead) && runtime.secret) {
    headers.set("X-Nanobot-Auth", runtime.secret);
  }
  const init: {
    body?: ArrayBuffer;
    headers: Headers;
    method: string;
  } = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  let response: Response;
  try {
    response = await fetchGateway(
      `${requestUrl.pathname}${requestUrl.search}`,
      init,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gateway proxy request failed: ${message}`);
    return new Response("Engine unavailable", { status: 503 });
  }
  if (!response.ok || (!isBootstrap && !isSettingsRead)) {
    return response;
  }
  const body = await response.json() as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {
    ...body,
    runtime_surface: "native",
    runtime_capabilities: NATIVE_RUNTIME_CAPABILITIES,
  };
  if (isBootstrap) {
    // Keep the official contract: ws_url becomes nanobot-host://engine{path}.
    // A token issued by the gateway stays in body.token; the renderer appends
    // it to the URL query and the shell forwards path+query verbatim on the
    // WebSocket handshake.
    const wsPath = typeof body.ws_path === "string" ? body.ws_path : "/";
    const normalizedWsPath = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
    rewritten.ws_url = `nanobot-host://engine${normalizedWsPath}`;
  } else {
    // settings reads also carry a `surface` field consumed by the WebUI.
    rewritten.surface = "native";
  }
  return Response.json(rewritten);
}

function resolveStaticAsset(webDist: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const resolved = path.resolve(webDist, relativePath);
  if (resolved !== webDist && !resolved.startsWith(`${webDist}${path.sep}`)) {
    return null;
  }
  if (existsSync(resolved)) return resolved;
  if (!path.extname(relativePath)) return path.join(webDist, "index.html");
  return null;
}

function registerAppProtocol(webDist: string, devUrl: string | null): void {
  protocol.handle("nanobot-app", async (request) => {
    if (!isTrustedAppUrl(request.url)) {
      return new Response("Forbidden", { status: 403 });
    }
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === OFFLINE_PAGE_PATH) {
      // D6: retry flow — re-probe the gateway; serve the real WebUI once it
      // is back (hash routing + absolute asset paths make the /__offline__
      // URL harmless), otherwise stay on the offline notice page.
      if (await gatewayIsUp()) {
        if (devUrl) {
          const response = await electronNet.fetch(new URL("/", devUrl).toString());
          return withSecurityHeaders(response, devUrl);
        }
        const assetPath = path.join(webDist, "index.html");
        if (!existsSync(assetPath)) {
          return new Response("Not Found", { status: 404 });
        }
        const response = await electronNet.fetch(pathToFileURL(assetPath).toString());
        return withSecurityHeaders(response, devUrl);
      }
      return new Response(OFFLINE_PAGE_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": desktopContentSecurityPolicy(null),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (
      requestUrl.pathname === "/webui/bootstrap"
      || requestUrl.pathname.startsWith("/api/")
    ) {
      return proxyToGateway(request);
    }

    if (devUrl) {
      const upstream = new URL(
        `${requestUrl.pathname}${requestUrl.search}`,
        devUrl,
      );
      const response = await electronNet.fetch(upstream.toString());
      return withSecurityHeaders(response, devUrl);
    }

    const assetPath = resolveStaticAsset(webDist, request.url);
    if (!assetPath) {
      return new Response("Not Found", { status: 404 });
    }
    const response = await electronNet.fetch(pathToFileURL(assetPath).toString());
    return withSecurityHeaders(response, devUrl);
  });
}

function createWindow(): BrowserWindow {
  const preload = path.join(app.getAppPath(), "build", "preload.cjs");
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: "nanobot",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    // 不透明窗口：透明+毛玻璃在 Electron 中持续拉高 WindowServer/GPU 负载，是 UI 卡顿主因
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("focus", clearDesktopNotificationBadge);
  win.on("close", (event) => {
    if (process.platform !== "darwin" || isQuitting) return;
    event.preventDefault();
    // 全屏窗口不能直接 hide（会留下黑屏空间），先退出全屏再隐藏
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
    } else {
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) {
      event.preventDefault();
      openExternalIfSafe(url);
    }
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload failed: ${preloadPath}`, error);
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    closeHostSockets();
  });
  return win;
}

function runtimeInfo() {
  return {
    surface: "native" as const,
    app_version: app.getVersion(),
    engine_status: runtime?.status ?? "stopped",
    data_dir: app.getPath("userData"),
    logs_dir: runtime?.logsDir ?? userDataPath("logs"),
    config_path: runtime?.configPath ?? defaultConfigPath(),
    workspace_path: userDataPath("workspace"),
    python: "external",
  };
}

function registerIpcHandlers(): void {
  handleHostIpc("nanobot:get-runtime-info", () => runtimeInfo());
  handleHostIpc("nanobot:restart-engine", async () => {
    // D1: the gateway is an external launchd-managed service; the shell does
    // not own engine lifecycle. No-op keeps the WebUI native restart button
    // from surfacing an IPC error.
    console.warn("[nanobot] restart-engine is a no-op: gateway is managed outside the shell");
  });
  handleHostIpc("nanobot:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return path.resolve(result.filePaths[0]);
  });
  handleHostIpc("nanobot:open-logs", async () => {
    const logsDir = runtime?.logsDir ?? userDataPath("logs");
    await mkdir(logsDir, { recursive: true });
    const error = await shell.openPath(logsDir);
    if (error) throw new Error(error);
  });
  handleHostIpc("nanobot:export-diagnostics", async () => {
    const diagnosticsPath = path.join(
      app.getPath("temp"),
      `nanobot-diagnostics-${Date.now()}.json`,
    );
    await writeFile(
      diagnosticsPath,
      JSON.stringify(runtimeInfo(), null, 2),
      "utf8",
    );
    shell.showItemInFolder(diagnosticsPath);
    return diagnosticsPath;
  });
  handleHostIpc("nanobot:open-file", async (_event, rawPath) => {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new Error("Invalid open-file argument");
    }
    try {
      const error = await shell.openPath(rawPath);
      return error ? { ok: false, error } : { ok: true };
    } catch (e) {
      // Windows 无关联应用时 openPath 可能 reject（ELECTRON-C7 坑）；
      // macOS 一般返回空字符串表示成功。
      return { ok: false, error: String(e) };
    }
  });
  handleHostIpc("nanobot:check-for-updates", () => ({
    supported: false,
    message: "Auto update is not configured for this build.",
  }));
  handleHostIpc("nanobot:ws-connect", (event, rawUrl) => {
    const url = parseHostSocketUrl(rawUrl);
    const id = randomBytes(12).toString("hex");
    const client = new UnixWebSocketClient(url, {
      onOpen: () => sendToRenderer(event.sender, "nanobot:ws-event", { id, type: "open" }),
      onMessage: (data) => {
        handleDesktopNotificationFrame(data, { getWindow: () => mainWindow });
        sendToRenderer(event.sender, "nanobot:ws-event", { id, type: "message", data });
      },
      onError: (message) => sendToRenderer(event.sender, "nanobot:ws-event", { id, type: "error", message }),
      onClose: (code, reason) => {
        hostSockets.delete(id);
        sendToRenderer(event.sender, "nanobot:ws-event", { id, type: "close", code, reason });
      },
    });
    hostSockets.set(id, client);
    client.connect();
    event.sender.once("destroyed", () => {
      client.close();
      hostSockets.delete(id);
    });
    return id;
  });
  handleHostIpc("nanobot:ws-send", (_event, id, data) => {
    if (typeof id !== "string" || typeof data !== "string") {
      throw new Error("Invalid host socket send arguments");
    }
    const socket = hostSockets.get(id);
    if (!socket) throw new Error("Host socket not found");
    socket.send(data);
  });
  handleHostIpc("nanobot:ws-close", (_event, id) => {
    if (typeof id !== "string") {
      throw new Error("Invalid host socket close argument");
    }
    hostSockets.get(id)?.close();
    hostSockets.delete(id);
  });
}

async function loadAppWindow(win: BrowserWindow): Promise<void> {
  // D6: never manages the engine — probe the gateway and load the offline
  // notice page when it is not running.
  if (await gatewayIsUp()) {
    console.log("[nanobot] gateway is up; loading WebUI");
    await win.loadURL("nanobot-app://app/index.html");
  } else {
    console.warn("[nanobot] gateway is not running; showing offline page");
    await win.loadURL(`nanobot-app://app${OFFLINE_PAGE_PATH}`);
  }
}

app.whenReady().then(async () => {
  const root = repoRoot();
  const webDist = webDistPath(root);
  const devUrl = webDevUrl();
  if (!devUrl && !existsSync(path.join(webDist, "index.html"))) {
    throw new Error(`WebUI dist not found at ${webDist}. Run npm run build:webui first.`);
  }
  if (devUrl) {
    await session.defaultSession.clearCache();
  }

  runtime = {
    configPath: defaultConfigPath(),
    logsDir: userDataPath("logs"),
    secret: loadGatewaySecret(),
    status: "ready",
  };

  // macOS dock icon: development builds use build/icon.png; packaged builds
  // get the .icns via electron-builder (build.mac.icon).
  if (process.platform === "darwin") {
    const dockIconPath = path.join(app.getAppPath(), "build", "icon.png");
    if (existsSync(dockIconPath)) {
      app.dock?.setIcon(dockIconPath);
    }
  }

  registerIpcHandlers();
  registerPermissionHandlers();
  registerAppProtocol(webDist, devUrl);

  mainWindow = createWindow();
  await loadAppWindow(mainWindow);

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      void loadAppWindow(mainWindow);
    }
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // D1: nothing to stop — the external gateway keeps running.
  isQuitting = true;
  closeHostSockets();
});

// D6: simple embedded notice page shown when the gateway is not running.
// Pure HTML + CSS (CSP forbids inline scripts); the retry link re-enters the
// protocol handler, which re-probes the gateway.
const OFFLINE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nanobot</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
    background: transparent;
    color: #333;
  }
  .card {
    max-width: 420px;
    padding: 40px 36px;
    text-align: center;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
  }
  .status-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #e5484d;
    margin-right: 8px;
    vertical-align: middle;
  }
  h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 10px;
  }
  p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 24px;
    color: #555;
  }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    background: rgba(0, 0, 0, 0.06);
    padding: 2px 6px;
    border-radius: 5px;
  }
  .retry {
    display: inline-block;
    padding: 10px 26px;
    font-size: 14px;
    font-weight: 500;
    color: #fff;
    background: #2563eb;
    border-radius: 8px;
    text-decoration: none;
  }
  .retry:hover { background: #1d4ed8; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; }
    .card { background: rgba(30, 30, 30, 0.85); border-color: rgba(255, 255, 255, 0.1); }
    p { color: #a3a3a3; }
    code { background: rgba(255, 255, 255, 0.1); }
  }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="status-dot"></span>gateway 未启动</h1>
    <p>请确认 nanobot gateway 正在运行<br>（launchd 服务 <code>ai.nanobot.gateway</code>）。</p>
    <a class="retry" href="nanobot-app://app/__offline__">重试</a>
  </div>
</body>
</html>
`;
