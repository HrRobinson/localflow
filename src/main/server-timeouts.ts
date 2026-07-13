import type { Server } from 'node:http'

/**
 * Shared socket/request timeouts for localflow's loopback HTTP servers
 * (hook-server, control-api). Node's defaults leave the socket inactivity
 * timeout disabled entirely, so a wedged local client (or a stray process
 * that connects and never finishes a request) would pin sockets in the main
 * process forever. Values are deliberately generous — every client is on
 * 127.0.0.1 and requests are tiny, so these only ever fire on a hung peer,
 * never on a slow network.
 */
export const SOCKET_IDLE_TIMEOUT_MS = 120_000
export const HEADERS_TIMEOUT_MS = 30_000
export const REQUEST_TIMEOUT_MS = 60_000

export function applyLoopbackTimeouts(server: Server): void {
  // Idle-socket timeout; with no 'timeout' listener Node destroys the socket.
  server.setTimeout(SOCKET_IDLE_TIMEOUT_MS)
  // How long a client may take to send the complete headers…
  server.headersTimeout = HEADERS_TIMEOUT_MS
  // …and the complete request (headers + body).
  server.requestTimeout = REQUEST_TIMEOUT_MS
}
