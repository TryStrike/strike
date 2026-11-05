//! Hand-written SQL with typed binds.
//!
//! The transport and the bind-count check live in `strike_core::db`; this module
//! re-exports them so handlers keep one import, and adds the `IN (...)`
//! placeholder builder. Every value goes through `push_typed_arg`, and the caller
//! writes the matching `CAST($n AS <type>)` in the statement, so the declared
//! parameter type and the cast can never disagree silently.

use serde_json::Value;

use strike_core::db;

pub use db::{execute, fetch, fetch_one, fetch_scalar};

/// `CAST($start AS text), CAST($start+1 AS text), ...` for an `IN (...)` list.
/// The caller binds one value per entry, in the same order. A count of zero is
/// rendered as `NULL` so `x IN (NULL)` matches nothing rather than failing to
/// parse - the TS gateway's `.in(col, [])` behaved the same way.
pub fn in_list(start: usize, type_name: &str, count: usize) -> String {
    let cast = if strike_core::db::is_safe_type_expression(type_name) {
        type_name
    } else {
        // A caller that hands us junk gets a statement that cannot match,
        // instead of a statement that matches anything.
        return "NULL".to_string();
    };
    if count == 0 {
        return "NULL".to_string();
    }
    (0..count)
        .map(|i| format!("CAST(${} AS {cast})", start + i))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_numbering_is_read_from_the_statement() {
        assert_eq!(db::highest_placeholder("SELECT $1, $2"), 2);
        assert_eq!(db::highest_placeholder("SELECT $2, $1"), 2);
        assert_eq!(db::highest_placeholder("SELECT 1"), 0);
        assert_eq!(db::highest_placeholder("WHERE a = CAST($12 AS int)"), 12);
        // `$` inside an identifier-ish context is not a placeholder.
        assert_eq!(db::highest_placeholder("SELECT '$not'"), 0);
    }

    #[tokio::test]
    async fn bind_count_mismatch_is_refused_without_touching_the_pool() {
        let value = Value::from("1");
        // Two placeholders, one bind: the error must come from the arity check,
        // not from a connection attempt - so this passes with no DATABASE_URL.
        let err = fetch("SELECT $1, $2", &[("text", &value)])
            .await
            .err()
            .expect("arity mismatch is refused");
        assert!(err.to_string().contains("placeholders"), "{err}");
    }

    #[test]
    fn in_list_renders_one_cast_per_bound_value() {
        assert_eq!(in_list(3, "text", 2), "CAST($3 AS text), CAST($4 AS text)");
        assert_eq!(in_list(1, "text", 0), "NULL");
        assert_eq!(in_list(1, "text); DROP TABLE", 1), "NULL");
    }
}
