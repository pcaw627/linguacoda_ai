import { auth } from "@/auth";
import { createDesktopAuthCode } from "@/lib/desktop-auth";
import { redirect } from "next/navigation";
import { DesktopCallbackClient } from "./DesktopCallbackClient";

export default async function DesktopCallbackPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/auth/desktop-callback");
  }

  const code = await createDesktopAuthCode(session.user.id);

  // Do not use redirect("linguacoda://...") — browsers block custom-scheme
  // server redirects from HTTPS pages. Hand off via client-side navigation.
  return <DesktopCallbackClient code={code} />;
}
