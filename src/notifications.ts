import {
  app,
  BrowserWindow,
  Notification,
} from "electron";
import { appendFileSync } from "node:fs";
import path from "node:path";

type NotificationSource = {
  kind?: unknown;
  label?: unknown;
};

type WsMessageFrame = {
  chat_id?: unknown;
  event?: unknown;
  kind?: unknown;
  source?: NotificationSource;
  stream_id?: unknown;
  text?: unknown;
};

interface DesktopNotifierOptions {
  getWindow: () => BrowserWindow | null;
}

const MAX_NOTIFICATION_BODY_LENGTH = 180;
const MAX_NOTIFICATION_TITLE_LENGTH = 80;

let unreadNotificationCount = 0;
const streamTextBuffers = new Map<string, string>();

// Keep a reference to every live notification. On macOS a Notification whose JS
// object has been garbage-collected keeps showing in Notification Center, but its
// click handler is gone — clicking it then does nothing. We hold the object until
// it is clicked, closed, or fails (2026-08-14 fix).
const activeNotifications = new Set<Notification>();

// A single agent turn streams several text segments, each ending with its own
// stream_end (one per tool call boundary). Only the final segment of a turn is
// the real answer, so we defer notifications: cache the latest segment text per
// chat, then fire exactly one toast when turn_end arrives (or after a timeout
// in case the turn never completes cleanly). 2026-08-14.
const pendingTurnTexts = new Map<string, string>();
const pendingTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TURN_FLUSH_TIMEOUT_MS = 15_000;
const PENDING_CHAT_LIMIT = 128;

function deferTurnNotification(chatId: string, text: string): void {
  if (pendingTurnTexts.size >= PENDING_CHAT_LIMIT && !pendingTurnTexts.has(chatId)) {
    pendingTurnTexts.clear();
    for (const timer of pendingTurnTimers.values()) clearTimeout(timer);
    pendingTurnTimers.clear();
  }
  pendingTurnTexts.set(chatId, text);
  const existing = pendingTurnTimers.get(chatId);
  if (existing) clearTimeout(existing);
  pendingTurnTimers.set(
    chatId,
    setTimeout(() => flushDeferredNotification(chatId), TURN_FLUSH_TIMEOUT_MS),
  );
}

function flushDeferredNotification(chatId: string): void {
  const timer = pendingTurnTimers.get(chatId);
  if (timer) clearTimeout(timer);
  pendingTurnTimers.delete(chatId);
  const text = pendingTurnTexts.get(chatId);
  pendingTurnTexts.delete(chatId);
  const notificationFrame = text && text.trim().length > 0
    ? { chat_id: chatId, text }
    : null;
  if (!notificationFrame) return;
  if (!shouldNotify(getWindowRef())) return;
  logNotify(`show title=沫沫`);
  showDesktopNotification(notificationFrame, { getWindow: getWindowRef });
}

let getWindowRef: () => BrowserWindow | null = () => null;
function setWindowGetter(fn: () => BrowserWindow | null): void {
  getWindowRef = fn;
}

// Minimal debug log for notification diagnosis (2026-08-14). Written to the app
// user-data dir; safe to remove once notification delivery is stable.
const notifyLogPath = (): string => path.join(app.getPath("userData"), "notify-debug.log");

