use std::{
    env, io,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub(crate) struct Endpoint {
    http: ureq::Agent,
    port: u16,
}

impl Endpoint {
    fn new(port: u16) -> Self {
        let http = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(2)))
            .max_redirects(0)
            .proxy(None)
            .build()
            .new_agent();
        Self { http, port }
    }

    fn url(&self, route: &str) -> String {
        format!("http://127.0.0.1:{}{route}", self.port)
    }

    fn healthy(&self) -> bool {
        self.http
            .get(self.url("/health"))
            .call()
            .ok()
            .filter(|response| response.status().is_success())
            .and_then(|mut response| response.body_mut().read_json::<serde_json::Value>().ok())
            .is_some_and(|body| {
                body["ok"] == true && body["opencode"].is_boolean() && body["browser"].is_boolean()
            })
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        let response = self
            .http
            .post(self.url("/stop"))
            .send_empty()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        let acknowledged = response
            .into_body()
            .read_json::<serde_json::Value>()
            .map_err(|error| error.to_string())?;
        if acknowledged["ok"] == true {
            Ok(())
        } else {
            Err("jarvisd hat den Not-Aus nicht bestätigt".into())
        }
    }
}

pub(crate) struct Services {
    daemon: Endpoint,
    owned: Arc<Mutex<Owned>>,
}

#[derive(Default)]
struct Owned {
    closing: bool,
    children: Vec<ProcessTree>,
}

#[derive(Clone, Copy)]
enum Service {
    Daemon,
    Speech,
}

impl Service {
    fn name(self) -> &'static str {
        match self {
            Self::Daemon => "jarvisd",
            Self::Speech => "Sprach-Sidecar",
        }
    }

    fn command(self, root: &Path) -> io::Result<Command> {
        let (program, args): (_, &[&str]) = match self {
            Self::Daemon => ("bun", &["run", "core/src/index.ts"]),
            Self::Speech => (
                "uv",
                &[
                    "run",
                    "--project",
                    "speech",
                    "python",
                    "-m",
                    "jarvis_speech",
                ],
            ),
        };
        let mut command = Command::new(program);
        command.args(args).current_dir(root).stdin(Stdio::null());
        command.env("PATH", service_path()?);
        Ok(command)
    }

    fn port(self, daemon: &Endpoint) -> u16 {
        match self {
            Self::Daemon => daemon.port,
            Self::Speech => 7778,
        }
    }

    fn ready(self, daemon: &Endpoint) -> bool {
        match self {
            Self::Daemon => daemon.healthy(),
            Self::Speech => listening(self.port(daemon)),
        }
    }
}

