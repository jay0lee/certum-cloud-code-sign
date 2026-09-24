# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability within `certum-cloud-code-sign`, please report it responsibly. **Do not disclose security vulnerabilities through public GitHub issues or discussions.**

Instead, please report security issues through:
- **GitHub Private Vulnerability Reporting**: Use the "Report a vulnerability" button under the **Security** tab of this repository.
- **Direct Email**: Send details to the repository maintainer.

Please provide:
- A detailed description of the vulnerability.
- Steps to reproduce or proof-of-concept demonstration.
- The potential impact on workflows or secrets.

You will receive an acknowledgment within 48 hours, followed by updates as the issue is investigated and remediated.

---

## Security Architecture & Design Guarantees

This GitHub Action is designed with a defense-in-depth model specifically tailored for handling cryptographic signing credentials in CI/CD environments:

### 1. Zero Third-Party Runtime Dependencies
The action has **zero external npm or PowerShell package dependencies**. All TOTP calculations, Base32 decoding, and process automation utilize standard Node.js built-ins (`crypto`, `child_process`, `fs`, `path`) and native Windows PowerShell APIs. This eliminates risk from transitive dependency supply chain attacks, typo-squatting, or hijacked upstream packages.

### 2. Ephemeral Credential Lifecycle
- The Certum username and TOTP secret key are never persisted to disk, configuration files, or temporary directories.
- Credentials exist only ephemerally in process environment variables during the authentication step.

### 3. Dynamic GitHub Secret Masking
- The action dynamically invokes GitHub Actions log masking (`::add-mask::<value>`) for the username, the TOTP secret, and the generated OTP token.
- Even in unexpected exceptions, debug stack traces, or process crashes, the runner runtime redacts these sensitive strings with `***`.

### 4. Cryptographic In-Memory Buffer Zeroing
- HMAC-SHA256 calculations for TOTP tokens decode the Base32 secret directly into memory buffers.
- Immediately upon completing the HMAC digest computation, the allocated buffer is cleared in a `finally` block using `key.fill(0)`, preventing credentials from lingering in Node.js process heap memory.

### 5. Post-Execution Session Teardown
- Once code signing is complete, active SimplySign Desktop sessions should be terminated to prevent subsequent workflow steps or rogue dependencies from using the authenticated smart card certificate.
- The repository provides a dedicated companion action:
  ```yaml
  - name: Teardown SimplySign Desktop Session
    if: always()
    uses: jay0lee/certum-cloud-code-sign/teardown@v1
  ```
  This immediately closes SimplySign Desktop and verifies that cloud certificates are unmounted from `Cert:\CurrentUser\My`.

---

## Best Practices for Consumer Workflows

To ensure maximum security when consuming this action in your own repositories, follow these defense-in-depth recommendations:

### 1. Pin Actions to Full 40-Character Commit SHAs
Tags like `@v1` or branch references like `@main` can be modified. For immutable supply chain security, pin the action to a specific commit SHA:
```yaml
- name: Setup Certum Cloud Code Signing
  uses: jay0lee/certum-cloud-code-sign@<full-commit-sha> # e.g. uses: jay0lee/certum-cloud-code-sign@abcd1234...
  with:
    username: ${{ secrets.CERTUM_USERNAME }}
    totp_secret: ${{ secrets.CERTUM_TOTP_SECRET }}
```
Configure Dependabot in your repository (`.github/dependabot.yml`) to automatically monitor and open pull requests for new releases while maintaining SHA pinning.

### 2. Implement Job-Level Isolation (Build vs Sign)
Never expose signing credentials to build scripts, compilers, or third-party build dependencies. Structure your workflow into two isolated jobs:
1. **`build` job**: Compiles the binaries and packages artifacts. Runs with **zero secrets** and minimal token permissions.
2. **`sign` job**: Runs only after build succeeds. Downloads the unsigned binary artifact, invokes `certum-cloud-code-sign`, signs the binary with SignTool, verifies the signature, and runs teardown.

### 3. Restrict Permissions to Least Privilege
Explicitly set `permissions` at the workflow or job level:
```yaml
permissions:
  contents: read
```
If your workflow does not need to interact with the GitHub API, set `permissions: {}`.

### 4. Use GitHub Environments and Protection Rules
Store `CERTUM_USERNAME` and `CERTUM_TOTP_SECRET` in a dedicated GitHub Environment (e.g. `release` or `production-signing`):
- Configure **Required reviewers** so signing cannot occur without explicit peer approval.
- Restrict deployment branches to protected branches (e.g. `main` or release tags).
- Secrets remain inaccessible to untrusted pull requests or arbitrary branch builds.
