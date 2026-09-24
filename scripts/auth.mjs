/**
 * SimplySign Desktop authentication automation for GitHub Actions Windows runners.
 *
 * Key guarantees:
 * 1. TOTP is generated at the absolute last possible second before typing into the active OTP field.
 * 2. If the current TOTP 30-second window has less than 5 seconds remaining, it waits for a fresh window
 *    so the OTP never expires during typing or network transmission to Certum's servers.
 * 3. Neither the TOTP secret nor the generated OTP are EVER printed to logging or console output.
 * 4. A debug flag enables capturing and archiving desktop images and logs for troubleshooting.
 * 5. Windows ARM64 OOBE initial setup screen is automatically dismissed.
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

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

// Validate inputs
if (!username) {
  console.error('Error: CERTUM_USERNAME environment variable is required.');
  process.exit(1);
}
if (!totpSecret) {
  console.error('Error: CERTUM_TOTP_SECRET environment variable is required.');
  process.exit(1);
}

// Register GitHub Actions secret masks immediately to ensure credentials
// can never leak into console logs or runner diagnostics
console.log(`::add-mask::${username}`);
console.log(`::add-mask::${totpSecret}`);

// Ensure screenshots directory exists if debug is enabled
if (DEBUG) {
  try {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  } catch (err) {
    // Ignore directory creation error
  }
}

// ==========================================
// Base32 Decoding & RFC 6238 TOTP Generation
// ==========================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('TOTP secret must be a non-empty string');
  }

  const cleaned = secret.trim().replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (cleaned.length === 0) {
    throw new Error('TOTP secret contains no valid Base32 characters');
  }

  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error('Invalid character in Base32 secret');
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

function generateTOTP(secret, options = {}) {
  const {
    algorithm = 'SHA-256',
    digits = 6,
    period = 30,
    timestamp = Math.floor(Date.now() / 1000)
  } = options;

  const key = base32Decode(secret);
  const normAlgo = algorithm.toUpperCase().replace(/[-_]/g, '');
  let nodeAlgo;
  if (normAlgo === 'SHA1') {
    nodeAlgo = 'sha1';
  } else if (normAlgo === 'SHA256') {
    nodeAlgo = 'sha256';
  } else if (normAlgo === 'SHA512') {
    nodeAlgo = 'sha512';
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const counter = Math.floor(timestamp / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  let hmac;
  try {
    hmac = crypto.createHmac(nodeAlgo, key).update(counterBuf).digest();
  } finally {
    key.fill(0);
  }

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff);
  const code = binary % (10 ** digits);

  return code.toString().padStart(digits, '0');
}

// ==========================================
// Windows GUI & Keystroke Automation
// ==========================================

function execPowerShell(psCode) {
  const buffer = Buffer.from(psCode, 'utf16le');
  const base64 = buffer.toString('base64');
  try {
    return execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${base64}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
  } catch (err) {
    // Never include psCode in error messages to avoid any potential secret/OTP leak
    throw new Error('PowerShell command execution failed.');
  }
}

function sendKeys(keys) {
  const ps = `$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${keys.replace(/'/g, "''")}')`;
  execPowerShell(ps);
}

function sendText(text) {
  // WScript.Shell SendKeys special characters: + ^ % ~ ( ) { } [ ]
  const escaped = text.replace(/([+^%~(){}[\]])/g, '{$1}');
  sendKeys(escaped);
}

function minimizeAllWindows() {
  if (DEBUG) console.log('Minimizing background windows...');
  try {
    const ps = `$shell = New-Object -ComObject "Shell.Application"; $shell.MinimizeAll()`;
    execPowerShell(ps);
  } catch (err) {
    // Ignore minimize notice
  }
}

function activateWindow(title) {
  try {
    const ps = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32Win {
          [DllImport("user32.dll")]
          [return: MarshalAs(UnmanagedType.Bool)]
          public static extern bool SetForegroundWindow(IntPtr hWnd);

          [DllImport("user32.dll")]
          public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

          [DllImport("user32.dll", CharSet = CharSet.Auto)]
          public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        }
"@ -ErrorAction SilentlyContinue

      $safeTitle = '${title.replace(/'/g, "''")}'
      $hWnd = [IntPtr]::Zero
      $p = Get-Process | Where-Object { ($_.MainWindowTitle -like "*$safeTitle*" -or $_.ProcessName -like "*$safeTitle*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($p) {
        $hWnd = $p.MainWindowHandle
      } else {
        $hWnd = [Win32Win]::FindWindow($null, $safeTitle)
      }

      if ($hWnd -ne [IntPtr]::Zero) {
        [Win32Win]::ShowWindow($hWnd, 9) | Out-Null
        [Win32Win]::SetForegroundWindow($hWnd) | Out-Null
        $wshell = New-Object -ComObject wscript.shell
        if ($p) {
          $wshell.AppActivate($p.Id) | Out-Null
        } else {
          $wshell.AppActivate($safeTitle) | Out-Null
        }
      } else {
        $wshell = New-Object -ComObject wscript.shell
        $wshell.AppActivate($safeTitle) | Out-Null
      }
    `;
    execPowerShell(ps);
  } catch (err) {
    // Ignore activation notice
  }
}

function getOpenWindows() {
  try {
    const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -Property ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
    const res = execPowerShell(ps);
    if (!res || !res.trim()) return [];
    const parsed = JSON.parse(res.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [];
  }
}

async function cleanupDesktop() {
  const runnerArch = (process.env.RUNNER_ARCH || '').toUpperCase();
  if (runnerArch !== 'ARM64') {
    return;
  }

  console.log('Dismissing popups/dialogs on ARM64 via desktop interactions...');

  // 1. Dismiss System Properties (paging file warning) dialog by activating and sending ENTER to click [OK]
  activateWindow('System Properties');
  await sleep(200);
  sendKeys('{ENTER}');
  await sleep(200);

  // 2. Dismiss WSL update prompt if open by activating and sending ^c and %{F4}
  activateWindow('wsl');
  await sleep(200);
  sendKeys('^c');
  await sleep(200);
  sendKeys('%{F4}');
  await sleep(200);

  // 3. Gracefully close any console host or wsl window that opened
  try {
    const ps = `
      Get-Process | Where-Object { $_.ProcessName -in @('wsl', 'WindowsTerminal') -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
        $_.CloseMainWindow() | Out-Null
      }
    `;
    execPowerShell(ps);
  } catch (e) {}

  // 4. Send ESC to dismiss Start Menu or open context menus if open
  sendKeys('{ESC}');
  await sleep(200);

  if (DEBUG) {
    const wins = getOpenWindows();
    console.log('[DEBUG] Open windows after cleanup:', JSON.stringify(wins));
  }
}

async function takeScreenshot(filename) {
  // Only capture screenshots if debug mode is active
  if (!DEBUG) return;

  try {
    fs.mkdirSync(screenshotsDir, { recursive: true });
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
      }
    `;

    execPowerShell(psScript);
    console.log(`[DEBUG] Saved desktop screenshot: ${filename}`);
  } catch (err) {
    // Silently continue if screenshot fails
  }
}

function launchSSD() {
  let out = 'ignore';
  let err = 'ignore';

  if (DEBUG) {
    try {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const outLogPath = path.join(screenshotsDir, 'ssd_out.log');
      const errLogPath = path.join(screenshotsDir, 'ssd_err.log');
      out = fs.openSync(outLogPath, 'a');
      err = fs.openSync(errLogPath, 'a');
    } catch (e) {
      // Ignore log file creation failure
    }
  }

  console.log(`Launching SimplySign Desktop...`);
  const child = spawn(appPath, [], {
    detached: true,
    stdio: ['ignore', out, err]
  });

  child.on('error', (error) => {
    console.error(`Failed to launch SimplySign Desktop at "${appPath}":`, error.message);
  });

  child.unref();
}

async function run() {
  const runnerArch = (process.env.RUNNER_ARCH || '').toUpperCase();
  console.log(`=== Certum SimplySign Desktop Authentication ===`);
  console.log(`Runner Architecture: ${runnerArch}`);
  console.log(`Debug Mode: ${DEBUG ? 'Enabled (saving diagnostic screenshots)' : 'Disabled'}`);

  // 1. Handle Windows ARM64 GitHub runner OOBE and initial popups via desktop interactions
  if (runnerArch === 'ARM64') {
    console.log('Running on Windows ARM64 runner. Dismissing OOBE setup screen...');
    await sleep(3000);
    await takeScreenshot('001_oob.png');

    // Dismiss OOBE: Tab 7 times to "Next" button and press Enter
    for (let i = 0; i < 7; i++) {
      sendKeys('{TAB}');
      await sleep(200);
    }
    sendKeys('{ENTER}');
    console.log('OOBE: Clicked Next (dismissed OOBE)');
    await sleep(2000);

    // Dismiss initial popups (Start Menu, System Properties dialog, WSL update prompt)
    await cleanupDesktop();
    await sleep(1000);
  }

  // 2. Clear desktop and launch SimplySign Desktop
  minimizeAllWindows();
  await sleep(1000);
  await takeScreenshot('002_desktop_clean.png');

  // First launch starts the background daemon
  launchSSD();
  await sleep(3000);
  await takeScreenshot('003_ssd_daemon.png');

  // Second launch forces the login window to appear
  launchSSD();
  await sleep(3000);
  await takeScreenshot('004_ssd_login.png');

  // Ensure SimplySign Desktop window is active and in foreground
  let ssdDetected = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wins = getOpenWindows();
    const ssdWin = wins.find(w => (w.MainWindowTitle && w.MainWindowTitle.includes('SimplySign')) || (w.ProcessName && w.ProcessName.includes('SimplySign')));
    if (ssdWin && ssdWin.MainWindowTitle) {
      console.log(`SimplySign Desktop window detected: "${ssdWin.MainWindowTitle}"`);
      ssdDetected = true;
      break;
    }
    console.log(`SimplySign window not yet in foreground (attempt ${attempt + 1}/5). Cleaning popups and re-launching...`);
    await cleanupDesktop();
    launchSSD();
    await sleep(3000);
  }

  if (!ssdDetected) {
    throw new Error('SimplySign Desktop login window failed to appear.');
  }

  // 3. Enter credentials and authenticate SimplySign Desktop
  const maxAuthAttempts = 2;
  let loginClosed = false;

  for (let authAttempt = 1; authAttempt <= maxAuthAttempts; authAttempt++) {
    if (authAttempt > 1) {
      console.log(`\nRetrying authentication (attempt ${authAttempt}/${maxAuthAttempts})...`);
      // Dismiss any open error message dialog ("Invalid user name or token") with ENTER / ESC
      activateWindow('SimplySign Desktop');
      activateWindow('SimplySign');
      await sleep(300);
      sendKeys('{ENTER}');
      await sleep(500);
      sendKeys('{ESC}');
      await sleep(1000);
    }

    // Check remaining time in the current TOTP period.
    // Ensure at least 15 seconds of token validity remain so the token never expires during network transit.
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = totpPeriod - (now % totpPeriod);
    if (remainingSeconds < 15) {
      console.log(`Current TOTP window expires in ${remainingSeconds}s. Waiting for fresh period...`);
      await sleep((remainingSeconds + 1) * 1000);
    }

    const otp = generateTOTP(totpSecret, {
      algorithm: totpAlgorithm,
      digits: totpDigits,
      period: totpPeriod
    });
    console.log(`::add-mask::${otp}`);
    console.log(`Fresh TOTP token generated (attempt ${authAttempt}).`);

    // Activate the SimplySign Desktop application window
    activateWindow('SimplySign Desktop');
    activateWindow('SimplySign');
    await sleep(500);

    // 4. Enter Username (using Ctrl+A to safely replace any previous content)
    console.log('Entering username into SimplySign Desktop...');
    sendKeys('^a');
    await sleep(100);
    sendText(username);
    await sleep(200);
    if (DEBUG) await takeScreenshot(`005_username_att${authAttempt}.png`);

    // 5. Tab to OTP Field and enter OTP immediately
    console.log('Tabbing to OTP field and entering token...');
    sendKeys('{TAB}');
    await sleep(200);
    sendKeys('^a');
    await sleep(100);
    sendText(otp);
    await sleep(200);
    if (DEBUG) await takeScreenshot(`006_otp_att${authAttempt}.png`);

    // 6. Submit login dialog
    console.log('Submitting login credentials...');
    activateWindow('SimplySign Desktop');
    activateWindow('SimplySign');
    await sleep(300);
    sendKeys('{ENTER}');
    if (DEBUG) await takeScreenshot(`007_submitted_att${authAttempt}.png`);

    // 7. Post-submit monitoring: check every 2 seconds for up to 20 seconds (10 checks)
    console.log('Monitoring SimplySign Desktop post-login progress...');
    const maxPostWait = 10;

    for (let i = 1; i <= maxPostWait; i++) {
      await sleep(2000);
      if (DEBUG) {
        const snapNum = String(7 + (authAttempt - 1) * 10 + i).padStart(3, '0');
        await takeScreenshot(`${snapNum}.png`);
      }

      const wins = getOpenWindows();
      const ssdWin = wins.find(w => (w.MainWindowTitle && w.MainWindowTitle.includes('SimplySign')) || (w.ProcessName && w.ProcessName.includes('SimplySign')));

      if (!ssdWin || !ssdWin.MainWindowTitle) {
        console.log(`SimplySign Desktop window has closed (authenticated) after ~${i * 2}s.`);
        loginClosed = true;
        break;
      } else {
        if (DEBUG) console.log(`[DEBUG] (${i}/${maxPostWait}) SimplySign window still visible: "${ssdWin.MainWindowTitle}"`);
      }
    }

    if (loginClosed) {
      break;
    }
  }

  if (!loginClosed) {
    throw new Error('SimplySign Desktop window did not close after submitting credentials.');
  }

  if (DEBUG) {
    await takeScreenshot('login_finished.png');
  }

  console.log('SimplySign Desktop authentication sequence completed successfully.');
}

run().catch(async (err) => {
  console.error('Error during SimplySign Desktop authentication:', err.message);
  // Only capture failure screenshot if debug is explicitly enabled
  if (DEBUG) {
    try {
      await takeScreenshot('failure-desktop.png');
    } catch (e) {
      // Ignore error
    }
  }
  process.exit(1);
});
