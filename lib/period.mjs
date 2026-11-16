/**
 * Reporting periods: --this-month (the default), --last-month, --month, --this-year, --last-year, --year,
 * --last-12-months, --all, or an explicit --since/--until. All in local time, as YYYY-MM-DD bounds.
 */

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ym = (y, m) => { // m may run past 0..11
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(y, m, 0).getDate())}`;
};

export const PERIOD_FLAGS = ['this-month', 'last-month', 'month', 'this-year', 'last-year', 'year', 'last-12-months', 'all'];

/** "Today" — overridable for tests with RLS_CLAUDE_USAGE_TODAY=YYYY-MM-DD. */
export function today() {
  const fixed = process.env.RLS_CLAUDE_USAGE_TODAY;
  if (fixed) {
    const [y, m, d] = fixed.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date();
}

/**
 * The period the options ask for: { since, until, label, yearly } (since/until null when open;
 * yearly: long enough for a per-month breakdown).
 * Throws on conflicting or malformed options.
 */
export function resolvePeriod(o, now = today()) {
  const given = PERIOD_FLAGS.filter((k) => o[k] !== undefined && o[k] !== false);
  if (given.length > 1) throw new Error(`--${given.join(', --')}: pick one period`);
  if (given.length && (o.since || o.until)) throw new Error(`--${given[0]} and --since/--until: pick one`);
  if (o.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(o.month)) throw new Error(`--month ${o.month}: expected YYYY-MM`);
  if (o.year !== undefined && !/^\d{4}$/.test(o.year)) throw new Error(`--year ${o.year}: expected YYYY`);

  const y = now.getFullYear();
  const m = now.getMonth();
  const month = (key, label) => ({ since: `${key}-01`, until: lastDay(key), label: `${key} (${label})`, yearly: false });
  const year = (yy, label) => ({ since: `${yy}-01-01`, until: `${yy}-12-31`, label: `${yy} (${label})`, yearly: true });

  switch (given[0]) {
    case 'last-month': return month(ym(y, m - 1), 'last month');
    case 'month': return month(o.month, 'month');
    case 'this-year': return { ...year(y, 'this year'), until: ymd(now), label: `${y}-01-01 – ${ymd(now)} (this year)` };
    case 'last-year': return year(y - 1, 'last year');
    case 'year': return year(o.year, 'year');
    case 'last-12-months': {
      const since = `${ym(y, m - 11)}-01`;
      return { since, until: ymd(now), label: `${since} – ${ymd(now)} (last 12 months)`, yearly: true };
    }
    case 'all': return { since: null, until: null, label: 'all history', yearly: true };
    case 'this-month': return month(ym(y, m), 'this month');
  }
  if (o.since || o.until) {
    return { since: o.since ?? null, until: o.until ?? null, label: `${o.since ?? '…'} – ${o.until ?? '…'}`, yearly: true };
  }
  if (o.session) return { since: null, until: null, label: 'all history', yearly: true }; // an id lookup: don't hide it by date
  return month(ym(y, m), 'this month');
}

/** Every YYYY-MM from `from` to `to` inclusive. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let key = ym(y, m - 1); key <= to; key = ym(y, m - 1)) {
    out.push(key);
    m++;
  }
  return out;
}
