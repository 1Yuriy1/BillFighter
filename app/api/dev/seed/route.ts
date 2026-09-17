import { NextResponse } from "next/server";
import { withServiceClient } from "@/lib/db/connect";
import { seedDemoData } from "@/lib/db/seed";
import { devLoginEnabled } from "@/lib/session";

/** Creates the synthetic demo data set (idempotent). Dev/CI aid only. */
export async function POST(): Promise<NextResponse> {
  if (!devLoginEnabled()) {
    return NextResponse.json({ error: "dev_login_disabled" }, { status: 403 });
  }
  const summary = await withServiceClient((client) => seedDemoData(client));
  return NextResponse.json(summary);
}
