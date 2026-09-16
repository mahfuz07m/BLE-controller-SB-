import { BleClient } from "@capacitor-community/bluetooth-le";

// ---- Must match the ESP32 firmware exactly ----
const SERVICE_UUID = "a0d771fc-bb96-4c65-8c6e-3e1a2b7f9d10";
const CHAR_UUID = "a0d771fd-bb96-4c65-8c6e-3e1a2b7f9d10";

let device = null;
let currentDeviceId = null;
let characteristic = null;
let connected = false;
let writeChain = Promise.resolve();

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const connectBtn = document.getElementById("connectBtn");

function vibrate(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function setStatus(isConnected, label) {
  connected = isConnected;
  dot.classList.toggle("connected", isConnected);
  statusText.textContent =
    label || (isConnected ? "Connected" : "Disconnected");
  connectBtn.textContent = isConnected ? "Disconnect" : "Connect";
}

async function sendBytes(bytes) {
  if (!characteristic) return writeChain;

  const { deviceId, serviceUuid, characteristicUuid } = characteristic; // snapshot now
  const dataValue = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  writeChain = writeChain.then(async () => {
    try {
      await BleClient.writeWithoutResponse(
        deviceId,
        serviceUuid,
        characteristicUuid,
        dataValue,
      );
    } catch (err) {
      console.error("BLE write failed", bytes, err);
    }
  });
  return writeChain;
}

async function sendCmd(char) {
  sendBytes(new TextEncoder().encode(char));
}

async function handleFound(device) {
  try {
    await BleClient.stopLEScan();
    currentDeviceId = device.deviceId;
    setStatus(false, "Connecting…");

    await BleClient.connect(device.deviceId, onDisconnected);

    characteristic = {
      deviceId: device.deviceId,
      serviceUuid: SERVICE_UUID,
      characteristicUuid: CHAR_UUID,
    };

    console.log("BLE connected:", device.deviceId);
    setStatus(true);
    startHeartbeat();
  } catch (err) {
    console.error("connect step failed", err);
    setStatus(false, "Connection failed");
  }
}

async function connect() {
  try {
    await BleClient.initialize({ androidNeverForLocation: true });
    await BleClient.requestEnable();

    let found = false;
    setStatus(false, "Scanning…");

    await BleClient.requestLEScan({ services: [SERVICE_UUID] }, (result) => {
      if (found) return;
      found = true;
      device = result.device;
      handleFound(device);
    });

    setTimeout(async () => {
      if (!found) {
        await BleClient.stopLEScan();
        setStatus(false, "Not found — power on the bot");
      }
    }, 8000);
  } catch (err) {
    console.error("connect() failed", err);
    setStatus(false, "Connect Error.");
  }
}

function onDisconnected(deviceId) {
  if (deviceId !== currentDeviceId) {
    console.log("Ignoring stale disconnect for: ", deviceId);
    return; // guards against a disconnect callback from an unwanted attempt
  }
  console.log("BLE disconnected: ", deviceId);
  characteristic = null;
  currentDeviceId = null;
  writeChain = Promise.resolve();
  setStatus(false);
  stopHeartbeat();
  releaseAllHeld();
}

async function disconnect() {
  try {
    if (device) await BleClient.disconnect(device.deviceId);
  } catch (err) {
    console.error("disconnect failed", err);
  } finally {
    onDisconnected(device.deviceId);
  }
}

const HEARTBEAT_MS = 150;
let heartbeatTimer = null;
const heldState = {
  up: false,
  down: false,
  triangle: false,
  cross: false,
  square: false,
  circle: false,
};

function sendHeartbeat() {
  const mask =
    (heldState.up ? 1 : 0) |
    (heldState.down ? 2 : 0) |
    (heldState.triangle ? 4 : 0) |
    (heldState.cross ? 8 : 0) |
    (heldState.square ? 16 : 0) |
    (heldState.circle ? 32 : 0);
  sendBytes(new Uint8Array([72 /* 'H' */, mask])); // 72 = ASCII 'H'
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

connectBtn.addEventListener("click", () => {
  if (connected) disconnect();
  else connect();
});

// ============================================================
// Button management
// ============================================================
// Buttons fire based on where the finger physically IS right now,
// not which button it originally touched down on. No pointer
// capture is used, so a held finger sliding from one button to
// another releases the first and presses the second at the exact
// moment it crosses the boundary -- it doesn't matter whether a
// button was reached by sliding or by lifting off and landing on
// a different one.

const holdButtons = new Map(); // DOM element -> {el, pressChar, releaseChar, stateKey}
const tapButtons = new Map(); // DOM element -> {el, char}

// pointerId -> the hold-button config currently "owned" by that finger (or null)
const activeTouches = new Map();

function registerHoldButton(el, pressChar, releaseChar, stateKey) {
  holdButtons.set(el, { el, pressChar, releaseChar, stateKey });
}

function registerTapButton(el, char) {
  tapButtons.set(el, { el, char });
}

function pressHold(cfg) {
  cfg.el.classList.add("pressed");
  heldState[cfg.stateKey] = true;
  sendCmd(cfg.pressChar);
  vibrate(12);
}

function releaseHold(cfg) {
  cfg.el.classList.remove("pressed");
  heldState[cfg.stateKey] = false;
  sendCmd(cfg.releaseChar);
}

// Hit-tests whatever is physically under (x, y) right now and returns
// its hold-button config, or null if the finger isn't over one.
function holdButtonAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  const btnEl = hit ? hit.closest(".btn") : null;
  return btnEl ? holdButtons.get(btnEl) || null : null;
}

function onPointerDown(e) {
  const btnEl = e.target.closest(".btn");
  if (!btnEl) return;
  e.preventDefault();

  if (tapButtons.has(btnEl)) {
    const tapCfg = tapButtons.get(btnEl);
    btnEl.classList.add("pressed");
    sendCmd(tapCfg.char);
    vibrate(20);
    setTimeout(() => btnEl.classList.remove("pressed"), 150);
    return;
  }

  const cfg = holdButtons.get(btnEl);
  if (!cfg) return;

  activeTouches.set(e.pointerId, cfg);
  pressHold(cfg);
}

function onPointerMove(e) {
  if (!activeTouches.has(e.pointerId)) return;

  const prevCfg = activeTouches.get(e.pointerId);
  const cfg = holdButtonAt(e.clientX, e.clientY);

  if (cfg === prevCfg) return; // still over the same button, or still off any button

  if (prevCfg) releaseHold(prevCfg);
  if (cfg) pressHold(cfg);
  activeTouches.set(e.pointerId, cfg);
}

function onPointerEnd(e) {
  if (!activeTouches.has(e.pointerId)) return;
  const cfg = activeTouches.get(e.pointerId);
  if (cfg) releaseHold(cfg);
  activeTouches.delete(e.pointerId);
}

// Listened on document (not per-button, and no setPointerCapture) so a
// dragging finger is hit-tested against whatever is actually beneath it.
document.addEventListener("pointerdown", onPointerDown, { passive: false });
document.addEventListener("pointermove", onPointerMove, { passive: false });
document.addEventListener("pointerup", onPointerEnd);
document.addEventListener("pointercancel", onPointerEnd);

// ============================================================
// EMERGENCY RELEASE
// ============================================================

function releaseAllHeld() {
  activeTouches.forEach((cfg) => {
    if (cfg) releaseHold(cfg);
  });
  activeTouches.clear();
  Object.keys(heldState).forEach((k) => {
    heldState[k] = false;
  });
}

// ============================================================
// BUTTON MAPPING
// ============================================================

// UP / DOWN
registerHoldButton(document.getElementById("dUp"), "U", "u", "up");
registerHoldButton(document.getElementById("dDown"), "D", "d", "down");

// TRIANGLE / CROSS
registerHoldButton(document.getElementById("aTriangle"), "T", "t", "triangle");
registerHoldButton(document.getElementById("aCross"), "C", "c", "cross");

// SQUARE / CIRCLE
registerHoldButton(document.getElementById("aSquare"), "S", "s", "square");
registerHoldButton(document.getElementById("aCircle"), "O", "o", "circle");

// LEFT / RIGHT -- one-tap 180 degree spin, not a hold button
registerTapButton(document.getElementById("dLeft"), "L");
registerTapButton(document.getElementById("dRight"), "R");

// Safety: if the tab/app is backgrounded mid-press, release everything
// so the bot doesn't keep driving with no one watching it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllHeld();
});
window.addEventListener("pagehide", releaseAllHeld);
document.addEventListener("contextmenu", (e) => e.preventDefault());
