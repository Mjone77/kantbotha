//! extool: build and maintenance tool for the Kantbotha extension (Kantata quality of life
//! features + the Kantata → Workday timesheet copier).
//!
//! Run from anywhere; paths are resolved relative to the `kantbotha/` directory (the parent
//! of this crate).
//!
//! Layout: the extension source is the kantbotha/ folder itself. Plain JS/CSS/HTML/images in
//! SOURCE_DIRS are copied as-is; TypeScript (timesheet/**/*.ts) is compiled by `tsc`.
//! manifest-chrome.json / manifest-firefox.json become dist/<browser>/manifest.json.
//!
//! Commands:
//!   build [chrome|firefox]  Type-check and compile the TypeScript with `tsc` (any type error
//!                           fails the build), then assemble dist/chrome and dist/firefox
//!                           (or just one). The Chrome build gets the manifest "key" from
//!                           manifest_key.txt so its extension ID is stable when loaded
//!                           unpacked. Checks that every file the manifest names exists.
//!   check                   Type-check only (`tsc --noEmit`).
//!   keygen                  Create manifest_key.txt (public key only; the private key is
//!                           discarded because it's only needed to publish to a store).
//!   id                      Print the Chrome/Edge extension ID and the copier's app URL.
//!   export <dir> [browser]  Build, then copy dist/<browser> (default chrome) to <dir> (e.g.
//!                           a Windows folder under /mnt/c so Edge can "Load unpacked").
//!   page-fn <module> <function> [json-args] [--out <file>]
//!                           Write a standalone `(function …)(…args)` expression for one
//!                           exported function of a compiled timesheet module (e.g.
//!                           page/workday.js), for testing in-page code by pasting it into
//!                           the browser's DevTools console. --out is relative to the
//!                           current directory.
//!   package                 Build both browsers, then write store-ready zips to
//!                           releases/kantbotha-<browser>-<version>.zip. manifest.json sits
//!                           at the zip root, and the Chrome "key" is removed (the store
//!                           assigns its own ID and doesn't accept it).
//!   clean                   Delete dist/.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// Folders of kantbotha/ that make up the extension.
const SOURCE_DIRS: &[&str] = &["background", "content_scripts", "icons", "timesheet"];
/// File types copied from SOURCE_DIRS (TypeScript is compiled instead).
const COPY_EXTS: &[&str] = &["js", "css", "html", "json", "png", "svg"];
const BROWSERS: &[&str] = &["chrome", "firefox"];
/// Path of the timesheet copier page inside the extension.
const APP_PATH: &str = "timesheet/app.html";

fn root() -> PathBuf {
    // CARGO_MANIFEST_DIR is kantbotha/tool at compile time.
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("kantbotha dir").to_path_buf()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("build") => browsers(args.get(1)).and_then(|b| build(&b)),
        Some("check") => check(),
        Some("keygen") => keygen(),
        Some("id") => print_id(),
        Some("export") => match args.get(1) {
            Some(dir) => browsers(args.get(2).or(Some(&"chrome".to_string()))).and_then(|b| {
                if b.len() != 1 {
                    return Err("export takes one browser".into());
                }
                build(&b)?;
                export(b[0], Path::new(dir))
            }),
            None => Err("usage: extool export <dir> [chrome|firefox]".into()),
        },
        Some("page-fn") => page_fn(&args[1..]),
        Some("package") => package(),
        Some("clean") => clean(),
        _ => Err(USAGE.into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(1)
        }
    }
}

const USAGE: &str = "usage: extool <build [chrome|firefox] | check | keygen | id | export <dir> [chrome|firefox] | page-fn <module> <function> [json-args] [--out <file>] | package | clean>";

type Res<T> = Result<T, String>;

fn io<T>(r: std::io::Result<T>, what: &str) -> Res<T> {
    r.map_err(|e| format!("{what}: {e}"))
}

fn browsers(arg: Option<&String>) -> Res<Vec<&'static str>> {
    match arg.map(String::as_str) {
        None | Some("all") => Ok(BROWSERS.to_vec()),
        Some(b) => BROWSERS
            .iter()
            .find(|x| **x == b)
            .map(|x| vec![*x])
            .ok_or_else(|| format!("unknown browser {b:?} (use chrome or firefox)")),
    }
}

