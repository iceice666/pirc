//! Skill locations the file tools may read (`agent/skills.ts`); listing
//! skills to the model is M5's `skills` feature.

/// `skillRoots(configDir, workspace)`.
pub fn skill_roots(config_dir: &str, workspace: &str) -> Vec<String> {
    let _ = (config_dir, workspace);
    todo!("M4 store: skillRoots")
}

/// `skillReadPaths(roots)`.
pub fn skill_read_paths(roots: &[String]) -> Vec<String> {
    let _ = roots;
    todo!("M4 store: skillReadPaths")
}
