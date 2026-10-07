import { describe, expect, it } from "vitest";
import { containerSpec, specHash, type ContainerSpecInput } from "./spec";

const input: ContainerSpecInput = {
  key: "project-1234",
  imageId: "sha256:abc",
  network: "abotica-sandbox",
  runtime: "runc",
  limits: { memoryMb: 2048, cpus: 1.5, pids: 512 },
};

describe("containerSpec", () => {
  const spec = containerSpec(input);
  const host = spec.HostConfig!;

  it("names the container and volume after the workspace", () => {
    expect(spec.name).toBe("abotica-ws-project-1234");
    expect(host.Mounts).toEqual([{ Type: "volume", Source: "abotica-ws-project-1234", Target: "/workspace" }]);
    expect(spec.WorkingDir).toBe("/workspace");
    expect(spec.Env).toContain("HOME=/workspace/.home");
  });

  it("runs as the sandbox user, with only the capabilities root needs to install packages", () => {
    expect(spec.User).toBe("1000:1000");
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID"]);
    expect(host.Privileged).toBeUndefined();
    expect(host.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(host.ReadonlyRootfs).toBe(false);
    expect(Object.keys(host.Tmpfs ?? {})).toEqual(["/tmp", "/opt/abotica/bundles"]);
    expect(host.Tmpfs?.["/tmp"]).toContain("size=512m");
    expect(host.Tmpfs?.["/opt/abotica/bundles"]).toContain("mode=0755");
  });

  it("applies the resource limits", () => {
    expect(host.Memory).toBe(2048 * 1024 * 1024);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1_500_000_000);
    expect(host.PidsLimit).toBe(512);
  });

  it("joins only the internal network, without DNS or published ports", () => {
    expect(host.NetworkMode).toBe("abotica-sandbox");
    expect(Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {})).toEqual(["abotica-sandbox"]);
    expect(host.Dns).toEqual(["127.0.0.1"]);
    expect(host.PortBindings).toEqual({});
    expect(host.PublishAllPorts).toBe(false);
    expect(spec.ExposedPorts).toBeUndefined();
  });

  it("labels the container", () => {
    expect(spec.Labels).toEqual({
      "abotica.sandbox": "1",
      "abotica.workspace": "project-1234",
      "abotica.spec": specHash(input),
    });
  });

  it("uses gVisor only when chosen", () => {
    expect(host.Runtime).toBeUndefined();
    expect(containerSpec({ ...input, runtime: "runsc" }).HostConfig?.Runtime).toBe("runsc");
  });

  it("rejects keys that are not safe names", () => {
    for (const key of ["", "Project", "a/b", "-x", "a".repeat(64), "a_b"]) {
      expect(() => containerSpec({ ...input, key })).toThrow(/Invalid workspace key/);
    }
  });
});

describe("specHash", () => {
  it("changes with the image, limits, runtime and network, not the key", () => {
    const base = specHash(input);
    expect(specHash({ ...input, key: "other" })).toBe(base);
    expect(specHash({ ...input, imageId: "sha256:def" })).not.toBe(base);
    expect(specHash({ ...input, limits: { ...input.limits, memoryMb: 4096 } })).not.toBe(base);
    expect(specHash({ ...input, runtime: "runsc" })).not.toBe(base);
    expect(specHash({ ...input, network: "other" })).not.toBe(base);
  });
});