function logNotify(message: string): void {
  try {
    appendFileSync(notifyLogPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break notification flow
  }
}

export function handleDesktopNotificationFrame(
  data: string,
  options: DesktopNotifierOptions,
): void {
  setWindowGetter(options.getWindow);
  const frame = parseWsMessageFrame(data);
  if (!frame) return;
  if (frame.event === "stream_end" && typeof frame.chat_id === "string") {
    const key = streamNotificationKey(frame);
    const text = typeof frame.text === "string"
      ? frame.text
      : streamTextBuffers.get(key) ?? "";
    streamTextBuffers.delete(key);
    if (text.trim().length > 0) {
      deferTurnNotification(frame.chat_id, text);
    }
    return;
  }
  if (frame.event === "turn_end" && typeof frame.chat_id === "string") {
    flushDeferredNotification(frame.chat_id);
    return;
  }
  const notificationFrame = notificationFrameFromWsFrame(frame);
  if (!notificationFrame) return;
  if (!shouldNotify(options.getWindow())) return;
  logNotify(`show title=${notificationTitle(frame?.source)}`);
  showDesktopNotification(notificationFrame, options);
}

export function clearDesktopNotificationBadge(): void {
  unreadNotificationCount = 0;
  app.setBadgeCount(0);
}

function parseWsMessageFrame(data: string): WsMessageFrame | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as WsMessageFrame
      : null;
  } catch {
    return null;
  }
}

function isAssistantNotificationFrame(frame: WsMessageFrame): frame is WsMessageFrame & {
  chat_id: string;
  text: string;
} {
  return (
    frame.event === "message" &&
    typeof frame.chat_id === "string" &&
    typeof frame.text === "string" &&
    frame.text.trim().length > 0 &&
    frame.kind !== "tool_hint" &&
    frame.kind !== "progress" &&
    frame.kind !== "reasoning"
  );
}

function notificationFrameFromWsFrame(frame: WsMessageFrame): WsMessageFrame & {
  chat_id: string;
  text: string;
} | null {
  if (isAssistantNotificationFrame(frame)) return frame;
  if (frame.event === "delta") {
    if (typeof frame.chat_id === "string" && typeof frame.text === "string") {
      const key = streamNotificationKey(frame);
      streamTextBuffers.set(key, `${streamTextBuffers.get(key) ?? ""}${frame.text}`);
    }
    return null;
  }
  return null;
}

function streamNotificationKey(frame: WsMessageFrame): string {
  const streamId = typeof frame.stream_id === "string" ? frame.stream_id : "";
  return `${frame.chat_id ?? ""}\u0000${streamId}`;
}

function shouldNotify(win: BrowserWindow | null): boolean {
  if (!Notification.isSupported()) return false;
  if (!win || win.isDestroyed()) return false;
  return !win.isFocused();
}

function showDesktopNotification(
  frame: WsMessageFrame & { chat_id: string; text: string },
  options: DesktopNotifierOptions,
): void {
  const notification = new Notification({
    title: notificationTitle(frame.source),
    body: notificationBody(frame.text),
  });
  activeNotifications.add(notification);
  const release = () => {
    activeNotifications.delete(notification);
  };
  notification.on("failed", (_event, error) => {
    logNotify(`failed: ${String(error)}`);
    console.warn(`[nanobot] Desktop notification failed: ${error}`);
    release();
  });
  notification.on("show", () => logNotify("shown"));
  notification.on("close", release);
  notification.on("click", () => {
    release();
    logNotify("clicked");
    openChatFromNotification(frame.chat_id, options);
  });
  notification.show();
  unreadNotificationCount += 1;
  app.setBadgeCount(unreadNotificationCount);
}

function notificationTitle(source: NotificationSource | undefined): string {
  if (source?.kind === "cron" && typeof source.label === "string") {
    const label = source.label.trim();
    if (label) return truncateText(label, MAX_NOTIFICATION_TITLE_LENGTH);
  }
  return "沫沫";
}

function notificationBody(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return truncateText(compact, MAX_NOTIFICATION_BODY_LENGTH);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function openChatFromNotification(chatId: string, options: DesktopNotifierOptions): void {
  const win = options.getWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  clearDesktopNotificationBadge();

  const sessionKey = `websocket:${chatId}`;
  const hash = `#/chat/${encodeURIComponent(sessionKey)}`;
  void win.webContents.executeJavaScript(
    `window.location.hash = ${JSON.stringify(hash)}`,
    true,
  ).catch(() => {});
}
