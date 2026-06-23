"use client";

import { useEffect } from "react";

type Props = {
  code: string;
};

export function DesktopCallbackClient({ code }: Props) {
  const appUrl = `linguacoda://auth/callback?code=${encodeURIComponent(code)}`;

  useEffect(() => {
    window.location.href = appUrl;
  }, [appUrl]);

  return (
    <main className="page">
      <h1>Signed in</h1>
      <p className="message">Return to the LinguaCoda desktop app</p>
      <p className="hint">
        Your browser may ask to open LinguaCoda. If nothing happens, click the
        button below.
      </p>
      <p className="download">
        <a href={appUrl}>Open LinguaCoda</a>
      </p>
    </main>
  );
}
