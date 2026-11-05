import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  accountKeyFromReset,
  ApiError,
  completeReset,
  createResetRequest,
  pollResetRequest,
  type AuthRequestCreated,
} from "../api/client";
import { accountKeyCheckPhrase, authRequestFingerprint, generateResetKeyPair, type ResetKeyPair } from "../crypto";
import RecoveryCodeNotice from "../components/RecoveryCodeNotice";

const POLL_MS = 3000;

interface Waiting extends AuthRequestCreated {
  fingerprint: string;
  keyPair: ResetKeyPair;
}

interface Approved {
  request: Waiting;
  accountKey: Uint8Array;
  checkPhrase: string;
}

/** "Forgot your password?" without the recovery code, when two of the
 * account's browsers are still connected (docs/encryption.md §9.4). Two
 * different extensions must approve; the second hands over the account key,
 * encrypted to this page, so the new password keeps all synced data. */
export default function ResetWithDevices() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [approved, setApproved] = useState<Approved | null>(null);
  const [phraseMatches, setPhraseMatches] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newCode, setNewCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await pollResetRequest(waiting.id, waiting.secret);
        if (cancelled) return;
        if (result.status === "approved") {
          const accountKey = await accountKeyFromReset(waiting.keyPair.privateKey, waiting.id, result);
          if (cancelled) return;
          setApproved({ request: waiting, accountKey, checkPhrase: await accountKeyCheckPhrase(accountKey) });
          setWaiting(null);
          return;
        }
        if (result.status === "denied" || result.status === "expired") {
          setWaiting(null);
          setError(
            result.status === "denied"
              ? "The reset request was denied."
              : "The reset request expired. Start a new one.",
          );
          return;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && !(err instanceof ApiError)) {
          // The approval didn't decrypt: not for this page.
          setWaiting(null);
          setError("The approval couldn't be read. Start a new request.");
          return;
        }
        // A network blip or a rate limit: keep waiting until it expires.
      }
      if (Date.now() >= Date.parse(waiting.expiresAt)) {
        setWaiting(null);
        setError("The reset request expired. Start a new one.");
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting]);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const keyPair = await generateResetKeyPair();
      const created = await createResetRequest(email, keyPair.publicKey);
      setWaiting({ ...created, keyPair, fingerprint: await authRequestFingerprint(keyPair.publicKey) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (!approved) return;
    setError(null);
    if (password !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const { request, accountKey } = approved;
      setNewCode(await completeReset(request.id, request.secret, accountKey, password));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "This reset is no longer valid. Start a new request."
          : err instanceof Error
            ? err.message
            : "Something went wrong",
      );
    } finally {
      setSubmitting(false);
    }
  }

  let body;
  if (newCode) {
    body = (
      <>
        <p className="text-sm text-slate-500 mb-6">Your password was reset</p>
        <p className="text-sm text-slate-700 mb-4">
          Your old recovery code no longer works. Every browser session was signed out; connected extensions keep
          syncing.
        </p>
        <RecoveryCodeNotice
          code={newCode}
          email={email}
          continueLabel="Sign in"
          onContinue={() => navigate("/login", { replace: true })}
          confirmOnServer={false}
        />
      </>
    );
  } else if (approved) {
    body = (
      <form onSubmit={finish} className="flex flex-col gap-4">
        <p className="text-sm text-slate-500">Two of your browsers approved</p>
        <p className="text-sm text-slate-700">
          The second browser shows a key check phrase. Continue only if it is exactly this one:
        </p>
        <code className="block text-center font-mono text-lg tracking-wider bg-slate-100 border border-slate-200 rounded px-3 py-3">
          {approved.checkPhrase}
        </code>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={phraseMatches}
            onChange={(e) => setPhraseMatches(e.target.checked)}
            className="mt-1"
          />
          <span>The phrase matches the one in the extension.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm new password
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!phraseMatches || submitting}
          className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
        >
          {submitting ? "Resetting…" : "Reset password"}
        </button>
      </form>
    );
  } else if (waiting) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-700">
          Open the HelixSync extension in <strong>two different browsers</strong> that are connected to this account.
          Each one shows a <strong>password reset</strong> request: approve it in both, but only if it shows this exact
          phrase:
        </p>
        <code className="block text-center font-mono text-lg tracking-wider bg-slate-100 border border-slate-200 rounded px-3 py-3">
          {waiting.fingerprint}
        </code>
        <p className="text-sm text-slate-500">Waiting for two approvals…</p>
        <button type="button" onClick={() => setWaiting(null)} className="rounded border border-slate-300 py-2 text-sm">
          Cancel
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <p className="text-sm text-slate-500 mb-6">Reset your password with two of your browsers</p>
        <form onSubmit={start} className="flex flex-col gap-4">
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
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "Starting…" : "Ask my browsers"}
          </button>
        </form>
        <p className="mt-4 text-sm text-slate-500">
          This needs at least two browsers with the HelixSync extension already connected to your account. Your synced
          data stays readable.
        </p>
        <Link to="/recover" className="mt-4 inline-block text-sm text-slate-500 underline">
          Use my recovery code instead
        </Link>
      </>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm p-8">
        <h1 className="text-xl font-semibold mb-1">HelixSync</h1>
        {body}
      </div>
    </div>
  );
}
