// Money is integer cents internally. Decimal strings exist only at the PayPal boundary.

export function toCents(value) {
  const s = String(value).trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Not a USD amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

export function toDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Bad cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export const formatUsd = (cents) => `$${toDecimal(cents)}`;
