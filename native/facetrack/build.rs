// Mac：ONNX Runtime 的 CoreML 部分用到 __isPlatformVersionAtLeast（在 clang 的 compiler-rt 裡，rustc 預設不連結）→ 連結 libclang_rt.osx.a
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        if let Ok(o) = std::process::Command::new("clang").arg("--print-resource-dir").output() {
            let dir = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let lib = std::path::Path::new(&dir).join("lib/darwin/libclang_rt.osx.a");
            if lib.exists() { println!("cargo:rustc-link-arg={}", lib.display()); }
        }
    }
}
