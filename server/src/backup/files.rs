// Backup file names and the folder they live in.
//
//   helixsync-backup-20261113T030000Z.sql.zst.age              scheduled
//   helixsync-backup-20261113T030000Z-manual.sql.zst.age       `backup-now`
//   helixsync-backup-20261113T030000Z-prerestore.sql.zst.age   safety copy
//
// The folder is the only state the scheduler keeps, so nothing but a name
// that matches exactly is ever read, listed or deleted: foreign files and
// the operator's own copies stay where they are.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDateTime, Utc};

pub const PREFIX: &str = "helixsync-backup-";
pub const SUFFIX: &str = ".sql.zst.age";
pub const PARTIAL_SUFFIX: &str = ".partial";

const TIMESTAMP_FORMAT: &str = "%Y%m%dT%H%M%SZ";
/// `20261113T030000Z`
const TIMESTAMP_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Written by the scheduler.
    Scheduled,
    /// Written by `backup-now`.
    Manual,
    /// Written by `restore-backup` before it replaced the data.
    PreRestore,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Scheduled => "scheduled",
            Kind::Manual => "manual",
            Kind::PreRestore => "prerestore",
        }
    }

    fn name_marker(self) -> &'static str {
        match self {
            Kind::Scheduled => "",
            Kind::Manual => "-manual",
            Kind::PreRestore => "-prerestore",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BackupFile {
    pub name: String,
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub kind: Kind,
    pub size: u64,
}

pub fn file_name(created_at: DateTime<Utc>, kind: Kind) -> String {
    format!(
        "{PREFIX}{}{}{SUFFIX}",
        created_at.format(TIMESTAMP_FORMAT),
        kind.name_marker()
    )
}

/// Reads the time and kind out of a backup file name. `None` for any other
/// name, including `.partial` files.
pub fn parse_file_name(name: &str) -> Option<(DateTime<Utc>, Kind)> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    if rest.len() < TIMESTAMP_LEN || !rest.is_char_boundary(TIMESTAMP_LEN) {
        return None;
    }
    let (timestamp, marker) = rest.split_at(TIMESTAMP_LEN);
    let kind = match marker {
        "" => Kind::Scheduled,
        "-manual" => Kind::Manual,
        "-prerestore" => Kind::PreRestore,
        _ => return None,
    };
    let naive = NaiveDateTime::parse_from_str(timestamp, TIMESTAMP_FORMAT).ok()?;
    Some((naive.and_utc(), kind))
}

/// All backup files in `dir`, oldest first.
pub fn list(dir: &Path) -> io::Result<Vec<BackupFile>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some((created_at, kind)) = parse_file_name(&name) else {
            continue;
        };
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        files.push(BackupFile {
            path: entry.path(),
            name,
            created_at,
            kind,
            size: metadata.len(),
        });
    }
    files.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(files)
}

/// The file `restore-backup` uses when none is named: the newest scheduled
/// or manual one. A safety copy is only ever restored by naming it.
pub fn newest_restorable(files: &[BackupFile]) -> Option<&BackupFile> {
    files.iter().rfind(|f| f.kind != Kind::PreRestore)
}

pub fn newest_scheduled(files: &[BackupFile]) -> Option<&BackupFile> {
    files.iter().rfind(|f| f.kind == Kind::Scheduled)
}

/// Which files to delete: everything beyond the newest `keep_last`, except
/// the newest safety copy, which is never pruned. `files` is oldest first, as
/// [`list`] returns it.
pub fn select_prune(files: &[BackupFile], keep_last: usize) -> Vec<&BackupFile> {
    let protected = files.iter().rfind(|f| f.kind == Kind::PreRestore);
    files
        .iter()
        .rev()
        .skip(keep_last)
        .filter(|f| protected.is_none_or(|p| p.name != f.name))
        .collect()
}

/// Deletes the files [`select_prune`] picks. Returns the names removed.
pub fn prune(dir: &Path, keep_last: usize) -> io::Result<Vec<String>> {
    let files = list(dir)?;
    let mut removed = Vec::new();
    for file in select_prune(&files, keep_last) {
        fs::remove_file(&file.path)?;
        removed.push(file.name.clone());
    }
    Ok(removed)
}

