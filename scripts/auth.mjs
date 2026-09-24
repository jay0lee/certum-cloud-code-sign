/**
 * SimplySign Desktop authentication automation for GitHub Actions Windows runners.
 *
 * Handles:
 * 1. Windows ARM64 OOBE initial setup dismissal.
 * 2. Launching SimplySign Desktop process and activating the login window.
 * 3. TOTP OTP calculation (SHA-256, RFC 6238).
 * 4. Typing username and OTP keystrokes into the SimplySign Desktop window.
 * 5. Diagnostic desktop screenshots for troubleshooting.
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { generateTOTP } from './totp.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Read configuration from environment
const username = process.env.CERTUM_USERNAME;
const totpSecret = process.env.CERTUM_TOTP_SECRET;
const appPath = process.env.CERTUM_APP_PATH || 'C:\\Program Files\\Certum\\SimplySign Desktop\\SimplySignDesktop.exe';
const totpAlgorithm = process.env.CERTUM_TOTP_ALGORITHM || 'SHA-256';
const totpDigits = parseInt(process.env.CERTUM_TOTP_DIGITS || '6', 10);
const totpPeriod = parseInt(process.env.CERTUM_TOTP_PERIOD || '30', 10);
const screenshotsDir = process.env.CERTUM_SCREENSHOTS_DIR || path.join(process.env.RUNNER_TEMP || process.cwd(), 'certum-screenshots');
const DEBUG = process.env.CERTUM_DEBUG === 'true';

// Ensure required inputs are present
if (!username) {
  console.error('Error: CERTUM_USERNAME environment variable is required.');
  process.exit(1);
}
if (!totpSecret) {
  console.error('Error: CERTUM_TOTP_SECRET environment variable is required.');
  process.exit(1);
}

// Mask secret in GitHub Actions logs
console.log(`::add-mask::${totpSecret}`);

// Ensure screenshots directory exists
try {
  fs.mkdirSync(screenshotsDir, { recursive: true });
} catch (err) {
  console.error(`Failed to create screenshots directory ${screenshotsDir}:`, err.message);
}

/**
 * Execute PowerShell script via UTF-16LE Base64 EncodedCommand to avoid any shell escaping issues.
 */
function execPowerShell(psCode) {
  const buffer = Buffer.from(psCode, 'utf16le');
  const base64 = buffer.toString('base64');
  return execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${base64}`, {
    stdio: 'pipe',
    encoding: 'utf8'
  });
}

/**
 * Send special key combinations (e.g. {TAB}, {ENTER}, {ESC}) via WScript.Shell.
 */
function sendKeys(keys) {
  const ps = `$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${keys.replace(/'/g, "''")}')`;
  execPowerShell(ps);
}

/**
 * Send literal text, escaping WScript.Shell special characters: + ^ % ~ ( ) { } [ ]
 */
function sendText(text) {
  const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
  sendKeys(escaped);
}

/**
 * Minimize all open windows to reveal desktop and prevent stray windows from capturing keystrokes.
 */
function minimizeAllWindows() {
  console.log('Minimizing background windows...');
  try {
    const ps = `$shell = New-Object -ComObject "Shell.Application"; $shell.MinimizeAll()`;
    execPowerShell(ps);
  } catch (err) {
    if (DEBUG) console.log('Minimize command note:', err.message);
  }
}

/**
 * Activate application window by title to ensure focus before typing.
 */
function activateWindow(title) {
  try {
    const ps = `$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('${title.replace(/'/g, "''")}')`;
    execPowerShell(ps);
  } catch (err) {
    if (DEBUG) console.log(`AppActivate('${title}') note:`, err.message);
  }
}

/**
 * Capture full desktop screenshot to a PNG file for CI diagnostics.
 */
