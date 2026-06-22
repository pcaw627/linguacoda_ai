import { auth, signIn, signOut } from "@/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="page">
      <h1>LinguaCoda</h1>
      <p className="message">Desktop app required</p>
      <p className="hint">
        LinguaCoda is a desktop application for real-time transcription,
        translation, and vocabulary tracking. This site hosts the cloud API
        only — not the learning UI.
      </p>
      <p className="download">
        <a href="#" aria-disabled="true">
          Download desktop app (coming soon)
        </a>
      </p>

      <section className="dev-auth">
        <h2>Account (dev testing)</h2>
        {session?.user ? (
          <div>
            <p>Signed in as {session.user.email}</p>
            <form
              action={async () => {
                "use server";
                await signOut();
              }}
            >
              <button type="submit">Sign out</button>
            </form>
          </div>
        ) : (
          <form
            action={async () => {
              "use server";
              await signIn("google");
            }}
          >
            <button type="submit">Sign in with Google</button>
          </form>
        )}
      </section>
    </main>
  );
}
