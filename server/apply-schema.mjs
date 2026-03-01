import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Surreal } from 'surrealdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(join(__dirname, 'schema.surql'), 'utf8');

const db = new Surreal();
await db.connect(process.env.SURREAL_URL, {
  namespace: process.env.SURREAL_NS || 'avalon',
  database: process.env.SURREAL_DB || 'avalon',
  authentication: {
    username: process.env.SURREAL_USER,
    password: process.env.SURREAL_PASS,
  },
});
console.log('Connected, applying schema...');

// Execute the entire schema as one query — SurrealDB handles multiple statements
try {
  const result = await db.query(schema);
  console.log('Schema applied, result count:', result.length);
} catch (err) {
  console.error('Schema apply failed:', err.message);
  console.log('Trying statement by statement...');

  // Fallback: split on lines that end with ; and try each block
  const blocks = [];
  let current = '';
  for (const line of schema.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') && !current) continue;
    current += line + '\n';
    if (trimmed.endsWith(';')) {
      blocks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) blocks.push(current.trim());

  for (const block of blocks) {
    if (!block || block.startsWith('--')) continue;
    try {
      await db.query(block);
      console.log('OK:', block.substring(0, 80).replace(/\n/g, ' '));
    } catch (e) {
      console.error('FAIL:', block.substring(0, 80).replace(/\n/g, ' '));
      console.error('  Error:', e.message);
    }
  }
}

// Verify
const info = await db.query('INFO FOR DB');
console.log('\nAccesses:', JSON.stringify(info[0].accesses, null, 2));
console.log('Tables:', Object.keys(info[0].tables).join(', '));
console.log('User table:', info[0].tables.user);

await db.close();
console.log('Done');
