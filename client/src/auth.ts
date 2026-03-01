import { db, connectDb } from './surrealdb';

const TOKEN_KEY = 'avalon_auth_token';

export interface AuthTokens {
  access: string;
  refresh?: string;
}

export async function signupAnonymous(): Promise<AuthTokens> {
  await connectDb();
  const tokens = await db.signup({
    namespace: 'avalon',
    database: 'avalon',
    access: 'user_auth',
    variables: {
      email: `anon_${Date.now()}_${Math.random().toString(36).slice(2)}@anonymous.local`,
    },
  });
  persistToken(tokens);
  return tokens;
}

export async function signupWithEmail(email: string, password: string): Promise<AuthTokens> {
  await connectDb();
  const tokens = await db.signup({
    namespace: 'avalon',
    database: 'avalon',
    access: 'user_auth',
    variables: { email, pass: password },
  });
  persistToken(tokens);
  return tokens;
}

export async function signinWithEmail(email: string, password: string): Promise<AuthTokens> {
  await connectDb();
  const tokens = await db.signin({
    namespace: 'avalon',
    database: 'avalon',
    access: 'user_auth',
    variables: { email, pass: password },
  });
  persistToken(tokens);
  return tokens;
}

export async function signout(): Promise<void> {
  try {
    await db.invalidate();
  } catch {
    // ignore errors on invalidate
  }
  localStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export async function restoreSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;

  try {
    await connectDb();
    await db.authenticate(token);
    return true;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return false;
  }
}

export function getUserIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // SurrealDB record auth tokens have an ID claim like "user:abc123"
    const rawId = payload.ID || payload.id || null;
    if (!rawId) return null;
    // Strip the table prefix (e.g., "user:abc123" → "abc123")
    return typeof rawId === 'string' && rawId.includes(':')
      ? rawId.split(':').slice(1).join(':')
      : String(rawId);
  } catch {
    return null;
  }
}

function persistToken(tokens: AuthTokens): void {
  localStorage.setItem(TOKEN_KEY, tokens.access);
}
