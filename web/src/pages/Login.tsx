import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "../auth/context";
import { ApiError, createAuthRequest, getServerVersion } from "../api/client";
import { authRequestFingerprint, generateAuthRequestPublicKey } from "../crypto";
import RecoveryCodeNotice from "../components/RecoveryCodeNotice";
import { isInsecureRemoteHttp } from "../util/secure-context";
import LanguageSelect from "../components/LanguageSelect";
import { errorText } from "../i18n/errors";

/** How often a waiting login-with-device request is checked. */
const DEVICE_LOGIN_POLL_MS = 3000;

interface DeviceLogin {
  id: string;
  secret: string;
  fingerprint: string;
  expiresAt: string;
}

export default function Login() {
  const { login, register, pollDeviceLogin } = useAuth();
  const { t } = useTranslation();
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
  // Set right after registering: the code is shown before entering the app.
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<DeviceLogin | null>(null);
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

  useEffect(() => {
    if (!deviceLogin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await pollDeviceLogin(deviceLogin.id, deviceLogin.secret);
        if (cancelled) return;
        if (result.status === "approved") {
          navigate("/", { replace: true });
          return;
        }
        if (result.status === "denied") {
          setDeviceLogin(null);
          setError(t("login.deviceDenied"));
          return;
        }
        if (result.status === "expired") {
          setDeviceLogin(null);
          setError(t("login.deviceExpired"));
          return;
        }
      } catch {
        // A network blip or a rate limit: keep waiting until it expires.
        if (cancelled) return;
      }
      if (Date.now() >= Date.parse(deviceLogin.expiresAt)) {
        setDeviceLogin(null);
        setError(t("login.deviceExpired"));
        return;
      }
      timer = setTimeout(tick, DEVICE_LOGIN_POLL_MS);
    };
    timer = setTimeout(tick, DEVICE_LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deviceLogin, pollDeviceLogin, navigate, t]);

  const registrationClosed = registrationEnabled === false;
  const activeMode = registrationClosed ? "login" : mode;
  const insecureHttp = isInsecureRemoteHttp(window.location.protocol, window.location.hostname);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (activeMode === "register") {
      if (password !== confirmPassword) {
        setError(t("login.passwordsMismatch"));
        return;
      }
      if (!understood) {
        setError(t("login.understandRequired"));
        return;
      }
    }
    setSubmitting(true);
    try {
      if (activeMode === "login") {
        await login(email, password);
        navigate("/", { replace: true });
      } else {
        setRecoveryCode(await register(email, password));
      }
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t("errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  async function startDeviceLogin() {
    setError(null);
    if (!email.includes("@")) {
      setError(t("login.enterEmailFirst"));
      return;
    }
    setSubmitting(true);
    try {
      const publicKey = await generateAuthRequestPublicKey();
      const created = await createAuthRequest(email, publicKey);
      setDeviceLogin({ ...created, fingerprint: await authRequestFingerprint(publicKey) });
    } catch (err) {
      setError(err instanceof ApiError ? errorText(err) : t("errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  if (recoveryCode) {
    return (
      <LoginCard subtitle={t("login.subtitleSaveCode")}>
        <RecoveryCodeNotice
          code={recoveryCode}
          email={email}
          continueLabel={t("login.continue")}
          onContinue={() => navigate("/", { replace: true })}
        />
      </LoginCard>
    );
  }

  if (deviceLogin) {
    return (
      <LoginCard subtitle={t("login.subtitleDevice")}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-700">
            {t("login.deviceIntro")}
          </p>
          <code className="block text-center font-mono text-lg tracking-wider bg-slate-100 border border-slate-200 rounded px-3 py-3">
            {deviceLogin.fingerprint}
          </code>
          <p className="text-sm text-slate-500">{t("login.deviceWaiting")}</p>
          <button
            type="button"
            onClick={() => setDeviceLogin(null)}
            className="rounded border border-slate-300 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
        </div>
      </LoginCard>
    );
  }

  return (
    <LoginCard subtitle={activeMode === "login" ? t("login.subtitleLogin") : t("login.subtitleRegister")}>
      {insecureHttp && (
        <div role="alert" className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-3 py-2 mb-4">
          <Trans i18nKey="login.insecureHttp" components={{ strong: <strong />, code: <code /> }} />
        </div>
      )}
      {registrationClosed && wantsRegister && (
        <div role="status" className="text-sm text-slate-700 bg-slate-100 border border-slate-200 rounded px-3 py-2 mb-4">
          {t("login.registrationClosed")}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {t("login.email")}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t("login.password")}
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
              {t("login.confirmPassword")}
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
              {t("login.registerWarning")}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                required
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                className="mt-1"
              />
              <span>{t("login.understood")}</span>
            </label>
          </>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
        >
          {activeMode === "login" ? t("login.signIn") : t("login.createAccount")}
        </button>
      </form>
      {activeMode === "login" && (
        <div className="mt-4 flex flex-col items-start gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={startDeviceLogin}
            className="text-sm text-slate-500 underline disabled:opacity-50"
          >
            {t("login.logInWithDevice")}
          </button>
          <Link to="/recover" className="text-sm text-slate-500 underline">
            {t("login.forgot")}
          </Link>
        </div>
      )}
      {!registrationClosed && (
        <button
          className="mt-4 text-sm text-slate-500 underline"
          onClick={() => {
            setError(null);
            setMode(activeMode === "login" ? "register" : "login");
          }}
        >
          {activeMode === "login" ? t("login.needAccount") : t("login.haveAccount")}
        </button>
      )}
    </LoginCard>
  );
}

function LoginCard({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm p-8">
        <h1 className="text-xl font-semibold mb-1">HelixSync</h1>
        <p className="text-sm text-slate-500 mb-6">{subtitle}</p>
        {children}
      </div>
      <LanguageSelect />
    </div>
  );
}
