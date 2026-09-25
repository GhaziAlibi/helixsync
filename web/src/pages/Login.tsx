import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/context";
import { ApiError, getServerVersion } from "../api/client";
import { isInsecureRemoteHttp } from "../util/secure-context";

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const wantsRegister = searchParams.get("mode") === "register";
  const [mode, setMode] = useState<"login" | "register">(wantsRegister ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // null until the server has answered. A failed or old server that doesn't
  // report the flag counts as open: the server refuses a closed registration
  // itself, so this only decides what the page offers.
  const [registrationEnabled, setRegistrationEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getServerVersion()
      .then((version) => {
        if (!cancelled) setRegistrationEnabled(version.registrationEnabled !== false);
      })
      .catch(() => {
        if (!cancelled) setRegistrationEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const registrationClosed = registrationEnabled === false;
  const activeMode = registrationClosed ? "login" : mode;
  const insecureHttp = isInsecureRemoteHttp(window.location.protocol, window.location.hostname);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (activeMode === "register") {
      if (password !== confirmPassword) {
        setError("The passwords don't match.");
        return;
      }
      if (!understood) {
        setError("Please confirm that you understand your password can't be recovered.");
        return;
      }
    }
    setSubmitting(true);
    try {
      if (activeMode === "login") {
        await login(email, password);
      } else {
        await register(email, password);
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-xl font-semibold mb-1">HelixSync</h1>
        <p className="text-sm text-slate-500 mb-6">
          {activeMode === "login" ? "Sign in to your account" : "Create an account"}
        </p>
        {insecureHttp && (
          <div role="alert" className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-3 py-2 mb-4">
            <strong>This page is not using HTTPS.</strong> HelixSync's session cookies are marked{" "}
            <code>Secure</code>, so browsers won't keep you signed in over plain HTTP, and your sign-in would
            travel unencrypted. Serve HelixSync over HTTPS (see docs/deployment.md).
          </div>
        )}
        {registrationClosed && wantsRegister && (
          <div role="status" className="text-sm text-slate-700 bg-slate-100 border border-slate-200 rounded px-3 py-2 mb-4">
            This server has registration disabled, so new accounts can't be created here. Sign in with an existing
            account, or ask whoever runs this server.
          </div>
        )}
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              required
              minLength={activeMode === "register" ? 12 : undefined}
              autoComplete={activeMode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2"
            />
          </label>
          {activeMode === "register" && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                Confirm password
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2"
                />
              </label>
              <p className="text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                Your data is end-to-end encrypted with a key that comes from your password, on your own devices. The
                server never sees your password, so nobody, including whoever runs this server, can reset it or
                recover your data if you lose it.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  required
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                  className="mt-1"
                />
                <span>I understand that HelixSync can never recover my password or my data if I lose it.</span>
              </label>
            </>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
          >
            {activeMode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        {!registrationClosed && (
          <button
            className="mt-4 text-sm text-slate-500 underline"
            onClick={() => {
              setError(null);
              setMode(activeMode === "login" ? "register" : "login");
            }}
          >
            {activeMode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
          </button>
        )}
      </div>
    </div>
  );
}
