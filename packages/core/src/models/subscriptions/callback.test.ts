import { describe, expect, it } from "vitest";
import { loopbackCallback } from "./callback";

describe("loopbackCallback", () => {
  const provider = { callbackPath: "/auth/callback", fallbackPort: 1455 };

  it("returns to the app itself when it is opened over loopback", () => {
    expect(loopbackCallback(provider, "http://localhost:3000")).toEqual({
      redirectUri: "http://127.0.0.1:3000/auth/callback",
      direct: true,
    });
    expect(loopbackCallback(provider, "http://127.0.0.1")).toEqual({
      redirectUri: "http://127.0.0.1:80/auth/callback",
      direct: true,
    });
  });

  it("falls back to a fixed port the user pastes back from, for remote and https origins", () => {
    for (const origin of ["https://abotica.example.com", "https://localhost:3000", null, "not a url"]) {
      expect(loopbackCallback(provider, origin)).toEqual({
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        direct: false,
      });
    }
  });
});
