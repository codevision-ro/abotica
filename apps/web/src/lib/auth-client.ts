import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect: () => {
        // Runs inside better-auth's sign-in callback, outside React: a full navigation is intended.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/2fa";
      },
    }),
  ],
});
