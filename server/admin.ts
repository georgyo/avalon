import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import './firebaseKey'; // must be imported first to initialize Firebase

import fs from 'fs';

const db = getFirestore();

// @ts-expect-error - statsLib is untyped
import statsLib from '../firebase/functions/common/stats.js';

function _recursDeleteUsers(users: { uid: string; email?: string }[]): Promise<void> | void {
  console.log('Remaining', users.length);
  if (users.length == 0) return;
  const user = users.pop()!;
  if (!user.email) {
    return getAuth().deleteUser(user.uid).then(function() {
      console.log("Deleted user", user.uid);
      return _recursDeleteUsers(users);
    });
  } else {
    return _recursDeleteUsers(users);
  }
}

function _recursLookupUsers(users: { email: string; uid: string }[]): void {
  if (users.length == 0) return;
  const user = users.pop()!;
  const domain = user.email.split('@')[1];
  const WHITELIST = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'];
  if (WHITELIST.includes(domain)) {
    return _recursLookupUsers(users);
  }
  // ValidatorPizzaClient is not defined - this function is broken
  console.log('Would validate:', user.email, user.uid, domain);
}

function _exportLogSnapshot(logSnapshot: FirebaseFirestore.DocumentSnapshot): void {
    const data = logSnapshot.data();
    fs.writeFileSync(logSnapshot.id, JSON.stringify(data, null, ' '));
}

function _exportLogs(): Promise<void[]> {
  return db.collection('logs').get().then(snapshot => Promise.all(snapshot.docs.map(_exportLogSnapshot)));
}

function _exportLog(logId: string): Promise<void> {
  return db.collection('logs').doc(logId).get().then(_exportLogSnapshot);
}

//_exportLogs().then(() => 0);

function _lookupUsers(): Promise<void> {
 return getAuth().listUsers(1000).then(function(users) {
    return _recursLookupUsers(users.users as unknown as { email: string; uid: string }[]);
  });
}

//_lookupUsers().then(() => 0);

//db.collection('logs').doc('2020-04-08T16:26:17.145Z_HLW').get().then(doc => exports.computeStats(doc.data())).then(stats => exports.combineStats(stats, true));

//statsLib.recomputeAllStats(db);

function _cleanupLobbies(): Promise<void> {
  const batch = db.batch();
  const MAX_BATCH_SIZE = 300;
  let counter = 0;

  return db.collection('lobbies').get().then(
    function(querySnapshot) {
      querySnapshot.forEach(function(queryDocumentSnapshot) {
        if (counter >= MAX_BATCH_SIZE) return;

        const lobbyCreatedTimestamp = queryDocumentSnapshot.get("timeCreated").toMillis();
        const ageInDays = (Date.now() - lobbyCreatedTimestamp) / (1000 * 60 * 60 * 24);
        console.log(queryDocumentSnapshot.id, "is", ageInDays, "days old");
        if (((ageInDays > 2) && (queryDocumentSnapshot.get("game").state == 'INIT')) || (ageInDays > 7)) {
          counter++;
          console.log("Deleting lobby " + queryDocumentSnapshot.id);
          batch.delete(queryDocumentSnapshot.ref);
          // XXX this is bad since the user record will still point here
        }
      });
    }).then(function() {
      if (counter == 0) {
        console.log('Nothing to be done');
      } else {
        console.log("committing batch...");
        return batch.commit().then(() => {});
      }
    });
}

