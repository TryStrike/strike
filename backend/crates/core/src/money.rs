//! Fixed-point storage for NUMERIC columns.
//!
//! SQLite has no exact decimal type, so a `NUMERIC(p,s)` column is an INTEGER
//! holding `value * 10^s`. Each column keeps its Postgres scale; `balance` and
//! every other `NUMERIC(30,10)` money column can hold 1e-10 exactly, and its
//! largest value is `i64::MAX / 10^10` = 922,337,203.6854775807. That is lower
//! than the 1e20 Postgres allowed, so a value past it is refused with the
//! Postgres error text, never wrapped or truncated.
//!
//! Rounding matches a store into `NUMERIC(p,s)`: half away from zero.

use rust_decimal::{Decimal, RoundingStrategy};
use serde_json::Value;
use std::str::FromStr;

use crate::error::{ApiError, ApiResult};

/// `NUMERIC(30,10)`: every money column.
pub const MONEY_SCALE: u32 = 10;

/// Postgres' error text, which callers may surface in `{success: false}`.
pub const OVERFLOW: &str = "numeric field overflow";

/// Text of a `numeric` value: plain, or exponent form like `1e-8`.
pub fn parse_decimal(text: &str) -> ApiResult<Decimal> {
    let trimmed = text.trim();
    Decimal::from_str(trimmed)
        .or_else(|_| Decimal::from_scientific(trimmed))
        .map_err(|_| {
            ApiError::Other(format!(
                "invalid input syntax for type numeric: \"{trimmed}\""
            ))
        })
}

/// `value * 10^scale`, rounded to the column's scale. Overflow is an error.
pub fn to_fixed(value: Decimal, scale: u32) -> ApiResult<i64> {
    let overflow = || ApiError::Other(OVERFLOW.to_string());
    let mut rounded = value.round_dp_with_strategy(scale, RoundingStrategy::MidpointAwayFromZero);
    rounded.rescale(scale);
    // rescale keeps a smaller scale when the mantissa has no room left.
    if rounded.scale() != scale {
        return Err(overflow());
    }
    i64::try_from(rounded.mantissa()).map_err(|_| overflow())
}

/// NUMERIC `a + b`: the result keeps the larger scale even when one side is zero,
/// which `Decimal` drops. The scale decides whether `100` prints as a float.
pub fn add(a: Decimal, b: Decimal) -> Decimal {
    let mut sum = a + b;
    sum.rescale(sum.scale().max(a.scale()).max(b.scale()));
    sum
}

/// NUMERIC `a - b`, with the same scale rule as [`add`].
pub fn sub(a: Decimal, b: Decimal) -> Decimal {
    let mut difference = a - b;
    difference.rescale(difference.scale().max(a.scale()).max(b.scale()));
    difference
}

pub fn from_fixed(fixed: i64, scale: u32) -> Decimal {
    Decimal::new(fixed, scale)
}

/// The JSON number the API has always sent for NUMERIC: Postgres printed the
/// decimal and serde parsed that text, so this does the same. `19` stays an
/// integer and anything with a scale, stored columns included, is a float.
pub fn decimal_json(value: Decimal) -> Value {
    serde_json::from_str(&value.to_string()).unwrap_or(Value::Null)
}

pub fn fixed_json(fixed: i64, scale: u32) -> Value {
    decimal_json(from_fixed(fixed, scale))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(text: &str) -> Decimal {
        parse_decimal(text).unwrap()
    }

    #[test]
    fn the_smallest_fee_survives_exactly() {
        assert_eq!(to_fixed(dec("0.00000001"), MONEY_SCALE).unwrap(), 100);
        assert_eq!(to_fixed(dec("1e-8"), MONEY_SCALE).unwrap(), 100);
        assert_eq!(to_fixed(dec("0.0000000001"), MONEY_SCALE).unwrap(), 1);
        assert_eq!(from_fixed(100, MONEY_SCALE), dec("0.00000001"));
    }

    #[test]
    fn rounding_matches_a_numeric_store() {
        assert_eq!(
            to_fixed(dec("1.00000000005"), MONEY_SCALE).unwrap(),
            10_000_000_001
        );
        assert_eq!(
            to_fixed(dec("-1.00000000005"), MONEY_SCALE).unwrap(),
            -10_000_000_001
        );
        assert_eq!(
            to_fixed(dec("1.00000000004"), MONEY_SCALE).unwrap(),
            10_000_000_000
        );
        assert_eq!(to_fixed(dec("1.23455"), 4).unwrap(), 12_346);
        // Half-even would give 0.
        assert_eq!(to_fixed(dec("0.00005"), 4).unwrap(), 1);
    }

    #[test]
    fn the_limit_is_exact_and_one_past_it_fails() {
        let max = dec("922337203.6854775807");
        assert_eq!(to_fixed(max, MONEY_SCALE).unwrap(), i64::MAX);
        assert_eq!(from_fixed(i64::MAX, MONEY_SCALE), max);
        for over in ["922337203.6854775808", "1e15", "99999999999999999999"] {
            let err = to_fixed(dec(over), MONEY_SCALE).unwrap_err();
            assert_eq!(err.to_string(), OVERFLOW, "{over}");
        }
    }

    #[test]
    fn float_addition_noise_is_not_stored() {
        // 0.1 + 0.2 in JS. The stored value is the rounded decimal, exactly.
        let sum = dec("0.30000000000000004");
        assert_eq!(to_fixed(sum, MONEY_SCALE).unwrap(), 3_000_000_000);
    }

    #[test]
    fn json_is_the_float_the_postgres_text_parses_to() {
        assert_eq!(fixed_json(10_000_000_000, MONEY_SCALE).to_string(), "1.0");
        assert_eq!(
            fixed_json(1_234_500_000, MONEY_SCALE).to_string(),
            "0.12345"
        );
        assert_eq!(fixed_json(100, MONEY_SCALE).to_string(), "1e-8");
        assert_eq!(fixed_json(0, MONEY_SCALE).to_string(), "0.0");
        assert_eq!(decimal_json(dec("19")).to_string(), "19");
        assert_eq!(decimal_json(dec("19.0")).to_string(), "19.0");
    }

    #[test]
    fn sums_keep_numeric_scale() {
        let zero = from_fixed(0, MONEY_SCALE);
        assert_eq!(decimal_json(add(zero, dec("100"))).to_string(), "100.0");
        let five = from_fixed(50_000_000_000, MONEY_SCALE);
        assert_eq!(decimal_json(sub(five, dec("5"))).to_string(), "0.0");
        assert_eq!(
            decimal_json(add(dec("1.5"), dec("0.25"))).to_string(),
            "1.75"
        );
    }

    #[test]
    fn junk_is_refused() {
        for bad in ["", "abc", "NaN", "Infinity", "1.2.3"] {
            assert!(parse_decimal(bad).is_err(), "{bad}");
        }
    }
}
