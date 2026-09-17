/** Fax channel, Phase 1 stub — see stub.ts for the contract. */
import { makeStubAdapter } from "./stub";
import type { ChannelAdapter } from "../types";

export const faxAdapter: ChannelAdapter = makeStubAdapter("fax");
