import { StockDetail } from "@/components/markets/StockDetail";

type Props = { params: Promise<{ ticker: string }> };

export async function generateMetadata({ params }: Props) {
  return { title: (await params).ticker.toUpperCase() };
}

export default async function Page({ params }: Props) {
  return <StockDetail ticker={(await params).ticker.toUpperCase()} />;
}
