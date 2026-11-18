// ============================================================
// 地点 Service
// ============================================================

import { schema } from '@novel/db';
import type { Location } from '@novel/shared';
import { BaseService, normalizeTimestamps, toDbTimestamps, parseJson } from './base-service.js';
import { v4 as uuidv4 } from 'uuid';

const JSON_FIELDS = ['states', 'relations', 'chapters', 'tags'];

function rowToLocation(r: Record<string, unknown>): Location {
  const result = normalizeTimestamps<Location>(r);
  (result as unknown as Record<string, unknown>).states = parseJson(r.states, []);
  (result as unknown as Record<string, unknown>).relations = parseJson(r.relations, []) as Location['relations'];
  (result as unknown as Record<string, unknown>).chapters = parseJson(r.chapters, []) as number[];
  (result as unknown as Record<string, unknown>).tags = parseJson(r.tags, []) as string[];
  return result;
}

function locationToRow(l: Location): Record<string, unknown> {
  const row = { ...l } as unknown as Record<string, unknown>;
  row.states = JSON.stringify(l.states ?? []);
  row.relations = JSON.stringify(l.relations ?? []);
  row.chapters = JSON.stringify(l.chapters ?? []);
  row.tags = JSON.stringify(l.tags ?? []);
  toDbTimestamps(row);
  return row;
}

const service = new BaseService<Location>(schema.locations, {
  rowToModel: rowToLocation,
  modelToRow: locationToRow,
  jsonFields: JSON_FIELDS,
  loadByColumn: 'projectId',
  entityLabel: 'Locations',
  scope: 'project',
});

export async function createLocation(data: Omit<Location, 'createdAt' | 'updatedAt'>, projectId: string): Promise<Location> {
  const now = Date.now();
  const location: Location = {
    ...data,
    id: data.id ?? uuidv4(),
    states: data.states ?? [],
    relations: data.relations ?? [],
    chapters: data.chapters ?? [],
    tags: data.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await service.save(location, false, projectId);
  return location;
}

export async function getLocation(id: string, projectId: string): Promise<Location | null> {
  return service.getById(id, projectId);
}

export async function listLocations(projectId: string): Promise<Location[]> {
  return service.loadAll(projectId, projectId);
}

export async function updateLocation(id: string, data: Partial<Omit<Location, 'id' | 'createdAt'>>, projectId: string): Promise<void> {
  await service.update(id, { ...data, updatedAt: Date.now() }, projectId);
}

export async function deleteLocation(id: string, projectId: string): Promise<void> {
  await service.delete(id, projectId);
}
