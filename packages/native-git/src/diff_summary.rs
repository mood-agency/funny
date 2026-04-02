use gix::bstr::BString;

use crate::repo_cache::with_repo;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileDiffSummaryItem {
  pub path: String,
  pub status: String,
  pub staged: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct DiffSummaryResult {
  pub files: Vec<FileDiffSummaryItem>,
  pub total: u32,
  pub truncated: bool,
}

/// Check if a path matches any of the exclude patterns (simple suffix/contains matching).
fn matches_any_pattern(path: &str, patterns: &[String]) -> bool {
  for pat in patterns {
    if path.contains(pat.as_str()) {
      return true;
    }
  }
  false
}

#[napi]
pub async fn get_diff_summary(
  cwd: String,
  exclude_patterns: Option<Vec<String>>,
  max_files: Option<u32>,
) -> napi::Result<DiffSummaryResult> {
  with_repo(&cwd, |repo| {
    let exclude = exclude_patterns.unwrap_or_default();
    let max = max_files.unwrap_or(0) as usize;

    let status_platform = repo
      .status(gix::progress::Discard)
      .map_err(|e| napi::Error::from_reason(format!("Failed to create status: {e}")))?
      .untracked_files(gix::status::UntrackedFiles::Files);

    // into_index_worktree_iter takes pathspec patterns (empty = all files)
    let empty_patterns: Vec<BString> = Vec::new();
    let status_iter = status_platform
      .into_index_worktree_iter(empty_patterns)
      .map_err(|e| napi::Error::from_reason(format!("Failed to iterate status: {e}")))?;

    let mut all_files: Vec<FileDiffSummaryItem> = Vec::new();

    for entry in status_iter {
      let entry = entry
        .map_err(|e| napi::Error::from_reason(format!("Status iteration error: {e}")))?;

      let (path, status) = match &entry {
        gix::status::index_worktree::Item::Modification { rela_path, status, .. } => {
          let p = rela_path.to_string();
          use gix_status::index_as_worktree::EntryStatus;
          use gix_status::index_as_worktree::Change;
          let s = match status {
            EntryStatus::Conflict { .. } => "conflicted",
            EntryStatus::Change(change) => match change {
              Change::Removed => "deleted",
              Change::Type { .. } => "modified",
              Change::Modification { .. } => "modified",
              Change::SubmoduleModification(_) => "modified",
            },
            EntryStatus::NeedsUpdate(_) => "modified",
            EntryStatus::IntentToAdd => "added",
          };
          (p, s.to_string())
        }
        gix::status::index_worktree::Item::DirectoryContents { entry: dir_entry, .. } => {
          let p = dir_entry.rela_path.to_string();
          (p, "added".to_string())
        }
        gix::status::index_worktree::Item::Rewrite { dirwalk_entry, .. } => {
          let p = dirwalk_entry.rela_path.to_string();
          (p, "renamed".to_string())
        }
      };

      if !exclude.is_empty() && matches_any_pattern(&path, &exclude) {
        continue;
      }

      all_files.push(FileDiffSummaryItem {
        path,
        status,
        staged: false,
      });
    }

    let total = all_files.len() as u32;
    let truncated = max > 0 && all_files.len() > max;
    if truncated {
      all_files.truncate(max);
    }

    Ok(DiffSummaryResult {
      files: all_files,
      total,
      truncated,
    })
  })
}
