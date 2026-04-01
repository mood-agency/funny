use crate::repo_cache::with_repo;

#[napi]
pub async fn get_current_branch(cwd: String) -> napi::Result<Option<String>> {
  with_repo(&cwd, |repo| {
    let head_ref = repo
      .head_ref()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD: {e}")))?;

    Ok(head_ref.map(|r| r.name().shorten().to_string()))
  })
}

#[napi]
pub async fn list_branches(cwd: String) -> napi::Result<Vec<String>> {
  with_repo(&cwd, |repo| {
    let refs = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

    let local_refs = refs
      .local_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list local branches: {e}")))?;

    let mut seen = std::collections::HashSet::new();
    let mut branches: Vec<String> = Vec::new();

    for reference in local_refs {
      if let Ok(r) = reference {
        let name = r.name().shorten().to_string();
        seen.insert(name.clone());
        branches.push(name);
      }
    }

    // Always include remote branches that don't exist locally
    let refs2 = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

    let remote_refs = refs2
      .remote_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list remote branches: {e}")))?;

    for reference in remote_refs {
      if let Ok(r) = reference {
        let name = r.name().shorten().to_string();
        if name.contains("HEAD") {
          continue;
        }
        // Only include branches with origin/ prefix, strip it
        if let Some(stripped) = name.strip_prefix("origin/") {
          if !stripped.is_empty() && seen.insert(stripped.to_string()) {
            branches.push(stripped.to_string());
          }
        }
      }
    }

    if branches.is_empty() {
      // Fall back to symbolic ref for empty repos
      if let Ok(Some(head_ref)) = repo.head_ref() {
        branches.push(head_ref.name().shorten().to_string());
      }
    }

    Ok(branches)
  })
}

#[napi]
pub async fn get_default_branch(cwd: String) -> napi::Result<Option<String>> {
  with_repo(&cwd, |repo| {
    // Try refs/remotes/origin/HEAD — it's a symbolic ref pointing to e.g. refs/remotes/origin/master
    if let Ok(origin_head) = repo.find_reference("refs/remotes/origin/HEAD") {
      // Follow the symbolic ref to get the actual target branch
      if let gix::refs::TargetRef::Symbolic(target_name) = origin_head.target() {
        let name = target_name.shorten().to_string();
        let branch = if let Some(stripped) = name.strip_prefix("origin/") {
          stripped.to_string()
        } else {
          name
        };
        return Ok(Some(branch));
      }
    }

    // Fall back to checking common branch names
    let refs = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;

    let local_refs = refs
      .local_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list branches: {e}")))?;

    let mut branch_names: Vec<String> = Vec::new();
    for reference in local_refs {
      if let Ok(r) = reference {
        branch_names.push(r.name().shorten().to_string());
      }
    }

    if branch_names.contains(&"main".to_string()) {
      return Ok(Some("main".to_string()));
    }
    if branch_names.contains(&"master".to_string()) {
      return Ok(Some("master".to_string()));
    }
    if branch_names.contains(&"develop".to_string()) {
      return Ok(Some("develop".to_string()));
    }

    Ok(branch_names.first().cloned())
  })
}

#[napi]
pub async fn get_remote_url(cwd: String) -> napi::Result<Option<String>> {
  with_repo(&cwd, |repo| {
    let config = repo.config_snapshot();
    match config.string("remote.origin.url") {
      Some(value) => Ok(Some(value.to_string())),
      None => Ok(None),
    }
  })
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BranchDetailedInfo {
  pub name: String,
  pub is_local: bool,
  pub is_remote: bool,
}

#[napi]
pub async fn list_branches_detailed(cwd: String) -> napi::Result<Vec<BranchDetailedInfo>> {
  with_repo(&cwd, |repo| {
    let mut local_set = std::collections::HashSet::new();
    let mut remote_set = std::collections::HashSet::new();

    // Collect local branches
    let refs = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;
    let local_refs = refs
      .local_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list local branches: {e}")))?;
    for reference in local_refs {
      if let Ok(r) = reference {
        local_set.insert(r.name().shorten().to_string());
      }
    }

    // Collect remote branches
    let refs2 = repo
      .references()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get references: {e}")))?;
    let remote_refs = refs2
      .remote_branches()
      .map_err(|e| napi::Error::from_reason(format!("Failed to list remote branches: {e}")))?;
    for reference in remote_refs {
      if let Ok(r) = reference {
        let name = r.name().shorten().to_string();
        if name.contains("HEAD") {
          continue;
        }
        if let Some(stripped) = name.strip_prefix("origin/") {
          if !stripped.is_empty() {
            remote_set.insert(stripped.to_string());
          }
        }
      }
    }

    let all_names: std::collections::HashSet<_> = local_set.union(&remote_set).cloned().collect();
    let mut branches: Vec<BranchDetailedInfo> = all_names
      .into_iter()
      .map(|name| BranchDetailedInfo {
        is_local: local_set.contains(&name),
        is_remote: remote_set.contains(&name),
        name,
      })
      .collect();
    branches.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if branches.is_empty() {
      if let Ok(Some(head_ref)) = repo.head_ref() {
        branches.push(BranchDetailedInfo {
          name: head_ref.name().shorten().to_string(),
          is_local: true,
          is_remote: false,
        });
      }
    }

    Ok(branches)
  })
}
