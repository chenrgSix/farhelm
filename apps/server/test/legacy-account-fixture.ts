import { randomUUID } from "node:crypto";
import { Credentials } from "../src/credentials.js";
import { AccountAuthorizations } from "../src/account-authorizations.js";
import type { Store } from "../src/store.js";

// Simulate persisted data from a version that still had account configuration.
// Retired HTTP endpoints must never be used to prepare these compatibility tests.
export function seedLegacyAccount(
  store: Store,
  deviceId: string,
  data: {
    name: string;
    username: string;
    method: "sudo" | "ssh";
    allowed_users?: string[];
    allowed_groups?: string[];
    allowed_roles?: string[];
    sudo_password?: string;
    private_key?: string;
  },
) {
  const id = randomUUID(),
    allowed_users = data.allowed_users ?? [],
    allowed_groups = data.allowed_groups ?? [],
    allowed_roles = data.allowed_roles ?? [];
  const secrets: Record<string, string> = {};
  if (data.sudo_password) secrets.sudo_password = data.sudo_password;
  if (data.private_key) secrets.private_key = data.private_key;
  store.db
    .prepare(
      "INSERT INTO target_accounts(id,device_id,name,username,method,revision,allowed_users,secrets) VALUES(?,?,?,?,?,1,?,?)",
    )
    .run(
      id,
      deviceId,
      data.name,
      data.username,
      data.method,
      JSON.stringify(allowed_users),
      new Credentials(store.dataDir, false).seal(id, secrets),
    );
  for (const group of allowed_groups)
    store.db
      .prepare("INSERT INTO target_account_groups VALUES(?,?)")
      .run(id, group);
  for (const role of allowed_roles)
    store.db
      .prepare("INSERT INTO target_account_roles VALUES(?,?)")
      .run(id, role);
  new AccountAuthorizations(store.db).replaceLegacy(deviceId, id, {
    allowed_users,
    allowed_groups,
    allowed_roles,
  });
  return {
    id,
    device_id: deviceId,
    name: data.name,
    username: data.username,
    method: data.method,
    revision: 1,
    allowed_users,
    allowed_groups,
    allowed_roles,
  };
}
export function seedLegacyGrant(
  store: Store,
  deviceId: string,
  accountId: string,
  userId: string,
) {
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO account_authorizations(id,device_id,account_id,user_id) VALUES(?,?,?,?)",
    )
    .run(id, deviceId, accountId, userId);
  return id;
}
