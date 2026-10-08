import { describe, expect, it } from "vitest";
import { parseHttpUrl, reachableUrl } from "./reachable-url";

const GATEWAY = "host.docker.internal";

describe("reachableUrl", () => {
  it("leaves every address alone without a gateway", () => {
    expect(reachableUrl("http://localhost:11434", undefined)).toBe("http://localhost:11434");
    expect(reachableUrl("http://localhost:11434", "")).toBe("http://localhost:11434");
  });

  it("points loopback hosts to the gateway, keeping the port and path", () => {
    expect(reachableUrl("http://localhost:11434", GATEWAY)).toBe("http://host.docker.internal:11434/");
    expect(reachableUrl("http://127.0.0.1:11434/api", GATEWAY)).toBe("http://host.docker.internal:11434/api");
    expect(reachableUrl("http://[::1]:11434", GATEWAY)).toBe("http://host.docker.internal:11434/");
    expect(reachableUrl("https://LOCALHOST", GATEWAY)).toBe("https://host.docker.internal/");
  });

  it("passes other hosts through unchanged", () => {
    expect(reachableUrl("http://ollama:11434", GATEWAY)).toBe("http://ollama:11434");
    expect(reachableUrl("http://192.168.1.20:11434", GATEWAY)).toBe("http://192.168.1.20:11434");
    expect(reachableUrl("http://localhost.example.com", GATEWAY)).toBe("http://localhost.example.com");
  });

  it("returns an address it cannot parse as it is", () => {
    expect(reachableUrl("not a url", GATEWAY)).toBe("not a url");
  });
});

describe("parseHttpUrl", () => {
  it("accepts http and https addresses, without the trailing slash", () => {
    expect(parseHttpUrl(" http://localhost:11434/ ")).toBe("http://localhost:11434");
    expect(parseHttpUrl("https://ollama.example.com/base/")).toBe("https://ollama.example.com/base");
    expect(parseHttpUrl("http://ollama:11434")).toBe("http://ollama:11434");
  });

  it("refuses anything else", () => {
    expect(parseHttpUrl("localhost:11434")).toBeNull();
    expect(parseHttpUrl("ftp://localhost")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });
});
