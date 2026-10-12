//! Running bubblewrap with a profile too long for one command line.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/linux-sandbox-utils.js`
//! (`renderBwrapInvocation`, `openBwrapArgsProfile`, `BWRAP_MAX_ARGS`,
//! `BWRAP_ARGS_FD`, `LinuxSandboxProfileError`) (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).
//!
//! srt handed its embedder one shell string, so its limit was Linux's
//! per-argument `MAX_ARG_STRLEN` (`maxArgStrlen`). pirc executes bubblewrap
//! directly, one argument per word, where no single word comes near that
//! cap; what a large policy can reach is the limit on the whole argument
//! list (`ARG_MAX`, shared with the environment) and bubblewrap's own cap
//! of 9,000 parsed words. A policy reaches either with a few thousand
//! mounts: a node whose state lies under a writable root and has many
//! sessions (one deny per session directory), or a scan finding thousands
//! of dangerous files. So, as in srt: past bubblewrap's cap the profile is
//! refused; past half of `ARG_MAX` (the other half is left to the
//! environment, which carries the policy too, and the runner's flags) the
//! mount words go to an unnamed file (`O_TMPFILE`) this process holds
//! open, which `/bin/sh` opens again through `/proc/<pid>/fd/<n>` on fd 9
//! for bubblewrap's `--args 9`.

use std::ffi::OsString;
use std::io::Write;
use std::ops::Range;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};

use nix::fcntl::OFlag;
use nix::sys::stat::Mode;

/// `BWRAP_MAX_ARGS`: bubblewrap's cap on parsed words, command line and
/// `--args` file together.
pub const BWRAP_MAX_ARGS: usize = 9000;

/// `BWRAP_ARGS_FD`: one digit (dash takes no more in a redirection), high
/// enough to stay clear of the embedder's.
pub const BWRAP_ARGS_FD: u32 = 9;

/// How bubblewrap is started: directly, or through `/bin/sh` with the
/// mount words held on `profile`.
#[derive(Debug)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// The unnamed profile file; must stay open until bubblewrap has read
    /// it (the session's cleanup closes it).
    pub profile: Option<OwnedFd>,
}

/// The byte budget of bubblewrap's argument list: half of `ARG_MAX`.
pub fn byte_budget() -> usize {
    let arg_max = nix::unistd::sysconf(nix::unistd::SysconfVar::ARG_MAX)
        .ok()
        .flatten()
        .and_then(|max| usize::try_from(max).ok())
        .unwrap_or(128 * 1024);
    arg_max / 2
}

fn bytes(words: &[OsString]) -> usize {
    words.iter().map(|word| word.len() + 1).sum()
}

/// `renderBwrapInvocation`: `bwrap` with `options` (bubblewrap's options;
/// `mounts` is the filesystem plan's range in them) and then `command`
/// (`--` and what runs inside), within `budget` bytes. `tmpdir` is where
/// the unnamed file is tried first (then `/dev/shm`).
pub fn render(
    bwrap: &Path,
    options: Vec<String>,
    mounts: Range<usize>,
    command: Vec<OsString>,
    budget: usize,
    tmpdir: &Path,
) -> Result<Invocation, String> {
    if options.len() > BWRAP_MAX_ARGS {
        return Err(format!(
            "the sandbox profile has {} bubblewrap arguments and bubblewrap accepts at most {BWRAP_MAX_ARGS} (about {} mounts); reduce what the policy expands to",
            options.len(),
            BWRAP_MAX_ARGS / 3
        ));
    }
    if options[mounts.clone()]
        .iter()
        .any(|word| word.contains('\0'))
    {
        return Err(
            "the sandbox profile contains a path with a NUL byte, which neither a command line nor a file of bubblewrap arguments can carry"
                .to_owned(),
        );
    }
    let mut inline: Vec<OsString> = options.iter().map(OsString::from).collect();
    inline.extend(command.iter().cloned());
    let inline_bytes = bwrap.as_os_str().len() + 1 + bytes(&inline);
    if inline_bytes <= budget {
        return Ok(Invocation {
            program: bwrap.to_path_buf(),
            args: inline,
            profile: None,
        });
    }
    let too_long = format!(
        "the sandbox profile is too long for the command line ({inline_bytes} bytes; past {budget} it goes through a file)"
    );
    if options.len() + 2 > BWRAP_MAX_ARGS {
        return Err(format!(
            "{too_long} and, passed through a file, would exceed the {BWRAP_MAX_ARGS} arguments bubblewrap accepts"
        ));
    }
    let profile = open_profile(&options[mounts.clone()], tmpdir)
        .map_err(|error| format!("{too_long} and cannot be passed through a file: {error}"))?;
    let mut args: Vec<OsString> = vec![
        "-c".into(),
        format!("exec {BWRAP_ARGS_FD}<\"$1\" && shift && exec \"$@\"").into(),
        "pirc-args".into(),
        profile_path(&profile).into(),
        bwrap.into(),
    ];
    args.extend(options[..mounts.start].iter().map(OsString::from));
    args.extend(["--args".into(), BWRAP_ARGS_FD.to_string().into()]);
    args.extend(options[mounts.end..].iter().map(OsString::from));
    args.extend(command);
    let total = "/bin/sh".len() + 1 + bytes(&args);
    if total > budget {
        return Err(format!(
            "the sandboxed command is too long even with the mounts passed through a file ({total} bytes; the limit here is {budget})"
        ));
    }
    Ok(Invocation {
        program: PathBuf::from("/bin/sh"),
        args,
        profile: Some(profile),
    })
}

