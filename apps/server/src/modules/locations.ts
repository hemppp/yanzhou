// ============================================================
// 地点路由
// ============================================================

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import {
  createLocation,
  getLocation,
  listLocations,
  updateLocation,
  deleteLocation,
} from '../services/location-service.js';
import { assignAutoCoords } from '../services/location-coords-service.js';
import { requireAuth } from '../middleware/auth.js';
import { requireProjectScope, type ProjectScopedVariables } from '../lib/project-scope.js';

const createLocationSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().min(1),
  name: z.string().min(1, '地点名称不能为空'),
  description: z.string().optional(),
  thumbnail: z.string().optional(),
  color: z.string().optional(),
  // 地图坐标（程序化地势图使用世界坐标 0-100；历史数据为经纬度）
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  mapZoom: z.number().nullable().optional(),
  world: z.string().optional(),
  states: z.array(z.object({
    chapter: z.number(),
    field: z.string(),
    oldValue: z.string().optional(),
    newValue: z.string(),
    description: z.string().optional(),
  })).optional(),
  relations: z.array(z.object({
    targetId: z.string().min(1),
    targetKind: z.enum(['location', 'character']),
    type: z.enum(['located_in', 'nearby', 'routes_to', 'related_to']),
    description: z.string().optional(),
    chapter: z.number().nullable().optional(),
  })).optional(),
  chapters: z.array(z.number()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateLocationSchema = createLocationSchema.partial();

const router = new Hono<{ Variables: ProjectScopedVariables }>();

router.get('/projects/:projectId', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const locations = await listLocations(projectId);
  return c.json({ data: locations });
});

router.get('/:id', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  const location = await getLocation(id, projectId);
  if (!location) return c.json({ error: { code: 'NOT_FOUND', message: '地点不存在' } }, 404);
  return c.json({ data: location });
});

router.post('/', requireAuth, zValidator('json', createLocationSchema), async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const data = c.req.valid('json') as z.infer<typeof createLocationSchema>;
  const location = await createLocation({ ...data, projectId } as Parameters<typeof createLocation>[0], projectId);
  return c.json({ data: location }, 201);
});

router.put('/:id', requireAuth, zValidator('json', updateLocationSchema), async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  const existing = await getLocation(id, projectId);
  if (!existing) {
    // upsert：不存在则创建（RFC 7231 PUT 幂等语义）
    const data = c.req.valid('json');
    const created = await createLocation({ id, ...data, projectId } as Parameters<typeof createLocation>[0], projectId);
    return c.json({ data: created }, 201);
  }
  const data = c.req.valid('json') as z.infer<typeof updateLocationSchema>;
  // schema 允许 null（DB 可空），service 层签名按 Location 排除 null；此处 zod 已校验，断言安全
  await updateLocation(id, data as Parameters<typeof updateLocation>[1], projectId);
  const location = await getLocation(id, projectId);
  return c.json({ data: location });
});

router.delete('/:id', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;
  const id = c.req.param('id')!;
  await deleteLocation(id, projectId);
  return c.json({ data: { success: true } });
});

// POST /api/locations/assign-coords - 为无坐标地点自动分配虚拟地图坐标
router.post('/assign-coords', requireAuth, async (c) => {
  const denial = await requireProjectScope(c);
  if (denial) return denial;
  const projectId = c.get('projectId')!;

  const locations = await listLocations(projectId);
  const result = assignAutoCoords(locations);

  for (const loc of result.updatedLocations) {
    const orig = locations.find(l => l.id === loc.id);
    if (orig && (orig.latitude !== loc.latitude || orig.longitude !== loc.longitude)) {
      await updateLocation(loc.id, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        mapZoom: loc.mapZoom,
      }, projectId);
    }
  }

  return c.json({
    data: {
      assignedCount: result.assignedCount,
      locations: result.updatedLocations,
    },
  });
});

export default router;
