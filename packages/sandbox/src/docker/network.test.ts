import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { networkProblem } from "./network";

const network = (overrides: Partial<Docker.NetworkInspectInfo>) =>
  ({ Name: "abotica-sandbox", Driver: "bridge", Internal: true, Options: {}, ...overrides }) as Docker.NetworkInspectInfo;

describe("networkProblem", () => {
  it("accepts an internal bridge without a gateway address", () => {
    expect(networkProblem(network({ Options: { "com.docker.network.bridge.inhibit_ipv4": "true" } }))).toBeNull();
    expect(networkProblem(network({ Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" } }))).toBeNull();
  });

  it("refuses a network with a route out", () => {
    expect(networkProblem(network({ Internal: false }))).toMatch(/not internal/);
  });

  it("refuses an internal bridge that gives containers the host's gateway address", () => {
    expect(networkProblem(network({}))).toMatch(/inhibit_ipv4=true/);
  });
});
