import { AsyncLocalStorage } from "node:async_hooks";

export interface AuditContext {
  source: "http" | "api" | "ssh" | "agent" | "system";
  api_token_id?: string;
  api_token_name?: string;
  remote_address?: string;
  request_id?: string;
  method?: string;
  route?: string;
  user_agent?: string;
}
export const auditContext = new AsyncLocalStorage<AuditContext>();
export function auditText(value: string | undefined, max: number) {
  return value?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
}
