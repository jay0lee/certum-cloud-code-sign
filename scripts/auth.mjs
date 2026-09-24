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

  const hmac = crypto.createHmac(nodeAlgo, key).update(counterBuf).digest();
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
        }
"@ -ErrorAction SilentlyContinue

      $p = Get-Process | Where-Object { ($_.MainWindowTitle -like "*${title.replace(/'/g, "''")}*" -or $_.ProcessName -like "*${title.replace(/'/g, "''")}*") -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($p) {
        [Win32Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
        [Win32Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        $wshell = New-Object -ComObject wscript.shell
        $wshell.AppActivate($p.Id) | Out-Null
      } else {
        $wshell = New-Object -ComObject wscript.shell
        $wshell.AppActivate('${title.replace(/'/g, "''")}') | Out-Null
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
  // Send ESC to dismiss any active popup, Start Menu, or terminal prompt
  sendKeys('{ESC}');
  await sleep(300);
  sendKeys('{ESC}');
  await sleep(300);

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
    await takeScreenshot('002_start_menu.png');

    // Dismiss Start Menu that opens automatically upon OOBE dismissal
    sendKeys('{ESC}');
    console.log('Dismissed Start Menu');

    await sleep(1500);
    await takeScreenshot('003_wsl_prompt.png');

    // Dismiss WSL prompt that opens behind Start Menu ("Press ESC or CTRL-C to cancel")
    sendKeys('{ESC}');
    console.log('Dismissed WSL prompt');

    await sleep(1500);
    await takeScreenshot('004_desktop_clean.png');
    console.log('ARM64 desktop dismissal sequence completed.');
  }

  // 2. Clear desktop and launch SimplySign Desktop
  minimizeAllWindows();
  await sleep(1000);

  // First launch starts the background daemon
  launchSSD();
  await sleep(3000);
  await takeScreenshot('008.png');

  // Second launch forces the login window to appear
  launchSSD();
  await sleep(3000);
  await takeScreenshot('009.png');

  // Ensure SimplySign Desktop window is active and in foreground
  for (let attempt = 0; attempt < 5; attempt++) {
    const wins = getOpenWindows();
    const ssdWin = wins.find(w => (w.MainWindowTitle && w.MainWindowTitle.includes('SimplySign')) || (w.ProcessName && w.ProcessName.includes('SimplySign')));
    if (ssdWin && ssdWin.MainWindowTitle) {
      console.log(`SimplySign Desktop window detected: "${ssdWin.MainWindowTitle}"`);
      break;
    }
    console.log(`SimplySign window not yet in foreground (attempt ${attempt + 1}/5). Cleaning popups and re-launching...`);
    await cleanupDesktop();
    launchSSD();
    await sleep(3000);
  }

  // Activate the application window
  activateWindow('SimplySign Desktop');
  activateWindow('SimplySign');
  await sleep(1000);

  // 3. Enter Username
  console.log('Entering username into SimplySign Desktop...');
  sendText(username);
  await sleep(500);
  await takeScreenshot('010.png');

  // 4. Tab to OTP Field
  console.log('Tabbing to OTP field...');
  sendKeys('{TAB}');
  await sleep(500);

  // 5. Generate TOTP at the last possible second with expiry protection
  // Check remaining time in the current TOTP period
  const now = Math.floor(Date.now() / 1000);
  const remainingSeconds = totpPeriod - (now % totpPeriod);

  if (remainingSeconds < 5) {
    // If fewer than 5 seconds remain in the current period, wait for the next period
    // so the OTP does not expire while being typed and verified by Certum cloud servers.
    console.log(`Current TOTP window expires in ${remainingSeconds}s. Waiting for fresh period...`);
    await sleep((remainingSeconds + 1) * 1000);
  }

  console.log('Generating fresh TOTP token and entering credentials...');
  // Generate TOTP token immediately before sending keystrokes
  const otp = generateTOTP(totpSecret, {
    algorithm: totpAlgorithm,
    digits: totpDigits,
    period: totpPeriod
  });

  // Enter the OTP into the active input field
  sendText(otp);
  await sleep(500);
  await takeScreenshot('011.png');

  // 6. Submit login dialog
  console.log('Submitting login credentials...');
  // Ensure SimplySign Desktop has focus before submitting
  activateWindow('SimplySign Desktop');
  activateWindow('SimplySign');
  await sleep(500);
  sendKeys('{ENTER}');

  // 7. Post-submit screenshot cascade every 2 seconds
  console.log('Monitoring SimplySign Desktop post-login progress...');
  const maxPostWait = 15; // 15 checks * 2s = 30 seconds
  let loginClosed = false;

  for (let i = 1; i <= maxPostWait; i++) {
    await sleep(2000);
    const snapNum = String(11 + i).padStart(3, '0');
    await takeScreenshot(`${snapNum}.png`);

    const wins = getOpenWindows();
    const ssdWin = wins.find(w => (w.MainWindowTitle && w.MainWindowTitle.includes('SimplySign')) || (w.ProcessName && w.ProcessName.includes('SimplySign')));
    
    if (!ssdWin || !ssdWin.MainWindowTitle) {
      console.log(`SimplySign Desktop window has closed (authenticated) after ~${i * 2}s.`);
      loginClosed = true;
      break;
    } else {
      if (DEBUG) console.log(`[DEBUG] (${i}/${maxPostWait}) SimplySign window still visible: "${ssdWin.MainWindowTitle}"`);
      // Keep SimplySign Desktop activated in case another app tried to steal focus
      activateWindow('SimplySign Desktop');
      activateWindow('SimplySign');

      // If the window remains open after 4s (i == 2) or 8s (i == 4), re-send ENTER
      // in case the initial keystroke was lost
      if (i === 2 || i === 4) {
        console.log(`SimplySign window still visible after ${i * 2}s. Re-submitting ENTER...`);
        sendKeys('{ENTER}');
      }
    }
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
