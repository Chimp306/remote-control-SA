// Run locally with the password on stdin. Prints only the derived verifier;
// never writes or logs the password. Store the result in the service-only DB.
import { randomBytes, pbkdf2Sync } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '');
if (!password || password.length > 256) throw new Error('A password is required on stdin');
const salt = randomBytes(32);
const iterations = 600000;
const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
console.log(JSON.stringify({ password_salt: salt.toString('hex'), password_hash: derived.toString('hex'), iterations }));
