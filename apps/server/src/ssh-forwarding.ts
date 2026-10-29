import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Duplex, Transform } from "node:stream";
import type { ServerChannel } from "ssh2";
import { auditContext } from "./audit-context.js";
import { AgentForward } from "./agent-forward.js";
import type { Store } from "./store.js";
import type { SshLogin } from "./ssh.js";
import { fail, integer, str } from "./util.js";

type Agent = {
  id: string;
  send(type: string, body: Record<string, unknown>): boolean;
};
type Route = { backend: "agent" | "ssh"; revision: string; agent?: Agent };
interface Dependencies {
  store: Store;
  authorize(login: SshLogin): Route;
  openSsh(
    deviceId: string,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<Duplex>;
}
interface Forward {
  id: string;
  login: SshLogin;
  route: Route;
  stop(reason: string): void;
  validate(): void;
  agent?: AgentForward;
}
export function createSshForwarding(d: Dependencies) {
  const active = new Map<string, Forward>();
  function authorize(login: SshLogin) {
    if (!login.deviceId) fail(403, "FORWARD_DEVICE_REQUIRED");
    return d.authorize(login);
  }
  return {
    async open(
      login: SshLogin,
      host: string,
      port: number,
      accept: () => ServerChannel,
      signal: AbortSignal,
    ) {
      str(host, 1, 253);
      integer(port, 1, 65535);
      if (
        !isIP(host) &&
        !host
          .split(".")
          .every((label) =>
            /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
          )
      )
        fail(400, "INVALID_FORWARD_HOST");
      let route: Route;
      try {
        route = authorize(login);
        const sessions = [...active.values()];
        if (
          sessions.length >= 128 ||
          sessions.filter((s) => s.login.deviceId === login.deviceId).length >=
            32 ||
          sessions.filter((s) => s.login.sessionHash === login.sessionHash)
            .length >= 16
        )
          fail(429, "FORWARD_LIMIT");
      } catch (error) {
        d.store.audit(
          "authorization.denied",
          login.user.id,
          login.deviceId ?? null,
          null,
          { reason: "SSH_FORWARD_DENIED", method: "SSH", route: "ssh" },
        );
        throw error;
      }
      const id = randomUUID(),
        controller = new AbortController();
      const context = auditContext.getStore();
      let target: Duplex | undefined,
        channel: ServerChannel | undefined,
        opened = false;
      const guards: Transform[] = [];
      const expires = Date.now() + 3600000;
      let sent = 0,
        received = 0;
      const audit = (action: string, extra = {}) =>
        auditContext.run(context ?? { source: "system" }, () =>
          d.store.audit(action, login.user.id, login.deviceId!, null, {
            forward_id: id,
            host,
            port,
            backend: route.backend,
            ...extra,
          }),
        );
      const stop = (reason: string) => {
        if (!active.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
        target?.destroy();
        channel?.destroy();
        for (const guard of guards) guard.destroy();
        try {
          audit("ssh.forward_closed", {
            reason,
            opened,
            bytes_sent: sent,
            bytes_received: received,
          });
        } catch {
          /* Transport is already closed on audit failure. */
        }
      };
      const validate = () => {
        if (Date.now() >= expires) fail(401, "FORWARD_EXPIRED");
        const current = authorize(login);
        if (
          current.backend !== route.backend ||
          current.revision !== route.revision ||
          current.agent?.id !== route.agent?.id
        )
          fail(403, "FORWARD_ROUTE_CHANGED");
      };
      const abort = () => stop("USER_DISCONNECTED");
      const timer = setTimeout(
        () => stop("FORWARD_CONNECT_TIMEOUT"),
        10000,
      ).unref();
      const entry: Forward = { id, login, route, stop, validate };
      active.set(id, entry);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw new Error("FORWARD_CANCELLED");
        if (route.backend === "agent") {
          const stream = new AgentForward(id, route.agent!.send);
          entry.agent = stream;
          target = stream;
          controller.signal.addEventListener("abort", () => stream.destroy(), {
            once: true,
          });
          if (!route.agent!.send("tcp.open", { forward_id: id, host, port }))
            stream.destroy(new Error("AGENT_DISCONNECTED"));
          await stream.ready;
        } else
          target = await d.openSsh(
            login.deviceId!,
            host,
            port,
            controller.signal,
          );
        if (!active.has(id) || signal.aborted || target.destroyed)
          throw new Error("FORWARD_CANCELLED");
        validate();
        audit("ssh.forward_opened");
        opened = true;
        clearTimeout(timer);
        channel = accept();
        const guard = (outbound: boolean) =>
          new Transform({
            transform(data, _encoding, callback) {
              try {
                validate();
                if (outbound) sent += data.length;
                else received += data.length;
                callback(null, data);
              } catch {
                stop("AUTHORIZATION_EXPIRED");
                callback(new Error("AUTHORIZATION_EXPIRED"));
              }
            },
          });
        const outgoing = guard(true),
          incoming = guard(false);
        guards.push(outgoing, incoming);
        for (const stream of [target, channel, outgoing, incoming]) {
          stream.on("error", () => stop("FORWARD_IO_ERROR"));
        }
        target.once("close", () => {
          // A clean upstream EOF may precede draining the client's SSH window.
          if (!target!.readableEnded || !target!.writableFinished)
            stop("TARGET_DISCONNECTED");
        });
        channel.once("close", () => stop("USER_DISCONNECTED"));
        // Keep EOF independent in each direction (HTTP/database replies may follow client EOF).
        channel.pipe(outgoing).pipe(target);
        // ssh2 server channels close both directions on .end(). Send EOF only
        // after buffered writes drain, and defer .end() until client EOF too.
        let outputEnded = false;
        incoming.once("end", () => {
          channel!.write(Buffer.alloc(0), () => {
            if (!active.has(id)) return;
            outputEnded = true;
            channel!.eof();
            if (channel!.readableEnded) channel!.end();
          });
        });
        channel.once("end", () => {
          if (outputEnded) channel!.end();
        });
        target.pipe(incoming).pipe(channel, { end: false });
      } catch (error) {
        target?.destroy();
        stop("FORWARD_OPEN_FAILED");
        throw error;
      }
    },
    receive(
      deviceId: string,
      connectionId: string,
      type: string,
      body: Record<string, any>,
    ) {
      const id = str(body.forward_id, 1, 128),
        entry = active.get(id);
      if (
        !entry ||
        entry.login.deviceId !== deviceId ||
        entry.route.agent?.id !== connectionId
      )
        return;
      try {
        entry.validate();
      } catch {
        entry.stop("AUTHORIZATION_EXPIRED");
        return;
      }
      entry.agent?.receive(type, body);
    },
    tick() {
      for (const entry of active.values()) {
        try {
          entry.validate();
        } catch {
          entry.stop("AUTHORIZATION_EXPIRED");
        }
      }
    },
    disconnect(deviceId: string) {
      for (const entry of active.values())
        if (
          entry.route.backend === "agent" &&
          entry.login.deviceId === deviceId
        )
          entry.stop("AGENT_DISCONNECTED");
    },
    close() {
      for (const entry of active.values()) entry.stop("SERVER_SHUTDOWN");
    },
    get size() {
      return active.size;
    },
  };
}
