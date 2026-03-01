import { Surreal } from 'surrealdb';

const SURREAL_URL = 'wss://avalon-06b8rurustq696ho5iu0ms1rbk.aws-euw1.surreal.cloud/rpc';
const SURREAL_NS = 'avalon';
const SURREAL_DB = 'avalon';

const db = new Surreal();

let connected = false;

export async function connectDb(): Promise<Surreal> {
  if (connected) return db;

  await db.connect(SURREAL_URL, {
    namespace: SURREAL_NS,
    database: SURREAL_DB,
  });

  connected = true;
  return db;
}

export function isConnected(): boolean {
  return connected;
}

export { db };
