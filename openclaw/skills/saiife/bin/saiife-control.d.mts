/** Minimal type declaration for the JS CLI, so tsc can type-check the test
 *  that imports it without enabling allowJs on the whole node project. */
export interface ControlRequest {
  method: string
  path: string
  body?: Record<string, unknown>
}

export function buildRequest(base: string, argv: string[]): ControlRequest