async function takeScreenshot(filename) {
  const fullPath = path.join(screenshotsDir, filename);
  const safePath = fullPath.replace(/\\/g, '/');

  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms;
    Add-Type -AssemblyName System.Drawing;
    $Screen = [System.Windows.Forms.SystemInformation]::VirtualScreen;
    if ($Screen.Width -gt 0 -and $Screen.Height -gt 0) {
        $bitmap = New-Object System.Drawing.Bitmap $Screen.Width, $Screen.Height;
        $graphic = [System.Drawing.Graphics]::FromImage($bitmap);
        $graphic.CopyFromScreen($Screen.Left, $Screen.Top, 0, 0, $bitmap.Size);
        $bitmap.Save('${safePath}', [System.Drawing.Imaging.ImageFormat]::Png);
        $graphic.Dispose();
        $bitmap.Dispose();
        Write-Output "Wrote screenshot to ${safePath}";
    } else {
        Write-Warning "Screen dimensions are 0x0. Desktop not fully initialized.";
    }
  `;

  try {
    execPowerShell(psScript);
    if (DEBUG) console.log(`Saved screenshot: ${fullPath}`);
  } catch (err) {
    if (DEBUG) console.error(`Screenshot failed for ${filename}:`, err.message);
  }
}

/**
 * Launch SimplySign Desktop in detached background process with output logged.
 */
function launchSSD() {
  const outLogPath = path.join(screenshotsDir, 'ssd_out.log');
  const errLogPath = path.join(screenshotsDir, 'ssd_err.log');

  const out = fs.openSync(outLogPath, 'a');
  const err = fs.openSync(errLogPath, 'a');

  console.log(`Launching SimplySign Desktop at: ${appPath}`);
  console.log(`Redirecting logs -> stdout: ${outLogPath}, stderr: ${errLogPath}`);

  const child = spawn(appPath, [], {
    detached: true,
    stdio: ['ignore', out, err]
  });

  child.on('error', (error) => {
    console.error(`Failed to spawn SimplySign Desktop at "${appPath}":`, error.message);
  });

  child.unref();
}

/**
 * Main execution routine.
 */
async function run() {
  const runnerArch = (process.env.RUNNER_ARCH || '').toUpperCase();
  console.log(`Runner Architecture: ${runnerArch}`);
  console.log(`SimplySign Executable: ${appPath}`);
  console.log(`Screenshots Directory: ${screenshotsDir}`);

  // Handle Windows ARM64 GitHub runner OOBE quirks
  if (runnerArch === 'ARM64') {
    console.log('Running on Windows ARM64 runner. Dismissing OOBE setup screen...');
    await sleep(3000);
    await takeScreenshot('oob1.png');

    // Page 1: Tab through toggles to reach the "Next" button
    console.log('OOBE: Tabbing to Next button...');
    for (let i = 0; i < 7; i++) {
      sendKeys('{TAB}');
      await sleep(200);
    }
    sendKeys('{ENTER}');
    console.log('OOBE: Clicked Next');

    await sleep(3000);
    await takeScreenshot('oob2.png');

    // Page 2: Tab through toggles to reach the "Accept" button
    console.log('OOBE: Tabbing to Accept button...');
    for (let i = 0; i < 7; i++) {
      sendKeys('{TAB}');
      await sleep(200);
    }
    sendKeys('{ENTER}');
    console.log('OOBE: Clicked Accept');

    await sleep(3000);
    await takeScreenshot('oob3.png');

    // Dismiss Start Menu if open
    sendKeys('{ESC}');
    console.log('OOBE: Dismissed Start Menu');

    await sleep(3000);
    await takeScreenshot('oob4.png');
    console.log('OOBE dismissal sequence completed.');
  } else {
    console.log(`Not running on ARM64 (${runnerArch}). OOBE dismissal not required.`);
  }

  // Clear desktop of any interfering windows
  minimizeAllWindows();
  await sleep(1000);

  // Launch SimplySign Desktop.
  // The first execution starts the background service/tray icon.
  launchSSD();
  await sleep(3000);
  await takeScreenshot('008.png');

  // The second execution signals the running instance to pop up the login window.
  launchSSD();
  await sleep(3000);
  await takeScreenshot('009.png');

  // Activate SimplySign window to ensure focus
  activateWindow('SimplySign Desktop');
  activateWindow('SimplySign');
  await sleep(1000);

  // Begin Credential Entry
  console.log('Typing SimplySign credentials...');

  // 1. Type Username / Email
  console.log(`Typing username: ${username.replace(/(.{2})(.*)(@.*)/, '$1***$3')}`);
  sendText(username);
  await sleep(500);
  await takeScreenshot('010.png');

  // 2. Tab to OTP field
  sendKeys('{TAB}');
  await sleep(500);

  // 3. Compute and type TOTP
  const otp = generateTOTP(totpSecret, {
    algorithm: totpAlgorithm,
    digits: totpDigits,
    period: totpPeriod
  });

  // Mask the generated OTP in GitHub Actions logs
  console.log(`::add-mask::${otp}`);
  console.log(`Generated TOTP (${otp.length} digits) using ${totpAlgorithm}. Typing OTP...`);

  sendText(otp);
  await sleep(500);
  await takeScreenshot('011.png');

  // 4. Submit login dialog
  sendKeys('{ENTER}');
  console.log('Submitted login credentials. Waiting for authentication...');

  // Screenshot cascade to monitor dialog dismissal and authentication state
  await takeScreenshot('012.png');
  await sleep(500);
  await takeScreenshot('013.png');
  await sleep(500);
  await takeScreenshot('014.png');
  await sleep(1000);
  await takeScreenshot('015.png');

  console.log('SimplySign Desktop authentication sequence completed successfully.');
}

run().catch((err) => {
  console.error('Fatal error during SimplySign Desktop authentication:', err);
  process.exit(1);
});
