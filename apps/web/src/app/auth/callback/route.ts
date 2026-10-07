import { connectSubscription, SignInCallbackError, trustedAppOrigin } from "@abotica/core";
import { type NextRequest, NextResponse } from "next/server";
import { subscriptionReturnUrl } from "@/lib/subscription-return";

export const dynamic = "force-dynamic";

/**
 * Where a subscription provider (e.g. ChatGPT) sends the browser back after sign-in. It is reached
 * on 127.0.0.1, so the session cookie of the host the user works on is not sent here: the
 * single-use state, created by the signed-in user who started the sign-in, authenticates the call.
 */
export async function GET(request: NextRequest) {
  try {
    const { provider, returnTo } = await connectSubscription(request.nextUrl.searchParams);
    return NextResponse.redirect(subscriptionReturnUrl(returnTo, { outcome: "connected", provider }));
  } catch (error) {
    if (!(error instanceof SignInCallbackError)) throw error;
    return NextResponse.redirect(
      subscriptionReturnUrl(error.returnTo ?? trustedAppOrigin(), {
        outcome: error.reason,
        provider: error.provider,
        message: error.reason === "failed" ? error.message : undefined,
      }),
    );
  }
}
