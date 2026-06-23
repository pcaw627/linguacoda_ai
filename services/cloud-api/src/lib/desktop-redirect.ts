/**
 * Validate redirect targets for desktop OAuth handoff.
 * Only loopback HTTP URLs are allowed (Electron local server).
 */
export function isAllowedDesktopRedirect(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      return false;
    }

    if (parsed.pathname !== "/auth/callback") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function buildDesktopRedirectUrl(
  redirect: string,
  code: string
): string | null {
  if (!isAllowedDesktopRedirect(redirect)) {
    return null;
  }

  const target = new URL(redirect);
  target.searchParams.set("code", code);
  return target.toString();
}
