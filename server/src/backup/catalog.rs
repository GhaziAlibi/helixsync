// What is in the database, read from Postgres's own catalog. Nothing is
// hard-coded: a table added by a later migration is part of the next backup
// without touching this code.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context};
use sqlx::PgConnection;

/// Tracks applied migrations. Not data: it is rebuilt by running them.
pub const MIGRATIONS_TABLE: &str = "_sqlx_migrations";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalog {
    /// Ordinary tables of `public`, parents before the tables that reference
    /// them, so each COPY finds the rows its foreign keys point at.
    pub tables: Vec<Table>,
    /// Sequences of `public`, by name.
    pub sequences: Vec<String>,
}

impl Catalog {
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.iter().find(|t| t.name == name)
    }

    pub fn has_sequence(&self, name: &str) -> bool {
        self.sequences.iter().any(|s| s == name)
    }

    pub fn table_names(&self) -> BTreeSet<&str> {
        self.tables.iter().map(|t| t.name.as_str()).collect()
    }
}

/// Reads tables, columns, foreign keys and sequences of the `public` schema.
pub async fn discover(conn: &mut PgConnection) -> anyhow::Result<Catalog> {
    let columns: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT c.relname::text, a.attname::text
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND c.relname <> $1
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attgenerated = ''
        ORDER BY c.relname, a.attnum
        "#,
    )
    .bind(MIGRATIONS_TABLE)
    .fetch_all(&mut *conn)
    .await
    .context("could not read the table list")?;

    let mut by_table: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (table, column) in columns {
        by_table.entry(table).or_default().push(column);
    }

    let edges: Vec<(String, String)> = sqlx::query_as(
        r#"
        SELECT child.relname::text, parent.relname::text
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace cn ON cn.oid = child.relnamespace
        JOIN pg_namespace pn ON pn.oid = parent.relnamespace
        WHERE con.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public'
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .context("could not read the foreign keys")?;

    let sequences: Vec<(String,)> = sqlx::query_as(
        "SELECT sequencename::text FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
    )
    .fetch_all(&mut *conn)
    .await
    .context("could not read the sequence list")?;

    let order = dependency_order(by_table.keys().cloned().collect(), &edges)?;
    let tables = order
        .into_iter()
        .map(|name| {
            let columns = by_table.remove(&name).unwrap_or_default();
            Table { name, columns }
        })
        .collect();

    Ok(Catalog {
        tables,
        sequences: sequences.into_iter().map(|(s,)| s).collect(),
    })
}

/// Orders `tables` so that every parent comes before its children
/// (`edges` are `(child, parent)` pairs). Alphabetical among equals, so the
/// same schema always gives the same order. A table referencing itself is
/// fine; a cycle between tables is refused, since no COPY order could load it.
pub fn dependency_order(
    tables: Vec<String>,
    edges: &[(String, String)],
) -> anyhow::Result<Vec<String>> {
    let known: BTreeSet<&str> = tables.iter().map(String::as_str).collect();
    let mut waiting_on: BTreeMap<&str, BTreeSet<&str>> = tables
        .iter()
        .map(|t| (t.as_str(), BTreeSet::new()))
        .collect();
    for (child, parent) in edges {
        if child != parent && known.contains(child.as_str()) && known.contains(parent.as_str()) {
            waiting_on
                .get_mut(child.as_str())
                .expect("child is a known table")
                .insert(parent.as_str());
        }
    }

    let mut ordered: Vec<String> = Vec::with_capacity(tables.len());
    let mut done: BTreeSet<&str> = BTreeSet::new();
    while ordered.len() < tables.len() {
        let next = waiting_on
            .iter()
            .find(|(table, parents)| !done.contains(*table) && parents.is_subset(&done))
            .map(|(table, _)| *table);
        let Some(next) = next else {
            let stuck: Vec<&str> = waiting_on
                .keys()
                .filter(|t| !done.contains(*t))
                .copied()
                .collect();
            bail!(
                "tables reference each other in a cycle ({}); a backup cannot order them",
                stuck.join(", ")
            );
        };
        done.insert(next);
        ordered.push(next.to_string());
    }
    Ok(ordered)
}

/// The newest applied migration, or `None` before any migration ran.
pub async fn migration_version(conn: &mut PgConnection) -> anyhow::Result<Option<i64>> {
    let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
        .bind(format!("public.{MIGRATIONS_TABLE}"))
        .fetch_one(&mut *conn)
        .await?;
    if !exists {
        return Ok(None);
    }
    let version: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success")
            .fetch_one(&mut *conn)
            .await?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn edge(child: &str, parent: &str) -> (String, String) {
        (child.to_string(), parent.to_string())
    }

    #[test]
    fn parents_come_first_and_ties_are_alphabetical() {
        let order = dependency_order(
            s(&["devices", "audit", "users", "sessions"]),
            &[
                edge("devices", "users"),
                edge("sessions", "devices"),
                edge("audit", "users"),
            ],
        )
        .unwrap();
        assert_eq!(order, s(&["users", "audit", "devices", "sessions"]));
    }

    #[test]
    fn a_self_reference_is_not_a_cycle() {
        let order = dependency_order(s(&["nodes"]), &[edge("nodes", "nodes")]).unwrap();
        assert_eq!(order, s(&["nodes"]));
    }

    #[test]
    fn references_outside_the_list_are_ignored() {
        let order = dependency_order(s(&["a"]), &[edge("a", "elsewhere")]).unwrap();
        assert_eq!(order, s(&["a"]));
    }

    #[test]
    fn a_cycle_is_refused() {
        let err = dependency_order(s(&["a", "b"]), &[edge("a", "b"), edge("b", "a")]).unwrap_err();
        assert!(err.to_string().contains("cycle"));
    }
}
