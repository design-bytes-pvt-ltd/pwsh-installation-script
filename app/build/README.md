# Build resources

electron-builder reads packaging resources from this folder (its default `buildResources`
directory). Nothing here is bundled into the renderer UI. UI images go in
`src/renderer/assets/`.

Expected app icons (electron-builder picks them up by name):

| File        | Platform | Notes                                   |
|-------------|----------|-----------------------------------------|
| `icon.icns` | macOS    | Generated from a 1024×1024 source       |
| `icon.ico`  | Windows  | Include 16, 32, 48, 64, 128, 256 px     |
| `icon.png`  | Linux    | 512×512 or larger                       |

Until these exist, electron-builder falls back to the default Electron icon.
