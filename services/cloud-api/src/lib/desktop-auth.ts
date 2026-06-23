import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

const DESKTOP_CODE_TTL_MS = 5 * 60 * 1000;

export function generateDesktopAuthCode(): string {
  return randomBytes(24).toString("hex");
}

export async function createDesktopAuthCode(userId: string): Promise<string> {
  const code = generateDesktopAuthCode();
  const expiresAt = new Date(Date.now() + DESKTOP_CODE_TTL_MS);

  await prisma.desktopAuthCode.create({
    data: {
      code,
      userId,
      expiresAt,
    },
  });

  return code;
}

export async function consumeDesktopAuthCode(
  code: string
): Promise<string | null> {
  const record = await prisma.desktopAuthCode.findUnique({
    where: { code },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return null;
  }

  await prisma.desktopAuthCode.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.userId;
}
