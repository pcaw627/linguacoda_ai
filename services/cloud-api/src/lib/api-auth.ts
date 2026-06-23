import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

const API_TOKEN_TTL_DAYS = 90;

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateApiToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createApiTokenForUser(userId: string): Promise<string> {
  const plaintext = generateApiToken();
  const tokenHash = hashApiToken(plaintext);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + API_TOKEN_TTL_DAYS);

  await prisma.$transaction([
    prisma.apiToken.deleteMany({ where: { userId } }),
    prisma.apiToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    }),
  ]);

  return plaintext;
}

export async function validateApiToken(
  token: string
): Promise<{ userId: string; email: string | null } | null> {
  const tokenHash = hashApiToken(token);
  const record = await prisma.apiToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!record || record.expiresAt < new Date()) {
    return null;
  }

  return {
    userId: record.user.id,
    email: record.user.email,
  };
}

export async function revokeApiTokensForUser(userId: string): Promise<void> {
  await prisma.apiToken.deleteMany({ where: { userId } });
}
