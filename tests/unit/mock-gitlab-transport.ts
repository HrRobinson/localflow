import type {
  GitLabRequest,
  GitLabResponse,
  GitLabTransport
} from '../../src/main/gitlab/gitlab-api'

/**
 * The offline mock transport seam (spec §12): `gitlab-api` takes its HTTP
 * transport as a constructor dep, so tests inject this mock, which records every
 * request and returns canned GitLab JSON / status codes — NO test ever makes a
 * live call. Backing the `MockGitLabApi` seam the spec names.
 */
export class MockGitLabTransport implements GitLabTransport {
  readonly requests: GitLabRequest[] = []
  private readonly handler: (
    req: GitLabRequest,
    attempt: number
  ) => GitLabResponse | Promise<GitLabResponse>

  constructor(
    handler: (req: GitLabRequest, attempt: number) => GitLabResponse | Promise<GitLabResponse>
  ) {
    this.handler = handler
  }

  private countFor(req: GitLabRequest): number {
    return this.requests.filter((r) => r.method === req.method && r.url === req.url).length
  }

  async send(req: GitLabRequest): Promise<GitLabResponse> {
    const attempt = this.countFor(req)
    this.requests.push(req)
    return this.handler(req, attempt)
  }
}

/** A canned JSON 200 response. */
export const ok = (value: unknown): GitLabResponse => ({
  status: 200,
  body: JSON.stringify(value)
})

/** A canned error response with an optional GitLab-style `{ message }` body and
 *  optional headers (e.g. `retry-after`). */
export const err = (
  status: number,
  message?: string,
  headers?: Record<string, string>
): GitLabResponse => ({
  status,
  body: message === undefined ? '' : JSON.stringify({ message }),
  headers
})
