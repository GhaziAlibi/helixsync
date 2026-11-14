// The text inside a backup file: a `psql`-loadable data script.
//
//   -- HelixSync backup
//   -- format: 1
//   -- server_version: 1.0.0
//   -- migration_version: 3
//   -- created_at: 2026-11-13T03:00:00Z
//
//   COPY public."users" ("id", "email") FROM stdin;
//   <raw COPY text rows>
//   \.
//
//   SELECT pg_catalog.setval('public."audit_logs_id_seq"', 42, true);
//
//   -- rows "users" 5
//   -- end
//
// The writer produces exactly these statements. The parser accepts nothing
// else: a restore never executes a statement from the file. Rows travel to
// Postgres through the COPY protocol and sequences are set with a bound
// parameter, so the file's text is data only.
use std::io::BufRead;

use anyhow::{anyhow, bail, Context};
use chrono::{DateTime, SecondsFormat, Utc};

/// Bumped when the layout changes in a way an older reader cannot handle.
pub const FORMAT_VERSION: u32 = 1;

/// COPY rows are forwarded in chunks of about this size.
const DATA_CHUNK_BYTES: usize = 64 * 1024;

/// `"name"` with embedded quotes doubled.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub format: u32,
    pub server_version: String,
    pub migration_version: i64,
    pub created_at: DateTime<Utc>,
}

pub fn header_text(header: &Header) -> String {
    format!(
        "-- HelixSync backup\n-- format: {}\n-- server_version: {}\n-- migration_version: {}\n-- created_at: {}\n\n",
        header.format,
        header.server_version,
        header.migration_version,
        header.created_at.to_rfc3339_opts(SecondsFormat::Secs, true),
    )
}

