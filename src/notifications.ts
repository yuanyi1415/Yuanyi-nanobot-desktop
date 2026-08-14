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
// stream_end (one per tool call boundary). Only the first segment of a turn
// should raise a desktop notification, otherwise one reply spams N toasts.
// stream_id looks like "websocket:{chat_id}:{turn_ns}:{segment}"; the base
// (everything before the trailing numeric segment) identifies the turn.
const notifiedStreamBases = new Set<string>();
const NOTIFIED_BASE_LIMIT = 512;

function streamBaseId(streamId: unknown): string | null {
  if (typeof streamId !== "string") return null;
  const idx = streamId.lastIndexOf(":");
  if (idx <= 0) return null;
  return /^\d+$/.test(streamId.slice(idx + 1)) ? streamId.slice(0, idx) : null;
}

function claimTurnNotification(streamId: unknown): boolean {
  const base = streamBaseId(streamId);
  if (!base) return true; // unknown stream shape: keep notifying
  if (notifiedStreamBases.has(base)) return false;
  if (notifiedStreamBases.size >= NOTIFIED_BASE_LIMIT) {
    notifiedStreamBases.clear();
  }
  notifiedStreamBases.add(base);
  return true;
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
  const frame = parseWsMessageFrame(data);
  const notificationFrame = frame ? notificationFrameFromWsFrame(frame) : null;
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
  if (frame.event === "stream_end" && typeof frame.chat_id === "string") {
    const key = streamNotificationKey(frame);
    const text = typeof frame.text === "string"
      ? frame.text
      : streamTextBuffers.get(key) ?? "";
    streamTextBuffers.delete(key);
    if (text.trim().length === 0) return null;
    if (!claimTurnNotification(frame.stream_id)) {
      logNotify("skip (same turn already notified)");
      return null;
    }
    return { ...frame, chat_id: frame.chat_id, text };
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
