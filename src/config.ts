const DEFAULT_PORT = 3000;

export const PORT = Number(process.env.PORT) || DEFAULT_PORT;

/** build/sync.js updates the data once a day, so browsers and proxies may keep an answer for a while. */
export const CACHE_MAX_AGE_SECONDS = 10 * 60;

/** On a startup failure wait this long before exiting, so the process manager does not restart in a tight loop. */
export const STARTUP_RETRY_DELAY_MS = 60 * 1000;
