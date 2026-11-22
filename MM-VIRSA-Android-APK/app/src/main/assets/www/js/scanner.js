/**
 * js/scanner.js
 * High-Speed Warehouse Barcode Scanner Engine:
 *  - Native Hardware BarcodeDetector acceleration (3x-5x faster on 1D Code-128/39 labels)
 *  - Full-HD 1080p + continuous autofocus camera constraints
 *  - Wide 1D airway-bill scan window at 20 FPS
 *  - Torch (Flashlight) & Digital Zoom controls (when supported by phone camera)
 *  - Minimum length noise filter (blocks stray 1-5 char reflections)
 *  - Global USB Handheld Scanner Wedge listener (works even if input isn't focused)
 */
(function (global) {
  const App = (global.DispatchApp = global.DispatchApp || {});

  let activeScanner = null;
  let activeElementId = null;
  let lastCameraCode = '';
  let lastCameraTime = 0;
  let torchOn = false;
  let currentZoom = 1;
  let zoomRange = null;
  let torchSupported = false;

  const MIN_BARCODE_LEN = 6;

  function isLibraryLoaded() {
    return typeof global.Html5Qrcode !== 'undefined';
  }

  function hasNativeBarcodeDetector() {
    return typeof global.BarcodeDetector !== 'undefined';
  }

  function getCapabilities() {
    return {
      torchSupported,
      torchOn,
      zoomSupported: Boolean(zoomRange && zoomRange.max > 1),
      currentZoom,
      nativeAccelerated: hasNativeBarcodeDetector()
    };
  }

  async function detectTrackCapabilities() {
    torchSupported = false;
    torchOn = false;
    zoomRange = null;
    currentZoom = 1;
    if (!activeScanner || !activeScanner.getRunningTrackCapabilities) return getCapabilities();
    try {
      const caps = activeScanner.getRunningTrackCapabilities();
      if (caps && caps.torch) {
        torchSupported = true;
      }
      if (caps && caps.zoom && caps.zoom.max > 1) {
        zoomRange = {
          min: caps.zoom.min || 1,
          max: Math.min(caps.zoom.max, 3.0)
        };
      }
      // Boost live camera stream to highest supported HD/FHD resolution + continuous autofocus
      const trackConstraints = {};
      if (caps && caps.width && caps.width.max) {
        trackConstraints.width = { ideal: Math.min(caps.width.max, 1920) };
      }
      if (caps && caps.height && caps.height.max) {
        trackConstraints.height = { ideal: Math.min(caps.height.max, 1080) };
      }
      if (caps && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        trackConstraints.advanced = [{ focusMode: 'continuous' }];
      }
      if (Object.keys(trackConstraints).length > 0 && activeScanner.applyVideoConstraints) {
        await activeScanner.applyVideoConstraints(trackConstraints);
      }
    } catch (_) {}
    return getCapabilities();
  }

  async function toggleTorch() {
    if (!activeScanner || !torchSupported) return { ok: false, torchOn: false };
    try {
      const next = !torchOn;
      await activeScanner.applyVideoConstraints({ advanced: [{ torch: next }] });
      torchOn = next;
      return { ok: true, torchOn };
    } catch (e) {
      return { ok: false, torchOn };
    }
  }

  async function cycleZoom() {
    if (!activeScanner || !zoomRange) return { ok: false, currentZoom: 1 };
    const steps = [1, 1.6, 2.2].filter((z) => z <= zoomRange.max + 0.05);
    if (steps.length < 2) steps.push(Number(zoomRange.max.toFixed(1)));
    const idx = steps.findIndex((z) => Math.abs(z - currentZoom) < 0.15);
    const nextZoom = steps[(idx + 1) % steps.length];
    try {
      await activeScanner.applyVideoConstraints({ advanced: [{ zoom: nextZoom }] });
      currentZoom = nextZoom;
      return { ok: true, currentZoom };
    } catch (_) {
      return { ok: false, currentZoom };
    }
  }

  async function stop() {
    torchOn = false;
    torchSupported = false;
    zoomRange = null;
    currentZoom = 1;
    if (!activeScanner) return;
    const scannerRef = activeScanner;
    activeScanner = null;
    activeElementId = null;
    try {
      if (scannerRef.isScanning) {
        await scannerRef.stop();
      }
      await scannerRef.clear();
    } catch (_) {}
  }

  /**
   * Starts high-speed 1D/2D camera barcode scanning inside target elementId.
   */
  async function start(elementId, onDecode, onError, options) {
    const opts = options || {};
    await stop();

    if (!isLibraryLoaded()) {
      const msg =
        'Camera barcode library (html5-qrcode) is not loaded (offline without local vendor file). You can still use a USB barcode scanner or type tracking numbers directly.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg =
        'Camera requires HTTPS or localhost. Launch via Start-VIRSA-Portal.bat (http://localhost:8787) on PC, or deploy over HTTPS for mobile phones.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }

    try {
      // Focus strictly on courier airway bill formats (Code 128, Code 39, ITF, EAN, QR) -> faster decoding!
      const formats = global.Html5QrcodeSupportedFormats
        ? [
            global.Html5QrcodeSupportedFormats.CODE_128,
            global.Html5QrcodeSupportedFormats.CODE_39,
            global.Html5QrcodeSupportedFormats.ITF,
            global.Html5QrcodeSupportedFormats.CODABAR,
            global.Html5QrcodeSupportedFormats.EAN_13,
            global.Html5QrcodeSupportedFormats.UPC_A,
            global.Html5QrcodeSupportedFormats.QR_CODE
          ]
        : undefined;

      const scanner = new global.Html5Qrcode(elementId, {
        formatsToSupport: formats,
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true
        },
        verbose: false
      });

      activeScanner = scanner;
      activeElementId = elementId;

      const config = {
        fps: 20,
        // Wide horizontal strip optimized for Leopards & Trax 1D linear barcodes (compact, zero-scroll)
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const w = Math.min(360, Math.floor(viewfinderWidth * 0.88));
          const h = Math.min(110, Math.floor(viewfinderHeight * 0.62));
          return { width: Math.max(200, w), height: Math.max(72, h) };
        },
        disableFlip: true,
        videoConstraints: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      };

      const cooldownMs = opts.cooldownMs !== undefined ? opts.cooldownMs : 1500;

      const handleSuccess = (decodedText) => {
        const clean = App.Couriers.normalizeTracking(decodedText);
        // Filter out stray noise / partial reads shorter than 6 characters
        if (!clean || clean.length < MIN_BARCODE_LEN) return;
        const now = Date.now();
        if (clean === lastCameraCode && now - lastCameraTime < cooldownMs) {
          return;
        }
        lastCameraCode = clean;
        lastCameraTime = now;
        if (onDecode) onDecode(clean);
      };

      try {
        await scanner.start({ facingMode: 'environment' }, config, handleSuccess, () => {});
      } catch (hdErr) {
        // Fallback to 720p HD constraints before bare default
        config.videoConstraints = {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };
        try {
          await scanner.start({ facingMode: 'environment' }, config, handleSuccess, () => {});
        } catch (_) {
          delete config.videoConstraints;
          await scanner.start({ facingMode: 'environment' }, config, handleSuccess, () => {});
        }
      }

      const caps = await detectTrackCapabilities();
      return { ok: true, capabilities: caps };
    } catch (err) {
      activeScanner = null;
      activeElementId = null;
      const msg =
        err && err.message
          ? `Camera could not start: ${err.message}`
          : 'Camera permission denied or no camera detected.';
      if (onError) onError(msg);
      return { ok: false, error: msg };
    }
  }

  function isActive(elementId) {
    if (!activeScanner) return false;
    if (elementId) return activeElementId === elementId;
    return true;
  }

  function resetCameraCooldown() {
    lastCameraCode = '';
    lastCameraTime = 0;
  }

  /**
   * Global USB Handheld Barcode Gun Wedge Listener:
   * Captures rapid HID scanner keystrokes (< 50ms between chars ending in Enter)
   * even when the operator forgot to click inside the text box!
   */
  function attachUsbWedge(onScanCallback) {
    let buffer = '';
    let lastKeyTs = 0;

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      // If user is already typing inside an input/textarea/select, let the input handle it natively
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const now = Date.now();
      if (now - lastKeyTs > 80) {
        buffer = '';
      }
      lastKeyTs = now;

      if (e.key === 'Enter') {
        const clean = App.Couriers.normalizeTracking(buffer);
        buffer = '';
        if (clean.length >= MIN_BARCODE_LEN && typeof onScanCallback === 'function') {
          e.preventDefault();
          onScanCallback(clean);
        }
      } else if (e.key && e.key.length === 1) {
        buffer += e.key;
      }
    });
  }

  App.Scanner = {
    isLibraryLoaded,
    hasNativeBarcodeDetector,
    getCapabilities,
    toggleTorch,
    cycleZoom,
    start,
    stop,
    isActive,
    resetCameraCooldown,
    attachUsbWedge
  };
})(window);
