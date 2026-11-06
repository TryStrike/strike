// Mirror of backend/crates/core/src/settlement.rs band_odds and
// band_multiplier_ceiling. Keep the two in step; bandCeiling.check.ts compares them.

const CHART_DISTANCE_SPAN = 0.8;
const CHART_TIME_BONUS = 0.29;
const CHART_MAX_MULTIPLIER = 10;
const IN_BAND_CEILING = 1.01 + CHART_TIME_BONUS;
const BAND_MAX_RETURN = 0.95;
const BLITZ_MAX_MULTIPLIER = 20;

export function bandOdds(
  strike: number,
  top: number,
  bottom: number,
  range: number,
  windowMs: number,
  leftMs: number,
): number {
  const spread = (range / 1.6) * Math.sqrt(leftMs / windowMs);
  const below = (price: number) => 1 / (1 + Math.exp((-1.702 * (price - strike)) / spread));
  return below(top) - below(bottom);
}

/** The highest multiplier the server accepts for a band. `boost` is the Blitz factor (1 when off). */
export function bandMultiplierCeiling(
  strike: number,
  top: number,
  bottom: number,
  range: number,
  windowMs: number,
  leftMs: number,
  boost = 1,
): number {
  const chart =
    strike >= bottom && strike <= top
      ? IN_BAND_CEILING
      : Math.min(
          1.05 +
            Math.pow(
              Math.min(Math.abs((top + bottom) / 2 - strike) / (range * CHART_DISTANCE_SPAN), 1),
              1.3,
            ) *
              3.95 +
            CHART_TIME_BONUS,
          CHART_MAX_MULTIPLIER,
        );
  return Math.min(
    chart * boost,
    BAND_MAX_RETURN / bandOdds(strike, top, bottom, range, windowMs, leftMs),
    BLITZ_MAX_MULTIPLIER,
  );
}
