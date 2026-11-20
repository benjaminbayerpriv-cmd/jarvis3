use std::{env, fs, path::Path};

fn main() {
    let icon = Path::new("../ui/icons/tray.svg");
    let fallback = Path::new("icons/tray-placeholder.svg");
    println!("cargo:rerun-if-changed=../ui/icons");
    println!("cargo:rerun-if-changed={}", fallback.display());
    let svg = fs::read(if icon.is_file() { icon } else { fallback }).expect("read tray SVG");
    let tree = resvg::usvg::Tree::from_data(&svg, &Default::default()).expect("parse tray SVG");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(36, 36).expect("allocate tray icon");
    let scale = (36.0 / tree.size().width()).min(36.0 / tree.size().height());
    let x = (36.0 - tree.size().width() * scale) / 2.0;
    let y = (36.0 - tree.size().height() * scale) / 2.0;
    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale).post_translate(x, y);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let rgba: Vec<_> = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let out = env::var_os("OUT_DIR").expect("Cargo output directory");
    fs::write(Path::new(&out).join("tray.rgba"), rgba).expect("write tray icon");
    tauri_build::build();
}
