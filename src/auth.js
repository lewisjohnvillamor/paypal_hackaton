// Merchant session (signed cookie) and buyer capability tokens (hashed, expiring).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "rr_merchant";
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("Set SESSION_SECRET (32+ characters) in .env");
  return s;
}

const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");

const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function checkMerchantPassword(given) {
  const expected = process.env.MERCHANT_PASSWORD;
  if (!expected) throw new Error("Set MERCHANT_PASSWORD in .env");
  const h = (s) => createHash("sha256").update(String(s)).digest();
  return timingSafeEqual(h(given), h(expected));
}

export function issueSession(res) {
  const payload = Buffer.from(JSON.stringify({ sub: "merchant", exp: Date.now() + SESSION_HOURS * 3600e3 })).toString("base64url");
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: "strict", secure: process.env.APP_BASE_URL?.startsWith("https://"), path: "/",
    maxAge: SESSION_HOURS * 3600e3,
  });
}

export const clearSession = (res) => res.clearCookie(COOKIE, { path: "/" });

function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  return data.exp > Date.now() ? data : null;
}

// Cookie auth plus a custom header on mutations: SameSite=Strict and the header together stop
// cross-site form posts from reaching refund endpoints.
export function requireMerchant(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: "UNAUTHENTICATED", message: "Sign in as the merchant." });
  if (req.method !== "GET" && req.get("X-Refund-Relay") !== "1") {
    return res.status(403).json({ error: "CSRF", message: "Missing request header." });
  }
  req.actor = "merchant";
  next();
}

export const newToken = () => randomBytes(24).toString("base64url");
export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");
export const tokenMatches = (given, hash) => !!given && safeEqual(hashToken(given), hash);
