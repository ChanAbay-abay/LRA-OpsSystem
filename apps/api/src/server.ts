/**
 * LRA Global Ops :: API Server
 */

// Load .env before anything else imports a module that reads process.env.
// This import must stay first: ESM evaluates dependencies in import
// order, and LRA-HR's api silently returned 500 on every authenticated
// route for its whole first life because a Supabase client snapshot ran
// before dotenv had populated process.env.
import 'dotenv/config';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { ApiError } from './lib/domain.js';
import { assertEnv } from './lib/env.js';
import meRoutes, { membersRoutes } from './routes/me.js';
import adminRoutes from './routes/admin.js';
import catalogRoutes from './routes/catalog.js';
import tasksRoutes, { blocksRoutes } from './routes/tasks.js';
import pointsRoutes from './routes/points.js';
import notificationsRoutes from './routes/notifications.js';
import weeksRoutes from './routes/weeks.js';
import settingsRoutes from './routes/settings.js';
import jobsRoutes from './routes/jobs.js';

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
  app.setErrorHandler((error, req, reply) => {
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

    req.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: { message: 'An unexpected error occurred', code: 'INTERNAL' },
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'lra-ops-api',
    time: new Date().toISOString(),
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
