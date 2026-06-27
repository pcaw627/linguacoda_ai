import { SignJWT } from "jose";

const JWT_ALGORITHM = "HS256";
const TOKEN_TTL_SECONDS = 15 * 60;

export type ComputeJwtPayload = {
  sub: string;
  email: string | null;
};

export async function signComputeJwt(
  payload: ComputeJwtPayload
): Promise<{ token: string; expiresAt: string }> {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const key = new TextEncoder().encode(secret);

  const token = await new SignJWT({
    email: payload.email,
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(payload.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
