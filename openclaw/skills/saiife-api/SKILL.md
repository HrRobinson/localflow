---
name: saiife-api
description: Send HTTP requests through a granted saiife API collection — list collections, send saved or ad-hoc requests, read response shapes, and pull individual values. The credential stays on the machine; you work through a reference and never see it.
metadata:
  openclaw:
    requires:
      bins: [node]
      env: [SAIIFE_API_ENDPOINT, SAIIFE_API_TOKEN]
---

# saiife API-client skill

saiife exposes a loopback API-client surface scoped to the ONE environment and
collection set this grant covers. You compose and send HTTP requests against a
curated collection's declared origins; the API credential is substituted by the
main process and NEVER enters your context. Responses come back as a _shape_
(paths, types, sizes — no values); you pull individual scalar values by path.

Auth is the per-grant bearer token in `SAIIFE_API_TOKEN` (distinct from the
operator skill's `SAIIFE_TOKEN`).

Run the wrapped CLI:

    node "$SKILL_DIR/bin/saiife-api.mjs" <verb> [args...]

Verbs:

- `collections` — list the collections this grant can send against, with their
  origins, varSet names, and saved requests.
- `send <collectionId> --request <requestId> [--varset <name>] [--vars <json>]`
  — send a saved request.
- `send <collectionId> --spec <json> [--varset <name>] [--vars <json>]`
  — send an ad-hoc request. `<json>` is `{ "method", "path", "headers"?, "body"? }`;
  `path` is joined to the varSet's `base_url` or a full URL, and must resolve
  inside the collection's declared origins.
- `response <responseId>` — re-read a response's shape.
- `pull <responseId> <path>` — read one scalar value, e.g.
  `pull r3 "\$['data'][0]['id']"`. A path is JSONPath bracket-string form: every
  object key is quoted (`$['key']`), array indices are bare (`[0]`), and a
  response header reads as `$headers['header-name']`. A withheld field returns
  403; a path resolving to an object/array returns 400 (pull a leaf path
  under it).

A send returns `{ responseId, status, durationMs, shape }`. Read the shape to
find the leaf paths you need, then `pull` them.

## Chaining a value without reading it

To use a value from one response in the next request without ever seeing it,
put `{ "$ref": "<responseId>:<path>" }` in any string field of a `--spec` or
`--vars` — for example `{ "$ref": "r3:$['access_token']" }`. It resolves in
the main process at send time. A **withheld** field can be chained this way:
passing a value through is not reading it, so no approval is needed. The
chained value is also scrubbed from the response that comes back.

A chained value used as a `path` segment is substituted verbatim and is NOT
URL-encoded. It stays inside the collection's declared origin (so it cannot
redirect you off it), but if the upstream response you chained it from was
itself attacker-influenced, that value can steer where inside the origin your
next request lands (e.g. a value containing `../` or a query string). Treat a
chained path value the same way you'd treat any other untrusted redirect
target, and prefer chaining into a header or body field when the value isn't
meant to shape the URL.
