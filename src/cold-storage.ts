import { S3Client, PutObjectCommand, GetObjectCommand, NoSuchKey } from "@aws-sdk/client-s3";

/**
 * Cold-storage flush + hydration via S3-compatible bucket.
 *
 * Each conversation flushes as one JSON object at key
 *   `<prefix><tenant>/<user>/<conversation_id>.json`
 * Body:
 *   { schema_version: 1, messages: [...], connector_state: [...],
 *     model_id_override: string | null }
 *
 * The bucket is per-session (storage.s3 in the session payload). S3
 * clients are cached per (endpoint, region, access_key_id) tuple so
 * concurrent sessions with the same bucket reuse a single client.
 *
 * This module is mode-agnostic — the demo path's `local/demo_session.json`
 * carries the same `storage.s3` envelope an integrator's POST /sessions
 * body does, so flush works in both with no demo carve-outs.
 *
 * See contract-storage-flush, contract-storage-durability, adr-0003.
 */

export interface ColdStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix?: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface FlushedConversation {
  schema_version: 1;
  messages: Array<{
    id: string;
    ordinal: number;
    role: string;
    parts: unknown;
    metadata: unknown;
  }>;
  connector_state: Array<{ descriptive_id: string; active: boolean }>;
  model_id_override: string | null;
  flushed_at: string;
}

/**
 * Parses a `session.storage` blob into a `ColdStorageConfig`. Returns
 * undefined when the session has no cold storage configured (hot-only
 * mode). Throws on a partially-filled storage block, since that
 * silently downgrading would surprise the operator.
 */
export function coldStorageConfigFrom(
  storage: Record<string, unknown> | undefined,
): ColdStorageConfig | undefined {
  if (!storage) return undefined;
  const s3 = (storage as { s3?: unknown }).s3;
  if (s3 === undefined) return undefined;
  if (typeof s3 !== "object" || s3 === null || Array.isArray(s3)) {
    throw new Error(`storage.s3 must be an object`);
  }
  const o = s3 as Record<string, unknown>;
  const required = ["endpoint", "region", "bucket", "access_key_id", "secret_access_key"] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) {
      throw new Error(`storage.s3.${k} must be a non-empty string`);
    }
  }
  const prefix = o["prefix"];
  if (prefix !== undefined && typeof prefix !== "string") {
    throw new Error(`storage.s3.prefix must be a string when set`);
  }
  return {
    endpoint: o["endpoint"] as string,
    region: o["region"] as string,
    bucket: o["bucket"] as string,
    prefix: (prefix as string | undefined) ?? "",
    access_key_id: o["access_key_id"] as string,
    secret_access_key: o["secret_access_key"] as string,
  };
}

// Client cache keyed by endpoint|region|access_key_id (do NOT include the
// secret — the access_key_id is a sufficient discriminator and keeping
// the key shape tight makes the cache easier to reason about).
const clients = new Map<string, S3Client>();

function clientFor(c: ColdStorageConfig): S3Client {
  const key = `${c.endpoint}|${c.region}|${c.access_key_id}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const fresh = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    // forcePathStyle works for MinIO / Backblaze; AWS auto-detects.
    forcePathStyle: true,
    credentials: {
      accessKeyId: c.access_key_id,
      secretAccessKey: c.secret_access_key,
    },
  });
  clients.set(key, fresh);
  return fresh;
}

function keyFor(c: ColdStorageConfig, tenant: string, user: string, cid: string): string {
  return `${c.prefix ?? ""}${tenant}/${user}/${cid}.json`;
}

/**
 * Writability probe — uploads a zero-byte test object under the
 * configured prefix and deletes intent is irrelevant for a one-shot
 * check; leaving it as a `.augchatd-probe` marker is fine. Throws on
 * any failure (auth, network, permission). Called at session creation
 * to satisfy contract-session-create §2.
 */
export async function probeWritability(c: ColdStorageConfig): Promise<void> {
  const probeKey = `${c.prefix ?? ""}.augchatd-probe`;
  await clientFor(c).send(
    new PutObjectCommand({
      Bucket: c.bucket,
      Key: probeKey,
      Body: "",
      ContentType: "application/octet-stream",
    }),
  );
}

/** Upload one conversation's flushed JSON to S3. */
export async function uploadFlush(
  c: ColdStorageConfig,
  tenant: string,
  user: string,
  cid: string,
  body: FlushedConversation,
): Promise<void> {
  await clientFor(c).send(
    new PutObjectCommand({
      Bucket: c.bucket,
      Key: keyFor(c, tenant, user, cid),
      Body: JSON.stringify(body),
      ContentType: "application/json",
    }),
  );
}

/**
 * Try to download a previously-flushed conversation. Returns undefined
 * when the key is absent (cold has no record of this cid for this
 * (tenant, user)). Throws on any other error.
 */
export async function downloadFlush(
  c: ColdStorageConfig,
  tenant: string,
  user: string,
  cid: string,
): Promise<FlushedConversation | undefined> {
  try {
    const out = await clientFor(c).send(
      new GetObjectCommand({
        Bucket: c.bucket,
        Key: keyFor(c, tenant, user, cid),
      }),
    );
    if (!out.Body) return undefined;
    const text = await out.Body.transformToString();
    return JSON.parse(text) as FlushedConversation;
  } catch (err) {
    if (err instanceof NoSuchKey) return undefined;
    // The SDK sometimes returns a generic error with name "NoSuchKey"
    // rather than the typed class; check the name too.
    if (err instanceof Error && err.name === "NoSuchKey") return undefined;
    throw err;
  }
}