impl Services {
    pub(crate) fn new() -> Self {
        // jarvisd supports JARVIS_PORT. The default is the endpoint shared with the UI.
        let port = env::var("JARVIS_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|&port| port != 0);
        Self {
            daemon: Endpoint::new(port.unwrap_or(7777)),
            owned: Arc::new(Mutex::new(Owned::default())),
        }
    }

    pub(crate) fn endpoint(&self) -> &Endpoint {
        &self.daemon
    }

    pub(crate) fn start(&self) {
        for service in [Service::Daemon, Service::Speech] {
            let endpoint = self.daemon.clone();
            let owned = Arc::clone(&self.owned);
            thread::spawn(move || {
                if let Err(error) = start_service(service, &endpoint, &owned) {
                    eprintln!("Jarvis3: {}: {error}", service.name());
                    crate::errorlog::record("app", &format!("tauri/{}", service.name()), &error, serde_json::json!({ "service": service.name(), "port": service.port(&endpoint), "repo": env::var("JARVIS_REPO").ok() }));
                }
            });
        }
    }

    pub(crate) fn shutdown(&self) {
        let children = {
            let mut owned = self.owned.lock().unwrap();
            owned.closing = true;
            std::mem::take(&mut owned.children)
        };
        drop(children);
    }
}

impl Drop for Services {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn start_service(
    service: Service,
    endpoint: &Endpoint,
    state: &Mutex<Owned>,
) -> Result<(), String> {
    if service.ready(endpoint) {
        eprintln!("Jarvis3: {} läuft bereits", service.name());
        return Ok(());
    }
    if listening(service.port(endpoint)) {
        return Err(format!(
            "Port {} ist belegt und /health meldet keinen erreichbaren jarvisd",
            service.port(endpoint)
        ));
    }

    let root =
        repo_root().ok_or("Jarvis3-Repository fehlt. JARVIS_REPO auf den Checkout setzen.")?;
    let mut command = service.command(&root).map_err(|error| error.to_string())?;
    let id = {
        let mut owned = state.lock().unwrap();
        if owned.closing {
            return Ok(());
        }
        let process = ProcessTree::spawn(&mut command).map_err(|error| error.to_string())?;
        let id = process.child.id();
        eprintln!("Jarvis3: {} gestartet (PID {id})", service.name());
        owned.children.push(process);
        id
    };
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut checking_readiness = true;
    loop {
        {
            let mut owned = state.lock().unwrap();
            if owned.closing {
                return Ok(());
            }
            let index = owned
                .children
                .iter()
                .position(|process| process.child.id() == id)
                .expect("worker owns a registered child");
            if let Some(status) = owned.children[index]
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
            {
                let stopped = owned.children.swap_remove(index);
                drop(owned);
                drop(stopped);
                return Err(format!("Prozess beendet: {status}"));
            }
        }
        if checking_readiness {
            if service.ready(endpoint) {
                eprintln!("Jarvis3: {} bereit", service.name());
                checking_readiness = false;
            } else if Instant::now() >= deadline {
                eprintln!(
                    "Jarvis3: {} nach {} s noch nicht bereit",
                    service.name(),
                    STARTUP_TIMEOUT.as_secs()
                );
                checking_readiness = false;
            }
        }
        thread::sleep(if checking_readiness {
            PROBE_INTERVAL
        } else {
            Duration::from_secs(1)
        });
    }
}

fn listening(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn repo_root() -> Option<PathBuf> {
    let is_checkout = |path: &Path| {
        path.join("core/src/index.ts").is_file() && path.join("speech/pyproject.toml").is_file()
    };
    if let Some(path) = env::var_os("JARVIS_REPO").map(PathBuf::from) {
        return is_checkout(&path).then_some(path);
    }
    let current_dir = env::current_dir().ok();
    let executable = env::current_exe().ok();
    for candidate in [
        current_dir.as_deref(),
        executable.as_deref(),
        Some(Path::new(env!("CARGO_MANIFEST_DIR"))),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = candidate.ancestors().find(|path| is_checkout(path)) {
            return Some(path.to_owned());
        }
    }
    None
}

fn service_path() -> io::Result<std::ffi::OsString> {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<_> = env::split_paths(&inherited).collect();
    #[cfg(unix)]
    let home = env::var_os("HOME");
    #[cfg(windows)]
    let home = env::var_os("USERPROFILE");
    if let Some(home) = home.map(PathBuf::from) {
        paths.extend([
            home.join(".bun").join("bin"),
            home.join(".local").join("bin"),
        ]);
    }
    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    env::join_paths(paths).map_err(io::Error::other)
}

struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    job: Job,
}

impl ProcessTree {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            Ok(Self {
                child: command.spawn()?,
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
            let job = Job::new()?;
            let mut child = command.spawn()?;
            if let Err(error) = job.assign(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(Self { child, job })
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let group = -(self.child.id() as libc::pid_t);
            // Give jarvisd a chance to run its SIGTERM handler before ending descendants.
            unsafe { libc::kill(group, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_millis(700);
            while Instant::now() < deadline {
                let _ = self.child.try_wait();
                if unsafe { libc::kill(group, 0) } != 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            unsafe { libc::kill(group, libc::SIGKILL) };
        }
        #[cfg(windows)]
        if !self.job.terminate() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
struct Job(usize);

#[cfg(windows)]
impl Job {
    fn new() -> io::Result<Self> {
        use std::mem::{size_of_val, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(handle as usize);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let valid = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            )
        };
        if valid == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        if unsafe { AssignProcessToJobObject(self.0 as _, child.as_raw_handle() as _) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> bool {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        (unsafe { TerminateJobObject(self.0 as _, 1) }) != 0
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };

    #[test]
    fn health_and_emergency_stop_use_the_contract_routes() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = Endpoint::new(listener.local_addr().unwrap().port());
        let server = thread::spawn(move || {
            for (path, body) in [
                (
                    "GET /health HTTP/1.1",
                    r#"{"ok":true,"opencode":false,"browser":false}"#,
                ),
                ("POST /stop HTTP/1.1", r#"{"ok":true}"#),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = BufReader::new(&stream);
                let mut first = String::new();
                request.read_line(&mut first).unwrap();
                assert_eq!(path, first.trim());
                loop {
                    let mut header = String::new();
                    request.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                }
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        assert!(endpoint.healthy());
        assert_eq!(endpoint.stop(), Ok(()));
        server.join().unwrap();
    }
}
