// REST client for the web dashboard. Uses cookie-based sessions
// (docs/security.md §1.1) with a double-submit CSRF token on mutating
// requests, unlike the extension, which uses device bearer tokens.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message ?? `request failed (${res.status})`, res.status, body.error);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface UserPublic {
  id: string;
  email: string;
}

export interface AuthResponse {
  user: UserPublic;
  csrfToken: string;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const result = await request<AuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setCsrfToken(result.csrfToken);
  return result;
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const result = await request<AuthResponse>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setCsrfToken(result.csrfToken);
  return result;
}

export async function logout(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
  csrfToken = null;
}

export async function me(): Promise<UserPublic> {
  return request("/api/v1/auth/me");
}

export interface DevicePublic {
  id: string;
  name: string;
  browser: string | null;
  browserVersion: string | null;
  platform: string | null;
  extensionVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export async function listDevices(): Promise<DevicePublic[]> {
  return request("/api/v1/devices");
}

export async function renameDevice(id: string, name: string): Promise<DevicePublic> {
  return request(`/api/v1/devices/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function revokeDevice(id: string): Promise<DevicePublic> {
  return request(`/api/v1/devices/${id}/revoke`, { method: "POST" });
}

export interface UserSettings {
  syncBookmarks: boolean;
  syncHistory: boolean;
  syncTabs: boolean;
  syncTabGroups: boolean;
  syncExtensions: boolean;
  tabRestorePolicy: "disabled" | "ask" | "automatic";
  historyRetention: "7d" | "30d" | "90d" | "1y" | "unlimited";
  requireEncryption: boolean;
}

export async function getSettings(): Promise<UserSettings> {
  return request("/api/v1/sync/settings");
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  return request("/api/v1/sync/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface ServerVersion {
  apiVersion: string;
  protocolVersion: number;
  minimumSupportedProtocolVersion: number;
}

export async function getServerVersion(): Promise<ServerVersion> {
  return request("/api/v1/version");
}

export interface SyncStats {
  bookmarks: number;
  historyVisits: number;
  tabs: number;
}

export async function getSyncStats(): Promise<SyncStats> {
  return request("/api/v1/sync/stats");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request("/api/v1/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export interface WebSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  current: boolean;
}

export async function listSessions(): Promise<WebSession[]> {
  return request("/api/v1/auth/sessions");
}

export async function revokeSession(id: string): Promise<void> {
  await request(`/api/v1/auth/sessions/${id}/revoke`, { method: "POST" });
}
