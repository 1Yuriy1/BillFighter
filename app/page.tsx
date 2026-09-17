import { redirect } from "next/navigation";
import { currentClaims } from "@/lib/session-server";

/**
 * Session-aware entry point: staff to the console, families to their
 * dashboard, everyone else to sign-in. Never renders cross-role content.
 */
export default async function Home() {
  const claims = await currentClaims();
  if (claims === null) {
    redirect("/login");
  }
  redirect(claims.role === "staff" ? "/staff" : "/dashboard");
}
