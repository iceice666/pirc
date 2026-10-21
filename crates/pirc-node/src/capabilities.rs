//! What this node's machine can do (plans/rewrite/08-nodes.md), sent with
//! its registration so the gateway can choose a machine for a task: the
//! OS and architecture, its GPUs, whether agents get a browser and the
//! panel terminals, the sandbox and whether it reaches the GPU, and how
//! many agents it means to run at once. Facts, never permissions.
//!
//! GPUs are found cheaply and without running anything: on Linux the DRM
//! devices in `/sys/class/drm` by PCI vendor (and `/dev/nvidia*` for an
//! NVIDIA driver without DRM), on macOS Apple silicon's own GPU. The first
//! version reports vendor and count only; model and memory stay empty.

use std::collections::BTreeMap;
use std::path::Path;

use pirc_protocol::{Capabilities, Gpu, SandboxCapability};

use crate::sandbox::SandboxStatus;
use crate::services::Node;

/// The capabilities to register with.
pub async fn capabilities(node: &Node) -> Capabilities {
    let status = node.sandbox.check().await;
    Capabilities {
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        gpus: gpus(),
        browser: node.browser.enabled(),
        terminals: node.config.terminals_enabled,
        sandbox: SandboxCapability {
            backend: backend(node.config.sandbox.srt.is_some(), &status).to_owned(),
            status: match status {
                SandboxStatus::Active { .. } => "active",
                SandboxStatus::Unavailable { .. } => "unavailable",
            }
            .to_owned(),
            // Not yet: plans/sandbox-gpu.md.
            gpu: false,
        },
        max_running: node.config.max_running,
    }
}

fn backend(srt: bool, status: &SandboxStatus) -> &'static str {
    if matches!(status, SandboxStatus::Unavailable { .. }) {
        "none"
    } else if srt {
        "srt"
    } else if cfg!(target_os = "macos") {
        "seatbelt"
    } else {
        "bubblewrap"
    }
}

/// This machine's GPUs.
pub fn gpus() -> Vec<Gpu> {
    if cfg!(target_os = "macos") {
        return if std::env::consts::ARCH == "aarch64" {
            vec![Gpu {
                vendor: "apple".to_owned(),
                count: 1,
                ..Gpu::default()
            }]
        } else {
            Vec::new()
        };
    }
    linux_gpus(Path::new("/sys/class/drm"), Path::new("/dev"))
}

/// The DRM cards under `drm` (`card0`, not its connectors `card0-DP-1`) by
/// PCI vendor, and NVIDIA's `/dev/nvidiaN` devices when DRM lists none of
/// its cards.
pub fn linux_gpus(drm: &Path, dev: &Path) -> Vec<Gpu> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    let entries = std::fs::read_dir(drm).into_iter().flatten().flatten();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(number) = name.strip_prefix("card") else {
            continue;
        };
        if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(vendor) = std::fs::read_to_string(entry.path().join("device/vendor")) else {
            continue;
        };
        let vendor = match vendor.trim().to_ascii_lowercase().as_str() {
            "0x10de" => "nvidia".to_owned(),
            "0x1002" => "amd".to_owned(),
            "0x8086" => "intel".to_owned(),
            other => other.to_owned(),
        };
        *counts.entry(vendor).or_default() += 1;
    }
    if !counts.contains_key("nvidia") {
        let nvidia = std::fs::read_dir(dev)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.strip_prefix("nvidia")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            })
            .count();
        if nvidia > 0 {
            counts.insert("nvidia".to_owned(), nvidia as u32);
        }
    }
    counts
        .into_iter()
        .map(|(vendor, count)| Gpu {
            vendor,
            count,
            ..Gpu::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_drm_cards_by_vendor_and_nvidia_devices_without_drm() {
        let dir = tempfile::tempdir().unwrap();
        let (drm, dev) = (dir.path().join("drm"), dir.path().join("dev"));
        for (card, vendor) in [
            ("card0", "0x8086\n"),
            ("card1", "0x10de\n"),
            ("card2", "0x10de\n"),
        ] {
            std::fs::create_dir_all(drm.join(card).join("device")).unwrap();
            std::fs::write(drm.join(card).join("device/vendor"), vendor).unwrap();
        }
        // A connector and a render node are not cards.
        std::fs::create_dir_all(drm.join("card0-DP-1/device")).unwrap();
        std::fs::write(drm.join("card0-DP-1/device/vendor"), "0x8086").unwrap();
        std::fs::create_dir_all(drm.join("renderD128")).unwrap();
        std::fs::create_dir_all(&dev).unwrap();
        let found = |gpus: Vec<Gpu>| -> Vec<(String, u32)> {
            gpus.into_iter()
                .map(|gpu| (gpu.vendor, gpu.count))
                .collect()
        };
        assert_eq!(
            found(linux_gpus(&drm, &dev)),
            [("intel".to_owned(), 1), ("nvidia".to_owned(), 2)]
        );
        // The NVIDIA driver alone: its device files.
        let bare = dir.path().join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        for name in ["nvidia0", "nvidia1", "nvidiactl", "nvidia-uvm"] {
            std::fs::write(dev.join(name), "").unwrap();
        }
        assert_eq!(found(linux_gpus(&bare, &dev)), [("nvidia".to_owned(), 2)]);
        assert!(linux_gpus(&dir.path().join("none"), &bare).is_empty());
    }
}
