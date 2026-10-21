const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse durations like "15m", "7d", "30s" into milliseconds. */
export function durationToMs(value) {
  const match = /^(\d+)\s*([smhd])$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNITS[match[2]];
}

export const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000);
