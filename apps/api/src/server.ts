/**
 * LRA Global Ops :: API Server
 */

// Load .env before anything else imports a module that reads process.env.
// This import must stay first: ESM evaluates dependencies in import
// order, and LRA-HR's api silently returned 500 on every authenticated
// route for its whole first life because a Supabase client snapshot ran
// before dotenv had populated process.env.
import 'dotenv/config';

import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { ApiError } from './lib/domain.js';
import { mapPostgrestError } from './lib/pg-errors.js';
import { assertEnv } from './lib/env.js';
import { auditFailures } from './lib/supabase.js';
import meRoutes, { membersRoutes } from './routes/me.js';
import adminRoutes from './routes/admin.js';
import catalogRoutes from './routes/catalog.js';
import tasksRoutes, { blocksRoutes } from './routes/tasks.js';
import pointsRoutes from './routes/points.js';
import notificationsRoutes from './routes/notifications.js';
import weeksRoutes from './routes/weeks.js';
import settingsRoutes from './routes/settings.js';
import jobsRoutes from './routes/jobs.js';
import briefingRoutes from './routes/briefing.js';
import nowRoutes from './routes/now.js';
import scoreboardRoutes from './routes/scoreboard.js';
import taskEditRequestsRoutes from './routes/task-edit-requests.js';

export function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never log an Authorization header into a file someone else can read.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
  });

  app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  // -------------------------------------------------------------------
  // Error handling
  //
  // Internal errors are logged in full but returned as a generic
  // message, so a Postgres error never leaks schema details to a
  // browser. Responses are always `{ data }` on success.
  // -------------------------------------------------------------------
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      });
    }

    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        req.log.error({ err: error }, 'Server error');
      }
      return reply.code(error.statusCode).send({
        error: { message: error.message, code: error.code ?? 'ERROR' },
      });
    }

    // Fastify's own body-parser errors (malformed JSON, wrong
    // content-type, oversized body, ...) already carry a correct
    // 4xx `statusCode` and an `FST_ERR_CTP_*`/`FST_ERR_*` code --
    // the bug this branch fixes is that the code below it used to
    // ignore that and always answer 500, turning "you sent bad JSON"
    // into "the server broke".
    if (
      typeof error.code === 'string' &&
      error.code.startsWith('FST_ERR_') &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        error: { message: error.message, code: error.code },
      });
    }

    // A raw PostgREST/Postgres error thrown straight from a route's
    // `if (error) throw error;` (28 sites across the route files) used
    // to fall through to the generic 500 below no matter what actually
    // went wrong in the database -- a duplicate name and a real crash
    // were indistinguishable to the client. Map the SQLSTATE/PostgREST
    // code centrally instead of hand-writing a try/catch at every site.
    const mapped = mapPostgrestError(error);
    if (mapped) {
      if (mapped.statusCode >= 500) {
        req.log.error({ err: error }, 'Server error');
      }
      return reply.code(mapped.statusCode).send({
        error: { message: mapped.message, code: mapped.code },
      });
    }

    req.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { message: 'An unexpected error occurred', code: 'INTERNAL' },
    });
  });

  // `audit.failures` is here so a broken audit trail is discoverable by
  // asking, rather than by someone eventually noticing a row that was
  // never written. `status` degrades to 'degraded' when any audit write
  // has failed: the service is still serving, but it is no longer
  // keeping the record it promises to keep, and that is not 'ok'.
  app.get('/health', async () => ({
    status: auditFailures.count === 0 ? 'ok' : 'degraded',
    service: 'lra-ops-api',
    time: new Date().toISOString(),
    audit: { failures: auditFailures.count, last: auditFailures.last },
  }));

  app.register(meRoutes, { prefix: '/api/me' });
  app.register(membersRoutes, { prefix: '/api/members' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(catalogRoutes, { prefix: '/api/catalog' });
  app.register(tasksRoutes, { prefix: '/api/tasks' });
  app.register(blocksRoutes, { prefix: '/api/blocks' });
  app.register(pointsRoutes, { prefix: '/api/points' });
  app.register(notificationsRoutes, { prefix: '/api/notifications' });
  app.register(weeksRoutes, { prefix: '/api/weeks' });
  app.register(settingsRoutes, { prefix: '/api/settings' });
  app.register(jobsRoutes, { prefix: '/api/jobs' });
  app.register(briefingRoutes, { prefix: '/api/briefing' });
  app.register(nowRoutes, { prefix: '/api/now' });
  app.register(scoreboardRoutes, { prefix: '/api/scoreboard' });
  app.register(taskEditRequestsRoutes, { prefix: '/api/task-edit-requests' });

  return app;
}

// Only listen when run directly, so tests can import buildServer freely.
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  // Fail loudly at boot rather than as a generic 500 on every request.
  assertEnv();

  const app = buildServer();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '0.0.0.0';

  app.listen({ port, host }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`LRA Ops API listening on ${address}`);
  });
}
