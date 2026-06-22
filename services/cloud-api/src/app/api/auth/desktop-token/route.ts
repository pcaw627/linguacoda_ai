import { NextResponse } from "next/server";
import { createApiTokenForUser } from "@/lib/api-auth";
import { consumeDesktopAuthCode } from "@/lib/desktop-auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  let body: { code?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  const userId = await consumeDesktopAuthCode(code);
  if (!userId) {
    return NextResponse.json(
      { error: "Invalid or expired code" },
      { status: 401 }
    );
  }

  const token = await createApiTokenForUser(userId);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  return NextResponse.json({
    token,
    expiresInDays: 90,
    email: user?.email ?? null,
  });
}
