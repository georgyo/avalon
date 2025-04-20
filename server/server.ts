import express, { Request, Response, NextFunction } from 'express';
import promiseRouter from 'express-promise-router';
import firebaseAdmin from 'firebase-admin';
import serviceAccount from './firebaseKey';
// Avalon logic imported after Firebase initialization to ensure default app exists
// We'll require it dynamically below

// Initialize Firebase Admin
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount as any),
  databaseURL: 'https://georgyo-avalon-default-rtdb.firebaseio.com'
});
// Import Avalon server logic after initialization
const avalon = require('./avalon-server');

const app = express();
app.use(express.json());
app.use(express.static('dist'));

const router = promiseRouter();

// Extend Request interface to include uid
interface AuthRequest extends Request {
  uid: string;
}

// Auth middleware
router.use((req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthRequest;
  const idToken = req.get('X-Avalon-Auth');
  if (!idToken) {
    throw new Error(`No auth info in request: ${req.method} ${req.path}`);
  }

  firebaseAdmin.auth().verifyIdToken(idToken)
    .then(decodedToken => {
      authReq.uid = decodedToken.uid;
      console.log('Request', req.method, req.path, authReq.uid, JSON.stringify(req.body));
      next();
    })
    .catch(next);
});

// Route handlers
router.post('/login', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.loginUser(req.body, authReq.uid).then(() => res.end());
});

router.post('/createLobby', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
return avalon.createLobby(req.body, authReq.uid).then((r: any) => res.json(r));
});

router.post('/joinLobby', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
return avalon.joinLobby(req.body, authReq.uid).then((r: any) => res.json(r));
});

router.post('/leaveLobby', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.leaveLobby(req.body, authReq.uid).then(() => res.end());
});

router.post('/kickPlayer', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.kickPlayer(req.body, authReq.uid).then(() => res.end());
});

router.post('/startGame', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.startGame(req.body, authReq.uid).then(() => res.end());
});

router.post('/cancelGame', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.cancelGame(req.body, authReq.uid).then(() => res.end());
});

router.post('/proposeTeam', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.proposeTeam(req.body, authReq.uid).then(() => res.end());
});

router.post('/voteTeam', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.voteTeam(req.body, authReq.uid).then(() => res.end());
});

router.post('/doMission', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.doMission(req.body, authReq.uid).then(() => res.end());
});

router.post('/assassinate', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  return avalon.assassinate(req.body, authReq.uid).then(() => res.end());
});

// Error handler
router.use((err: any, req: Request, res: Response, next: NextFunction) => {
  res.status(err.statusCode || 500);
  res.json({ message: err.message });
});

// Mount router
app.use('/api', router);

// Start server
const PORT = parseInt(process.env.PORT || '8001', 10);
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}...`);
});