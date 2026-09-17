"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Development sign-in. Production replaces this with Supabase auth; the
 * route behind it only resolves synthetic seed users and is disabled when
 * BILLFIGHTER_ENABLE_DEV_LOGIN=false.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function signIn() {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        setError("No account found for that email — use a seeded synthetic user.");
        return;
      }
      const session = (await response.json()) as { role: "user" | "staff" };
      router.push(session.role === "staff" ? "/staff" : "/dashboard");
      router.refresh();
    } catch {
      setError("Sign-in failed — try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">BillFighter</h1>
      <p className="mt-2 text-slate-600">Sign in to your console.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void signIn();
        }}
        className="mt-6 flex flex-col gap-3"
      >
        <label htmlFor="email" className="text-sm font-semibold text-slate-900">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={working || !email.includes("@")}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {working ? "Signing in…" : "Sign in"}
        </button>
        {error !== null ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
