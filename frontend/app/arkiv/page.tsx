import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowSquareOut, TreeStructure } from "@phosphor-icons/react/dist/ssr";
import { SiteNav } from "@/components/SiteNav";

export const metadata: Metadata = { title: "How it works" };

const DIAGRAMS = [
  {
    src: "/arkiv/architecture.png",
    width: 1550,
    height: 850,
    title: "How Strike fits together",
    text: "You tap in the browser, the round settles in USDC on Arc, and every result lands somewhere anyone can check.",
  },
  {
    src: "/arkiv/proof-staircase.png",
    width: 2064,
    height: 964,
    title: "How a round proves itself",
    text: "Each step is harder to fake than the last. The top step needs nothing from us.",
  },
  {
    src: "/arkiv/money-flow.png",
    width: 1570,
    height: 740,
    title: "Money in, money out",
    text: "USDC from Base, Arbitrum or Ethereum lands on Arc in seconds through Circle, and leaves the same way.",
  },
];

const CHECKS = [
  {
    label: "An epoch on Arkiv",
    href: "https://rabdi.explorer.arkiv.network/entity/0x59c5ddf06b5605e27833d0a02c8f6e96cebf9f334a6470b39e31eccb34895807",
  },
  {
    label: "Its proof file on Swarm",
    href: "https://api-strike.fastship.studio/swarm/bytes/d46b380493158dbbc9831e643ed1027fced49b310f25ad722f281dc21e3444ca",
  },
  {
    label: "The Strike vault on Arc",
    href: "https://explorer.testnet.arc.io/address/0x8726144B6a122862B9F1184752d8ebA0AcD662B6",
  },
  {
    label: "The docs and diagrams on GitHub",
    href: "https://github.com/TryStrike/strike/tree/main/arkiv",
  },
];

export default function ArkivPage() {
  return (
    <div className="min-h-full w-full bg-white font-tight text-ink">
      <SiteNav
        wide
        right={
          <Link
            href="/trade"
            className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-sm font-medium text-white"
          >
            Trade
          </Link>
        }
      />

      <main className="mx-auto max-w-[1200px] px-5 pb-16 pt-8 sm:px-8">
        <header className="mb-10">
          <div className="mb-2 flex items-center gap-2 font-jet text-[11px] uppercase tracking-[0.14em] text-faint">
            <TreeStructure size={14} />
            How it works
          </div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
            Fast rounds you can check yourself
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Three pictures of how Strike works, then links to check one real
            round end to end.
          </p>
        </header>

        <div className="space-y-12">
          {DIAGRAMS.map((d) => (
            <section key={d.src}>
              <h2 className="text-lg font-semibold tracking-tight">
                {d.title}
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-muted">{d.text}</p>
              <div className="mt-4 overflow-x-auto rounded-2xl ring-1 ring-line">
                <Image
                  src={d.src}
                  alt={d.title}
                  width={d.width}
                  height={d.height}
                  className="h-auto w-full min-w-[720px]"
                  sizes="(min-width: 1200px) 1136px, 100vw"
                />
              </div>
            </section>
          ))}
        </div>

        <section className="mt-14 rounded-2xl bg-surface px-5 py-5">
          <h2 className="text-lg font-semibold tracking-tight">
            Check it yourself
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {CHECKS.map((c) => (
              <li key={c.href}>
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-ink underline-offset-4 hover:underline"
                >
                  {c.label}
                  <ArrowSquareOut size={14} className="text-faint" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
