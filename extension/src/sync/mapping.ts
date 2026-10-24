import {
  deleteMappingByLocalId,
  getMappingByLocalId,
  getMappingByObjectId,
  putMapping,
} from "../storage/db";
import type { ObjectType } from "./types";
import { uuidv7 } from "../util/uuid";

function saveMapping(objectType: ObjectType, chromiumLocalId: string, objectId: string): Promise<void> {
  return putMapping({
    key: `${objectType}:${chromiumLocalId}`,
    objectType,
    chromiumLocalId,
    objectId,
  });
}

/** Returns the HelixSync objectId for a Chromium-local id, minting and
 * persisting a new one if needed (docs/protocol.md §1.1). The Chromium id
 * itself is never used as an objectId. */
export async function getOrCreateObjectId(
  objectType: ObjectType,
  chromiumLocalId: string,
): Promise<string> {
  const existing = await getMappingByLocalId(objectType, chromiumLocalId);
  if (existing) return existing.objectId;

  const objectId = uuidv7();
  await saveMapping(objectType, chromiumLocalId, objectId);
  return objectId;
}

export async function lookupObjectId(
  objectType: ObjectType,
  chromiumLocalId: string,
): Promise<string | undefined> {
  return (await getMappingByLocalId(objectType, chromiumLocalId))?.objectId;
}

export async function lookupChromiumLocalId(objectId: string): Promise<string | undefined> {
  return (await getMappingByObjectId(objectId))?.chromiumLocalId;
}

export async function forgetMapping(objectType: ObjectType, chromiumLocalId: string): Promise<void> {
  await deleteMappingByLocalId(objectType, chromiumLocalId);
}

/** Records a mapping for an objectId that already exists, e.g. when a
 * remotely created object is materialized locally for the first time. */
export async function establishMapping(
  objectType: ObjectType,
  chromiumLocalId: string,
  objectId: string,
): Promise<void> {
  await saveMapping(objectType, chromiumLocalId, objectId);
}
