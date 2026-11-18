import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const STATE_PATH = path.join(ROOT_DIR, "state.json");
const ICS_PATH = path.join(ROOT_DIR, "deadlines.ics");

const TRACKR_SOURCES = [
  {
    url: "https://app.the-trackr.com/uk-finance/summer-internships",
    detail: "The Trackr • UK Finance",
    defaultSector: "Corporate & Investment Banking"
  },
  {
    url: "https://app.the-trackr.com/uk-consulting/summer-internships",
    detail: "The Trackr • UK Consulting",
    defaultSector: "Strategy & Consulting"
  }
];

const TARGET_KEYWORDS = [
  "corporate banking",
  "specialist coverage",
  "investment management",
  "asset management",
  "sales & trading",
  "sales and trading",
  "markets",
  "investment banking",
  "consulting",
  "advisory",
  "private markets",
  "wealth management",
  "capital markets",
  "research",
  "summer",
  "2027"
];

function makeRecSlug(company, role) {
  return `${String(company || "").toLowerCase().trim()}::${String(role || "").toLowerCase().trim()}`;
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseDateToIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Relative dates like "Today", "Yesterday", "2 days ago", "3d ago"
  const now = new Date();
  const lower = s.toLowerCase();
  if (lower.includes("today") || lower.includes("just now") || /\b\d+\s*h(ours?)?\s*ago\b/.test(lower)) {
    return now.toISOString().slice(0, 10);
  }
  if (lower.includes("yesterday")) {
    const d = new Date(now.getTime() - 86400000);
    return d.toISOString().slice(0, 10);
  }
  const relDays = lower.match(/(\d+)\s*d(?:ays?)?\s*ago/);
  if (relDays) {
    const d = new Date(now.getTime() - Number(relDays[1]) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  // DD/MM/YYYY or DD Mon YYYY or Mon DD, YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function inferSector(text, fallback) {
  const t = String(text || "").toLowerCase();
  if (t.includes("consult") || t.includes("strategy") || t.includes("advisory")) return "Strategy & Consulting";
  if (t.includes("sales") || t.includes("trading") || t.includes("markets") || t.includes("equities") || t.includes("fixed income")) return "Sales & Trading";
  if (t.includes("investment management") || t.includes("asset management") || t.includes("wealth") || t.includes("private markets")) return "Investment Management";
  if (t.includes("corporate banking") || t.includes("investment banking") || t.includes("coverage") || t.includes("capital markets") || t.includes("m&a")) return "Corporate & Investment Banking";
  return fallback;
}

function isWithinLastDays(isoDate, days = 4) {
  if (!isoDate) return false;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return false;
  const targetUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const diffDays = (todayUtc - targetUtc) / 86400000;
  return diffDays >= -1 && diffDays <= days;
}

function extractCandidatesFromJson(payload, sourceMeta) {
  const results = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object") {
      const company = node.company?.name || node.companyName || node.employer || node.firm || (typeof node.company === "string" ? node.company : null);
      const role = node.programme || node.program || node.title || node.role || node.name;
      const openedRaw = node.openingDate || node.openedDate || node.openDate || node.opened_at || node.opening_date || node.createdAt;
      if (company && role && openedRaw && typeof role === "string" && role.length >= 4) {
        const closingRaw = node.closingDate || node.closeDate || node.deadline || node.closing_date || "Rolling Deadline";
        const applyLink = node.url || node.applyUrl || node.applicationUrl || node.link || sourceMeta.url;
        const division = node.division || node.category || node.track || "";
        const combined = `${company} ${role} ${division}`.toLowerCase();
        if (!combined.includes("2025") && !combined.includes("2026") && (combined.includes("2027") || combined.includes("summer") || combined.includes("intern"))) {
          const openedDate = parseDateToIso(openedRaw);
          const closingIso = parseDateToIso(closingRaw);
          results.push({
            company: String(company).trim(),
            role: String(role).trim(),
            division: String(division || "").trim(),
            openedDate,
            closingDate: closingIso || (String(closingRaw).toLowerCase().includes("rolling") ? "Rolling Deadline" : String(closingRaw).trim() || "Rolling Deadline"),
            applyLink: String(applyLink).startsWith("http") ? String(applyLink) : sourceMeta.url,
            sourceDetail: division ? `${sourceMeta.detail} (${division})` : sourceMeta.detail,
            sector: inferSector(`${role} ${division}`, sourceMeta.defaultSector)
          });
        }
      }
      for (const val of Object.values(node)) {
        if (val && typeof val === "object") visit(val);
      }
    }
  };
  visit(payload);
  return results;
}

