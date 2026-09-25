import {
  deleteMappingByLocalId,
  getMappingByLocalId,
  getMappingByObjectId,
  putMapping,
} from "../storage/db";
import type { ObjectType } from "./types";
import { uuidv7 } from "../util/uuid";

/** Returns the existing HelixSync objectId for a Chromium-local id, or
 * creates and persists a new stable mapping (docs/protocol.md §1.1). Never
 * use the Chromium id itself as objectId. */
export async function getOrCreateObjectId(
  objectType: ObjectType,
  chromiumLocalId: string,
): Promise<string> {
  const existing = await getMappingByLocalId(objectType, chromiumLocalId);
  if (existing) return existing.objectId;

  const objectId = uuidv7();
  await putMapping({
    key: `${objectType}:${chromiumLocalId}`,
    objectType,
    chromiumLocalId,
    objectId,
  });
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

/** Record a mapping for an objectId that already exists (e.g. materializing
 * a remotely-created object locally for the first time), as opposed to
 * `getOrCreateObjectId` which mints a fresh objectId for a locally-observed
 * Chromium node. */
export async function establishMapping(
  objectType: ObjectType,
  chromiumLocalId: string,
  objectId: string,
): Promise<void> {
  await putMapping({
    key: `${objectType}:${chromiumLocalId}`,
    objectType,
    chromiumLocalId,
    objectId,
  });
}
