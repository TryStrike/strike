import { ChartSkeleton } from '@/components/states/Skeleton';

export default function TradeLoading() {
  return (
    <div className="relative h-full min-h-[70vh] w-full bg-white">
      <ChartSkeleton label="Loading the trade board" />
    </div>
  );
}
