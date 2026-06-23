"use client";

import { useEffect } from "react";

type Props = {
  handoffUrl: string;
};

export function DesktopCallbackClient({ handoffUrl }: Props) {
  useEffect(() => {
    window.location.replace(handoffUrl);
  }, [handoffUrl]);

  return (
    <main className="page">
      <h1>Signed in</h1>
      <p className="message">Returning to LinguaCoda…</p>
      <p className="hint">
        The desktop app should receive your sign-in automatically. If the app
        does not update, click below.
      </p>
      <p className="download">
        <a href={handoffUrl}>Continue to LinguaCoda</a>
      </p>
    </main>
  );
}
