import { Duplex } from "node:stream";
import { ApiError, integer, keys, str } from "./util.js";

const CHUNK = 8192;
const agentCloseReasons = new Set([
  "TARGET_CONNECT_TIMEOUT",
  "TARGET_CONNECT_REFUSED",
  "TARGET_CONNECT_FAILED",
  "FORWARD_LIMIT",
  "FORWARD_EXPIRED",
  "FORWARD_IO_ERROR",
]);
type Send = (type: string, body: Record<string, unknown>) => boolean;
// Shared by all forwards on one Agent connection. Reserve in arrival order;
// 200 frames/s with a short burst keeps small queries responsive.
export class AgentForwardPacer {
  private next = -Infinity;
  private queue = new Set<() => void>();
  private timer?: NodeJS.Timeout;
  schedule(frame: () => void) {
    this.queue.add(frame);
    if (!this.timer) this.drain();
  }
  cancel(frame: () => void) {
    this.queue.delete(frame);
    if (!this.queue.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private drain() {
    this.timer = undefined;
    for (const frame of this.queue) {
      const now = performance.now();
      if (this.next > now) {
        this.timer = setTimeout(
          () => this.drain(),
          Math.ceil(this.next - now),
        ).unref();
        break;
      }
      this.next = Math.max(now - 155, this.next) + 5;
      this.queue.delete(frame);
      frame();
    }
  }
}
// One acknowledged chunk in each direction bounds memory independently of TCP speed.
export class AgentForward extends Duplex {
  readonly ready: Promise<void>;
  private opened = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private writeDone?: (error?: Error | null) => void;
  private pending: Buffer = Buffer.alloc(0);
  private sent = 0;
  private received = 0;
  private readAck = 0;
  private ended = false;
  private delayed = new Map<string, () => void>();
  constructor(
    readonly id: string,
    private sendFrame: Send,
    private pacer: AgentForwardPacer,
  ) {
    super({ allowHalfOpen: true, highWaterMark: 16384 });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.on("error", () => {});
  }
  private send(type: string, body: Record<string, unknown> = {}) {
    if (!this.sendFrame(type, { forward_id: this.id, ...body }))
      this.destroy(new Error("AGENT_DISCONNECTED"));
  }
  override _read() {
    if (this.readAck) {
      const seq = this.readAck;
      this.readAck = 0;
      this.send("tcp.ack", { seq });
    }
  }
  override _write(
    data: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.pending = data;
    this.writeDone = callback;
    this.next();
  }
  private next() {
    if (this.destroyed) return;
    const data = this.pending.subarray(0, CHUNK);
    this.pending = this.pending.subarray(data.length);
    this.send("tcp.data", { seq: ++this.sent, data: data.toString("base64") });
  }
  override _final(callback: (error?: Error | null) => void) {
    this.send("tcp.end");
    callback();
  }
  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void,
  ) {
    for (const frame of this.delayed.values()) this.pacer.cancel(frame);
    this.delayed.clear();
    this.sendFrame("tcp.close", { forward_id: this.id });
    this.rejectReady(error ?? new Error("AGENT_DISCONNECTED"));
    const done = this.writeDone;
    this.writeDone = undefined;
    done?.(error ?? new Error("FORWARD_CLOSED"));
    callback(error);
  }
  receive(type: string, body: Record<string, any>) {
    if (this.destroyed) return;
    if (type === "tcp.data" || type === "tcp.ack") {
      // The wire protocol permits only one outstanding frame per direction.
      // Delay its processing (and hence its credit), never the shared WebSocket.
      if (this.delayed.has(type)) {
        this.destroy(new Error("INVALID_FORWARD_SEQUENCE"));
        return;
      }
      const frame = () => {
        this.delayed.delete(type);
        if (!this.destroyed) this.processFrame(type, body);
      };
      this.delayed.set(type, frame);
      this.pacer.schedule(frame);
      return;
    }
    this.processFrame(type, body);
  }
  private processFrame(type: string, body: Record<string, any>) {
    try {
      if (type === "tcp.opened") {
        keys(body, ["forward_id"]);
        if (this.opened) throw new Error("INVALID_FORWARD_SEQUENCE");
        this.opened = true;
        this.resolveReady();
      } else if (type === "tcp.closed") {
        keys(body, ["forward_id", "reason"]);
        str(body.reason, 1, 128);
        if (body.reason !== "EOF" || !this.ended) {
          const fallback = this.opened
            ? "FORWARD_IO_ERROR"
            : "FORWARD_OPEN_FAILED";
          this.destroy(
            new ApiError(
              502,
              agentCloseReasons.has(body.reason) ? body.reason : fallback,
            ),
          );
        }
      } else {
        if (!this.opened) throw new Error("FORWARD_NOT_READY");
        if (type === "tcp.data") {
          keys(body, ["forward_id", "seq", "data"]);
          const seq = integer(body.seq, 1, Number.MAX_SAFE_INTEGER);
          const encoded = str(body.data, 1, 10924),
            data = Buffer.from(encoded, "base64");
          if (
            this.ended ||
            this.readAck ||
            seq !== this.received + 1 ||
            !data.length ||
            data.length > CHUNK ||
            data.toString("base64") !== encoded
          )
            throw new Error("INVALID_FORWARD_SEQUENCE");
          this.received = seq;
          this.readAck = seq;
          if (this.push(data)) this._read();
        } else if (type === "tcp.ack") {
          keys(body, ["forward_id", "seq"]);
          if (
            integer(body.seq, 1, Number.MAX_SAFE_INTEGER) !== this.sent ||
            !this.writeDone
          )
            throw new Error("INVALID_FORWARD_SEQUENCE");
          if (this.pending.length) this.next();
          else {
            const done = this.writeDone;
            this.writeDone = undefined;
            done();
          }
        } else if (type === "tcp.end") {
          keys(body, ["forward_id"]);
          if (this.ended) throw new Error("INVALID_FORWARD_SEQUENCE");
          this.ended = true;
          this.push(null);
        } else throw new Error("INVALID_FORWARD_MESSAGE");
      }
    } catch {
      this.destroy(new Error("INVALID_FORWARD_MESSAGE"));
    }
  }
}
