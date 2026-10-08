import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackend, SandboxProcess } from "../types";
import { startProcess } from "./exec";

/**
 * Idle workspaces in the Docker backend: pause, stop and wake. Docker is a fake that keeps each
 * container's state and records the calls that change it; execs and the egress proxy are mocked.
 */

type Status = "running" | "paused" | "exited";

const docker = vi.hoisted(() => ({
  containers: new Map<string, { status: Status; labels: Record<string, string> }>(),
  /** `<verb> <container>` of each call that changes a container. */
  calls: [] as string[],
}));

const NETWORK = "abotica-sandbox";
const ADDRESS = "10.0.0.5";

const apiError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

function fakeDocker() {
  const containerOf = (name: string) => {
    const container = docker.containers.get(name);
    if (!container) throw apiError(404);
    return container;
  };
  /** Moves the container from `from` to `to`, answering like Docker when it is in another state. */
  const transition = (name: string, verb: string, from: Status, to: Status, refused: number) => async () => {
    docker.calls.push(`${verb} ${name}`);
    const container = containerOf(name);
    if (container.status !== from) throw apiError(refused);
    container.status = to;
  };
  return {
    info: async () => ({ Runtimes: { runc: {} } }),
    getNetwork: () => ({ inspect: async () => ({ Id: "network-id" }) }),
    getImage: () => ({ inspect: async () => ({ Id: "sha256:image" }) }),
    createVolume: async () => ({}),
    createContainer: async (spec: { name: string; Labels: Record<string, string> }) => {
      docker.containers.set(spec.name, { status: "exited", labels: spec.Labels });
    },
    listContainers: async ({ filters }: { filters: { status: Status[] } }) =>
      [...docker.containers]
        .filter(([, container]) => filters.status.includes(container.status))
        .map(([name, container]) => ({ Id: name, State: container.status, Labels: container.labels })),
    getContainer: (name: string) => ({
      inspect: async () => {
        const { status, labels } = containerOf(name);
        return {
          Id: name,
          Config: { Labels: labels },
          // As in Docker: a paused container still counts as running.
          State: { Status: status, Running: status !== "exited", Paused: status === "paused", StartedAt: "t0" },
          NetworkSettings: { Networks: { [NETWORK]: { IPAddress: ADDRESS, NetworkID: "network-id" } } },
        };
      },
      start: transition(name, "start", "exited", "running", 304),
      pause: transition(name, "pause", "running", "paused", 409),
      unpause: transition(name, "unpause", "paused", "running", 500),
      stop: async () => {
        docker.calls.push(`stop ${name}`);
        containerOf(name).status = "exited";
      },
    }),
  };
}

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  dockerClient: () => fakeDocker(),
}));
vi.mock("./network", () => ({ findWorkerAddress: async () => "10.0.0.1" }));
vi.mock("../egress/proxy", () => ({ startEgressProxy: async () => ({ close: async () => {} }) }));
vi.mock("./exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec")>()),
  runHelper: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startProcess: vi.fn(),
}));

const { createDockerBackend } = await import("./backend");

