import { describe, expect, it } from "vitest";
import { withServiceClient, withSessionClient } from "@/lib/db/connect";

/**
 * The pool carries two doors (session and service), and Postgres does not
 * undo `SET ROLE` when `RESET ALL` runs. These tests pin the containment:
 * a pooled connection that served a session must never lend that role —
 * or the claims behind it — to the next borrower, including the RLS-bypass
 * service door.
 */

const familyClaims = {
  sub: "11111111-1111-4111-8111-111111111111",
  role: "user" as const,
};

describe("pooled connection role hygiene", () => {
  it("resets the session role after a session client finishes", async () => {
    await withSessionClient(familyClaims, async (session) => {
      const who = await session.query<{ current_user: string }>("select current_user");
      expect(who.rows[0]?.current_user).toBe("authenticated");
    });

    // The pool hands the just-released connection back first — it must come
    // back as the login role, not still acting as `authenticated`.
    await withServiceClient(async (service) => {
      const who = await service.query<{ current_user: string }>("select current_user");
      expect(who.rows[0]?.current_user).toBe("postgres");
    });
  });

  it("keeps the service door RLS-bypassing after session traffic", async () => {
    // Staff sessions have INSERT on events; authenticated sessions do not.
    // Running a family session first is exactly the traffic shape that
    // poisoned the approve route's event write.
    await withSessionClient(familyClaims, async (session) => {
      await session.query("select 1");
    });

    await withServiceClient(async (service) => {
      // `postgres` owns events and bypasses RLS; an `authenticated` leftover
      // role fails this INSERT with `permission denied for table events`.
      await service.query(
        `insert into events (case_id, actor, message)
         select id, 'system', 'connect pool hygiene probe'
           from cases limit 1`,
      );
    });
  });

  it("destroys a session connection that fails mid-request", async () => {
    await expect(
      withSessionClient(familyClaims, async (session) => {
        await session.query(
          "select * from cases where id = '00000000-0000-0000-0000-000000000000'",
        );
        throw new Error("session fn failed after its queries");
      }),
    ).rejects.toThrow("session fn failed after its queries");

    // The failed connection was destroyed, so the next checkout is fresh —
    // still the login role, with the pool healthy for later requests.
    await withServiceClient(async (service) => {
      const who = await service.query<{ current_user: string }>("select current_user");
      expect(who.rows[0]?.current_user).toBe("postgres");
    });
  });
});
