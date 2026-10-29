// Secrets at rest: merchant passwords (scrypt) and PayPal client secrets (AES-256-GCM).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// CREDENTIALS_KEY when set; otherwise a key derived from SESSION_SECRET, so a fresh install works
// without one more setting. Changing either makes stored PayPal secrets unreadable (reconnect).
function key() {
  const base = process.env.CREDENTIALS_KEY || process.env.SESSION_SECRET;
  if (!base || base.length < 32) throw new Error("Set CREDENTIALS_KEY or SESSION_SECRET (32+ characters)");
  return Buffer.from(hkdfSync("sha256", base, "refund-relay", "paypal-credentials", 32));
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(sealed) {
  const [v, iv, tag, data] = String(sealed).split(".");
  if (v !== "v1") throw new Error("Unknown credential format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt.${salt.toString("base64url")}.${scryptSync(String(password), salt, 32).toString("base64url")}`;
}

export function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? "").split(".");
  // Same work for an unknown account as for a wrong password.
  const expected = kind === "scrypt" ? Buffer.from(hash, "base64url") : Buffer.alloc(32);
  const given = scryptSync(String(password), kind === "scrypt" ? Buffer.from(salt, "base64url") : Buffer.alloc(16), 32);
  return kind === "scrypt" && timingSafeEqual(given, expected);
}

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
