import net from "node:net";
import os from "node:os";
import type Docker from "dockerode";
import { addressKey, localAddresses } from "../egress/addresses";
import { errorMessage, statusOf, withTimeout } from "./client";

/** Driver options that keep the host off an internal bridge network (no gateway address on the bridge). */
const ISOLATED_BRIDGE_OPTIONS = {
  "com.docker.network.bridge.inhibit_ipv4": "true",
  "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
} as const;

/**
 * Why the network cannot carry sandboxes, or null when it can. It must be internal (no route out
 * except through the proxy) and its bridge must have no address, otherwise containers reach every
 * service the host listens on through the gateway IP.
 */
export function networkProblem(info: Docker.NetworkInspectInfo): string | null {
  if (!info.Internal) return `Docker network ${info.Name} is not internal, so sandboxes could bypass the egress proxy`;
  if (info.Driver === "bridge") {
    const options = info.Options ?? {};
    const isolated = Object.entries(ISOLATED_BRIDGE_OPTIONS).some(([name, value]) => options[name] === value);
    if (!isolated) {
      return `Docker network ${info.Name} gives sandboxes the host's gateway address; recreate it with the driver option com.docker.network.bridge.inhibit_ipv4=true`;
    }
  }
  return null;
}

function inSubnet(address: string, cidr: string): boolean {
  const [base = "", prefix = ""] = cidr.split("/");
  const family = net.isIPv4(base) ? "ipv4" : net.isIPv6(base) ? "ipv6" : null;
  if (!family || !/^\d+$/.test(prefix)) return false;
  const list = new net.BlockList();
  list.addSubnet(base, Number(prefix), family);
  return net.isIP(address) === (family === "ipv4" ? 4 : 6) && list.check(address, family);
}

/**
 * The worker's own IPv4 address on the sandbox network, where the egress proxy listens. First the
 * worker's container (found by hostname, which Docker sets to the container ID), checked against the
 * local interfaces; then any local interface inside the network's subnet.
 */
export async function findWorkerAddress(docker: Docker, network: string): Promise<string> {
  let info: Docker.NetworkInspectInfo;
  try {
    info = await withTimeout(docker.getNetwork(network).inspect(), 10_000, "Inspecting the sandbox network");
  } catch (error) {
    throw new Error(
      statusOf(error) === 404
        ? `Docker network ${network} does not exist`
        : `Docker network ${network}: ${errorMessage(error)}`,
    );
  }
  const own = localAddresses();
  try {
    const self = await withTimeout(docker.getContainer(os.hostname()).inspect(), 10_000, "Inspecting the worker container");
    const endpoint = Object.values(self.NetworkSettings.Networks ?? {}).find((entry) => entry.NetworkID === info.Id);
    const ip = endpoint?.IPAddress;
    if (ip && own.has(addressKey(ip) ?? "")) return ip;
  } catch {
    // Not in a container, or a container we cannot see: fall back to the interfaces.
  }
  const subnets = (info.IPAM?.Config ?? []).map((config) => config.Subnet).filter((subnet): subnet is string => !!subnet);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && subnets.some((subnet) => inSubnet(entry.address, subnet))) return entry.address;
    }
  }
  throw new Error(`The worker is not attached to the Docker network ${info.Name}`);
}
