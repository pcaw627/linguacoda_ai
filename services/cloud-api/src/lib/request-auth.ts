import { auth } from "@/auth";
import { validateApiToken } from "@/lib/api-auth";

export type AuthenticatedUser = {
  userId: string;
  email: string | null;
};

function extractBearerToken(
  authorizationHeader: string | null
): string | null {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export async function getAuthenticatedUser(
  authorizationHeader: string | null
): Promise<AuthenticatedUser | null> {
  const bearerToken = extractBearerToken(authorizationHeader);
  if (bearerToken) {
    return validateApiToken(bearerToken);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  return {
    userId: session.user.id,
    email: session.user.email ?? null,
  };
}
