/**
 * LRA Global Ops :: /api/catalog
 *
 * Task types and recurring templates. Writes go through `userClient` so
 * `ops.task_types` / `ops.recurring_templates` RLS (oversight-only
 * insert/update) is the real enforcement, not this route -- a route bug
 * here cannot promote anyone the way it could if it reached for
 * `serviceClient` to dodge a policy (PLAN.md's standing rule).
 *
 * Every seeded type ships DRAFT with `default_points = null`
 * (OPEN-QUESTIONS.md #3); pricing one is just a normal PATCH once an
 * admin/oversight caller is ready, which is what the admin console's
 * catalog screen does.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient } from '../lib/supabase.js';
import { ApiError } from '../lib/domain.js';

const FIB = [1, 2, 3, 5, 8, 13, 21] as const;

const typeSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  guidelineNote: z.string().min(1),
  defaultPoints: z.union([z.literal(FIB[0]), z.literal(FIB[1]), z.literal(FIB[2]), z.literal(FIB[3]), z.literal(FIB[4]), z.literal(FIB[5]), z.literal(FIB[6])]).nullable().optional(),
  isRecurring: z.boolean().optional(),
});

const typePatchSchema = typeSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const templateSchema = z.object({
  position: z.enum(['founder', 'gm', 'sales', 'broker', 'hr_officer', 'accounting', 'other']),
  taskTypeId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
});

const templatePatchSchema = templateSchema.partial().extend({ isActive: z.boolean().optional() });

function toRow(body: z.infer<typeof typeSchema>) {
  return {
    name: body.name,
    category: body.category,
    guideline_note: body.guidelineNote,
    default_points: body.defaultPoints ?? null,
    is_recurring: body.isRecurring ?? false,
  };
}

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_types')
      .select('*')
      .order('category')
      .order('name');
    if (error) throw error;
    return { data };
  });

  app.post('/', { onRequest: requireOversight() }, async (req) => {
    const body = typeSchema.parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_types')
      .insert({ ...toRow(body), created_by: req.user.id })
      .select()
      .single();
    if (error) throw error;
    return { data };
  });

  app.patch('/:id', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = typePatchSchema.parse(req.body);
    const db = userClient(req.accessToken);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.category !== undefined) patch.category = body.category;
    if (body.guidelineNote !== undefined) patch.guideline_note = body.guidelineNote;
    if (body.defaultPoints !== undefined) patch.default_points = body.defaultPoints;
    if (body.isRecurring !== undefined) patch.is_recurring = body.isRecurring;
    if (body.isActive !== undefined) patch.is_active = body.isActive;

    const { data, error } = await db
      .schema('ops')
      .from('task_types')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return { data };
  });

  // The only DELETE path: `ops.delete_task_type_if_unused` checks
  // oversight AND "never referenced by any task or template" itself, so
  // this route cannot be tricked into a hard delete a route bug thinks
  // is safe. Everything else is deactivate (`PATCH { isActive: false }`
  // above) -- "delete" here means that, per Chan's explicit decision.
  app.delete('/:id', { onRequest: requireOversight() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { error } = await db.schema('ops').rpc('delete_task_type_if_unused', { p_id: id });
    if (error) throw new ApiError(409, error.message, error.code ?? 'DELETE_REFUSED');
    return reply.code(204).send();
  });

  app.get('/:id/revisions', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_type_revisions')
      .select('*')
      .eq('task_type_id', id)
      .order('changed_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.get('/recurring', async (req) => {
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('recurring_templates')
      .select('*, task_type:task_type_id(id, name, default_points)')
      .order('position');
    if (error) throw error;
    return { data };
  });

  app.post('/recurring', { onRequest: requireOversight() }, async (req) => {
    const body = templateSchema.parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('recurring_templates')
      .insert({
        position: body.position,
        task_type_id: body.taskTypeId,
        title: body.title,
        description: body.description ?? null,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;
    return { data };
  });

  app.patch('/recurring/:id', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = templatePatchSchema.parse(req.body);
    const db = userClient(req.accessToken);

    const patch: Record<string, unknown> = {};
    if (body.position !== undefined) patch.position = body.position;
    if (body.taskTypeId !== undefined) patch.task_type_id = body.taskTypeId;
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.is_active = body.isActive;

    const { data, error } = await db
      .schema('ops')
      .from('recurring_templates')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return { data };
  });

  // Same "hard-delete only if unused" rule as task types, above.
  app.delete('/recurring/:id', { onRequest: requireOversight() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { error } = await db.schema('ops').rpc('delete_recurring_template_if_unused', { p_id: id });
    if (error) throw new ApiError(409, error.message, error.code ?? 'DELETE_REFUSED');
    return reply.code(204).send();
  });
}
