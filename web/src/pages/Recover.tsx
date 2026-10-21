import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, recoverAccount } from "../api/client";
import RecoveryCodeNotice from "../components/RecoveryCodeNotice";

/** "Forgot your password?": sets a new password with the recovery code
 * (docs/encryption.md §9.1). The account key, and so every synced item,
 * stays the same; the code is replaced by a new one, shown once. */
export default function Recover() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("The passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      setNewCode(await recoverAccount(email, code, password));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? "That email and recovery code don't match an account." : err.message);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm p-8">
        <h1 className="text-xl font-semibold mb-1">HelixSync</h1>
        {newCode ? (
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
            />
          </>
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-6">Reset your password with your recovery code</p>
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
                Recovery code
                <input
                  type="text"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="rounded border border-slate-300 px-3 py-2 font-mono"
                />
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
                disabled={submitting}
                className="rounded bg-slate-900 text-white py-2 text-sm font-medium disabled:opacity-50"
              >
                {submitting ? "Resetting…" : "Reset password"}
              </button>
            </form>
            <p className="mt-4 text-sm text-slate-500">
              Lost your recovery code too? Whoever runs this server can delete the account so you can register again;
              browsers that are still connected upload their bookmarks and history again when you reconnect them.
            </p>
            <Link to="/login" className="mt-4 inline-block text-sm text-slate-500 underline">
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
