export default function Home() {
  return (
    <main className="page">
      <h1>LinguaCoda</h1>
      <p className="message">Desktop app required</p>
      <p className="hint">
        LinguaCoda is a desktop application for real-time transcription, translation,
        and vocabulary tracking. This site hosts the cloud API only — not the learning UI.
      </p>
      <p className="download">
        <a href="#" aria-disabled="true">
          Download desktop app (coming soon)
        </a>
      </p>
    </main>
  );
}
