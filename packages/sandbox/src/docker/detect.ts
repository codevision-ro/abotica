import type { DockerBackendOptions, SandboxStatus } from "../types";
import { dockerClient, errorMessage, statusOf, withTimeout } from "./client";
import { findWorkerAddress, networkProblem } from "./network";

export type DockerDetection = SandboxStatus["docker"] & { runtimes: string[] };

const TIMEOUT_MS = 5_000;

/**
 * Whether the Docker backend can run with these options: engine reachable, Linux containers, the
 * requested runtime installed, the sandbox image built, the network internal and isolated from the
 * host, and the worker attached to it. `reason` names the first thing that is missing.
 */
export async function detectDocker(options: DockerBackendOptions): Promise<DockerDetection> {
  const result: DockerDetection = { configured: true, available: false, gvisor: false, runtimes: [] };
  const fail = (reason: string): DockerDetection => ({ ...result, reason });
  let docker;
  try {
    docker = dockerClient(options.host);
  } catch (error) {
    return fail(errorMessage(error));
  }
  try {
    await withTimeout(docker.ping(), TIMEOUT_MS, "Docker ping");
    const version = await withTimeout(docker.version(), TIMEOUT_MS, "Docker version");
    if (version.Os !== "linux") return fail(`Docker runs ${version.Os} containers; the sandbox needs Linux containers`);
    const info = await withTimeout(docker.info(), TIMEOUT_MS, "Docker info");
    result.runtimes = Object.keys((info as { Runtimes?: Record<string, unknown> }).Runtimes ?? {}).sort();
  } catch (error) {
    return fail(`Docker API at ${options.host} is not reachable: ${errorMessage(error)}`);
  }
  result.gvisor = result.runtimes.includes("runsc");
  if (options.runtime === "runsc" && !result.gvisor) {
    return fail("The gVisor runtime (runsc) is not installed in Docker");
  }
  try {
    await withTimeout(docker.getImage(options.image).inspect(), TIMEOUT_MS, "Image inspect");
    result.image = options.image;
  } catch (error) {
    return fail(
      statusOf(error) === 404
        ? `Image ${options.image} not found; build it with the sandbox-image service: docker compose build sandbox-image`
        : `Image ${options.image}: ${errorMessage(error)}`,
    );
  }
  try {
    const network = await withTimeout(docker.getNetwork(options.network).inspect(), TIMEOUT_MS, "Network inspect");
    const problem = networkProblem(network);
    if (problem) return fail(problem);
    await findWorkerAddress(docker, options.network);
  } catch (error) {
    return fail(statusOf(error) === 404 ? `Docker network ${options.network} does not exist` : errorMessage(error));
  }
  return { ...result, available: true };
}
