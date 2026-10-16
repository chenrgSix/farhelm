import type { SecureContextOptions } from "node:tls";
export function readTlsContext(
  certPath: string,
  keyPath: string,
): { options: SecureContextOptions; fingerprint: string };
export function watchTlsContext(
  server: { setSecureContext(options: SecureContextOptions): void },
  options: {
    certPath: string;
    keyPath: string;
    intervalMs?: number;
    log?: (message: string) => void;
  },
): { check(): boolean; close(): void };
