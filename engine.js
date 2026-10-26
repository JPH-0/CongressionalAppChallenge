const ALPHA = 0.3;            // how much the newest session counts (0 to 1)
const MIN_SAMPLES = 2;        // sessions needed at an hour before we trust it
const DEFAULT_MINUTES = 45;   // guess for hours you have never tried
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------- DATES ----------
export function toISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
}

export function weekdayOf(iso) {
    return new Date(iso + "T00:00:00").getDay();
}

export function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
}

export function prettyDate(iso) {
    const d = new Date(iso + "T00:00:00");
    return DAY_NAMES[d.getDay()].slice(0, 3) + " " + (d.getMonth() + 1) + "/" + d.getDate();
}

// ---------- LIMITS: is this hour free on this date? ----------
export function isAsleep(limits, hour) {
    const { bedtime, wake } = limits;
    if (bedtime === wake) return false;
    // bedtime 22, wake 7 wraps past midnight; bedtime 1, wake 7 does not
    return bedtime > wake ? (hour >= bedtime || hour < wake) : (hour >= bedtime && hour < wake);
}
//--Bug located HERE!!!!!! :( --- 
export function isBlocked(limits, iso, hour) {
    const day = weekdayOf(iso);
    const weekly = limits.weekly.some(function (b) {
        return b.day === day && hour >= b.start && hour < b.end;
    });
    const dated = limits.dates.some(function (b) {
        return b.date === iso && hour >= b.start && hour < b.end;
    });
    return weekly || dated;
}

export function isFree(limits, iso, hour) {
    return !isAsleep(limits, hour) && !isBlocked(limits, iso, hour);
}

// the hours a session touches, or null if it runs past midnight
export function spanOf(startHour, minutes) {
    const last = Math.ceil((startHour * 60 + minutes) / 60) - 1;
    if (last > 23) return null;
    const hours = [];
    for (let h = startHour; h <= last; h++) hours.push(h);
    return hours;
}

// the whole session has to fit: every hour from the start to the end must be free
export function fits(limits, iso, startHour, minutes) {
    const span = spanOf(startHour, minutes);
    return span !== null && span.every(function (h) { return isFree(limits, iso, h); });
}

// ---------- LEARNING: EMA of minutes taken, per starting hour ----------
export function scoreHours(sessions) {
    const stats = {};
    sessions.forEach(function (s) {
        if (!stats[s.hour]) {
            stats[s.hour] = { avg: s.minutes, count: 1 };
        } else {
            stats[s.hour].avg = ALPHA * s.minutes + (1 - ALPHA) * stats[s.hour].avg;
            stats[s.hour].count++;
        }
    });
    return stats;
}

// hours to try, best first: learned hours (fastest first), then afternoon, then the rest
export function hourPreference(sessions) {
    const stats = scoreHours(sessions);
    const learned = Object.keys(stats)
        .filter(function (k) { return stats[k].count >= MIN_SAMPLES; })
        .sort(function (a, b) { return stats[a].avg - stats[b].avg; })
        .map(Number);

    const order = learned.slice();
    for (let h = 15; h <= 19; h++) if (order.indexOf(h) === -1) order.push(h);
    for (let h = 0; h < 24; h++) if (order.indexOf(h) === -1) order.push(h);
    return { order: order, stats: stats, learned: learned };
}

// best single hour for a date (used by the weekly popup); null = not available
export function bestHourFor(limits, sessions, iso, earliestHour) {
    const pref = hourPreference(sessions);
    for (let i = 0; i < pref.order.length; i++) {
        const h = pref.order[i];
        const known = pref.learned.indexOf(h) !== -1;
        const minutes = known ? Math.round(pref.stats[h].avg) : DEFAULT_MINUTES;
        // only suggest untried hours in the afternoon/evening, not at 3 AM
        if (!known && (h < 15 || h > 19)) continue;
        if (h < earliestHour) continue;
        if (fits(limits, iso, h, minutes)) return { hour: h, minutes: minutes, known: known };
    }
    return null;
}

// place each assignment into a free slot on this date, without overlapping
export function scheduleDay(limits, sessions, iso, earliestHour, items) {
    const pref = hourPreference(sessions);
    const taken = {};
    const placed = [];

    items.forEach(function (item) {
        let slot = null;
        for (let i = 0; i < pref.order.length && slot === null; i++) {
            const h = pref.order[i];
            if (h < earliestHour || !fits(limits, iso, h, item.minutes)) continue;
            const span = spanOf(h, item.minutes);
            if (span.some(function (x) { return taken[x]; })) continue;
            span.forEach(function (x) { taken[x] = true; });
            slot = h;
        }
        placed.push({ item: item, hour: slot });
    });
    return placed;
}

// one entry per day, starting from today; best is null when nothing fits
export function weeklySchedule(limits, sessions) {
    const now = new Date();
    const week = [];
    for (let i = 0; i < 7; i++) {
        const date = addDays(now, i);
        const earliest = i === 0 ? now.getHours() + 1 : 0;   // today: only hours still ahead
        week.push({ date: date, best: bestHourFor(limits, sessions, toISO(date), earliest) });
    }
    return week;
}

// ---------- FORMATTING ----------
export function formatHour(h) {
    const suffix = h >= 12 && h < 24 ? "PM" : "AM";
    return (h % 12 || 12) + ":00 " + suffix;
}

export function formatClock(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = String(totalMinutes % 60).padStart(2, "0");
    const suffix = h >= 12 && h < 24 ? "PM" : "AM";
    return (h % 12 || 12) + ":" + m + " " + suffix;
}