// ---------------------------------------------------------------- build

fn build(targets: &[&str]) -> Res<()> {
    let root = root();
    let dist = root.join("dist");
    let compiled = dist.join(".tsc");
    if compiled.exists() {
        io(fs::remove_dir_all(&compiled), "remove dist/.tsc")?;
    }
    // Type-check and emit timesheet/**/*.ts into dist/.tsc (outDir in tsconfig.json).
    tsc(&root, true)?;

    for &browser in targets {
        let out = dist.join(browser);
        if out.exists() {
            io(fs::remove_dir_all(&out), "remove old build")?;
        }
        // 1. Plain source files.
        for dir in SOURCE_DIRS {
            let src = root.join(dir);
            if !src.exists() {
                return Err(format!("{} is missing", src.display()));
            }
            for f in walk(&src)? {
                let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("");
                if COPY_EXTS.contains(&ext) {
                    copy_into(&f, &out.join(f.strip_prefix(&root).unwrap()))?;
                }
            }
        }
        // 2. Compiled TypeScript.
        for f in walk(&compiled)? {
            copy_into(&f, &out.join(f.strip_prefix(&compiled).unwrap()))?;
        }
        // 3. Manifest (+ key for Chrome so the unpacked ID is stable).
        let text = io(fs::read_to_string(root.join(format!("manifest-{browser}.json"))), "read manifest")?;
        let mut json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("manifest-{browser}.json: {e}"))?;
        if browser == "chrome" {
            match read_key(&root) {
                Ok(key) => json["key"] = serde_json::Value::String(key),
                Err(_) => println!("note: no manifest_key.txt, so the Chrome extension ID will depend on the install path"),
            }
        }
        io(fs::write(out.join("manifest.json"), serde_json::to_string_pretty(&json).unwrap()), "write manifest")?;
        verify_manifest(&json, &out, browser)?;
        if !out.join(APP_PATH).exists() || !out.join("timesheet/app.js").exists() || !out.join("timesheet/options.js").exists() {
            return Err(format!("{browser}: the timesheet copier page is missing from the build"));
        }
        println!("built {}", out.display());
        if let Some(win) = windows_path(&out) {
            println!("  load unpacked from: {win}");
        }
    }
    if targets.contains(&"chrome") {
        if let Ok(id) = extension_id(&root) {
            println!("chrome/edge extension id: {id}");
            println!("copier url: chrome-extension://{id}/{APP_PATH}");
        }
    }
    Ok(())
}

fn copy_into(from: &Path, to: &Path) -> Res<()> {
    io(fs::create_dir_all(to.parent().unwrap()), "mkdir")?;
    io(fs::copy(from, to), "copy").map(|_| ())
}

/// Every file the manifest refers to must be in the build.
fn verify_manifest(m: &serde_json::Value, out: &Path, browser: &str) -> Res<()> {
    let mut files: Vec<String> = Vec::new();
    let mut push = |v: &serde_json::Value| {
        if let Some(s) = v.as_str() {
            files.push(s.to_string());
        }
    };
    push(&m["background"]["service_worker"]);
    push(&m["options_ui"]["page"]);
    m["background"]["scripts"].as_array().into_iter().flatten().for_each(&mut push);
    m["icons"].as_object().into_iter().flat_map(|o| o.values()).for_each(&mut push);
    for cs in m["content_scripts"].as_array().into_iter().flatten() {
        cs["js"].as_array().into_iter().flatten().for_each(&mut push);
        cs["css"].as_array().into_iter().flatten().for_each(&mut push);
    }
    let missing: Vec<_> = files.iter().filter(|f| !out.join(f).exists()).collect();
    if !missing.is_empty() {
        return Err(format!("{browser}: manifest refers to missing file(s): {missing:?}"));
    }
    Ok(())
}

