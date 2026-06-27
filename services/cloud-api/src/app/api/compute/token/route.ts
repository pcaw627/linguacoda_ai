import { NextResponse } from "next/server";
import { signComputeJwt } from "@/lib/compute-jwt";
import { getAuthenticatedUser } from "@/lib/request-auth";

const RATE_LIMIT_PER_MINUTE = 10;
const rateHits = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (rateHits.get(userId) ?? []).filter((t) => t > windowStart);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    rateHits.set(userId, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(userId, hits);
  return false;
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(
    request.headers.get("authorization")
  );

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isRateLimited(user.userId)) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  try {
    const { token, expiresAt } = await signComputeJwt({
      sub: user.userId,
      email: user.email,
    });
    return NextResponse.json({ token, expiresAt });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to issue compute token";
    console.error("[ComputeToken]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
