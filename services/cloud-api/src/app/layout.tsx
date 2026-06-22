import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LinguaCoda Cloud API",
  description: "Cloud API for LinguaCoda — auth, vocab sync, and compute tokens",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