async function _cleanupStaleLobbies(): Promise<void> {
  const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - THREE_MONTHS_MS;
  const MAX_OPS_PER_BATCH = 500;

  // Server-side filter: only fetch lobbies older than the cutoff
  const staleLobbiesSnapshot = await db.collection('lobbies')
    .where('timeCreated', '<', Timestamp.fromMillis(cutoff))
    .get();

  if (staleLobbiesSnapshot.empty) {
    console.log('No stale lobbies found');
    return;
  }

  console.log(`\nFound ${staleLobbiesSnapshot.size} stale lobbies. Deleting in batches...\n`);

  let batch = db.batch();
  let opsInBatch = 0;
  let batchNumber = 1;
  let totalDeleted = 0;
  let totalUsersUpdated = 0;
  let totalRolesDeleted = 0;
  const userUidsInBatch = new Set<string>();

  async function flushBatch(): Promise<void> {
    console.log(`Committing batch ${batchNumber} (${opsInBatch} operations)...`);
    await batch.commit();
    batch = db.batch();
    opsInBatch = 0;
    batchNumber++;
    userUidsInBatch.clear();
  }

  for (const lobbyDoc of staleLobbiesSnapshot.docs) {
    const lobbyId = lobbyDoc.id;
    const createdMs = lobbyDoc.get('timeCreated').toMillis();
    const ageInDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    console.log(lobbyId, 'is', Math.round(ageInDays), 'days old - STALE');

    const users = lobbyDoc.get('users') as Record<string, { uid: string; name: string }> | undefined;
    const userUids = users ? [...new Set(Object.values(users).map(u => u.uid))] : [];

    const rolesDocs = await lobbyDoc.ref.collection('roles').listDocuments();

    // Delete role subcollection docs, flushing as needed
    for (const roleDocRef of rolesDocs) {
      if (opsInBatch >= MAX_OPS_PER_BATCH) {
        await flushBatch();
      }
      batch.delete(roleDocRef);
      opsInBatch++;
      totalRolesDeleted++;
    }

    // Update user docs: only clear lobby if it still points to this stale lobby
    for (const uid of userUids) {
      // Flush if this UID was already written in the current batch
      if (userUidsInBatch.has(uid)) {
        await flushBatch();
      }
      if (opsInBatch >= MAX_OPS_PER_BATCH) {
        await flushBatch();
      }

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists && userDoc.get('lobby') === lobbyId) {
        batch.set(userRef, { lobby: FieldValue.delete() }, { merge: true });
        opsInBatch++;
        totalUsersUpdated++;
        userUidsInBatch.add(uid);
      }
    }

    // Delete the lobby document itself
    if (opsInBatch >= MAX_OPS_PER_BATCH) {
      await flushBatch();
    }
    batch.delete(lobbyDoc.ref);
    opsInBatch++;
    totalDeleted++;
    console.log(`Queued deletion: lobby ${lobbyId} (${userUids.length} users, ${rolesDocs.length} role docs)`);
  }

  if (opsInBatch > 0) {
    console.log(`Committing batch ${batchNumber} (${opsInBatch} operations)...`);
    await batch.commit();
  }

  console.log(`\nDone. Deleted ${totalDeleted} lobbies, updated ${totalUsersUpdated} users, deleted ${totalRolesDeleted} role docs.`);
}

// XXX welp, this is an exact copy of the function above. Should probably extract it?
function _cleanupLogs(): Promise<void> {
  const batch = db.batch();
  const MAX_BATCH_SIZE = 300;
  let counter = 0;

  return db.collection('logs').get().then(
    function(querySnapshot) {
      querySnapshot.forEach(function(queryDocumentSnapshot) {
        if (counter >= MAX_BATCH_SIZE) return;

        const lobbyCreatedTimestamp = queryDocumentSnapshot.get("timeCreated").toMillis();
        const ageInDays = (Date.now() - lobbyCreatedTimestamp) / (1000 * 60 * 60 * 24);
        console.log(queryDocumentSnapshot.id, "is", ageInDays, "days old");
        if (ageInDays > 60) {
          counter++;
          console.log("Deleting log " + queryDocumentSnapshot.id);
          batch.delete(queryDocumentSnapshot.ref);
        }
      });
    }).then(function() {
      if (counter == 0) {
        console.log('Nothing to be done');
      } else {
        console.log("committing batch...");
        return batch.commit().then(() => {});
      }
    });
}

//_cleanupLogs().then(() => 0);
//_cleanupLobbies().then(() => 0);

// Keep unused refs to suppress lint while maintaining access for manual use
void _recursDeleteUsers;
void _recursLookupUsers;
void _exportLogs;
void _exportLog;
void _lookupUsers;
void _cleanupLobbies;
void _cleanupStaleLobbies;
void _cleanupLogs;
void statsLib;
