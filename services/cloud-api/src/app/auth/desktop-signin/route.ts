import { signIn } from "@/auth";
import { isAllowedDesktopRedirect } from "@/lib/desktop-redirect";
import { NextRequest } from "next/server";

function invalidRedirectHtml(): Response {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem">` +
      `<h1>Desktop sign-in</h1>` +
      `<p>Invalid or missing redirect. Start sign-in from the LinguaCoda desktop app.</p>` +
      `</body></html>`,
    {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

export async function GET(request: NextRequest) {
  const redirectTarget = request.nextUrl.searchParams.get("redirect")?.trim();

  if (!redirectTarget || !isAllowedDesktopRedirect(redirectTarget)) {
    return invalidRedirectHtml();
  }

  const callbackPath = `/auth/desktop-callback?redirect=${encodeURIComponent(redirectTarget)}`;

  // Route Handlers may set cookies; Server Component pages cannot call signIn() directly.
  await signIn("google", { redirectTo: callbackPath });
}
