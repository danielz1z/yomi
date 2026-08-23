fn main() {
    #[cfg(target_os = "windows")]
    {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("windows-native/Yomi.ico");
        resource.set("ProductName", "Yomi Desktop");
        resource.set(
            "FileDescription",
            "Yomi native LINE inbox and agent workspace",
        );
        resource.compile().expect("compile Windows resources");
    }
}
