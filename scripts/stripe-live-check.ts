/**
 * Manual validation: a live Stripe TEST-MODE round trip through the real
 * adapter (not CI — CI stays network-free). Confirms the configured
 * STRIPE_SECRET_KEY is a test key and that the adapter's createCustomer
 * request shape is accepted by the real API.
 */
import { makeStripeGateway } from "../lib/billing/stripe";
import { GatewayError } from "../lib/billing/gateway";

async function main(): Promise<void> {
  // The Obvious runtime injects secrets as SECRET_<NAME>; STRIPE_SECRET_KEY
  // is the conventional local name. Either way, never log the value.
  const key = process.env.SECRET_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log("RESULT: no key injected — skipping live check (CI coverage is offline tests)");
    return;
  }
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    console.log(`RESULT: key prefix ${key.slice(0, 8)} is NOT test mode — refusing to call Stripe`);
    process.exit(1);
  }
  try {
    const gateway = makeStripeGateway({ secretKey: key });
    const result = await gateway.createCustomer({
      email: "live-check@billfighter-test.example",
      name: "Test Mode Validation",
    });
    console.log(`RESULT: created live test-mode customer ${result.customerId}`);
  } catch (error) {
    if (error instanceof GatewayError) {
      console.log(`RESULT: gateway error ${error.code}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.log(`RESULT: unexpected failure — ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
