import { createRequire } from "node:module";

// Keep the pinned client's legacy forge entry point out of the runtime module
// graph. This boundary is shared by the ACME worker and the dependency regression.
const require = createRequire(import.meta.url);
export const Client: typeof import("acme-client").Client = require("acme-client/src/client");
export const crypto: typeof import("acme-client").crypto = require("acme-client/src/crypto");
export const axios: typeof import("acme-client").axios = require("acme-client/src/axios");
