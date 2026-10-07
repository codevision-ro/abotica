import { describe, expect, it } from "vitest";
import { isCrossOriginWrite } from "./same-origin";

const request = (method: string, headers: Record<string, string>) =>
  new Request("https://abotica.example.com/api/chat", { method, headers });

describe("isCrossOriginWrite", () => {
  it("lets reads through from anywhere", () => {
    expect(isCrossOriginWrite(request("GET", { "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("accepts writes from the app's own pages", () => {
    expect(isCrossOriginWrite(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossOriginWrite(request("POST", { origin: "https://abotica.example.com" }))).toBe(false);
  });

  it("refuses writes from a preview subdomain or another site", () => {
    expect(isCrossOriginWrite(request("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossOriginWrite(request("DELETE", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossOriginWrite(request("POST", { origin: "https://x.preview.abotica.example.com" }))).toBe(true);
  });

  it("accepts clients that are not browsers", () => {
    expect(isCrossOriginWrite(request("POST", {}))).toBe(false);
  });
});
