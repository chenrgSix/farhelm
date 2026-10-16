import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, integer, keys, object, str, version } from "./util.js";
import { agentAddressSync } from "./agent-address.js";

export function platformServerUrl(value: unknown) {
  const input = str(value, 1, 2048).trim();
  if (!input || /[\x00-\x20\x7f]/.test(input))
    fail(400, "INVALID_AGENT_SERVER_URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail(400, "INVALID_AGENT_SERVER_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail(400, "INVALID_AGENT_SERVER_URL");
  return url.origin;
}

export function registerSettings(
  app: FastifyInstance,
  d: {
    store: Store;
    admin: (req: FastifyRequest) => User;
    initialServerUrl?: string;
    networkManaged?: (id: string) => boolean;
    agent?: (
      id: string,
    ) =>
      | { supported: boolean; send(type: string, body: unknown): boolean }
      | undefined;
  },
) {
  const { db } = d.store;
  const sync = agentAddressSync(
    d.store,
    d.agent ?? (() => undefined),
    d.networkManaged,
  );
  function current() {
    const row = db
      .prepare(
        "SELECT platform_server_url,revision,updated_at FROM system_settings WHERE id=1",
      )
      .get() as
      | {
          platform_server_url: string;
          revision: number;
          updated_at: number;
        }
      | undefined;
    return {
      v: 1,
      ...(row ?? {
        platform_server_url: d.initialServerUrl?.trim() ?? "",
        revision: 0,
        updated_at: null,
      }),
    };
  }
  app.get("/api/v1/settings", async (req) => {
    d.admin(req);
    return current();
  });
  app.put("/api/v1/settings", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision", "platform_server_url"]);
    const expected = integer(b.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    const url = platformServerUrl(b.platform_server_url);
    const saved = d.store.transaction(() => {
      const previous = current();
      if (previous.revision !== expected)
        fail(409, "SETTINGS_REVISION_CONFLICT");
      if (previous.revision > 0 && previous.platform_server_url === url)
        return previous;
      const revision = expected + 1,
        now = Date.now();
      db.prepare(
        "INSERT INTO system_settings(id,platform_server_url,revision,updated_at,updated_by) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform_server_url=excluded.platform_server_url,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
      ).run(url, revision, now, user.id);
      d.store.audit("settings.updated", user.id, null, null, {
        revision,
        platform_server_url: url,
      });
      sync.enqueue({ revision, platform_server_url: url });
      return current();
    });
    sync.flush();
    return saved;
  });
  app.get("/api/v1/settings/agent-sync", async (req) => {
    d.admin(req);
    return sync.snapshot(current());
  });
  app.post("/api/v1/settings/agent-sync", async (req) => {
    const user = d.admin(req),
      b = object(req.body);
    version(b);
    keys(b, ["v", "revision"]);
    const target = current();
    if (integer(b.revision, 1, Number.MAX_SAFE_INTEGER) !== target.revision)
      fail(409, "SETTINGS_REVISION_CONFLICT");
    d.store.transaction(() => {
      sync.enqueue(target, true);
      d.store.audit("settings.sync_requested", user.id, null, null, {
        revision: target.revision,
      });
    });
    sync.flush();
    return sync.snapshot(target);
  });
  return { current, sync };
}
