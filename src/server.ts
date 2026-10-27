import { loadConfig } from './config.js';
import { migrate, openDatabase } from './db/index.js';
import type { Ctx } from './domain/core.js';
import { runMaintenance } from './domain/maintenance.js';
import { processDeliveries } from './domain/notifications.js';
import { systemClock } from './lib/clock.js';
import { createSenders } from './senders.js';
import { buildApp } from './web/app.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
migrate(db);
const ctx: Ctx = { db, clock: systemClock, config };
const senders = createSenders(config);
const app = await buildApp({ ctx, senders });

const timers: NodeJS.Timeout[] = [];
if (config.workers) {
  const safe = (name: string, fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (err) {
      app.log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, `${name} failed`);
    }
  };
  timers.push(setInterval(safe('deliveries', () => processDeliveries(ctx, senders)), 5_000));
  timers.push(setInterval(safe('maintenance', () => runMaintenance(ctx)), 60_000));
  void safe('maintenance', () => runMaintenance(ctx))();
  void safe('deliveries', () => processDeliveries(ctx, senders))();
}

app.log.info({
  emergencyMode: config.emergencyMode, push: !!config.push, email: !!config.email, publicUrl: config.publicUrl,
}, 'starting Agape');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: shutting down`);
  for (const t of timers) clearInterval(t);
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
