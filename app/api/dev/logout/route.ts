import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

/** Clears the session cookie. */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
