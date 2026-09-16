import { BleClient } from "@capacitor-community/bluetooth-le";

// ---- Must match the ESP32 firmware exactly ----
const SERVICE_UUID = "a0d771fc-bb96-4c65-8c6e-3e1a2b7f9d10";
const CHAR_UUID = "a0d771fd-bb96-4c65-8c6e-3e1a2b7f9d10";

let device = null;
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

async function connect() {
  try {
    await BleClient.initialize({ androidNeverForLocation: true });
    await BleClient.requestEnable();

    let found = false;

    await BleClient.requestLEScan(
      { services: [SERVICE_UUID] },
      async (result) => {
        if (found) return;
        found = true;
        await BleClient.stopLEScan();

        device = result.device;
        setStatus(false, "Connecting…");
        await BleClient.connect(device.deviceId, onDisconnected);

        characteristic = {
          deviceId: device.deviceId,
          serviceUuid: SERVICE_UUID,
          characteristicUuid: CHAR_UUID,
        };

        setStatus(true);
        startHeartbeat();
      },
    );
    // // await BleClient.requestDevice({
    // //       services: [],
    // //       optionalServices: [SERVICE_UUID],
    // //     });
    // // connect directly to gatt server
    // await BleClient.connect(device.deviceId, () => {
    //   onDisconnected();
    // });

    setTimeout(async () => {
      if (!found) {
        await BleClient.stopLEScan();
        setStatus(false, "Not found — power on the bot");
      }
    }, 8000);
  } catch (err) {
    console.error(err);
    setStatus(false);

    const isCancelled =
      err.name === "NotFoundError" ||
      (err.message && err.message.toLowerCase().includes("cancelled"));
    if (isCancelled) {
      // user just cancelled the chooser
      console.log("User cancelled the device selection picker window.");
    } else {
      alert("Failed to connect: " + (err.message || err));
    }
  }
}

function onDisconnected() {
  characteristic = null;
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
    onDisconnected();
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

const activePresses = new Map();

function wireHoldButton(el, pressChar, releaseChar, stateKey) {
  let pointerId = null;

  function down(e) {
    e.preventDefault();
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch (_) {}
    el.classList.add("pressed");
    activePresses.set(el, releaseChar);
    heldState[stateKey] = true;
    sendCmd(pressChar);
    vibrate(12);
  }
  function up(e) {
    if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
    pointerId = null;
    el.classList.remove("pressed");
    activePresses.delete(el);
    heldState[stateKey] = false;
    sendCmd(releaseChar);
  }

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("lostpointercapture", up);
}

function wireTapButton(el, char) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.classList.add("pressed");
    sendCmd(char);
    vibrate(20);
    setTimeout(() => el.classList.remove("pressed"), 150);
  });
}

function releaseAllHeld() {
  activePresses.forEach((releaseChar, el) => {
    el.classList.remove("pressed");
    sendCmd(releaseChar);
  });
  activePresses.clear();
  Object.keys(heldState).forEach((k) => (heldState[k] = false));
}

// Up/Down = forward/backward assist, Triangle/Cross = the same (matches firmware OR logic)
wireHoldButton(document.getElementById("dUp"), "U", "u", "up");
wireHoldButton(document.getElementById("dDown"), "D", "d", "down");
wireHoldButton(document.getElementById("aTriangle"), "T", "t", "triangle");
wireHoldButton(document.getElementById("aCross"), "C", "c", "cross");
wireHoldButton(document.getElementById("aSquare"), "S", "s", "square"); // left turn
wireHoldButton(document.getElementById("aCircle"), "O", "o", "circle"); // right turn

// D-pad Left/Right = one-tap 180 spin, not held
wireTapButton(document.getElementById("dLeft"), "L"); // counter-clockwise
wireTapButton(document.getElementById("dRight"), "R"); // clockwise

// Safety: if the tab/app is backgrounded mid-press, release everything
// so the bot doesn't keep driving with no one watching it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllHeld();
});
window.addEventListener("pagehide", releaseAllHeld);
document.addEventListener("contextmenu", (e) => e.preventDefault());
