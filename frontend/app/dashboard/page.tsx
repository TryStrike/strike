'use client';


import { Suspense } from 'react';
import AdminDashboard from '@/components/admin/AdminDashboard';

function DashboardFallback() {
    return (
        <div className="min-h-screen bg-white p-6 lg:p-12">
            <div className="max-w-[1400px] mx-auto space-y-8">
                <div className="h-24 w-72 rounded-2xl bg-surface animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-40 rounded-[2.5rem] bg-surface animate-pulse" />
                    ))}
                </div>
                <div className="h-96 rounded-[2.5rem] bg-surface animate-pulse" />
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