async function scrapeTrackrSource(context, sourceMeta) {
  const page = await context.newPage();
  const captured = [];

  page.on("response", async (res) => {
    try {
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("application/json") && res.status() === 200) {
        const json = await res.json();
        const found = extractCandidatesFromJson(json, sourceMeta);
        if (found.length > 0) captured.push(...found);
      }
    } catch {
      // Ignore non-JSON or aborted responses
    }
  });

  try {
    console.log(`Visiting ${sourceMeta.url} ...`);
    await page.goto(sourceMeta.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4500);

    // Also scrape visible DOM table rows / cards as a resilient fallback
    const domRows = await page.evaluate((meta) => {
      const rows = [];
      const trNodes = Array.from(document.querySelectorAll("table tbody tr, [role='row']"));
      for (const tr of trNodes) {
        const cells = Array.from(tr.querySelectorAll("td, [role='cell']")).map((c) => c.innerText.trim()).filter(Boolean);
        if (cells.length < 3) continue;
        const linkEl = tr.querySelector("a[href^='http']");
        rows.push({
          cells,
          text: tr.innerText.trim(),
          href: linkEl ? linkEl.href : meta.url
        });
      }
      return rows;
    }, sourceMeta);

    for (const row of domRows) {
      const [company, role, ...rest] = row.cells;
      if (!company || !role) continue;
      const lower = row.text.toLowerCase();
      if (!TARGET_KEYWORDS.some((kw) => lower.includes(kw))) continue;
      const dateMatches = rest
        .map((c) => ({ raw: c, iso: parseDateToIso(c) }))
        .filter((d) => d.iso);
      const openedDate = dateMatches[0]?.iso || null;
      const closingDate = dateMatches[1]?.iso || (lower.includes("rolling") ? "Rolling Deadline" : "Rolling Deadline");
      if (openedDate) {
        captured.push({
          company,
          role,
          division: rest[0] || "",
          openedDate,
          closingDate,
          applyLink: row.href || sourceMeta.url,
          sourceDetail: sourceMeta.detail,
          sector: inferSector(row.text, sourceMeta.defaultSector)
        });
      }
    }
  } catch (err) {
    console.warn(`Warning while scraping ${sourceMeta.url}: ${err.message}`);
  } finally {
    await page.close();
  }

  return captured;
}

// ---------- RFC 5545 iCalendar Generator (deadlines.ics) ----------
function icsEscape(text) {
  if (!text) return "";
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

function foldLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    if (curBytes + len > 75) {
      parts.push(cur);
      cur = " " + ch;
      curBytes = 1 + len;
    } else {
      cur += ch;
      curBytes += len;
    }
  }
  if (cur) parts.push(cur);
  return parts.join("\r\n");
}

function buildValarms(summaryText) {
  const esc = icsEscape(summaryText);
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:24-Hour Reminder: ${esc}`,
    "TRIGGER:-PT24H",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:2-Hour Urgent Reminder: ${esc}`,
    "TRIGGER:-PT2H",
    "END:VALARM"
  ];
}

