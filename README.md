# Certum Cloud Code Signing GitHub Action

[![CI Test Suite](https://github.com/jay0lee/certum-cloud-code-sign/actions/workflows/test.yml/badge.svg)](https://github.com/jay0lee/certum-cloud-code-sign/actions/workflows/test.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A GitHub Action that installs, authenticates, and configures **Certum SimplySign Desktop** for "Code Signing in the Cloud" certificates on **Windows x86_64** and **Windows ARM64** GitHub runners.

---

## Features

- **Cross-Architecture Support**: Runs seamlessly on both `x86_64` (e.g. `windows-2022`, `windows-2025`, `windows-latest`) and `ARM64` (e.g. `windows-11-arm`) GitHub Actions runners.
- **Automated OOBE Screen Dismissal**: Automatically handles Windows ARM64 GitHub runner quirks where the VM begins with an interactive Out-Of-Box Experience (OOBE) privacy settings screen, tabbing through and dismissing it so GUI automation can proceed.
- **Last-Second TOTP Generation & Expiry Protection**:
  - Focuses the SimplySign Desktop OTP input field *first*.
  - Checks remaining validity in the current 30-second window; if fewer than 5 seconds remain, it pauses until a fresh cycle begins.
  - Generates the RFC 6238 HMAC-SHA256 OTP at the absolute last millisecond before typing, guaranteeing maximum validity window during network submission.
- **Strict Zero-Log Privacy & Dynamic Secret Masking**: Neither the TOTP secret nor the generated one-time password is **ever** printed, logged, or exposed in console outputs or error traces. Sensitive values are dynamically registered with the GitHub Actions secret masking engine (`::add-mask::`).
- **Cryptographic Memory Zeroing**: Sensitive Base32 decoded key buffers are securely wiped from memory (`key.fill(0)`) in `finally` blocks immediately following HMAC computation.
- **Session Teardown**: Provides an automated teardown companion action (`jay0lee/certum-cloud-code-sign/teardown@v1`) to terminate SimplySign Desktop and unmount cloud certificates after signing.
- **Zero External Dependencies**: Pure Node.js implementation with zero npm or PowerShell dependencies (`npm install` is not required on the runner).
- **GUI Desktop Automation**: Launches SimplySign Desktop and simulates keyboard input with proper character escaping.
- **Debug Flag & Image Archiving**: Includes an optional `debug: true` flag that enables capturing and archiving desktop screenshots throughout the login flow as an artifact for instant visual troubleshooting.
- **Certificate Verification & SignTool Discovery**:
  - Polls `Cert:\CurrentUser\My` until the code signing certificate with its cryptographic private key is loaded.
  - Automatically locates the correct **x64 `signtool.exe`** on both x64 and ARM64 runners (ARM64 `signtool.exe` cannot interface with SimplySign's 64-bit mini-driver).
  - Adds `signtool` to `GITHUB_PATH` so subsequent workflow steps can call `signtool` directly.

---

## Usage

### Prerequisites

Store your Certum credentials as GitHub Secrets in your repository (**Settings > Secrets and variables > Actions**):

> [!IMPORTANT]
> GitHub Secret names **only allow alphanumeric characters (`[A-Za-z0-9]`) and underscores (`_`)**. Hyphens/dashes (`-`) are not permitted by GitHub.

1. `CERTUM_USERNAME`: Your Certum SimplySign account email / username (e.g., `developer@example.com`).
2. `CERTUM_TOTP_SECRET`: Your Base32 TOTP secret key provided by Certum during SimplySign activation.

### Recommended Production Architecture (Job-Level Isolation)

For defense-in-depth security in production pipelines, follow the **job isolation pattern**:
1. **`build` job**: Compiles and packages your binary with **zero secrets** and minimal token permissions. Build dependencies or third-party build scripts cannot access your signing credentials.
2. **`sign` job**: Runs only after `build` succeeds. Downloads the unsigned binary artifact, authenticates SimplySign Desktop with commit-SHA pinned action, signs and verifies the binary, and always executes the teardown action.

```yaml
name: Build, Sign, and Release

on:
  push:
    tags: [ 'v*' ]

permissions:
  contents: read

jobs:
  build:
    name: Build Unsigned Binaries
    runs-on: windows-2022
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # Compile your executable with ZERO secrets exposed to compilers or build tools
      - name: Compile Executable
        run: go build -o dist/myapp.exe .

      - name: Upload Unsigned Binary Artifact
        uses: actions/upload-artifact@v4
        with:
          name: unsigned-myapp
          path: dist/myapp.exe

  sign:
    name: Sign Binaries with Certum Cloud
    needs: build
    runs-on: windows-2022
    # Optional: Require manual approval by scoping to a protected GitHub Environment
    # environment: production-signing
    steps:
      - name: Download Unsigned Binary Artifact
        uses: actions/download-artifact@v4
        with:
          name: unsigned-myapp
          path: dist

      - name: Setup Certum Cloud Code Signing
        id: certum
        # Best Practice: Pin to a full 40-character commit SHA for immutable supply chain security
        uses: jay0lee/certum-cloud-code-sign@v1
        with:
          username: ${{ secrets.CERTUM_USERNAME }}
          totp_secret: ${{ secrets.CERTUM_TOTP_SECRET }}

      - name: Sign Executable
        shell: pwsh
        run: |
          signtool sign /sha1 ${{ steps.certum.outputs.cert-thumbprint }} `
            /tr http://time.certum.pl /td SHA256 /fd SHA256 /v `
            dist/myapp.exe

      - name: Verify Signature
        shell: pwsh
        run: |
          signtool verify /pa /v dist/myapp.exe

      # Cleanly terminate SimplySign Desktop and unmount certificates post-signing
      - name: Teardown SimplySign Desktop Session
        if: always()
        uses: jay0lee/certum-cloud-code-sign/teardown@v1

      - name: Upload Signed Binary Artifact
        uses: actions/upload-artifact@v4
        with:
          name: myapp-windows-x64
          path: dist/myapp.exe
```

### Basic Single-Job Example

```yaml
name: Build and Sign Windows Executables

on: [push, pull_request]

permissions:
  contents: read

jobs:
  build-and-sign:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ windows-latest, windows-11-arm ]
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      # ... Your build steps to produce your .exe or .dll ...

      - name: Setup Certum Code Signing
        id: certum
        uses: jay0lee/certum-cloud-code-sign@v1
        with:
          username: ${{ secrets.CERTUM_USERNAME }}
          totp_secret: ${{ secrets.CERTUM_TOTP_SECRET }}

      - name: Sign Binaries
        shell: pwsh
        run: |
          signtool sign /sha1 ${{ steps.certum.outputs.cert-thumbprint }} `
            /tr http://time.certum.pl /td SHA256 /fd SHA256 /v `
            dist/myapp.exe

      - name: Verify Signature
        shell: pwsh
        run: |
          signtool verify /pa /v dist/myapp.exe

      - name: Teardown SimplySign Desktop Session
        if: always()
        uses: jay0lee/certum-cloud-code-sign/teardown@v1
```

---

## Action Inputs

| Input | Description | Required | Default |
| :--- | :--- | :---: | :--- |
| `username` | Certum SimplySign account email / username | **Yes** | — |
| `totp_secret` | Base32 TOTP secret key for 2FA one-time password generation (alias: `totp-secret`) | **Yes** | — |
| `version` | SimplySign Desktop version to download and install | No | `9.4.4.92` |
| `download-url` | Custom direct download URL for SimplySign Desktop MSI | No | `https://files.certum.eu/software/SimplySignDesktop/Windows/${version}/SimplySignDesktop-${version}-64-bit-en.msi` |
| `app-path` | Path to SimplySign Desktop executable | No | `C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe` |
| `totp_algorithm` | Hash algorithm for TOTP (`SHA-256`, `SHA-1`, `SHA-512`) | No | `SHA-256` |
| `totp_digits` | Number of digits in generated TOTP token | No | `6` |
| `totp_period` | Time interval in seconds for TOTP code expiration | No | `30` |
| `cert_sha1` | Expected certificate SHA-1 thumbprint (if empty, auto-detects) | No | `""` |
| `wait_for_cert_timeout` | Maximum seconds to wait for certificate to appear in store | No | `60` |
| `debug` | Enable saving and archiving desktop screenshots and diagnostic logs for troubleshooting | No | `false` |
| `screenshots_dir` | Directory path where debug screenshots and logs are stored | No | `$env:RUNNER_TEMP\certum-screenshots` |

### Parameter Defaults & Fail-Fast Behavior

- **Fail-Fast Validation**: The action validates in its very first step that both `username` and `totp_secret` are non-empty and that the runner OS is Windows. If either is missing, the action halts execution immediately with an error before attempting to download or install SimplySign Desktop.
- **`screenshots_dir` Default**:
  - If omitted or left empty, `screenshots_dir` defaults to:
    **`$env:RUNNER_TEMP\certum-screenshots`**
  - On GitHub-hosted Windows runners, `$env:RUNNER_TEMP` resolves to `D:\a\_temp` (or `C:\Users\runneradmin\AppData\Local\Temp`). Therefore, screenshots are placed in `D:\a\_temp\certum-screenshots`.
  - Placing diagnostic images in `RUNNER_TEMP` ensures they never clutter your repository workspace (`GITHUB_WORKSPACE`) and are automatically purged after the workflow finishes.
  - The resolved path is always exposed as the action output `screenshots-path` (`${{ steps.certum.outputs.screenshots-path }}`).

---

## Action Outputs

| Output | Description |
| :--- | :--- |
| `cert-thumbprint` | SHA-1 thumbprint of the active Certum Code Signing certificate |
| `cert-subject` | Subject distinguished name of the certificate |
| `cert-issuer` | Issuer distinguished name of the certificate |
| `cert-expiration` | Expiration date (`NotAfter`) of the certificate in ISO 8601 format |
| `cert-count` | Total number of certificates present in `Cert:\CurrentUser\My` |
| `signtool-path` | Discovered full path to the `x64` `signtool.exe` |
| `screenshots-path` | Directory containing captured diagnostic screenshots and logs |
| `teardown-script` | Path to the PowerShell session teardown script (`scripts/teardown.ps1`) |

---

## Environment Variables Set by Action

For added convenience in workflow steps following this action:
- `signtool.exe` parent directory is automatically added to `GITHUB_PATH` (so `signtool` can be invoked directly).
- `CERTUM_CERT_THUMBPRINT`: Certificate SHA-1 thumbprint.
- `CERTUM_CERT_SUBJECT`: Certificate Subject.
- `CERTUM_SIGNTOOL_PATH`: Absolute path to `x64` `signtool.exe`.

---

## How It Works

1. **Architecture & Runner Check**: Confirms the runner is running Windows.
2. **Download & Silent Install**: Downloads the 64-bit MSI installer from Certum's official repository (with automatic retry) and executes `msiexec /i ... /qn /norestart /l*! install.log`.
3. **ARM64 OOBE Dismissal**: If running on an ARM64 runner (`RUNNER_ARCH == "ARM64"`), sends keystrokes (`{TAB}` $\times$ 7, `{ENTER}`) across both privacy pages and dismisses the Start Menu with `{ESC}`.
4. **App Initialization**: Spawns `SimplySignDesktop.exe` and triggers window activation.
5. **Credential Automation**:
   - Sends the username keystrokes into the email field (with SendKeys character escaping).
   - Toggles to the OTP field using `{TAB}`.
   - Calculates the current TOTP token using the HMAC-SHA256 algorithm and the provided TOTP secret.
   - Sends the OTP keystrokes and submits using `{ENTER}`.
6. **Certificate Store Polling**: Continuously checks `Cert:\CurrentUser\My` until the certificate is loaded with an active private key link.
7. **SignTool Discovery**: Identifies the latest `x64` Windows SDK `signtool.exe` and exports its path.
8. **Artifact Upload**: If authentication fails (or `debug: 'true'`), captures and logs are uploaded via `actions/upload-artifact` for instant diagnosis.

---

## Troubleshooting

### Inspecting Desktop Screenshots
When running in GitHub Actions, GUI automation runs in the interactive desktop session. If a login failure occurs:
1. Navigate to the failed GitHub Actions workflow run.
2. Download the uploaded artifact named `certum-debug-<os>-<arch>-<run_id>`.
3. Inspect `oob1.png` - `oob4.png` (OOBE phase) and `008.png` - `015.png` (login dialog phase) along with `ssd_out.log`, `ssd_err.log`, and `install.log`.

### ARM64 Considerations
Certum's SimplySign Desktop virtual driver is compiled as a 64-bit (`x64`) application. On Windows 11 Arm runners (`runs-on: windows-11-arm`):
- SimplySign Desktop runs under Windows on Arm emulation.
- **You must use the `x64` version of `signtool.exe`**, because the ARM64 `signtool.exe` cannot load x64 CSP/KSP cryptographic mini-drivers. This action automatically selects the x64 binary for you.

---

## Security & Supply Chain Hardening

For sensitive code signing operations in production environments, adopting defense-in-depth principles is strongly recommended:

### 1. Pin to Immutable Commit SHAs
Tags like `@v1` can theoretically be re-pointed. For strict supply chain integrity, pin your workflow steps to a full 40-character commit SHA:
```yaml
- name: Setup Certum Code Signing
  uses: jay0lee/certum-cloud-code-sign@<full-commit-sha>
  with:
    username: ${{ secrets.CERTUM_USERNAME }}
    totp_secret: ${{ secrets.CERTUM_TOTP_SECRET }}

- name: Teardown SimplySign Desktop Session
  if: always()
  uses: jay0lee/certum-cloud-code-sign/teardown@<full-commit-sha>
```
With `.github/dependabot.yml` configured in your repository, Dependabot will automatically propose pull requests to update pinned SHAs when new releases are published.

### 2. Job-Level Isolation
Compilers, npm/pip/go modules, and build scripts run untrusted third-party code. To prevent malicious dependencies from accessing your signing credentials:
- **Build job**: Compiles binaries and runs tests with **zero secrets** configured.
- **Sign job**: Runs independently, downloads the build artifact, authenticates SimplySign Desktop, signs, and executes teardown.

### 3. Post-Execution Session Teardown
Always run the teardown action with `if: always()` after signing:
```yaml
- name: Teardown SimplySign Desktop Session
  if: always()
  uses: jay0lee/certum-cloud-code-sign/teardown@v1
```
This terminates SimplySign Desktop, clears active Smart Card sessions, and verifies that the cloud certificates are unmounted from `Cert:\CurrentUser\My`.

### 4. GitHub Environments & Required Approvals
Store `CERTUM_USERNAME` and `CERTUM_TOTP_SECRET` within a dedicated **GitHub Environment** (e.g. `production-signing`).
- Configure **Required Reviewers** so signing jobs require human authorization.
- Limit access strictly to protected branches (e.g. `main` or release tags).

See [.github/SECURITY.md](.github/SECURITY.md) for full details on security architecture and vulnerability reporting.

---

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
