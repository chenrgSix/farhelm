import type { Permission } from "./types";

export interface ApiToken {
  id: string;
  owner_id: string;
  owner_username: string | null;
  name: string;
  prefix: string;
  permissions: Permission[];
  device_scope: "*" | string[];
  expires_at: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_address: string | null;
  revision: number;
  status: "active" | "expired" | "revoked" | "owner_disabled";
}
export interface ApiTokenList {
  v: 1;
  tokens: ApiToken[];
  permissions: { id: Permission; label: string; description: string }[];
}