/// Deletes `helixsync-backup-*.partial` files: what a run that crashed left
/// behind. Callers hold the backup lock, so no live run is writing one.
pub fn remove_partials(dir: &Path) -> io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with(PREFIX) && name.ends_with(PARTIAL_SUFFIX) && entry.metadata()?.is_file()
        {
            fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Resolves the `<file>` argument of `restore-backup`: a bare name is looked
/// up in `dir`, anything with a path separator is used as given.
pub fn resolve_argument(dir: &Path, argument: &str) -> PathBuf {
    if argument.contains('/') || argument.contains(std::path::MAIN_SEPARATOR) {
        PathBuf::from(argument)
    } else {
        dir.join(argument)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 13, h, m, s).unwrap()
    }

    fn file(created_at: DateTime<Utc>, kind: Kind) -> BackupFile {
        let name = file_name(created_at, kind);
        BackupFile {
            path: PathBuf::from(&name),
            name,
            created_at,
            kind,
            size: 1,
        }
    }

    #[test]
    fn names_round_trip() {
        for kind in [Kind::Scheduled, Kind::Manual, Kind::PreRestore] {
            let name = file_name(at(3, 0, 7), kind);
            assert_eq!(parse_file_name(&name), Some((at(3, 0, 7), kind)), "{name}");
        }
        assert_eq!(
            file_name(at(3, 0, 0), Kind::Scheduled),
            "helixsync-backup-20261113T030000Z.sql.zst.age"
        );
    }

    #[test]
    fn foreign_and_partial_names_are_not_backups() {
        for name in [
            "notes.txt",
            "helixsync-backup-20261113T030000Z.sql.zst.age.partial",
            "helixsync-backup-20261113T030000Z.sql.zst",
            "helixsync-backup-20261113T030000Z-other.sql.zst.age",
            "helixsync-backup-2026-11-13.sql.zst.age",
            "helixsync-backup-20261313T030000Z.sql.zst.age",
            "helixsync-backup-.sql.zst.age",
            "helixsync-backup-éééééééééééééééé.sql.zst.age",
            "other-backup-20261113T030000Z.sql.zst.age",
        ] {
            assert_eq!(parse_file_name(name), None, "{name}");
        }
    }

    #[test]
    fn prune_keeps_the_newest_and_the_newest_safety_copy() {
        let files = vec![
            file(at(1, 0, 0), Kind::PreRestore),
            file(at(2, 0, 0), Kind::PreRestore),
            file(at(3, 0, 0), Kind::Scheduled),
            file(at(4, 0, 0), Kind::Scheduled),
            file(at(5, 0, 0), Kind::Manual),
            file(at(6, 0, 0), Kind::Scheduled),
        ];
        let doomed: Vec<_> = select_prune(&files, 2)
            .into_iter()
            .map(|f| f.name.as_str())
            .collect();
        // Newest two (05:00, 06:00) stay; the 02:00 safety copy is protected.
        assert_eq!(
            doomed,
            vec![
                file_name(at(4, 0, 0), Kind::Scheduled),
                file_name(at(3, 0, 0), Kind::Scheduled),
                file_name(at(1, 0, 0), Kind::PreRestore),
            ]
        );
    }

    #[test]
    fn prune_does_nothing_within_the_limit() {
        let files = vec![
            file(at(1, 0, 0), Kind::Scheduled),
            file(at(2, 0, 0), Kind::Manual),
        ];
        assert!(select_prune(&files, 2).is_empty());
        assert!(select_prune(&files, 7).is_empty());
    }

    #[test]
    fn default_restore_target_skips_safety_copies() {
        let files = vec![
            file(at(1, 0, 0), Kind::Scheduled),
            file(at(2, 0, 0), Kind::Manual),
            file(at(3, 0, 0), Kind::PreRestore),
        ];
        assert_eq!(newest_restorable(&files).unwrap().kind, Kind::Manual);
        assert_eq!(newest_scheduled(&files).unwrap().created_at, at(1, 0, 0));
        assert!(newest_restorable(&files[2..]).is_none());
    }

    #[test]
    fn arguments_resolve_inside_the_backup_folder_unless_a_path() {
        let dir = Path::new("/backups");
        assert_eq!(
            resolve_argument(dir, "a.sql.zst.age"),
            PathBuf::from("/backups/a.sql.zst.age")
        );
        assert_eq!(
            resolve_argument(dir, "/elsewhere/a.sql.zst.age"),
            PathBuf::from("/elsewhere/a.sql.zst.age")
        );
        assert_eq!(
            resolve_argument(dir, "./a.sql.zst.age"),
            PathBuf::from("./a.sql.zst.age")
        );
    }
}
