import { Surreal } from 'surrealdb';

const db = new Surreal();

const SURREAL_URL = process.env.SURREAL_URL || 'https://avalon-06b8rurustq696ho5iu0ms1rbk.aws-euw1.surreal.cloud/';
const SURREAL_NS = process.env.SURREAL_NS || 'avalon';
const SURREAL_DB = process.env.SURREAL_DB || 'avalon';
const SURREAL_USER = process.env.SURREAL_USER || '';
const SURREAL_PASS = process.env.SURREAL_PASS || '';

let connected = false;

export async function connectDb(): Promise<Surreal> {
  if (connected) return db;

  await db.connect(SURREAL_URL, {
    namespace: SURREAL_NS,
    database: SURREAL_DB,
    authentication: {
      username: SURREAL_USER,
      password: SURREAL_PASS,
    },
  });

  connected = true;
  console.log('Connected to SurrealDB at', SURREAL_URL);
  return db;
}

export { db };
