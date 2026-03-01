import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { connectDb } from './surrealdb';
import * as avalon from './avalon-server';
import { AvalonError } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AuthenticatedRequest extends Request {
  uid?: string;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

const router = express.Router();

router.use(async function(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.get('X-Avalon-Auth');
  if (!token) {
    res.status(401).json({ message: `No auth info in request: ${req.method} ${req.path}` });
    return;
  }

  try {
    // Decode SurrealDB JWT to extract the user record ID
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const userId = payload.ID || payload.id;
    if (!userId) {
      throw new Error('No user ID in token');
    }

    // Extract just the ID part from SurrealDB record ID format (e.g., "user:abc123" -> "abc123")
    req.uid = typeof userId === 'string' && userId.includes(':')
      ? userId.split(':').slice(1).join(':')
      : String(userId);

    console.log('Request', req.method, req.path, req.uid, JSON.stringify(req.body));
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired auth token' });
  }
});

router.post('/login', (req: AuthenticatedRequest, res: Response) => {
  return avalon.loginUser(req.body, req.uid!).then(_r => res.end());
});

router.post('/createLobby', (req: AuthenticatedRequest, res: Response) => {
  return avalon.createLobby(req.body, req.uid!).then(r => res.json(r));
});

router.post('/joinLobby', (req: AuthenticatedRequest, res: Response) => {
  return avalon.joinLobby(req.body, req.uid!).then(r => res.json(r));
});

router.post('/leaveLobby', (req: AuthenticatedRequest, res: Response) => {
  return avalon.leaveLobby(req.body, req.uid!).then(() => res.end());
});

router.post('/kickPlayer', (req: AuthenticatedRequest, res: Response) => {
  return avalon.kickPlayer(req.body, req.uid!).then(() => res.end());
});

router.post('/startGame', (req: AuthenticatedRequest, res: Response) => {
  return avalon.startGame(req.body, req.uid!).then(() => res.end());
});

router.post('/cancelGame', (req: AuthenticatedRequest, res: Response) => {
  return avalon.cancelGame(req.body, req.uid!).then(() => res.end());
});

router.post('/proposeTeam', (req: AuthenticatedRequest, res: Response) => {
  return avalon.proposeTeam(req.body, req.uid!).then(() => res.end());
});

router.post('/voteTeam', (req: AuthenticatedRequest, res: Response) => {
  return avalon.voteTeam(req.body, req.uid!).then(() => res.end());
});

router.post('/doMission', (req: AuthenticatedRequest, res: Response) => {
  return avalon.doMission(req.body, req.uid!).then(() => res.end());
});

router.post('/assassinate', (req: AuthenticatedRequest, res: Response) => {
  return avalon.assassinate(req.body, req.uid!).then(() => res.end());
});

router.use((err: AvalonError, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.statusCode ? err.statusCode : 500);
  res.json({ message: err.message });
});

app.use('/api', router);

const PORT = process.env.PORT || 8001;

// Connect to SurrealDB before starting the server
connectDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}...`);
  });
}).catch(err => {
  console.error('Failed to connect to SurrealDB:', err);
  process.exit(1);
});