fn walk(dir: &Path) -> Res<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in io(fs::read_dir(&d), "read_dir")? {
            let p = io(entry, "dir entry")?.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Run the TypeScript compiler on kantbotha/tsconfig.json. With `emit = false` it only
/// type-checks. Any type error fails the build.
fn tsc(root: &Path, emit: bool) -> Res<()> {
    let mut cmd = Command::new("tsc");
    cmd.arg("-p").arg(root.join("tsconfig.json")).arg("--pretty").arg("false");
    if !emit {
        cmd.arg("--noEmit");
    }
    let out = cmd
        .output()
        .map_err(|e| format!("couldn't run tsc (is TypeScript installed and on PATH?): {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(format!("tsc reported errors:\n{}", text.trim_end()));
    }
    if !text.trim().is_empty() {
        println!("{}", text.trim_end());
    }
    Ok(())
}

fn check() -> Res<()> {
    tsc(&root(), false)?;
    println!("type-check passed");
    Ok(())
}

// ---------------------------------------------------------------- key / id

fn key_file(root: &Path) -> PathBuf {
    root.join("manifest_key.txt")
}

fn keygen() -> Res<()> {
    let root = root();
    let kf = key_file(&root);
    if kf.exists() {
        return Err(format!("{} already exists; delete it first to change the extension ID", kf.display()));
    }
    use rsa::pkcs8::EncodePublicKey;
    let mut rng = rand::thread_rng();
    let private = rsa::RsaPrivateKey::new(&mut rng, 2048).map_err(|e| e.to_string())?;
    let der = rsa::RsaPublicKey::from(&private).to_public_key_der().map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_bytes());
    io(fs::write(&kf, format!("{b64}\n")), "write key")?;
    println!("wrote {}", kf.display());
    print_id()
}

fn read_key(root: &Path) -> Res<String> {
    let kf = key_file(root);
    let s = io(fs::read_to_string(&kf), "read manifest_key.txt (run `extool keygen` first)")?;
    Ok(s.trim().to_string())
}

fn extension_id(root: &Path) -> Res<String> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(read_key(root)?)
        .map_err(|e| e.to_string())?;
    let hash = Sha256::digest(&der);
    Ok(hash[..16]
        .iter()
        .flat_map(|b| [b >> 4, b & 0xf])
        .map(|n| (b'a' + n) as char)
        .collect())
}

fn print_id() -> Res<()> {
    let id = extension_id(&root())?;
    println!("chrome/edge extension id: {id}");
    println!("copier url: chrome-extension://{id}/{APP_PATH}");
    Ok(())
}

fn windows_path(p: &Path) -> Option<String> {
    let distro = std::env::var("WSL_DISTRO_NAME").ok()?;
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix("/mnt/") {
        let mut parts = rest.splitn(2, '/');
        let drive = parts.next()?.to_uppercase();
        return Some(format!("{drive}:\\{}", parts.next().unwrap_or("").replace('/', "\\")));
    }
    Some(format!("\\\\wsl.localhost\\{distro}{}", s.replace('/', "\\")))
}

// ---------------------------------------------------------------- export / clean

fn export(browser: &str, dir: &Path) -> Res<()> {
    let built = root().join("dist").join(browser);
    if dir.exists() {
        // Only replace a directory that looks like a previous export.
        if !dir.join("manifest.json").exists() && io(fs::read_dir(dir), "read export dir")?.next().is_some() {
            return Err(format!("{} exists and isn't a previous export; refusing to overwrite", dir.display()));
        }
        io(fs::remove_dir_all(dir), "remove old export")?;
    }
    for f in walk(&built)? {
        copy_into(&f, &dir.join(f.strip_prefix(&built).unwrap()))?;
    }
    println!("exported {browser} build to {}", dir.display());
    if let Some(win) = windows_path(dir) {
        println!("load unpacked from: {win}");
    }
    Ok(())
}

// ---------------------------------------------------------------- package

fn package() -> Res<()> {
    let root = root();
    // Both manifests must carry the same version; it names the zips.
    let mut version: Option<String> = None;
    for browser in BROWSERS {
        let text = io(fs::read_to_string(root.join(format!("manifest-{browser}.json"))), "read manifest")?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("manifest-{browser}.json: {e}"))?;
        let v = json["version"].as_str().ok_or(format!("manifest-{browser}.json has no version"))?.to_string();
        match &version {
            Some(prev) if *prev != v => {
                return Err(format!("manifest versions differ ({prev} vs {v} in manifest-{browser}.json); make them match"))
            }
            _ => version = Some(v),
        }
    }
    let version = version.unwrap();

    build(BROWSERS)?;

    let releases = root.join("releases");
    io(fs::create_dir_all(&releases), "mkdir releases")?;
    for browser in BROWSERS {
        let built = root.join("dist").join(browser);
        let zip_path = releases.join(format!("kantbotha-{browser}-{version}.zip"));
        let replaced = zip_path.exists();
        write_zip(&built, &zip_path)?;
        verify_zip(&zip_path)?;
        println!("{} {}", if replaced { "replaced" } else { "wrote" }, zip_path.display());
        if let Some(win) = windows_path(&zip_path) {
            println!("  {win}");
        }
    }
    Ok(())
}

