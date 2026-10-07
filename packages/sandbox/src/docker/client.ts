import Docker from "dockerode";

/** Docker client for `tcp://host:port`, `http(s)://host:port` or `unix:///path/to/docker.sock`. */
export function dockerClient(host: string): Docker {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Invalid Docker host: ${host}`);
  }
  switch (url.protocol) {
    case "unix:":
      return new Docker({ socketPath: url.pathname });
    case "tcp:":
    case "http:":
      return new Docker({ protocol: "http", host: url.hostname, port: Number(url.port || 2375) });
    case "https:":
      return new Docker({ protocol: "https", host: url.hostname, port: Number(url.port || 2376) });
    default:
      throw new Error(`Unsupported Docker host: ${host}`);
  }
}

/** HTTP status of a Docker API error, if it is one. */
export const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;

/** Resolves with the promise or rejects after `ms`; the request itself is left to finish or fail. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
