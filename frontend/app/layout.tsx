import type { Metadata } from "next";
import { Inter_Tight, Instrument_Serif, JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { BRAND } from "@/lib/brand";
import { Header } from "@/components/Header";
import { AI_ROUTE } from "@/lib/theme";

const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"] });
// Only AI mode uses it, so it is not preloaded: the browser fetches it on first use.
const pixelify = Pixelify_Sans({ variable: "--font-pixelify", subsets: ["latin"], preload: false });

export const metadata: Metadata = {
  metadataBase: new URL(BRAND.url),
  title: `${BRAND.name} · ${BRAND.tagline}`,
  description: BRAND.description,
  openGraph: { title: BRAND.name, description: BRAND.description },
};

// Sets the AI theme before first paint on a direct load of the AI route.
const themeBootScript = `if(location.pathname.startsWith('${AI_ROUTE}'))document.documentElement.dataset.theme='ai'`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body
        suppressHydrationWarning
        className={`${interTight.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} ${pixelify.variable} flex flex-col overflow-hidden antialiased`}
      >
        <Providers>
          <Header />
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
