---
type: fixed
---
`timon plugin sign` now signs the files `npm pack` ships, so it works in a plugin's working folder and the package installed from its archive passes verification; `timon plugin check` verifies the signature over the same files.
