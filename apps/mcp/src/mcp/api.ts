// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.

import { API_PATH, DEFAULT_BASE_URL } from "@maschinenlesbar.org/luftqualitaet-client";

export {
  LuftqualitaetClient as Client,
  LuftError as ClientError,
  LuftNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/luftqualitaet-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/luftqualitaet-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/luftqualitaet-client/internal/errors";

/**
 * The API's base as a result's `source` starts with it: the host (`--base-url`, else the default)
 * and the path the client adds to it (`/api/air-data/v3`).
 */
export function apiBase(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${API_PATH}`;
}
