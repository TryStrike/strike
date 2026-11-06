'use client';

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { createTapGrid } from './engine';
import type { TapGrid, TapGridOptions } from './types';

export interface TapGridChartProps extends TapGridOptions {
  className?: string;
  style?: CSSProperties;
  onReady?: (chart: TapGrid | null) => void;
}

export function TapGridChart({ className, style, onReady, ...options }: TapGridChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<TapGrid | null>(null);
  const optionsRef = useRef(options);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    optionsRef.current = options;
    onReadyRef.current = onReady;
    chartRef.current?.setOptions(options);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const chart = createTapGrid(canvas, optionsRef.current);
    chartRef.current = chart;
    onReadyRef.current?.(chart);
    return () => {
      onReadyRef.current?.(null);
      chartRef.current = null;
      chart.destroy();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} style={{ display: 'block', width: '100%', height: '100%', ...style }} />;
}
