import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
test("user bootstrap and audit commit atomically or roll back together", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "fleet-bootstrap-")));
  try {
    store.db.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.action='user.bootstrap' BEGIN SELECT RAISE(ABORT,'simulated audit write failure'); END",
    );
    assert.throws(() =>
      store.seedUser({
        username: "must-not-exist",
        password: "long-explicit-password",
        role: "admin",
        deviceScope: "*",
      }),
    );
    assert.equal(
      (store.db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n,
      0,
    );
    store.db.exec("DROP TRIGGER fail_audit");
    const u = store.seedUser({
      username: "admin",
      password: "long-explicit-password",
      role: "admin",
      deviceScope: "*",
    });
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS n FROM audit WHERE actor_id=?")
          .get(u.id) as any
      ).n,
      1,
    );
  } finally {
    store.close();
  }
});
