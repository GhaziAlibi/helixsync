import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as api from "../api/client";

interface AuthState {
  user: api.UserPublic | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Resolves to the new account's recovery code, to show once. */
  register: (email: string, password: string) => Promise<string>;
  /** One poll of a login-with-device request; signs in on approval. */
  pollDeviceLogin: (id: string, secret: string) => Promise<api.AuthRequestPoll>;
  logout: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  /** The user typed the current recovery code back and the server accepted it. */
  markRecoveryCodeConfirmed: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Fills in what login responses leave out (the recovery-code flag). A failure
 * keeps the signed-in user as is. */
async function refreshUser(setUser: (user: api.UserPublic) => void): Promise<void> {
  try {
    setUser(await api.me());
  } catch {
    // The flag stays unknown and no banner shows.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<api.UserPublic | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // There is no session-refresh endpoint that also returns a CSRF token
    // outside of login/register, so on a fresh page load we only know
    // "is there a valid session" via /auth/me; the CSRF token itself is
    // re-obtained by the double-submit cookie the browser already holds
    // (see api/client.ts — mutating requests still need the header to
    // match the cookie, so we read it back from document.cookie here).
    api
      .me()
      .then((u) => {
        setUser(u);
        const match = document.cookie.match(/helixsync_csrf=([^;]+)/);
        if (match) api.setCsrfToken(decodeURIComponent(match[1]));
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setUser(result.user);
    await refreshUser(setUser);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const result = await api.register(email, password);
    setUser({ ...result.user, recoveryCodeConfirmed: false });
    return result.recoveryCode;
  }, []);

  const pollDeviceLogin = useCallback(async (id: string, secret: string) => {
    const result = await api.pollAuthRequest(id, secret);
    if (result.status === "approved") {
      setUser(result.user);
      await refreshUser(setUser);
    }
    return result;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const deleteAccount = useCallback(async (password: string) => {
    await api.deleteAccount(password);
    setUser(null);
  }, []);

  const markRecoveryCodeConfirmed = useCallback(() => {
    setUser((u) => (u ? { ...u, recoveryCodeConfirmed: true } : u));
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, pollDeviceLogin, logout, deleteAccount, markRecoveryCodeConfirmed }),
    [user, loading, login, register, pollDeviceLogin, logout, deleteAccount, markRecoveryCodeConfirmed],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
