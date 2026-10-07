import { Response } from "undici";
import { describe, expect, it } from "vitest";
import { allowedAddresses, checkUrl, readTextCapped, SafeFetchError } from "./safe-fetch";

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof SafeFetchError ? error.code : error;
  }
  return null;
};

describe("checkUrl", () => {
  it.each(["https://example.com/page", "http://93.184.215.14:8080/", "https://[2606:4700::1111]/"])("allows %s", (url) =>
    expect(checkUrl(url).href).toBe(new URL(url).href),
  );

  it.each([
    ["ftp://example.com/file", "protocol"],
    ["file:///etc/passwd", "protocol"],
    ["https://user:secret@example.com/", "credentials"],
    ["https://user@example.com/", "credentials"],
    ["http://127.0.0.1/", "blocked"],
    ["http://169.254.169.254/latest/meta-data/", "blocked"],
    ["http://10.0.0.5:2375/containers/json", "blocked"],
    ["http://172.18.0.4:5432/", "blocked"],
    ["http://100.100.100.200/", "blocked"],
    ["http://0.0.0.0/", "blocked"],
    ["http://[::1]/", "blocked"],
    ["http://[::]/", "blocked"],
    ["http://[fd00::1]/", "blocked"],
    ["http://[fe80::1]/", "blocked"],
    ["http://[ff02::1]/", "blocked"],
    ["http://[::ffff:127.0.0.1]/", "blocked"],
    ["http://[::ffff:a9fe:a9fe]/", "blocked"],
    // Forms the URL parser normalizes to 127.0.0.1.
    ["http://2130706433/", "blocked"],
    ["http://0x7f.1/", "blocked"],
    ["http://127.1/", "blocked"],
  ])("refuses %s (%s)", (url, code) => expect(refusal(() => checkUrl(url))).toBe(code));

  it("refuses the host's own public address", () => {
    expect(refusal(() => checkUrl("http://203.0.114.7/", new Set(["203.0.114.7"])))).toBe("blocked");
  });

  it("leaves host names to the connect-time lookup", () => {
    expect(checkUrl("http://docker-proxy:2375/").hostname).toBe("docker-proxy");
  });
});

describe("allowedAddresses", () => {
  it("keeps only public addresses", () => {
    const found = allowedAddresses("mixed.example", [
      { address: "10.0.0.1", family: 4 },
      { address: "93.184.215.14", family: 4 },
      { address: "::1", family: 6 },
    ]);
    expect(found).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("refuses a name that resolves only to internal addresses", () => {
    const resolved = [
      { address: "172.18.0.3", family: 4 },
      { address: "fd12::3", family: 6 },
    ];
    expect(refusal(() => allowedAddresses("docker-proxy", resolved))).toBe("blocked");
  });
});

describe("readTextCapped", () => {
  it("reads a body under the cap", async () => {
    expect(await readTextCapped(new Response("hello"), 10)).toEqual({ text: "hello", truncated: false });
  });

  it("stops at the cap and says so", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
      },
    });
    expect(await readTextCapped(new Response(stream), 10)).toEqual({ text: "abcdabcdab", truncated: true });
  });
});
