import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  AGAPE_DATABASE_PATH: z.string().default('var/agape.db'),
  // Signs CSRF and form tokens, derives emergency access tokens, hashes IP addresses.
  AGAPE_SECRET: z.string().default(''),
  AGAPE_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  // Further origins allowed to submit forms (comma-separated), e.g. the fly.dev hostname.
  AGAPE_EXTRA_ORIGINS: z.string().default(''),
  AGAPE_TRUST_PROXY: bool,

  // off: emergency volunteer requests cannot be submitted (the direct-call action stays).
  // pilot: submissions open, shown as a limited, unstaffed pilot.
  AGAPE_EMERGENCY_MODE: z.enum(['off', 'pilot']).default('off'),
  AGAPE_EMERGENCY_RESPONDER_MIN_ACCOUNT_AGE_HOURS: z.coerce.number().min(0).default(24),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),

  SMTP_URL: z.string().default(''),
  SMTP_FROM: z.string().default(''),

  AGAPE_DISABLE_WORKERS: bool,
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const e = EnvSchema.parse(env);
  const production = e.NODE_ENV === 'production';
  const secret = e.AGAPE_SECRET || (production ? '' : 'development-only-secret-do-not-use-in-production');
  if (production && secret.length < 32) {
    throw new Error('AGAPE_SECRET must be set to at least 32 random characters in production');
  }
  const publicUrl = new URL(e.AGAPE_PUBLIC_URL);
  if (production && publicUrl.protocol !== 'https:') {
    throw new Error('AGAPE_PUBLIC_URL must use https in production');
  }
  const origins = new Set([publicUrl.origin]);
  for (const o of e.AGAPE_EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    origins.add(new URL(o).origin);
  }
  const push = e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY && e.VAPID_SUBJECT
    ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT }
    : null;
  const email = e.SMTP_URL && e.SMTP_FROM ? { url: e.SMTP_URL, from: e.SMTP_FROM } : null;

  return {
    env: e.NODE_ENV,
    production,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databasePath: e.AGAPE_DATABASE_PATH,
    secret,
    publicUrl: publicUrl.origin,
    allowedOrigins: origins,
    secureCookies: publicUrl.protocol === 'https:',
    trustProxy: e.AGAPE_TRUST_PROXY,
    emergencyMode: e.AGAPE_EMERGENCY_MODE,
    responderMinAccountAgeMs: e.AGAPE_EMERGENCY_RESPONDER_MIN_ACCOUNT_AGE_HOURS * 3600_000,
    push,
    email,
    workers: !e.AGAPE_DISABLE_WORKERS && e.NODE_ENV !== 'test',
  };
}

/** Limits and retention periods. Documented in docs/PRIVACY.md and docs/OPERATIONS.md. */
export const POLICY = {
  sessionTtlMs: 30 * 24 * 3600_000,
  // An accepted call task with no reported contact after this long is shown as unconfirmed
  // and can be taken over by another volunteer.
  callConfirmationMs: 3 * 60_000,
  // Accepted CPR/AED tasks with no progress report after this long are shown as unconfirmed.
  onSceneConfirmationMs: 10 * 60_000,
  // Open emergencies untouched this long are listed for moderator review. Never closed automatically.
  emergencyStaleMs: 2 * 3600_000,
  helpRequestDefaultTtlMs: 14 * 24 * 3600_000,
  retention: {
    emergencySensitiveAfterCloseMs: 72 * 3600_000,
    emergencyRecordAfterCloseMs: 90 * 24 * 3600_000,
    helpSensitiveAfterCloseMs: 30 * 24 * 3600_000,
    helpRecordAfterCloseMs: 180 * 24 * 3600_000,
    accessLogMs: 90 * 24 * 3600_000,
    ipHashMs: 30 * 24 * 3600_000,
    notificationsMs: 60 * 24 * 3600_000,
  },
  limits: {
    emergencyPerConnection: { count: 3, windowMs: 30 * 60_000 },
    emergencyPerConnectionDay: { count: 6, windowMs: 24 * 3600_000 },
    signupPerConnection: { count: 5, windowMs: 3600_000 },
    loginPerConnection: { count: 20, windowMs: 15 * 60_000 },
    loginPerEmail: { count: 10, windowMs: 15 * 60_000 },
    helpRequestsPerUserDay: { count: 5, windowMs: 24 * 3600_000 },
    openHelpRequestsPerUser: 5,
    claimsPerUserDay: { count: 15, windowMs: 24 * 3600_000 },
    emergencyClaimsPerUserHour: { count: 6, windowMs: 3600_000 },
    discoveryPerUserHour: { count: 300, windowMs: 3600_000 },
    messagesPerUserHour: { count: 60, windowMs: 3600_000 },
    reportsPerUserDay: { count: 20, windowMs: 24 * 3600_000 },
  },
  notify: {
    maxVolunteersPerHelpRequest: 25,
    maxVolunteersPerEmergency: 30,
    retryDelaysMs: [30_000, 120_000, 600_000, 1_800_000],
    emergencyRetryDelaysMs: [15_000, 45_000],
  },
} as const;
