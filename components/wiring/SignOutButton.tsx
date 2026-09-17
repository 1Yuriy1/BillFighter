"use client";

import { useRouter } from "next/navigation";

/** Clears the dev session cookie and returns to the sign-in page. */
export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/dev/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
    >
      Sign out
    </button>
  );
}
