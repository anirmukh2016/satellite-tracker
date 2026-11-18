/**
 * GET /api/tle — current ISS TLE as JSON: {name, line1, line2, source}.
 *
 * The browser does all the orbital math, so this is the only server code.
 * Vercel's edge cache (s-maxage) means this runs roughly once an hour no
 * matter how many people are watching; stale-if-error keeps serving the last
 * good TLE if both upstream sources go down.
 */

const NORAD_ID = 25544;
const CELESTRAK_URL = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${NORAD_ID}&FORMAT=TLE`;
// Celestrak throttles some cloud IP ranges, so fall back to wheretheiss.at.
const WHERETHEISS_URL = `https://api.wheretheiss.at/v1/satellites/${NORAD_ID}/tles`;

function validate(name, line1, line2) {
  if (typeof line1 !== 'string' || typeof line2 !== 'string' ||
      !line1.startsWith('1 ') || !line2.startsWith('2 ') ||
      line1.length < 69 || line2.length < 69) {
    throw new Error(`Malformed TLE lines: ${String(line1).slice(0, 30)} / ${String(line2).slice(0, 30)}`);
  }
  return { name: name || 'ISS (ZARYA)', line1, line2 };
}

async function fromCelestrak() {
  const res = await fetch(CELESTRAK_URL, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Celestrak HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('Unexpected Celestrak response');
  return { ...validate(lines[0], lines[1], lines[2]), source: 'celestrak' };
}

async function fromWheretheiss() {
  const res = await fetch(WHERETHEISS_URL, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`wheretheiss.at HTTP ${res.status}`);
  const d = await res.json();
  return { ...validate(d.header, d.line1, d.line2), source: 'wheretheiss.at' };
}

async function getTLE() {
  try {
    return await fromCelestrak();
  } catch (primaryError) {
    console.warn(`[TLE] Celestrak failed (${primaryError.message}), trying fallback`);
    return await fromWheretheiss();
  }
}

module.exports = async function handler(req, res) {
  try {
    const tle = await getTLE();
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=3600, stale-if-error=86400');
    res.status(200).json(tle);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: `Could not fetch TLE: ${e.message}` });
  }
};
module.exports.getTLE = getTLE;
