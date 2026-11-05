/**
 * Dependency-free sparkline. Pure SVG polyline + area fill, normalised to a
 * viewBox so it scales with its container. Zero-height data sets degrade to a
 * flat mid-line so the layout is identical for a brand-new wallet.
 */

type SparklineProps = {
    /** Series values (e.g. cumulative net PnL per day). */
    values: number[];
    width?: number | string;
    height?: number | string;
    /** Stroke color; positive/neutral/negative themes handled by caller. */
    stroke?: string;
    fill?: string;
    className?: string;
    ariaLabel?: string;
};

const VIEW_W = 240;
const VIEW_H = 64;
const PAD = 4;

export default function Sparkline({
    values,
    width = '100%',
    height = 64,
    stroke = '#2151F5',
    fill = 'rgba(0,255,136,0.12)',
    className,
    ariaLabel,
}: SparklineProps) {
    const data = values.filter((v) => Number.isFinite(v));
    const n = data.length;

    let path = '';
    let area = '';
    let zeroY: number | null = null;
    let last: { x: number; y: number } | null = null;

    if (n > 0) {
        const min = Math.min(...data, 0);
        const max = Math.max(...data, 0);
        const span = max - min || 1;
        const innerW = VIEW_W - PAD * 2;
        const innerH = VIEW_H - PAD * 2;
        const x = (i: number) => PAD + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
        const y = (v: number) => PAD + innerH - ((v - min) / span) * innerH;

        const pts = data.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
        path = `M${pts.join(' L')}`;
        area = `${path} L${x(n - 1).toFixed(2)},${(PAD + innerH).toFixed(2)} L${x(0).toFixed(2)},${(PAD + innerH).toFixed(2)} Z`;
        last = { x: x(n - 1), y: y(data[n - 1]) };
        if (min < 0 && max > 0) zeroY = y(0);
    }

    return (
        <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width={width}
            height={height}
            preserveAspectRatio="none"
            role={ariaLabel ? 'img' : 'presentation'}
            aria-label={ariaLabel}
            aria-hidden={ariaLabel ? undefined : true}
            className={className}
        >
            {zeroY != null && (
                <line x1={PAD} x2={VIEW_W - PAD} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="3 3" />
            )}
            {n > 0 ? (
                <>
                    <path d={area} fill={fill} stroke="none" />
                    <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    {last && <circle cx={last.x} cy={last.y} r={2.5} fill={stroke} />}
                </>
            ) : (
                <line x1={PAD} x2={VIEW_W - PAD} y1={VIEW_H / 2} y2={VIEW_H / 2} stroke="rgba(255,255,255,0.12)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
        </svg>
    );
}
