import { Surreal } from 'surrealdb';

const SURREAL_URL = 'wss://surreal.fu.io/rpc';
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
