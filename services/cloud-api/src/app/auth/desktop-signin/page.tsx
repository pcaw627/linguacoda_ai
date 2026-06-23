import { signIn } from "@/auth";
import { isAllowedDesktopRedirect } from "@/lib/desktop-redirect";

type Props = {
  searchParams: Promise<{ redirect?: string }>;
};

export default async function DesktopSignInPage({ searchParams }: Props) {
  const params = await searchParams;
  const redirectTarget = params.redirect?.trim();

  if (!redirectTarget || !isAllowedDesktopRedirect(redirectTarget)) {
    return (
      <main className="page">
        <h1>Desktop sign-in</h1>
        <p className="message">Invalid or missing redirect</p>
        <p className="hint">
          Start sign-in from the LinguaCoda desktop app.
        </p>
      </main>
    );
  }

  const callbackPath = `/auth/desktop-callback?redirect=${encodeURIComponent(redirectTarget)}`;

  // Auth.js v5 requires signIn() (POST internally) — not GET /api/auth/signin/google
  await signIn("google", { redirectTo: callbackPath });
}
