// Settings come from `.env` (loaded by `tsx --env-file` for scripts, and by the
// server at startup). `.env.example` lists every variable; a new one goes in both.

/** A required setting from the environment; fails with the fix when it is missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}: copy .env.example to .env and fill it in.`);
  }
  return value;
}
