'use client';

/**
 * Admin dashboard entry.
 *
 * The panel tree lives in components/admin/AdminDashboard.tsx (plus one file
 * per panel under components/admin/*). This page stays the route entry and
 * exists mainly to give `useSearchParams` a Suspense boundary: without it the
 * prerender of /dashboard fails, because reading the query string makes the
 * route unconditionally dynamic.
 */

import React, { Suspense } from 'react';
import AdminDashboard from '@/components/admin/AdminDashboard';

function DashboardFallback() {
    return (
        <div className="min-h-screen bg-[#050505] p-6 lg:p-12">
            <div className="max-w-[1400px] mx-auto space-y-8">
                <div className="h-24 w-72 rounded-2xl bg-white/[0.03] animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-40 rounded-[2.5rem] bg-white/[0.02] animate-pulse" />
                    ))}
                </div>
                <div className="h-96 rounded-[2.5rem] bg-white/[0.02] animate-pulse" />
            </div>
        </div>
    );
}

export default function DashboardPage() {
    return (
        <Suspense fallback={<DashboardFallback />}>
            <AdminDashboard />
        </Suspense>
    );
}
