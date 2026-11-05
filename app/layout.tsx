import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron, Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PostHogProvider } from "@/lib/posthog/PostHogProvider";
import { BRAND } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  metadataBase: new URL(BRAND.url),
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
  openGraph: { title: BRAND.name, description: BRAND.description },
};

import { Header } from "@/components/Header";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} ${interTight.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} antialiased bg-[#02040a] text-white overflow-hidden flex flex-col`}
      >
        <PostHogProvider>
          <Providers>
            <Header />
            {/* Body height is dvh-based (see globals.css: 100vh with a 100dvh
                override) so the mobile URL bar never clips the trade board.
                Body is overflow-hidden: main below must scroll or every page
                taller than the viewport is clipped. */}
            <main className="flex-1 relative flex flex-col min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
              {children}
            </main>
          </Providers>
        </PostHogProvider>
      </body>
    </html>
  );
}
