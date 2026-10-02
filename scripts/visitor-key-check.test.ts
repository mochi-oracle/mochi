import { expect, test } from "bun:test";
import { checkVisitorKeys } from "./visitor-key-check.ts";
import { createWebHandler } from "../web/server.ts";
import { createProductionProxy } from "../deploy/production/public-proxy.ts";
import { createFrontHandler } from "../deploy/phala/claims-service/front.ts";

const TOKEN = "test-invitation-token-at-least-24-characters";
const dist = new URL("../web/site/dist", import.meta.url).pathname;

test("the operator's key check gets match from both servers only with their shared secret, over loopback", async () => {
  const web = createWebHandler({ dist, visitorSecret: TOKEN });
  const protocol = createProductionProxy({ ready: () => true, gatewayPort: 8086, indexerPort: 8087, visitorSecret: TOKEN });
  const unused = async () => Response.json({});
  const front = createFrontHandler({ enrollment: unused, protocol, identities: unused, claims: unused, revenue: async () => ({}), clientDiagnostics: protocol.clientDiagnostics, productionStatus: () => ({ status: "standby" }) });
  // Port 0: the OS picks free ephemeral ports.
  const servers = [Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, bun) => web(request, bun.requestIP(request)?.address) }), Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, bun) => front(request, bun.requestIP(request)?.address) })];
  try {
    for (const server of servers) expect(server.port).not.toBe(18545);
    const urls = [`http://127.0.0.1:${servers[0]!.port}/health`, `http://127.0.0.1:${servers[1]!.port}/production/status`];
    expect((await checkVisitorKeys(TOKEN, urls)).map(({ result }) => result)).toEqual(["match", "match"]);
    expect((await checkVisitorKeys("another-invitation-token-of-24-chars", urls)).map(({ result }) => result)).toEqual(["mismatch", "mismatch"]);
    await expect(checkVisitorKeys(TOKEN, ["http://example.com/health"])).rejects.toThrow("HTTPS");
    await expect(checkVisitorKeys("short", urls)).rejects.toThrow("24 characters");
  } finally { for (const server of servers) server.stop(true); }
});
