import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Duplex, Transform } from "node:stream";
import type { ServerChannel } from "ssh2";
import { auditContext } from "./audit-context.js";
import { AgentForward, type AgentForwardPacer } from "./agent-forward.js";
import type { Store } from "./store.js";
import type { SshLogin } from "./ssh.js";
import { fail } from "./util.js";
import type { User } from "./types.js";
import { forwardDestination } from "./tcp-mapping-policy.js";

export type MappingLogin = {
  user: User;
  deviceId: string;
  mapping: { id: string; revision: number; source: string };
};
export type ForwardLogin = SshLogin | MappingLogin;
type ForwardChannel = ServerChannel | Socket;

type Agent = {
  id: string;
  pacer: AgentForwardPacer;
  send(type: string, body: Record<string, unknown>): boolean;
};
export type ForwardRoute = {
  backend: "agent" | "ssh";
  revision: string;
  agent?: Agent;
};
interface Dependencies {
  store: Store;
  authorize(login: ForwardLogin): ForwardRoute;
  openSsh(
    deviceId: string,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<Duplex>;
}
interface Forward {
  id: string;
  login: ForwardLogin;
  route: ForwardRoute;
  stop(reason: string): void;
  validate(): void;
  agent?: AgentForward;
}
export function createSshForwarding(d: Dependencies) {
  const active = new Map<string, Forward>();
  function authorize(login: ForwardLogin) {
    if (!login.deviceId) fail(403, "FORWARD_DEVICE_REQUIRED");
    return d.authorize(login);
  }
  return {
    async open(
      login: ForwardLogin,
      host: string,
      port: number,
      accept: () => ForwardChannel,
      signal: AbortSignal,
    ) {
      forwardDestination(host, port);
      const mapping = "mapping" in login ? login.mapping : undefined;
      const group = (value: ForwardLogin) =>
        "mapping" in value
          ? "mapping:" + value.mapping.id
          : "ssh:" + value.sessionHash;
      let route: ForwardRoute;
      try {
        route = authorize(login);
        const sessions = [...active.values()];
        if (
          sessions.length >= 128 ||
          sessions.filter((s) => s.login.deviceId === login.deviceId).length >=
            32 ||
          sessions.filter((s) => group(s.login) === group(login)).length >= 16
        )
          fail(429, "FORWARD_LIMIT");
      } catch (error) {
        // The raw listener records unauthenticated denials with its source and rate limit.
        if (mapping) fail(403, "MAPPING_FORWARD_DENIED");
        d.store.audit(
          "authorization.denied",
          login.user.id,
          login.deviceId ?? null,
          null,
          {
            reason: "SSH_FORWARD_DENIED",
            method: "SSH",
            route: "ssh",
          },
        );
        throw error;
      }
      const id = randomUUID(),
        controller = new AbortController();
      const context = auditContext.getStore();
      let target: Duplex | undefined,
        channel: ForwardChannel | undefined,
        opened = false;
      const guards: Transform[] = [];
      const expires = Date.now() + 3600000;
      let sent = 0,
        received = 0;
      const audit = (action: string, extra = {}) =>
        auditContext.run(context ?? { source: "system" }, () => {
          const detail = {
            forward_id: id,
            host,
            port,
            backend: route.backend,
            ...extra,
          };
          if (mapping)
            d.store.auditMappingClient(
              action.replace("ssh.forward_", "mapping.forward_"),
              login.user.id,
              login.deviceId!,
              {
                ...detail,
                mapping_id: mapping.id,
                source_address: mapping.source,
              },
            );
          else
            d.store.audit(action, login.user.id, login.deviceId!, null, detail);
        });
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
          const stream = new AgentForward(
            id,
            route.agent!.send,
            route.agent!.pacer,
          );
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
        if (mapping) {
          target.pipe(incoming).pipe(channel);
        } else {
          const sshChannel = channel as ServerChannel;
          // ssh2 server channels close both directions on .end(). Drain writes
          // before EOF and defer .end() until the client also sends EOF.
          let outputEnded = false;
          incoming.once("end", () => {
            sshChannel.write(Buffer.alloc(0), () => {
              if (!active.has(id)) return;
              outputEnded = true;
              sshChannel.eof();
              if (sshChannel.readableEnded) sshChannel.end();
            });
          });
          sshChannel.once("end", () => {
            if (outputEnded) sshChannel.end();
          });
          target.pipe(incoming).pipe(sshChannel, { end: false });
        }
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
      if (typeof body.forward_id !== "string" || body.forward_id.length > 128)
        return false;
      const entry = active.get(body.forward_id);
      if (
        !entry ||
        entry.login.deviceId !== deviceId ||
        entry.route.agent?.id !== connectionId
      )
        return false;
      try {
        entry.validate();
      } catch {
        entry.stop("AUTHORIZATION_EXPIRED");
        return true;
      }
      entry.agent?.receive(type, body);
      return true;
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
