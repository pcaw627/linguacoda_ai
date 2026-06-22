import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/request-auth";
import {
  mergeSeenVocab,
  parseSeenVocabJson,
  type SeenVocab,
} from "@/lib/vocab";

async function getOrCreateUserVocab(userId: string) {
  const existing = await prisma.userVocab.findUnique({ where: { userId } });
  if (existing) {
    return existing;
  }

  return prisma.userVocab.create({
    data: {
      userId,
      seenVocab: {},
    },
  });
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(
    request.headers.get("authorization")
  );

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const record = await getOrCreateUserVocab(user.userId);
  const seenVocab =
    parseSeenVocabJson(record.seenVocab) ?? ({} as SeenVocab);

  return NextResponse.json({
    seenVocab,
    updatedAt: record.updatedAt.toISOString(),
  });
}

export async function PUT(request: Request) {
  const user = await getAuthenticatedUser(
    request.headers.get("authorization")
  );

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { seenVocab?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const incoming = parseSeenVocabJson(body.seenVocab);
  if (!incoming) {
    return NextResponse.json(
      { error: "seenVocab must be an object of word → non-negative number" },
      { status: 400 }
    );
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(incoming), "utf8");
  if (payloadBytes > 500 * 1024) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const existing = await getOrCreateUserVocab(user.userId);
  const current =
    parseSeenVocabJson(existing.seenVocab) ?? ({} as SeenVocab);
  const merged = mergeSeenVocab(current, incoming);

  const updated = await prisma.userVocab.update({
    where: { userId: user.userId },
    data: { seenVocab: merged },
  });

  const seenVocab =
    parseSeenVocabJson(updated.seenVocab) ?? ({} as SeenVocab);

  return NextResponse.json({
    seenVocab,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
