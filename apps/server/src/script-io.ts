import { randomUUID } from "node:crypto";
import { ApiError, fail, integer, keys, object, str } from "./util.js";

export const INTERACTIVE_TIMEOUT_MS = 300_000;
export const CHUNK = 8192;
export interface ScriptQuery {
  stdout_offset: number;
  stderr_offset: number;
  input?: { seq: number; text: string };
}
export interface ScriptPage {
  stdout: string;
  stderr: string;
  next: number;
  accepted?: boolean;
}
export const emptyPage = (): ScriptPage => ({
  stdout: "",
  stderr: "",
  next: 0,
});
export function parseScriptQuery(body: Record<string, unknown>): ScriptQuery {
  keys(body, ["v", "stdout_offset", "stderr_offset", "input"]);
  const result: ScriptQuery = {
    stdout_offset: integer(body.stdout_offset, 0, 262144),
    stderr_offset: integer(body.stderr_offset, 0, 262144),
  };
  if (body.input !== undefined) {
    const line = object(body.input);
    keys(line, ["text", "seq"]);
    if (
      typeof line.text !== "string" ||
      Buffer.byteLength(line.text) > 1024 ||
      /[\r\n\0\uD800-\uDFFF]/u.test(line.text)
    )
      fail(400, "INVALID_SCRIPT_LINE");
    result.input = { seq: integer(line.seq, 1, 0x7fffffff), text: line.text };
  }
  return result;
}
export const sliceOutput = (data: Buffer, offset: number) =>
  data.subarray(offset, offset + CHUNK).toString("base64");

// A live SSH exec has a dedicated input stream. The script itself is supplied
// in the authenticated exec request and never shares this stream with answers.
export class SshScriptIo {
  private next = 1;
  private writer?: (line: string) => void;
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  ready(write: (line: string) => void) {
    this.writer = write;
  }
  output(stream: "stdout" | "stderr", bytes: Buffer) {
    this[stream].push(bytes);
  }
  captured(stream: "stdout" | "stderr") {
    return Buffer.concat(this[stream]);
  }
  query(q: ScriptQuery): ScriptPage {
    let accepted = false;
    if (q.input && q.input.seq === this.next && this.writer) {
      this.writer(q.input.text + "\n");
      this.next++;
      accepted = true;
    }
    return {
      stdout: sliceOutput(this.captured("stdout"), q.stdout_offset),
      stderr: sliceOutput(this.captured("stderr"), q.stderr_offset),
      next: this.writer ? this.next : 0,
      accepted,
    };
  }
}

export class AgentScriptIo {
  private pending = new Map<
    string,
    {
      device: string;
      task: string;
      resolve: (page: ScriptPage) => void;
    }
  >();
  async query(
    device: string,
    task: string,
    query: ScriptQuery,
    send: (body: unknown) => boolean,
  ) {
    if (this.pending.size >= 128) fail(429, "SCRIPT_IO_BUSY");
    const id = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ScriptPage>((resolve, reject) => {
        this.pending.set(id, { device, task, resolve });
        timer = setTimeout(
          () => reject(new ApiError(503, "SCRIPT_IO_UNAVAILABLE")),
          3000,
        );
        if (!send({ request_id: id, task_id: task, ...query }))
          reject(new ApiError(503, "SCRIPT_IO_UNAVAILABLE"));
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  receive(device: string, body: Record<string, unknown>) {
    keys(body, [
      "request_id",
      "task_id",
      "stdout",
      "stderr",
      "next",
      "accepted",
    ]);
    const pending = this.pending.get(str(body.request_id, 1, 64));
    if (!pending || pending.device !== device || pending.task !== body.task_id)
      return;
    const bytes = (s: unknown) => {
      if (
        typeof s !== "string" ||
        s.length > Math.ceil(CHUNK / 3) * 4 ||
        Buffer.from(s, "base64").toString("base64") !== s ||
        Buffer.from(s, "base64").length > CHUNK
      )
        fail(400, "INVALID_SCRIPT_OUTPUT");
      return s;
    };
    pending.resolve({
      stdout: bytes(body.stdout),
      stderr: bytes(body.stderr),
      next: integer(body.next, 0, 0x7fffffff),
      accepted: body.accepted === true,
    });
  }
}
