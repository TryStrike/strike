import type { Metadata } from "next";
import { Geist, Geist_Mono, Orbitron, Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PostHogProvider } from "@/lib/posthog/PostHogProvider";

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
  metadataBase: new URL('https://ethglobalmumbai.vercel.app'),
  title: "Strike — 5-second binary rounds, settled in USDC on Arc",
  description:
    "Call higher or lower on crypto, forex, stocks and metals in 5-second to 1-minute rounds. Deposit and withdraw USDC on Arc.",
  keywords: [
    "binary options",
    "crypto trading",
    "price feeds",
    "Arc",
    "USDC",
    "Web3",
    "prediction",
  ],
  icons: {
    icon: "/overflowlogo.ico",
    shortcut: "/overflowlogo.ico",
    apple: "/overflowlogo.ico",
  },
  openGraph: {
    title: "Strike — 5-second binary rounds, settled in USDC on Arc",
    description:
      "Call higher or lower in 5-second to 1-minute rounds. Deposit and withdraw USDC on Arc.",
    images: [{ url: '/overflowlogo.png', width: 512, height: 512, alt: 'Strike' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: "Strike — 5-second binary rounds, settled in USDC on Arc",
    description: "Call higher or lower in 5-second rounds. USDC on Arc.",
    images: ['/overflowlogo.png'],
  },
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
        className={`${geistSans.variable} ${geistMono.variable} ${orbitron.variable} ${interTight.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} antialiased bg-[#02040a] text-white h-screen overflow-hidden flex flex-col`}
      >
        <PostHogProvider>
          <Providers>
            <Header />
            {/* Body is h-screen overflow-hidden: this must scroll or every page taller than the viewport is clipped. */}
            <main className="flex-1 relative flex flex-col min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
              {children}
            </main>
          </Providers>
        </PostHogProvider>
      </body>
    </html>
  );
}
