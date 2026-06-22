import { auth } from "@/auth";
import { createDesktopAuthCode } from "@/lib/desktop-auth";
import { redirect } from "next/navigation";

export default async function DesktopCallbackPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/auth/desktop-callback");
  }

  const code = await createDesktopAuthCode(session.user.id);
  redirect(`linguacoda://auth/callback?code=${encodeURIComponent(code)}`);
}