/// Where the shell opens the profile held on `fd`.
fn profile_path(fd: &OwnedFd) -> String {
    format!("/proc/{}/fd/{}", std::process::id(), fd.as_raw_fd())
}

/// `openBwrapArgsProfile`: `words` NUL-separated in an unnamed file, made
/// read-only, checked to open again through `/proc`. Nothing is ever
/// named, so nothing can be substituted between now and bubblewrap's read.
fn open_profile(words: &[String], tmpdir: &Path) -> Result<OwnedFd, String> {
    let contents: String = words.iter().map(|word| format!("{word}\0")).collect();
    let mut failures = Vec::new();
    let mut dirs = vec![tmpdir.to_path_buf()];
    if tmpdir != Path::new("/dev/shm") {
        dirs.push(PathBuf::from("/dev/shm"));
    }
    for dir in dirs {
        let fd = match nix::fcntl::open(
            &dir,
            OFlag::O_TMPFILE | OFlag::O_RDWR | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        ) {
            Ok(fd) => fd,
            Err(error) => {
                failures.push(format!("{}: {error}", dir.display()));
                continue;
            }
        };
        let written = (|| -> Result<OwnedFd, String> {
            let mut file = std::fs::File::from(fd);
            file.write_all(contents.as_bytes())
                .map_err(|e| e.to_string())?;
            nix::sys::stat::fchmod(&file, Mode::from_bits_truncate(0o400))
                .map_err(|e| e.to_string())?;
            let fd = OwnedFd::from(file);
            std::fs::File::open(profile_path(&fd)).map_err(|e| e.to_string())?;
            Ok(fd)
        })();
        match written {
            Ok(fd) => return Ok(fd),
            Err(error) => failures.push(format!("{}: {error}", dir.display())),
        }
    }
    Err(format!(
        "no unnamed file could be opened for it ({})",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(mounts: usize) -> (Vec<String>, Range<usize>) {
        let mut words: Vec<String> = ["--new-session", "--unshare-net"]
            .map(String::from)
            .to_vec();
        let start = words.len();
        for index in 0..mounts {
            words.extend([
                "--ro-bind".to_owned(),
                format!("/p/{index}"),
                format!("/p/{index}"),
            ]);
        }
        let end = words.len();
        words.extend(["--dev", "/dev"].map(String::from));
        (words, start..end)
    }

    #[test]
    fn short_profiles_stay_on_the_command_line() {
        let (words, mounts) = options(2);
        let run = render(
            Path::new("/bin/bwrap"),
            words.clone(),
            mounts,
            vec!["--".into(), "agent".into()],
            1 << 20,
            Path::new("/tmp"),
        )
        .unwrap();
        assert_eq!(run.program, PathBuf::from("/bin/bwrap"));
        assert!(run.profile.is_none());
        assert_eq!(run.args.len(), words.len() + 2);
    }

    #[test]
    fn long_profiles_go_through_an_unnamed_file() {
        let (words, mounts) = options(100);
        let dir = tempfile::tempdir().unwrap();
        let run = render(
            Path::new("/bin/bwrap"),
            words.clone(),
            mounts.clone(),
            vec!["--".into(), "agent".into()],
            2000,
            dir.path(),
        )
        .unwrap();
        assert_eq!(run.program, PathBuf::from("/bin/sh"));
        let args: Vec<String> = run
            .args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "-c");
        assert_eq!(args[4], "/bin/bwrap");
        assert_eq!(
            args[5..],
            [
                "--new-session",
                "--unshare-net",
                "--args",
                "9",
                "--dev",
                "/dev",
                "--",
                "agent"
            ]
        );
        let profile = std::fs::read(&args[3]).unwrap();
        let expected: String = words[mounts].iter().map(|w| format!("{w}\0")).collect();
        assert_eq!(profile, expected.as_bytes());
        // Nothing was named in the directory.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        // The shell gives bubblewrap the same words.
        let out = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "exec 9<\"$1\" && shift && exec \"$@\"",
                "pirc-args",
                &args[3],
                "/bin/sh",
                "-c",
                "tr '\\0' ' ' <&9",
            ])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).starts_with("--ro-bind /p/0 /p/0 --ro-bind /p/1")
        );
    }

    #[test]
    fn profiles_past_bubblewraps_cap_are_refused() {
        let (words, mounts) = options(3001);
        let error = render(
            Path::new("/bin/bwrap"),
            words,
            mounts,
            Vec::new(),
            1 << 30,
            Path::new("/tmp"),
        )
        .unwrap_err();
        assert!(
            error.starts_with("the sandbox profile has 9007 bubblewrap arguments"),
            "{error}"
        );
        let (mut words, mounts) = options(1);
        words[3].push('\0');
        assert!(
            render(
                Path::new("/bin/bwrap"),
                words,
                mounts,
                Vec::new(),
                1 << 30,
                Path::new("/tmp")
            )
            .unwrap_err()
            .contains("NUL")
        );
        // Too long even through the file.
        let (words, mounts) = options(10);
        let long = vec![OsString::from("x".repeat(5000))];
        assert!(
            render(
                Path::new("/bin/bwrap"),
                words,
                mounts,
                long,
                1000,
                Path::new("/tmp")
            )
            .unwrap_err()
            .contains("too long even")
        );
    }
}
