import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export const token = () => randomBytes(32).toString("hex");
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export function hashPassword(password: string) {
  const salt = token();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
