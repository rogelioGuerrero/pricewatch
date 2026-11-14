// Observation policy, independent of rendering and account state.
// One business-day grace covers the hours before the 06:00 SV sweep.
const PWData = (() => {
  const DAY = 864e5;
  const today = () => new Date(Date.now() - 6 * 3600e3)
    .toISOString().slice(0, 10);
  const isoDay = x => {
    if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
    const t = Date.parse(x + "T00:00:00Z");
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === x;
  };
  const sourceDate = source => source === "siman"
    ? D.siman?.generated || ""
    : D.quality?.sources?.pricesmart?.observed_at || D.generated || "";
  const freshness = (observed, source, now = today()) => {
    if (!isoDay(observed) || !isoDay(source) || !isoDay(now)) return "unknown";
    const age = (Date.parse(now) - Date.parse(observed)) / DAY;
    if (age < 0) return "unknown";
    const sv = new Date(Date.now() - 6 * 3600e3);
    const grace = sv.toISOString().slice(0, 10) === now
      && sv.getUTCHours() < 6;
    return observed === source && (age === 0 || (age === 1 && grace))
      ? "fresh" : "stale";
  };
  const cents = n => Number.isSafeInteger(n) && n > 0 ? n : null;
  const stock = x => x === true || x === 1 ? "available"
    : x === false || x === 0 ? "unavailable" : "unknown";
  const product = (sku, club = null, now = today()) => {
    const rows = D.series?.[sku] || [], row = rows.at(-1);
    const meta = D.products?.[sku] || {};
    const source = sourceDate("pricesmart");
    let observed = meta.observed_at || row?.[0] || "", value = row?.[2];
    let current = meta.current !== false;
    if (club) {
      const detail = D.clubs?.[sku]?.[club];
      observed = detail?.observed_at || D.clubh?.[sku]?.[club]?.at(-1)?.[0] || "";
      value = detail?.in_stock;
      current = true; // A direct club observation has its own provenance.
    }
    const f = freshness(observed, source, now);
    return { state: D.quality?.sources?.pricesmart?.ok === false ? "unknown"
      : f === "fresh" ? (current ? stock(value) : "stale") : f,
      observedAt: observed, sourceDate: source, priceCents: cents(row?.[1]) };
  };
  const siman = (item, now = today()) => {
    const source = sourceDate("siman"), observed = item.last || "";
    const f = freshness(observed, source, now);
    const value = item.ta ? item.ok : item.avail;
    return { state: D.quality?.sources?.siman?.ok === false ? "unknown"
      : f === "fresh"
      ? (item.current === false ? "stale" : stock(value)) : f,
      observedAt: observed, sourceDate: source,
      priceCents: cents(item.price_cents)
        ?? (Number.isFinite(item.p) ? cents(Math.round(item.p * 100)) : null) };
  };
  const buyable = (sku, club = null, now = today()) => {
    const p = product(sku, club, now);
    return p.state === "available" && p.priceCents != null;
  };
  const score = (sku, now = today()) => {
    const p = product(sku, null, now), a = D.agg?.[sku] || {};
    if (p.state !== "available" || p.priceCents == null) return 0;
    const last = D.series[sku].at(-1), saved = Math.max(0, last[3] || 0) * 100;
    // Declared savings use the original price, not the reduced price.
    const advertised = saved / (p.priceCents + saved);
    const fromMax = a.max > 0 ? (a.max - p.priceCents) / a.max : 0;
    return Math.max(0, advertised, fromMax, -(a.vs_med || 0) / 100);
  };
  const nextSweep = (now = Date.now()) => {
    const d = new Date(now);
    let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
    if (next <= now) next += DAY;
    return new Date(next).toISOString();
  };
  const parseMoney = text => {
    const value = String(text).trim();
    if (!/^(?:\d+|\d*\.\d{1,2})$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const valueCents = Number(whole || 0) * 100
      + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(valueCents) && valueCents > 0
      && valueCents <= 99999999 ? valueCents : null;
  };
  // Quantity is represented by distinct unit rows, preserving the existing
  // Appwrite sku/paid/date schema. Callers assign a stable id to EVERY row.
  const purchaseRows = (lines, paidDate, now = today()) => {
    if (!isoDay(paidDate) || paidDate > now || !Array.isArray(lines) || !lines.length)
      throw new Error("Revisa la fecha y los articulos.");
    const result = [];
    for (const line of lines) {
      if (typeof line.sku !== "string" || !line.sku
          || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99
          || !Number.isInteger(line.unitCents) || line.unitCents < 1
          || line.unitCents > 99999999)
        throw new Error("Revisa cantidades (1-99) y precios unitarios.");
      for (let n = 0; n < line.quantity; n++)
        result.push({ sku: line.sku, paid: line.unitCents / 100, date: paidDate });
    }
    return result;
  };
  return { today, sourceDate, freshness, product, siman, buyable, score,
    nextSweep, parseMoney, purchaseRows };
})();