fn write_zip(dir: &Path, zip_path: &Path) -> Res<()> {
    use std::io::Write;
    let file = io(fs::File::create(zip_path), "create zip")?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for f in walk(dir)? {
        // Zip entry names always use "/" and are relative to the extension root.
        let name = f
            .strip_prefix(dir)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let mut bytes = io(fs::read(&f), "read file for zip")?;
        if name == "manifest.json" {
            let mut json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("manifest.json: {e}"))?;
            if let Some(obj) = json.as_object_mut() {
                obj.remove("key");
            }
            bytes = serde_json::to_vec_pretty(&json).unwrap();
        }
        zip.start_file(name, opts).map_err(|e| format!("zip: {e}"))?;
        io(zip.write_all(&bytes), "write zip entry")?;
    }
    zip.finish().map_err(|e| format!("zip: {e}"))?;
    Ok(())
}

/// Reopens the zip: manifest.json must be at the root, without a "key".
fn verify_zip(zip_path: &Path) -> Res<()> {
    use std::io::Read;
    let file = io(fs::File::open(zip_path), "open zip")?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    let mut text = String::new();
    zip.by_name("manifest.json")
        .map_err(|_| format!("{}: manifest.json isn't at the zip root", zip_path.display()))?
        .read_to_string(&mut text)
        .map_err(|e| format!("zip: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("zipped manifest.json: {e}"))?;
    if json.get("key").is_some() {
        return Err(format!("{}: manifest still has a key", zip_path.display()));
    }
    Ok(())
}

fn clean() -> Res<()> {
    let dist = root().join("dist");
    if dist.exists() {
        io(fs::remove_dir_all(&dist), "remove dist")?;
    }
    println!("cleaned {}", dist.display());
    Ok(())
}

// ---------------------------------------------------------------- page-fn

fn page_fn(args: &[String]) -> Res<()> {
    let mut positional = Vec::new();
    let mut out: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--out" {
            out = Some(PathBuf::from(it.next().ok_or("--out needs a path")?));
        } else {
            positional.push(a.clone());
        }
    }
    let [module, function, rest @ ..] = positional.as_slice() else {
        return Err("usage: extool page-fn <module.js> <function> [json-args] [--out <file>]".into());
    };
    let call_args = match rest.first() {
        Some(j) => {
            let v: serde_json::Value = serde_json::from_str(j).map_err(|e| format!("json-args: {e}"))?;
            match v {
                serde_json::Value::Array(items) => items.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", "),
                other => other.to_string(),
            }
        }
        None => String::new(),
    };
    let path = root().join("dist/.tsc/timesheet").join(module);
    let source = io(fs::read_to_string(&path), "read module (run `extool build` first)")?;
    let body = extract_function(&source, function).ok_or_else(|| format!("exported function {function} not found in {module}"))?;
    let expr = format!("({body})({call_args})\n");
    write_out(out, expr)
}

/// Cuts `export [async] function NAME(…) { … }` out of tsc output. tsc prints a top-level
/// function's closing brace alone at column 0, so the function ends at the first line that
/// is exactly "}". Returns the function without the `export ` keyword.
fn extract_function(source: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();
    let starts = [format!("export function {name}("), format!("export async function {name}(")];
    let start = lines.iter().position(|l| starts.iter().any(|s| l.starts_with(s.as_str())))?;
    let end = (start..lines.len()).find(|&i| lines[i] == "}")?;
    let text = lines[start..=end].join("\n");
    Some(text.trim_start_matches("export ").to_string())
}

fn write_out(out: Option<PathBuf>, expr: String) -> Res<()> {
    match out {
        Some(p) => {
            io(fs::write(&p, expr), "write --out")?;
            println!("wrote {}", p.display());
        }
        None => print!("{expr}"),
    }
    Ok(())
}
