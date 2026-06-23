import { auth } from "@/auth";
import { createDesktopAuthCode } from "@/lib/desktop-auth";
import {
  buildDesktopRedirectUrl,
  isAllowedDesktopRedirect,
} from "@/lib/desktop-redirect";
import { redirect } from "next/navigation";
import { DesktopCallbackClient } from "./DesktopCallbackClient";

type Props = {
  searchParams: Promise<{ redirect?: string }>;
};

export default async function DesktopCallbackPage({ searchParams }: Props) {
  const params = await searchParams;
  const redirectTarget = params.redirect?.trim();

  if (!redirectTarget || !isAllowedDesktopRedirect(redirectTarget)) {
    return (
      <main className="page">
        <h1>Desktop sign-in</h1>
        <p className="message">Invalid or missing redirect</p>
        <p className="hint">
          Start sign-in from the LinguaCoda desktop app, not this page directly.
        </p>
      </main>
    );
  }

  const session = await auth();

  if (!session?.user?.id) {
    const callbackPath = `/auth/desktop-callback?redirect=${encodeURIComponent(redirectTarget)}`;
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(callbackPath)}`);
  }

  const code = await createDesktopAuthCode(session.user.id);
  const handoffUrl = buildDesktopRedirectUrl(redirectTarget, code);

  if (!handoffUrl) {
    return (
      <main className="page">
        <h1>Desktop sign-in</h1>
        <p className="message">Could not build redirect URL</p>
      </main>
    );
  }

  return <DesktopCallbackClient handoffUrl={handoffUrl} />;
}
