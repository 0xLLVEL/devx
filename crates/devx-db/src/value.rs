//! One grid cell, engine-agnostically.
//!
//! The browser renders text; the servers produce typed values. [`DbValue`]
//! is the deliberately small bridge: enough type fidelity to display
//! numbers and NULL distinctly, no more.

use serde::Serialize;

/// A single cell of a result grid.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DbValue {
    /// SQL NULL — displayed distinctly from an empty string.
    Null,
    /// An integer.
    ///
    /// Exported to TypeScript as a plain `number`. Specta forbids `i64` by
    /// default because JSON parsing truncates past 2^53; a display grid shows
    /// values as text, so the worst case is a rare cosmetic rounding on
    /// absurdly large values.
    #[specta(type = specta_typescript::Number)]
    Int(i64),
    /// A float.
    Float(f64),
    /// Bytes or text; the browser shows text.
    Text(String),
    /// Anything else, rendered as the server's textual form.
    Other(String),
}

impl DbValue {
    /// Converts a MySQL protocol value.
    pub fn from_mysql(value: &mysql_async::Value) -> Self {
        use mysql_async::Value;
        match value {
            Value::NULL => Self::Null,
            Value::Int(n) => Self::Int(*n),
            Value::UInt(n) => Self::Int(i64::try_from(*n).unwrap_or(i64::MAX)),
            Value::Float(f) => Self::Float(*f as f64),
            Value::Double(f) => Self::Float(*f),
            Value::Bytes(bytes) => Self::Text(String::from_utf8_lossy(bytes).into_owned()),
            other => Self::Other(format!("{other:?}")),
        }
    }

    /// Converts one PostgreSQL column value.
    ///
    /// `raw` is the `Result` `tokio_postgres` yields from `try_get` on a
    /// `dyn ToSql` read: `Ok` carries a display string produced by the
    /// engine, `Err` a type mismatch, both of which render as text.
    pub fn from_postgres<E>(raw: core::result::Result<String, E>) -> Self {
        match raw {
            Ok(text) => Self::Text(text),
            Err(_) => Self::Other("<unrepresentable>".to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql_async::Value as MySql;
    use pretty_assertions::assert_eq;

    #[test]
    fn mysql_values_map_losslessly() {
        assert_eq!(DbValue::from_mysql(&MySql::NULL), DbValue::Null);
        assert_eq!(DbValue::from_mysql(&MySql::Int(-3)), DbValue::Int(-3));
        assert_eq!(
            DbValue::from_mysql(&MySql::Bytes(b"hello".to_vec())),
            DbValue::Text("hello".into())
        );
        assert_eq!(
            DbValue::from_mysql(&MySql::Double(1.5)),
            DbValue::Float(1.5)
        );
    }

    #[test]
    fn postgres_cells_render_as_text() {
        assert_eq!(
            DbValue::from_postgres::<std::convert::Infallible>(Ok("42".into())),
            DbValue::Text("42".into())
        );
        assert_eq!(
            DbValue::from_postgres::<String>(Err("mismatch".into())),
            DbValue::Other("<unrepresentable>".into())
        );
    }
}
