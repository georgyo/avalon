const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const statsLib = require('./common/stats')

initializeApp();

const db = getFirestore();

exports.onLogCreate = onDocumentCreated('/logs/{logId}', async (event) => {
    const logId = event.params.logId;
    console.log("New game", logId);

    if (!event.data) {
        return;
    }

    // Cloud Functions events can be delivered more than once; claim the log
    // doc first so duplicate deliveries don't double-count stats.
    const logRef = event.data.ref;
    const alreadyProcessed = await db.runTransaction(async (txn) => {
        const snapshot = await txn.get(logRef);
        if (!snapshot.exists || snapshot.get('statsProcessed')) {
            return true;
        }
        txn.update(logRef, { statsProcessed: true });
        return false;
    });
    if (alreadyProcessed) {
        console.log("Stats already processed for", logId);
        return;
    }

    try {
        const stats = statsLib.computeStats(event.data.data());
        await statsLib.combineStats(db, stats, false);
    } catch (err) {
        // Release the claim so a retry/redelivery can reprocess this log,
        // otherwise a transient failure would permanently drop these stats.
        await logRef.update({ statsProcessed: FieldValue.delete() })
            .catch((cleanupErr) => console.error("Failed to release stats claim for", logId, cleanupErr));
        throw err;
    }
});
