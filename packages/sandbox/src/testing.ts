/**
 * For tests only, also of other packages: the egress proxy around any workspace, the way a Docker
 * exec uses it, and a certificate for a local HTTPS server.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxyEnv } from "./docker/exec";
import type { EgressProxy } from "./egress/proxy";
import type { Workspace } from "./types";

export { startEgressProxy, type EgressProxy } from "./egress/proxy";

/**
 * The workspace with each exec given a fresh proxy token for `client`, with its egress and routes,
 * and the proxy environment; the token is revoked when the process exits, as in docker/exec.ts.
 */
export function proxiedWorkspace(workspace: Workspace, proxy: EgressProxy, client = "127.0.0.1"): Workspace {
  return {
    key: workspace.key,
    paths: workspace.paths,
    async exec(options) {
      const grant = proxy.register(options.egress, client, options.routes);
      const proc = await workspace.exec({ ...options, env: { ...options.env, ...proxyEnv(grant.url) } });
      const done = proc.wait().finally(() => grant.revoke());
      return { ...proc, wait: () => done };
    },
  };
}

/** A self-signed certificate for localhost and 127.0.0.1, valid for a day; it is also its own CA. */
export function testCertificate(): { cert: string; key: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "abotica-cert-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
        ...["-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"],
        ...["-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
      ],
      { stdio: "ignore" },
    );
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
