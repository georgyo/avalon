// @ts-nocheck
/* eslint-disable */
import firebaseAdmin from 'firebase-admin';
import serviceAccount from './firebaseKey';
import fs from 'fs';

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount as any),
  databaseURL: 'https://georgyo-avalon-default-rtdb.firebaseio.com'
});

const db = firebaseAdmin.firestore();

// Import stats library if available
import statsLib = require('../firebase/functions/common/stats');

// Global pizza validator client
declare const ValidatorPizzaClient: any;

// Recursively delete users without an email
async function recursDeleteUsers(users: firebaseAdmin.auth.UserRecord[]): Promise<void> {
  console.log('Remaining', users.length);
  if (users.length === 0) {
    return;
  }
  const user = users.pop()!;
  if (!user.email) {
    await firebaseAdmin.auth().deleteUser(user.uid);
    console.log('Deleted user', user.uid);
    await recursDeleteUsers(users);
  } else {
    await recursDeleteUsers(users);
  }
}

// Recursively lookup users using pizza validation
async function recursLookupUsers(users: firebaseAdmin.auth.UserRecord[]): Promise<void> {
  if (users.length === 0) {
    return;
  }
  const user = users.pop()!;
  const domain = (user.email || '').split('@')[1] || '';
  const WHITELIST = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'];
  if (WHITELIST.includes(domain)) {
    return recursLookupUsers(users);
  }
  const client = new ValidatorPizzaClient();
  const response = await client.validate('domain', domain);
  if (!response.valid()) {
    console.log(user.email, user.uid, domain);
  }
  await recursLookupUsers(users);
}

// Export a single log snapshot to a file
function exportLogSnapshot(logSnapshot: FirebaseFirestore.DocumentSnapshot): void {
  const data = logSnapshot.data();
  if (!data) {
    return;
  }
  fs.writeFileSync(logSnapshot.id, JSON.stringify(data, null, ' '));
}

// Export all logs from Firestore
async function exportLogs(): Promise<void[]> {
  const snapshot = await db.collection('logs').get();
  return Promise.all(snapshot.docs.map(exportLogSnapshot));
}

// Export a specific log by ID
async function exportLog(logId: string): Promise<void> {
  const doc = await db.collection('logs').doc(logId).get();
  exportLogSnapshot(doc);
}

// Lookup all authenticated users
async function lookupUsers(): Promise<void> {
  const result = await firebaseAdmin.auth().listUsers(1000);
  return recursLookupUsers(result.users);
}

// Cleanup stale lobbies older than 2 days in INIT state or 7 days any state
async function cleanupLobbies(): Promise<FirebaseFirestore.WriteResult[] | void> {
  const batch = db.batch();
  const MAX_BATCH_SIZE = 300;
  let counter = 0;

  const snapshot = await db.collection('lobbies').get();
  for (const doc of snapshot.docs) {
    if (counter >= MAX_BATCH_SIZE) {
      break;
    }
    const ts = doc.get('timeCreated') as FirebaseFirestore.Timestamp;
    const ageInDays = (Date.now() - ts.toMillis()) / (1000 * 60 * 60 * 24);
    console.log(doc.id, 'is', ageInDays, 'days old');
    if ((ageInDays > 2 && doc.get('game').state === 'INIT') || ageInDays > 7) {
      counter++;
      console.log('Deleting lobby', doc.id);
      batch.delete(doc.ref);
    }
  }

  if (counter === 0) {
    console.log('Nothing to be done');
    return;
  } else {
    console.log('committing batch...');
    return batch.commit();
  }
}

// Cleanup logs older than 60 days
async function cleanupLogs(): Promise<FirebaseFirestore.WriteResult[] | void> {
  const batch = db.batch();
  const MAX_BATCH_SIZE = 300;
  let counter = 0;

  const snapshot = await db.collection('logs').get();
  for (const doc of snapshot.docs) {
    if (counter >= MAX_BATCH_SIZE) {
      break;
    }
    const ts = doc.get('timeCreated') as FirebaseFirestore.Timestamp;
    const ageInDays = (Date.now() - ts.toMillis()) / (1000 * 60 * 60 * 24);
    console.log(doc.id, 'is', ageInDays, 'days old');
    if (ageInDays > 60) {
      counter++;
      console.log('Deleting log', doc.id);
      batch.delete(doc.ref);
    }
  }

  if (counter === 0) {
    console.log('Nothing to be done');
    return;
  } else {
    console.log('committing batch...');
    return batch.commit();
  }
}

// Uncomment the following calls to run specific tasks:
// exportLogs().then(() => 0);
// exportLog('someLogId').then(() => 0);
// lookupUsers().then(() => 0);
// statsLib.recomputeAllStats(db);
// cleanupLogs().then(() => 0);
// cleanupLobbies().then(() => 0);