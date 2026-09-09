/**
 * LRA Global Ops :: PostgREST/Postgres error -> HTTP mapping
 *
 * Every route reaches the database through `userClient`/`serviceClient`
 * (supabase-js over PostgREST), and most routes just do
 * `if (error) throw error;` -- 28 sites, per the tester's count. That
 * error is a `PostgrestError` (`{ message, details, hint, code }`,
 * `code` being either a real Postgres SQLSTATE like `23505` or a
 * PostgREST-specific code like `PGRST116`). Before this module the
 * server's error handler only understood `ZodError` and `ApiError`, so
 * every one of those 28 sites turned an *expected* refusal -- a
 * duplicate name, a missing row RLS hid, a malformed input -- into an
 * opaque `500 {"code":"INTERNAL"}`.
 *
 * This maps the handful of SQLSTATEs/PostgREST codes that show up as
 * ordinary, anticipated refusals to a sane HTTP status and a message
 * that does not repeat Postgres's internal wording (constraint names,
 * "JSON object" internals) back at the client. Anything not in this
 * table is deliberately left unmapped -- the caller's generic 500
 * still applies, and it still logs the full error server-side. Do not
 * add a catch-all fallback here; an unmapped code should stay loud.
 */

export interface MappedError {
  statusCode: number;
  code: string;
  message: string;
}

// Recognizes the shape supabase-js's `PostgrestError` has (it extends
// `Error`, so `instanceof Error` is true of it too -- `code` being a
// non-empty string is the actual discriminator).
function isPostgrestLikeError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.length > 0
  );
}

export function mapPostgrestError(error: unknown): MappedError | null {
  if (!isPostgrestLikeError(error)) return null;

  switch (error.code) {
    case '23505': // unique_violation
      return { statusCode: 409, code: 'DUPLICATE', message: 'That value is already in use.' };
    case '23503': // foreign_key_violation
      return {
        statusCode: 409,
        code: 'REFERENCED',
        message: 'This is still referenced by other records and cannot be changed that way.',
      };
    case '23514': // check_violation
      return { statusCode: 422, code: 'VALIDATION_ERROR', message: 'That value violates a data rule.' };
    case '42501': // insufficient_privilege -- these are raised by our
      // own triggers/RLS with an already-human message ("only GM or
      // founder may flag a task for cancellation"), so pass it through
      // rather than replace it with something generic.
      return { statusCode: 403, code: 'FORBIDDEN', message: error.message };
    case 'PGRST116': // "JSON object requested, ... 0 or multiple rows"
      // The row genuinely doesn't exist, or RLS filtered it out because
      // the caller isn't allowed to see/touch it -- from the client's
      // side those look identical and should read as one clear
      // sentence, not PostgREST's internal "cannot coerce" wording.
      return {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Not found, or you do not have permission to do that.',
      };
    // Contention, not a bug in the request. `20260909190000` made the
    // commitment guard take a `for share` lock on ops.weeks so a commit
    // landing while close_briefing is mid-transaction cannot slip past
    // it. That is correct, but it means a commit CAN now block, and a
    // block that outlives the statement timeout is cancelled by
    // Postgres. Left unmapped those arrive as an opaque 500 -- which is
    // very likely what the tester saw as an intermittent, self-healing
    // 500 on POST /api/tasks/:id/commit right after a restart.
    //
    // 503 with Retry-After semantics is the honest answer: nothing is
    // wrong with what the caller asked for, it just could not be served
    // this instant. Reasoned from the lock's behaviour, not reproduced
    // with concurrent sessions.
    case '55P03': // lock_not_available
    case '57014': // query_canceled (statement timeout, incl. lock waits)
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return {
        statusCode: 503,
        code: 'BUSY',
        message: 'The system was busy and could not complete that just now. Please try again.',
      };
    default:
      return null;
  }
}