function formatIcsLocal(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}T${p(dt.getHours())}${p(dt.getMinutes())}${p(dt.getSeconds())}`;
}

function generateIcsFromState(state) {
  const apps = Array.isArray(state.applications) ? state.applications : [];
  const recs = state.recommendationsPaused || state.offerAccepted ? [] : (Array.isArray(state.recommendations) ? state.recommendations : []);
  const handledSet = new Set([...(state.handledRecIds || []), ...(state.dismissedIds || [])]);
  const appSlugs = new Set(apps.map((a) => makeRecSlug(a.company || a.firm, a.role)));

  const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ramis Ahmad//2027 Application Tracker//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:2027 Application Tracker Deadlines",
    "X-WR-TIMEZONE:Europe/London",
    "X-WR-CALDESC:Upcoming Online Assessments, HireVue/Video Interviews, Assessment Centres, and 2027 Summer Internship Closing Dates",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/London",
    "X-LIC-LOCATION:Europe/London",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:BST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ];

  let eventCount = 0;

  for (const app of apps) {
    if (!app.deadline) continue;
    if (app.stage === "Closed / Unsuccessful" || app.stage === "Offer / Successful") continue;
    const raw = String(app.deadline).trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) continue;
    const endDt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 17), Number(m[5] || 0), Number(m[6] || 0));
    const startDt = new Date(endDt.getTime() - 3600000);
    const sub = app.subStatus || app.stage || "Assessment Deadline";
    const lower = `${sub} ${app.stage || ""}`.toLowerCase();
    const prefix = (lower.includes("interview") || lower.includes("hirevue") || lower.includes("assessment centre") || lower.includes("superday"))
      ? "INTERVIEW"
      : "DEADLINE";
    const summary = `${prefix}: ${app.company} — ${sub}`;
    const desc = [
      `Company: ${app.company}`,
      `Role: ${app.role}`,
      `Sector: ${app.sector || ""}`,
      `Stage: ${app.stage || ""}`,
      `Status: ${sub}`,
      app.portalLink ? `Portal Link: ${app.portalLink}` : "",
      app.notes ? `Notes: ${app.notes}` : ""
    ].filter(Boolean).join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:app-deadline-${app.id}@grad-tracker-2027.github.io`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Europe/London:${formatIcsLocal(startDt)}`,
      `DTEND;TZID=Europe/London:${formatIcsLocal(endDt)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      "STATUS:CONFIRMED"
    );
    if (app.portalLink && String(app.portalLink).startsWith("http")) {
      lines.push(`URL:${app.portalLink}`);
    }
    lines.push(...buildValarms(summary), "END:VEVENT");
    eventCount++;
  }

  for (const rec of recs) {
    const slug = makeRecSlug(rec.company, rec.role);
    if (handledSet.has(rec.id) || handledSet.has(slug) || appSlugs.has(slug)) continue;
    const closing = String(rec.closingDate || "").trim();
    const m = closing.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const endDt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0);
    const startDt = new Date(endDt.getTime() - 3600000);
    const summary = `CLOSING DATE: ${rec.company} — ${rec.role}`;
    const desc = [
      `Recommended Role (${rec.sourceDetail || rec.source || "Trackr"})`,
      `Company: ${rec.company}`,
      `Role: ${rec.role}`,
      `Sector: ${rec.sector || ""}`,
      `Opened: ${rec.openedDate || ""}`,
      `Closing Date: ${closing}`,
      rec.applyLink ? `Apply Link: ${rec.applyLink}` : "",
      rec.notes ? `Notes: ${rec.notes}` : ""
    ].filter(Boolean).join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:rec-closing-${rec.id}@grad-tracker-2027.github.io`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Europe/London:${formatIcsLocal(startDt)}`,
      `DTEND;TZID=Europe/London:${formatIcsLocal(endDt)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      "STATUS:CONFIRMED"
    );
    if (rec.applyLink && String(rec.applyLink).startsWith("http")) {
      lines.push(`URL:${rec.applyLink}`);
    }
    lines.push(...buildValarms(summary), "END:VEVENT");
    eventCount++;
  }

  lines.push("END:VCALENDAR");
  return { content: lines.map(foldLine).join("\r\n") + "\r\n", eventCount };
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  state.applications = Array.isArray(state.applications) ? state.applications : [];
  state.recommendations = Array.isArray(state.recommendations) ? state.recommendations : [];
  state.handledRecIds = Array.isArray(state.handledRecIds) ? state.handledRecIds : [];

  const isPaused = Boolean(
    state.recommendationsPaused ||
    state.offerAccepted ||
    state.cycleArchive?.offerAccepted ||
    state.cycleArchive?.archived
  );

  let addedCount = 0;

  if (isPaused) {
    console.log("Recommendations paused (offer accepted or cycle archived). Skipping Trackr scrape.");
  } else {
    const handledSet = new Set([...(state.handledRecIds || []), ...(state.dismissedIds || [])]);
    const existingSlugs = new Set([
      ...state.applications.map((a) => makeRecSlug(a.company || a.firm, a.role)),
      ...state.recommendations.map((r) => makeRecSlug(r.company || r.firm, r.role))
    ]);
    const existingRecIds = new Set(state.recommendations.map((r) => r.id));

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        locale: "en-GB",
        timezoneId: "Europe/London"
      });

      const scraped = [];
      for (const src of TRACKR_SOURCES) {
        const items = await scrapeTrackrSource(context, src);
        scraped.push(...items);
      }

      console.log(`Scraped ${scraped.length} candidate rows across Trackr UK Finance & Consulting.`);

      for (const item of scraped) {
        if (!isWithinLastDays(item.openedDate, 4)) continue;
        const slug = makeRecSlug(item.company, item.role);
        const recId = `rec-trackr-${slugify(item.company)}-${slugify(item.role).slice(0, 20)}-2027`;
        if (handledSet.has(recId) || handledSet.has(slug) || existingSlugs.has(slug) || existingRecIds.has(recId)) {
          continue;
        }
        existingSlugs.add(slug);
        existingRecIds.add(recId);
        state.recommendations.unshift({
          id: recId,
          source: "Trackr",
          sourceDetail: item.sourceDetail,
          company: item.company,
          role: item.role,
          sector: item.sector,
          openedDate: item.openedDate,
          closingDate: item.closingDate || "Rolling Deadline",
          applyLink: item.applyLink,
          notes: `Auto-discovered via GitHub Actions Daily Trackr Scrape (opened ${item.openedDate}).`
        });
        addedCount++;
      }
    } finally {
      await browser.close();
    }
  }

  if (addedCount > 0) {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
    console.log(`Added ${addedCount} newly opened Trackr role(s) to state.json.`);
  } else {
    console.log("No brand-new Trackr roles opened in the last 4 days.");
  }

  const { content: icsContent, eventCount } = generateIcsFromState(state);
  const existingIcs = fs.existsSync(ICS_PATH) ? fs.readFileSync(ICS_PATH, "utf8") : "";
  // Compare ignoring DTSTAMP line so we don't make empty timestamp-only commits
  const stripStamp = (s) => s.replace(/^DTSTAMP:.*$/gm, "");
  if (stripStamp(existingIcs) !== stripStamp(icsContent)) {
    fs.writeFileSync(ICS_PATH, icsContent, "utf8");
    console.log(`Updated deadlines.ics with ${eventCount} event(s).`);
  } else {
    console.log(`deadlines.ics unchanged (${eventCount} events).`);
  }
}

main().catch((err) => {
  console.error("Daily Trackr scrape failed:", err);
  process.exit(1);
});
