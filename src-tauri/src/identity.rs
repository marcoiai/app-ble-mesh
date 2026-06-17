use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshIdentity {
    pub id: String,
    pub label: String,
}

#[tauri::command]
pub fn load_mesh_identity(app: tauri::AppHandle) -> Result<Option<MeshIdentity>, String> {
    let path = identity_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(&path).map_err(|error| format!("read mesh identity: {error}"))?;
    let identity = serde_json::from_slice::<MeshIdentity>(&bytes)
        .map_err(|error| format!("parse mesh identity: {error}"))?;

    if identity.id.trim().is_empty() || identity.label.trim().is_empty() {
        return Ok(None);
    }

    Ok(Some(identity))
}

#[tauri::command]
pub fn save_mesh_identity(
    app: tauri::AppHandle,
    identity: MeshIdentity,
) -> Result<MeshIdentity, String> {
    let identity = MeshIdentity {
        id: identity.id.trim().to_string(),
        label: identity.label.trim().to_string(),
    };

    if identity.id.is_empty() || identity.label.is_empty() {
        return Err("mesh identity id/label cannot be empty".to_string());
    }

    let path = identity_path(&app)?;
    let bytes = serde_json::to_vec_pretty(&identity)
        .map_err(|error| format!("encode mesh identity: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("write mesh identity: {error}"))?;

    Ok(identity)
}

fn identity_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("resolve config dir: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("create config dir: {error}"))?;
    Ok(dir.join("mesh-identity.json"))
}
