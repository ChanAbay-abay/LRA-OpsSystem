/**
 * LRA Global Ops :: the request headers for `lib/api.ts`
 *
 * Its own module for one reason: `lib/api.ts` reads `import.meta.env` at
 * module scope, so it cannot be imported by a plain `node --test` run.
 * This rule needs a regression test more than almost anything else in
 * the client, so it lives where a test can reach it.
 *
 * THE RULE. `Content-Type: application/json` describes a body. Sending
 * it on a request that has NO body is not merely untidy — Fastify's JSON
 * content-type parser refuses such a request outright:
 *
 *     POST /api/blocks/:id/resolve   ->   400
 *     {"code":"FST_ERR_CTP_EMPTY_JSON_BODY",
 *      "message":"Body cannot be empty when content-type is set to
 *                 'application/json'"}
 *
 * — and it refuses it BEFORE the route handler runs, so the call never
 * reaches the database and no permission rule is ever consulted.
 *
 * That is the entirety of Chan's 2026-09-10 report "users cant unblock a
 * task" (reproduced with curl against the running API, 2026-09-10), and
 * it was never only about blocks. `api.post(path)` with no second
 * argument sends `body: undefined`, and every such call site was dead the
 * same way: resolving a block from the task modal AND from the board,
 * marking a notification read, committing a task to the week, generating
 * a week's recurring tasks, and opening and closing the Monday briefing.
 *
 * Each of those endpoints passed its own API-level test the whole time,
 * because those tests call the routes directly and never go through this
 * client. The bug lived in the seam, and the seam had no test. Hence this
 * file. See PLAN.md §11.1.
 */

export function buildHeaders(
  body: BodyInit | null | undefined,
  token: string,
  extra?: HeadersInit
): Record<string, string> {
  // `body === ''` matters as much as `body == null`: an empty string is
  // still an empty body as far as Fastify's parser is concerned, so
  // declaring JSON alongside it earns the same 400. `api.post` cannot
  // currently produce one, but the guard is about what Fastify accepts,
  // not about today's call sites.
  const hasBody = body != null && body !== '';
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
    // Last, so an explicit per-call header always wins — including a
    // caller who deliberately needs a different content type.
    ...(extra as Record<string, string> | undefined),
  };
}

/**
 * The 204 defect (2026-09-10) lives in `api.ts`'s `request()`, which cannot be
 * imported under `node --test` because it reads `import.meta.env` at module
 * scope. So the response-shape decision is pinned here as the same pure rule
 * `request()` applies, and the two must not drift: a no-content status yields
 * `undefined`, and any other 2xx must carry `{ data }`.
 *
 * Why it mattered: deleting an unused catalog type answers `204 No Content`,
 * `res.json()` rejects, and `body.data` threw a TypeError that the delete
 * dialog's catch dressed up as "Could not delete this — it may already have
 * been used by a task." The type was already permanently gone. A destructive
 * action that succeeds while reporting failure is worse than one that fails.
 */
export function isNoContent(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}
