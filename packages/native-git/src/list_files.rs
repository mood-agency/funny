use std::collections::HashSet;
use std::sync::atomic::AtomicBool;

use gix::bstr::{BString, ByteSlice};
use gix::dir::walk::{Action, EmissionMode, ForDeletionMode};

use crate::repo_cache::with_repo;

/// Heavy build/dependency directories we never want to surface in the file
/// picker, even when they're not in `.gitignore`. Mirrors the
/// `HEAVY_IGNORED_DIRS` constant on the TS side — keep both lists in sync.
const HEAVY_DIRS: &[&str] = &[
  // JS / web
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".vite",
  ".parcel-cache",
  // git internals
  ".git",
  // Unity (CT-12-24-style projects: `Library` alone holds 60k+ cache files)
  "Library",
  "Temp",
  "Logs",
  // Rust
  "target",
  // .NET / Java
  "bin",
  "obj",
  ".gradle",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  // Misc vendored deps
  "vendor",
];

fn is_under_heavy_dir(path: &str) -> bool {
  for seg in path.split('/') {
    for d in HEAVY_DIRS {
      if seg == *d {
        return true;
      }
    }
  }
  false
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ListFilesOptions {
  pub include_ignored: Option<bool>,
}

struct ListDelegate {
  files: Vec<String>,
}

impl gix::dir::walk::Delegate for ListDelegate {
  fn emit(
    &mut self,
    entry: gix::dir::EntryRef<'_>,
    _collapsed_directory_status: Option<gix::dir::entry::Status>,
  ) -> Action {
    // Only emit regular files / symlinks. Directory entries are dropped here
    // — for heavy dirs we don't even recurse (see `can_recurse`), so we never
    // see their contents. Repository entries (submodules, nested bare repos)
    // are skipped: walking into them would need a separate `gix::Repository`.
    match entry.disk_kind {
      Some(gix::dir::entry::Kind::File) | Some(gix::dir::entry::Kind::Symlink) => {
        let path = entry.rela_path.to_str_lossy().to_string();
        if !is_under_heavy_dir(&path) {
          self.files.push(path);
        }
      }
      _ => {}
    }
    Action::Continue(())
  }

  fn can_recurse(
    &mut self,
    entry: gix::dir::EntryRef<'_>,
    for_deletion: Option<ForDeletionMode>,
    worktree_root_is_repository: bool,
  ) -> bool {
    // Skip recursion into heavy build/dep directories regardless of their
    // ignore status — gix never enumerates their contents, so we don't have to
    // filter them post-hoc. The basename check is sufficient because the path
    // is `/`-joined from the walk root.
    let path_cow = entry.rela_path.to_str_lossy();
    let last = path_cow.rsplit('/').next().unwrap_or(path_cow.as_ref());
    if HEAVY_DIRS.iter().any(|d| *d == last) {
      return false;
    }
    entry.status.can_recurse(
      entry.disk_kind,
      entry.pathspec_match,
      for_deletion,
      worktree_root_is_repository,
    )
  }
}

/// List every file in the repo: tracked from the index, plus untracked and
/// (optionally) `.gitignore`-ignored files from a worktree walk. Heavy build
/// directories (`node_modules`, `dist`, `.next`, …) are pruned regardless.
///
/// Returns repository-relative paths with unix separators, deduplicated.
#[napi]
pub async fn list_files(
  cwd: String,
  options: Option<ListFilesOptions>,
) -> napi::Result<Vec<String>> {
  let include_ignored = options
    .as_ref()
    .and_then(|o| o.include_ignored)
    .unwrap_or(true);

  with_repo(&cwd, |repo| {
    let index = repo
      .open_index()
      .map_err(|e| napi::Error::from_reason(format!("Failed to open index: {e}")))?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut files: Vec<String> = Vec::new();

    // ── Phase 1: tracked files from the index ──
    // Reading the index is essentially free — no worktree I/O.
    for entry in index.entries().iter() {
      // Skip submodule (gitlink, mode 160000) entries: they're directories,
      // not individual files, and recursing into them would require opening
      // separate repos. The previous CLI behaviour did recurse, but the file
      // picker rarely benefits from nested submodule contents.
      if entry.mode.is_submodule() {
        continue;
      }
      let path = entry.path(&index).to_str_lossy().to_string();
      if is_under_heavy_dir(&path) {
        continue;
      }
      if seen.insert(path.clone()) {
        files.push(path);
      }
    }

    // ── Phase 2: untracked + ignored files via dirwalk ──
    // To match the CLI's behaviour (which lists files inside ignored dirs
    // like `.claude/`), we set `for_deletion =
    // FindNonBareRepositoriesInIgnoredDirectories`. That flips gix's default
    // "stop at ignored directories" rule and lets us walk into them. Heavy
    // build dirs (`node_modules`, `.next`, …) are still pruned by our
    // `can_recurse` override, so their contents are never enumerated.
    let mut opts = repo
      .dirwalk_options()
      .map_err(|e| napi::Error::from_reason(format!("Failed to build dirwalk options: {e}")))?;
    opts = opts
      .emit_untracked(EmissionMode::Matching)
      .emit_tracked(false);
    if include_ignored {
      opts = opts
        .emit_ignored(Some(EmissionMode::Matching))
        .for_deletion(Some(ForDeletionMode::FindNonBareRepositoriesInIgnoredDirectories));
    }

    let interrupt = AtomicBool::new(false);
    let mut delegate = ListDelegate { files: Vec::new() };
    let empty_patterns: Vec<BString> = Vec::new();

    repo
      .dirwalk(&index, empty_patterns, &interrupt, opts, &mut delegate)
      .map_err(|e| napi::Error::from_reason(format!("dirwalk failed: {e}")))?;

    for path in delegate.files {
      if seen.insert(path.clone()) {
        files.push(path);
      }
    }

    Ok(files)
  })
}
