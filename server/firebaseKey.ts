import { readEnv } from 'read-env';

const firebaseKeyJson: string = process.env.FIREBASE_KEY_FILE || './firebase-key.json';
const serviceAccount: any = readEnv('FIREBASE_KEY')[''] || require(firebaseKeyJson);

export default serviceAccount;
