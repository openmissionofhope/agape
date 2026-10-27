// Operator commands. On Fly.io: fly ssh console -C "node dist/cli.js <command>"
import webpush from 'web-push';
import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db/index.js';
import type { Ctx } from './domain/core.js';
import { runMaintenance } from './domain/maintenance.js';
import { getUserByEmail, setRole, type User } from './domain/users.js';
import { systemClock } from './lib/clock.js';

const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.log(`Usage: node dist/cli.js <command>

  migrate                         apply database migrations
  set-role <email> <role>         role: member | moderator | admin
  maintenance                     run expiry and retention once
  backup <path>                   write a consistent copy of the database
  generate-vapid-keys             print a VAPID key pair for push notifications`);
  process.exit(2);
}

if (command === 'generate-vapid-keys') {
  const keys = webpush.generateVAPIDKeys();
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
  process.exit(0);
}
if (!command) usage();

const config = loadConfig();
const db = openDatabase(config.databasePath);
const ctx: Ctx = { db, clock: systemClock, config };

switch (command) {
  case 'migrate':
    console.log('applied migrations:', migrate(db));
    break;
  case 'set-role': {
    const [email, role] = args;
    if (!email || !role) usage();
    const user = getUserByEmail(ctx, email);
    if (!user) throw new Error(`no account with email ${email}`);
    setRole(ctx, null, user.id, role as User['role']);
    console.log(`${email} is now ${role}`);
    break;
  }
  case 'maintenance':
    console.log(runMaintenance(ctx));
    break;
  case 'backup': {
    const [path] = args;
    if (!path) usage();
    await db.backup(path);
    console.log(`backup written to ${path}`);
    break;
  }
  default:
    usage();
}
db.close();
