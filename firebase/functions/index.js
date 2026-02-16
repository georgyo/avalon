const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const statsLib = require('./common/stats')

initializeApp();

const db = getFirestore();

exports.onLogCreate = onDocumentCreated('/logs/{logId}', async (event) => {
    const logId = event.params.logId;
    console.log("New game", logId);

    const docSnapshot = await db.collection('logs').doc(logId).get();
    const data = docSnapshot.data();

    console.log(data);

    const stats = statsLib.computeStats(data);

    return statsLib.combineStats(db, stats, false);
});
