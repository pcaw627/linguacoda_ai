import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: "connected" });
  } catch {
    return NextResponse.json(
      { ok: false, db: "disconnected" },
      { status: 503 }
    );
  }
}
