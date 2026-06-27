import { NextResponse } from "next/server";

export async function GET() {
  const gatewayUrl = process.env.COMPUTE_GATEWAY_URL?.trim().replace(/\/$/, "");

  if (!gatewayUrl) {
    return NextResponse.json({
      online: false,
      error: "COMPUTE_GATEWAY_URL is not configured",
    });
  }

  try {
    const response = await fetch(`${gatewayUrl}/health`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });

    let details: unknown = null;
    if (response.ok) {
      try {
        details = await response.json();
      } catch {
        details = null;
      }
    }

    return NextResponse.json({
      online: response.ok,
      details,
    });
  } catch {
    return NextResponse.json({ online: false });
  }
}