const KEY = "project-11111111-2222-4333-8444-555555555555";
const NAME = `abotica-ws-${KEY}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DELAYS = { pauseAfterMs: 15 * MINUTE, stopAfterMs: 6 * HOUR };
const T0 = new Date("2026-10-08T10:00:00Z").getTime();

/** A process that runs until the test ends. */
const runningProcess = (): SandboxProcess => ({
  stdin: null,
  stdout: new ReadableStream(),
  stderr: new ReadableStream(),
  wait: () => new Promise(() => {}),
  kill: async () => {},
});

let backend: SandboxBackend;

/** Opens the workspace at T0 and forgets the calls that started it. */
async function openWorkspace() {
  const workspace = await backend.open({ key: KEY });
  docker.calls.length = 0;
  return workspace;
}

/** Reaps `ms` after T0. */
async function reapAt(ms: number) {
  vi.setSystemTime(T0 + ms);
  await backend.reap(DELAYS);
}

const status = () => docker.containers.get(NAME)?.status;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.mocked(startProcess).mockReset();
  docker.containers.clear();
  docker.calls.length = 0;
  backend = await createDockerBackend({
    host: "unix:///var/run/docker.sock",
    network: NETWORK,
    image: "abotica-sandbox:test",
    runtime: "runc",
    limits: { memoryMb: 1024, cpus: 1, pids: 512 },
  });
});

afterEach(() => vi.useRealTimers());

describe("reap", () => {
  it("pauses an idle workspace, then unpauses and stops it once idle past the stop delay", async () => {
    await openWorkspace();
    await reapAt(15 * MINUTE - 1);
    expect(docker.calls).toEqual([]);

    await reapAt(15 * MINUTE);
    expect(docker.calls).toEqual([`pause ${NAME}`]);
    expect(status()).toBe("paused");

    // The stop delay counts from the last use, not from the pause.
    await reapAt(6 * HOUR - 1);
    expect(docker.calls).toEqual([`pause ${NAME}`]);

    await reapAt(6 * HOUR);
    expect(docker.calls).toEqual([`pause ${NAME}`, `unpause ${NAME}`, `stop ${NAME}`]);
    expect(status()).toBe("exited");
  });

  it("never pauses a workspace with a command running", async () => {
    const workspace = await openWorkspace();
    vi.mocked(startProcess).mockResolvedValue(runningProcess());
    await workspace.exec({ command: "npm run dev", egress: [] });
    await reapAt(7 * HOUR);
    expect(docker.calls).toEqual([]);
    expect(status()).toBe("running");
  });

  it("never pauses a workspace while a command is starting", async () => {
    const workspace = await openWorkspace();
    let started!: (process: SandboxProcess) => void;
    vi.mocked(startProcess).mockReturnValue(new Promise((resolve) => (started = resolve)));
    const exec = workspace.exec({ command: "npm test", egress: [] });
    await reapAt(7 * HOUR);
    expect(docker.calls).toEqual([]);
    started(runningProcess());
    await exec;
  });
});

describe("wake", () => {
  it("unpauses a paused workspace and counts as use", async () => {
    await openWorkspace();
    await reapAt(15 * MINUTE);
    expect(await backend.wake(KEY)).toBe(ADDRESS);
    expect(docker.calls).toEqual([`pause ${NAME}`, `unpause ${NAME}`]);
    expect(status()).toBe("running");

    // Idle again from the wake on.
    await reapAt(30 * MINUTE - 1);
    expect(status()).toBe("running");
    await reapAt(30 * MINUTE);
    expect(status()).toBe("paused");
  });

  it("returns the address of a running workspace without changing it", async () => {
    await openWorkspace();
    expect(await backend.wake(KEY)).toBe(ADDRESS);
    expect(docker.calls).toEqual([]);
  });

  it("never starts a stopped workspace", async () => {
    await openWorkspace();
    await reapAt(6 * HOUR);
    expect(status()).toBe("exited");
    docker.calls.length = 0;
    expect(await backend.wake(KEY)).toBeNull();
    expect(docker.calls).toEqual([]);
    expect(status()).toBe("exited");
  });

  it("returns null for a workspace that does not exist", async () => {
    expect(await backend.wake(KEY)).toBeNull();
  });
});

describe("exec", () => {
  it("wakes a paused workspace when Docker refuses the exec", async () => {
    const workspace = await openWorkspace();
    await reapAt(15 * MINUTE);
    const child = runningProcess();
    // Docker answers 409 to an exec in a paused container.
    vi.mocked(startProcess).mockRejectedValueOnce(apiError(409)).mockResolvedValueOnce(child);
    expect(await workspace.exec({ command: "php artisan test", egress: [] })).toBe(child);
    expect(docker.calls).toEqual([`pause ${NAME}`, `unpause ${NAME}`]);
    expect(status()).toBe("running");
    expect(startProcess).toHaveBeenCalledTimes(2);
  });
});
