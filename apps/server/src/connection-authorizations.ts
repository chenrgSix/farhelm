import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AccountAuthorizations,
  defaultAccountId,
} from "./account-authorizations.js";
import { deviceSudo } from "./device-sudo.js";
import { hasPermission } from "./permissions.js";
import type { Store } from "./store.js";
import type { User } from "./types.js";
import { fail, str } from "./util.js";

export function registerConnectionAuthorizations(
  app: FastifyInstance,
  d: {
    store: Store;
    admin(req: FastifyRequest): User;
    reader(req: FastifyRequest): User;
    requireScope(user: User, id: string): void;
    requireDevice(id: string): { connection_kind: string };
  },
) {
  const db = d.store.db;
  const policy = new AccountAuthorizations(db);
  function defaultNeedsSudo(user: User, deviceId: string) {
    const row = db
      .prepare("SELECT config_json FROM device_connections WHERE device_id=?")
      .get(deviceId);
    const privileged =
      !!row && JSON.parse(row.config_json as string).username === "root";
    return (
      privileged &&
      !policy.matches(user, deviceId, null).some((rule) => rule.legacy_scope)
    );
  }
  function requireDefault(user: User, deviceId: string) {
    d.requireScope(user, deviceId);
    if (
      !hasPermission(user, "terminal.connect") ||
      !policy.allowed(user, deviceId, null)
    )
      fail(403, "TARGET_ACCOUNT_DENIED");
    if (
      defaultNeedsSudo(user, deviceId) &&
      !deviceSudo(db, user, deviceId).allowed
    )
      fail(403, "SUDO_PERMISSION_REQUIRED");
  }
  function loginAccounts(user: User, deviceId: string) {
    d.requireScope(user, deviceId);
    const connection = db
      .prepare(
        "SELECT config_json,revision FROM device_connections WHERE device_id=?",
      )
      .get(deviceId);
    const device = d.requireDevice(deviceId);
    const username =
      device.connection_kind === "agent"
        ? "Agent 运行账号"
        : connection
          ? JSON.parse(connection.config_json as string).username
          : "接入账号";
    const defaults =
      user.role === "admin" ||
      (hasPermission(user, "terminal.connect") &&
        policy.allowed(user, deviceId, null) &&
        (!defaultNeedsSudo(user, deviceId) ||
          deviceSudo(db, user, deviceId).allowed))
        ? [
            {
              id: defaultAccountId(deviceId),
              device_id: deviceId,
              name: "普通连接",
              username,
              method: "default" as const,
              revision: Number(connection?.revision ?? 0),
              is_default: true,
            },
          ]
        : [];
    return defaults;
  }

  app.get("/api/v1/devices/:id/login-accounts", async (req) => {
    const user = d.reader(req);
    const deviceId = str((req.params as any).id, 1, 128);
    return { v: 1, accounts: loginAccounts(user, deviceId) };
  });
  // Authenticated old clients receive a clear retirement error. Never read,
  // mutate or decrypt archived accounts through these former configuration URLs.
  for (const url of [
    "/api/v1/devices/:id/accounts",
    "/api/v1/devices/:id/accounts/:accountId",
  ])
    app.route({
      method: ["GET", "POST", "PUT", "DELETE"],
      url,
      handler: async (req) => {
        if (req.method === "GET") d.reader(req);
        else d.admin(req);
        fail(410, "ACCOUNT_CONFIGURATION_REMOVED");
      },
    });
  return { loginAccounts, requireDefault, defaultNeedsSudo, policy };
}
