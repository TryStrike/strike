import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/requireAdminAuth';
import { computePlatformStats } from '@/lib/admin/computeStats';

export async function GET(request: NextRequest) {
    const deny = requireAdminAuth(request);
    if (deny) return deny;

    try {
        const { real, demo, currencyStats } = await computePlatformStats();

        return NextResponse.json({
            // Backward-compatible top-level fields (demo + real combined)
            totalVolume:  demo.totalVolume  + real.totalVolume,
            totalBets:    demo.totalBets    + real.totalBets,
            totalUsers:   demo.totalUsers   + real.totalUsers,
            platformPnL:  demo.platformPnL  + real.platformPnL,
            revenue:      demo.platformPnL  + real.platformPnL,
            currencyStats,
            // Split metrics
            demo,
            real,
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
