/**
 * The Inngest client behind the follow-up engine's scheduled jobs. The id
 * names the app in Inngest's dashboard and keys its function ids.
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "billfighter" });