pub fn copy_in_statement(table: &str, columns: &[String]) -> String {
    format!(
        "COPY public.{} ({}) FROM stdin;",
        quote_ident(table),
        columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub fn copy_out_statement(table: &str, columns: &[String]) -> String {
    format!(
        "COPY public.{} ({}) TO STDOUT",
        quote_ident(table),
        columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// The `regclass` text for a sequence, as `setval` takes it.
pub fn sequence_regclass(sequence: &str) -> String {
    format!("public.{}", quote_ident(sequence))
}

pub fn setval_statement(sequence: &str, value: i64, is_called: bool) -> anyhow::Result<String> {
    if sequence.contains('\'') {
        bail!("sequence name {sequence:?} contains a quote and cannot be written to a backup");
    }
    Ok(format!(
        "SELECT pg_catalog.setval('{}', {value}, {is_called});",
        sequence_regclass(sequence)
    ))
}

pub fn rows_line(table: &str, rows: u64) -> String {
    format!("-- rows {} {rows}\n", quote_ident(table))
}

pub const END_LINE: &str = "-- end\n";

/// What the parser hands to its sink, in file order.
#[derive(Debug)]
pub enum Item {
    /// Once, before the first statement.
    Header(Header),
    CopyStart {
        table: String,
        columns: Vec<String>,
    },
    /// Raw COPY text rows, whole lines only.
    CopyData(Vec<u8>),
    CopyEnd,
    Setval {
        sequence: String,
        value: i64,
        is_called: bool,
    },
}

/// What a fully read file contains.
#[derive(Debug, Clone)]
pub struct Summary {
    pub header: Header,
    /// Per table, in file order: name and number of rows.
    pub tables: Vec<(String, u64)>,
}

impl Summary {
    pub fn total_rows(&self) -> u64 {
        self.tables.iter().map(|(_, rows)| rows).sum()
    }
}

#[derive(Default)]
struct HeaderParts {
    format: Option<u32>,
    server_version: Option<String>,
    migration_version: Option<i64>,
    created_at: Option<DateTime<Utc>>,
}

impl HeaderParts {
    fn complete(&self) -> anyhow::Result<Header> {
        let missing = |field: &str| anyhow!("backup header is missing `{field}`");
        let format = self.format.ok_or_else(|| missing("format"))?;
        if format > FORMAT_VERSION {
            bail!(
                "backup uses format {format}, newer than this server understands ({FORMAT_VERSION}); use a newer HelixSync server to restore it"
            );
        }
        Ok(Header {
            format,
            server_version: self
                .server_version
                .clone()
                .ok_or_else(|| missing("server_version"))?,
            migration_version: self
                .migration_version
                .ok_or_else(|| missing("migration_version"))?,
            created_at: self.created_at.ok_or_else(|| missing("created_at"))?,
        })
    }
}

/// Reads one `"quoted"` identifier from the start of `input`; returns it and
/// the rest.
fn parse_quoted(input: &str) -> Option<(String, &str)> {
    let mut chars = input.strip_prefix('"')?.char_indices().peekable();
    let rest_start = 1;
    let mut name = String::new();
    while let Some((i, c)) = chars.next() {
        if c == '"' {
            if matches!(chars.peek(), Some((_, '"'))) {
                chars.next();
                name.push('"');
            } else {
                if name.is_empty() {
                    return None;
                }
                return Some((name, &input[rest_start + i + 1..]));
            }
        } else {
            name.push(c);
        }
    }
    None
}

fn parse_copy_statement(line: &str) -> Option<(String, Vec<String>)> {
    let rest = line.strip_prefix("COPY public.")?;
    let (table, rest) = parse_quoted(rest)?;
    let mut rest = rest.strip_prefix(" (")?;
    let mut columns = Vec::new();
    loop {
        let (column, after) = parse_quoted(rest)?;
        columns.push(column);
        if let Some(after) = after.strip_prefix(", ") {
            rest = after;
        } else {
            return if after == ") FROM stdin;" {
                Some((table, columns))
            } else {
                None
            };
        }
    }
}

fn parse_setval_statement(line: &str) -> Option<(String, i64, bool)> {
    let rest = line.strip_prefix("SELECT pg_catalog.setval('public.")?;
    let (sequence, rest) = parse_quoted(rest)?;
    let rest = rest.strip_prefix("', ")?;
    let rest = rest.strip_suffix(");")?;
    let (value, is_called) = rest.split_once(", ")?;
    let is_called = match is_called {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    // `parse` accepts a leading `+`; the writer never produces one.
    if value.starts_with('+') {
        return None;
    }
    Some((sequence, value.parse().ok()?, is_called))
}

fn parse_rows_line(rest: &str) -> Option<(String, u64)> {
    let (table, rest) = parse_quoted(rest)?;
    let count = rest.strip_prefix(' ')?;
    if count.starts_with('+') {
        return None;
    }
    Some((table, count.parse().ok()?))
}

/// Reads a whole script, handing each piece to `sink`, and checks it on the
/// way: the header, that every statement is one the writer produces, that the
/// per-table row counts of the trailer match the rows actually present, and
/// that the file ends with `-- end`. Any other content is an error.
pub fn parse<R: BufRead>(
    mut reader: R,
    mut sink: impl FnMut(Item) -> anyhow::Result<()>,
) -> anyhow::Result<Summary> {
    let mut header_parts = HeaderParts::default();
    let mut header: Option<Header> = None;
    let mut tables: Vec<(String, u64)> = Vec::new();
    let mut trailer: Vec<(String, u64)> = Vec::new();
    let mut copy: Option<(String, u64)> = None;
    let mut pending: Vec<u8> = Vec::new();
    let mut ended = false;
    let mut line_no = 0u64;
    let mut buf: Vec<u8> = Vec::new();

    loop {
        buf.clear();
        if reader
            .read_until(b'\n', &mut buf)
            .context("backup could not be read to the end (file damaged or truncated)")?
            == 0
        {
            break;
        }
        line_no += 1;

        if let Some((table, rows)) = copy.as_mut() {
            if buf == b"\\.\n" {
                if !pending.is_empty() {
                    sink(Item::CopyData(std::mem::take(&mut pending)))?;
                }
                sink(Item::CopyEnd)?;
                tables.push((std::mem::take(table), *rows));
                copy = None;
            } else {
                if buf.last() != Some(&b'\n') {
                    bail!("backup is truncated inside the data of a table (line {line_no})");
                }
                *rows += 1;
                pending.extend_from_slice(&buf);
                if pending.len() >= DATA_CHUNK_BYTES {
                    sink(Item::CopyData(std::mem::take(&mut pending)))?;
                }
            }
            continue;
        }

        if buf.last() != Some(&b'\n') {
            bail!("backup is truncated (line {line_no} has no end)");
        }
        let line = std::str::from_utf8(&buf[..buf.len() - 1])
            .map_err(|_| anyhow!("backup line {line_no} is not valid UTF-8"))?;

        if ended {
            if line.trim().is_empty() {
                continue;
            }
            bail!("backup has content after its end marker (line {line_no})");
        }
        if line.trim().is_empty() {
            continue;
        }

        if let Some(comment) = line.strip_prefix("--") {
            let comment = comment.trim_start();
            if let Some(value) = comment.strip_prefix("format: ") {
                if header.is_some() {
                    bail!("backup header field after the first statement (line {line_no})");
                }
                header_parts.format = Some(
                    value
                        .parse()
                        .map_err(|_| anyhow!("backup format {value:?} is not a number"))?,
                );
            } else if let Some(value) = comment.strip_prefix("server_version: ") {
                header_parts.server_version = Some(value.to_string());
            } else if let Some(value) = comment.strip_prefix("migration_version: ") {
                header_parts.migration_version = Some(
                    value
                        .parse()
                        .map_err(|_| anyhow!("migration version {value:?} is not a number"))?,
                );
            } else if let Some(value) = comment.strip_prefix("created_at: ") {
                header_parts.created_at = Some(
                    DateTime::parse_from_rfc3339(value)
                        .map_err(|_| anyhow!("created_at {value:?} is not a timestamp"))?
                        .with_timezone(&Utc),
                );
            } else if let Some(value) = comment.strip_prefix("rows ") {
                emit_header(&mut header, &header_parts, &mut sink)?;
                trailer.push(
                    parse_rows_line(value)
                        .ok_or_else(|| anyhow!("malformed row count line {line_no}"))?,
                );
            } else if comment == "end" {
                emit_header(&mut header, &header_parts, &mut sink)?;
                ended = true;
            }
            // Any other comment is ignored.
            continue;
        }

        // A statement. None may follow the row counts.
        if !trailer.is_empty() {
            bail!("backup has a statement after its row counts (line {line_no})");
        }
        emit_header(&mut header, &header_parts, &mut sink)?;

        if let Some((table, columns)) = parse_copy_statement(line) {
            if tables.iter().any(|(t, _)| *t == table) {
                bail!("backup contains table {table:?} twice");
            }
            sink(Item::CopyStart {
                table: table.clone(),
                columns,
            })?;
            copy = Some((table, 0));
        } else if let Some((sequence, value, is_called)) = parse_setval_statement(line) {
            sink(Item::Setval {
                sequence,
                value,
                is_called,
            })?;
        } else {
            let shown: String = line.chars().take(60).collect();
            bail!("backup contains a statement HelixSync did not write (line {line_no}: {shown:?}); refusing to run it");
        }
    }

    if copy.is_some() || !ended {
        bail!("backup is truncated: its end marker is missing");
    }
    let header = header.ok_or_else(|| anyhow!("backup has no header"))?;
    if trailer != tables {
        bail!(
            "backup row counts do not match its contents (trailer lists {} table(s), data holds {})",
            trailer.len(),
            tables.len()
        );
    }
    Ok(Summary { header, tables })
}

fn emit_header(
    emitted: &mut Option<Header>,
    parts: &HeaderParts,
    sink: &mut impl FnMut(Item) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    if emitted.is_none() {
        let header = parts.complete()?;
        sink(Item::Header(header.clone()))?;
        *emitted = Some(header);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn header() -> Header {
        Header {
            format: FORMAT_VERSION,
            server_version: "1.0.0".into(),
            migration_version: 3,
            created_at: Utc.with_ymd_and_hms(2026, 11, 13, 3, 0, 0).unwrap(),
        }
    }

    fn script(body: &str) -> String {
        format!("{}{body}", header_text(&header()))
    }

    fn good_body() -> String {
        let cols = vec!["id".to_string(), "weird \"col\"".to_string()];
        format!(
            "{}\n1\tone\n2\ttwo\\nlines\n\\.\n\n{}\n\n{}{}{}",
            copy_in_statement("things", &cols),
            setval_statement("things_id_seq", 2, true).unwrap(),
            rows_line("things", 2),
            END_LINE,
            ""
        )
    }

    fn parse_str(text: &str) -> anyhow::Result<Summary> {
        parse(text.as_bytes(), |_| Ok(()))
    }

    // `COPY` text rows never contain a bare newline, so the line after the
    // statement starts the data. The helper above puts a blank first line;
    // fix it for the happy path.
    fn good_script() -> String {
        script(&good_body().replacen("stdin;\n\n", "stdin;\n", 1))
    }

    #[test]
    fn reads_what_the_writer_produces() {
        let mut items = Vec::new();
        let summary = parse(good_script().as_bytes(), |i| {
            items.push(i);
            Ok(())
        })
        .unwrap();
        assert_eq!(summary.header, header());
        assert_eq!(summary.tables, vec![("things".to_string(), 2)]);
        assert_eq!(summary.total_rows(), 2);
        assert!(matches!(items[0], Item::Header(_)));
        match &items[1] {
            Item::CopyStart { table, columns } => {
                assert_eq!(table, "things");
                assert_eq!(columns, &["id", "weird \"col\""]);
            }
            other => panic!("{other:?}"),
        }
        match &items[2] {
            Item::CopyData(data) => assert_eq!(data, b"1\tone\n2\ttwo\\nlines\n"),
            other => panic!("{other:?}"),
        }
        assert!(matches!(items[3], Item::CopyEnd));
        assert!(matches!(
            &items[4],
            Item::Setval { sequence, value: 2, is_called: true } if sequence == "things_id_seq"
        ));
    }

    #[test]
    fn identifiers_round_trip() {
        for name in ["users", "a\"b", "with space", "ünï"] {
            let quoted = quote_ident(name);
            assert_eq!(
                parse_quoted(&quoted),
                Some((name.to_string(), "")),
                "{name}"
            );
        }
        assert_eq!(parse_quoted("\"a\" rest"), Some(("a".into(), " rest")));
        assert_eq!(parse_quoted("\"\""), None);
        assert_eq!(parse_quoted("\"unterminated"), None);
        assert_eq!(parse_quoted("bare"), None);
    }

    #[test]
    fn rejects_any_statement_the_writer_does_not_produce() {
        for evil in [
            "DROP TABLE users;",
            "TRUNCATE public.\"users\";",
            "COPY public.\"users\" (\"id\") FROM PROGRAM 'id';",
            "COPY public.\"users\" (\"id\") TO stdout;",
            "COPY public.\"users\" (\"id\") FROM stdin; DROP TABLE users;",
            "SELECT pg_catalog.setval('public.\"x\"', 1, true); DROP TABLE users;",
            "SELECT pg_catalog.setval('public.\"x\"', +1, true);",
            "SELECT pg_catalog.setval('public.\"x\"', 1, maybe);",
            "SELECT pg_catalog.setval('other.\"x\"', 1, true);",
            "SELECT 1;",
            "\\! id",
            "\\copy users from '/etc/passwd'",
        ] {
            let text = script(&format!("{evil}\n-- end\n"));
            assert!(parse_str(&text).is_err(), "{evil}");
        }
    }

    #[test]
    fn rejects_content_after_the_end_and_statements_after_the_counts() {
        let good = good_script();
        assert!(parse_str(&format!("{good}DROP TABLE users;\n")).is_err());
        assert!(parse_str(&format!("{good}\n\n")).is_ok());

        let late_statement = good.replace(
            "-- end\n",
            &format!("{}\n-- end\n", setval_statement("x", 1, true).unwrap()),
        );
        assert!(parse_str(&late_statement).is_err());
    }

    #[test]
    fn rejects_truncation_everywhere() {
        let good = good_script();
        assert!(parse_str(&good).is_ok());
        // Every proper prefix is refused: cut mid-row, mid-statement, before
        // the trailer or before the end marker.
        for cut in 0..good.len() - "-- end\n".len() {
            assert!(parse_str(&good[..cut]).is_err(), "cut at {cut}");
        }
        assert!(parse_str(&good[..good.len() - 1]).is_err());
    }

    #[test]
    fn rejects_row_counts_that_do_not_match() {
        let wrong = good_script().replace("-- rows \"things\" 2", "-- rows \"things\" 3");
        assert!(parse_str(&wrong).is_err());
        let missing = good_script().replace("-- rows \"things\" 2\n", "");
        assert!(parse_str(&missing).is_err());
        let extra = good_script().replace("-- end", &format!("{}-- end", rows_line("ghost", 0)));
        assert!(parse_str(&extra).is_err());
    }

    #[test]
    fn rejects_a_bad_or_newer_header() {
        let body = good_body().replacen("stdin;\n\n", "stdin;\n", 1);
        let newer = good_script().replace("-- format: 1", "-- format: 2");
        assert!(parse_str(&newer)
            .unwrap_err()
            .to_string()
            .contains("newer than this server"));
        let no_version = good_script().replace("-- migration_version: 3\n", "");
        assert!(parse_str(&no_version).is_err());
        assert!(parse_str(&body).is_err(), "a body without a header");
    }

    #[test]
    fn rejects_the_same_table_twice() {
        let cols = vec!["id".to_string()];
        let one = format!("{}\n1\n\\.\n", copy_in_statement("t", &cols));
        let text = script(&format!("{one}{one}{}{}", rows_line("t", 1), END_LINE));
        assert!(parse_str(&text).is_err());
    }

    #[test]
    fn large_tables_arrive_in_chunks_of_whole_rows() {
        let cols = vec!["v".to_string()];
        let row = format!("{}\n", "x".repeat(1000));
        let rows = 200;
        let text = script(&format!(
            "{}\n{}\\.\n{}{}",
            copy_in_statement("t", &cols),
            row.repeat(rows),
            rows_line("t", rows as u64),
            END_LINE
        ));
        let mut chunks = Vec::new();
        parse(text.as_bytes(), |item| {
            if let Item::CopyData(d) = item {
                chunks.push(d);
            }
            Ok(())
        })
        .unwrap();
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.ends_with(b"\n")));
        assert_eq!(chunks.concat(), row.repeat(rows).into_bytes());
    }
}
