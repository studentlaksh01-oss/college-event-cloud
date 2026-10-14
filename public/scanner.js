/* Camera + manual ticket check-in. Depends on helpers from app.js ($, api, toast) and jsQR. */
window.CampusScanner = (() => {
  const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
  const SCAN_INTERVAL_MS = 120;     // ~8 decodes per second is plenty and keeps phones cool
  const REPEAT_BLOCK_MS = 4000;     // ignore the same QR while it is still in front of the lens
  const MAX_FRAME_WIDTH = 800;

  const video = $('#scanVideo');
  const toggle = $('#scanToggle');
  const result = $('#scanResult');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let frameRequest = 0;
  let lastScanAt = 0;
  let busy = false;
  let lastToken = '';
  let lastTokenAt = 0;

  function show(message, ok) {
    result.textContent = message;
    result.className = `scan-result ${ok ? 'ok' : 'bad'}`;
  }

  async function checkIn(ticketToken) {
    const eventId = $('#checkinEventSelect').value || undefined; // undefined is dropped by JSON.stringify
    try {
      const data = await api('/api/admin/checkin', { method: 'POST', body: JSON.stringify({ ticketToken, eventId }) });
      show(data.message, true);
      navigator.vibrate?.(120);
      return true;
    } catch (error) {
      show(error.message, false);
      navigator.vibrate?.([80, 60, 80]);
      return false;
    }
  }

  function tick(now) {
    frameRequest = requestAnimationFrame(tick);
    if (busy || now - lastScanAt < SCAN_INTERVAL_MS) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA || !video.videoWidth) return;
    lastScanAt = now;

    const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR?.(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
    if (!code) return;

    const token = code.data.trim();
    if (!TOKEN_PATTERN.test(token)) {
      if (token !== lastToken) { lastToken = token; show('That QR code is not a CampusConnect ticket.', false); }
      return;
    }
    if (token === lastToken && Date.now() - lastTokenAt < REPEAT_BLOCK_MS) return;
    lastToken = token;
    lastTokenAt = Date.now();
    busy = true;
    checkIn(token).finally(() => { busy = false; });
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      show('Camera access needs HTTPS (or localhost). Use manual entry below instead.', false);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (error) {
      show(error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser settings, or use manual entry.' : 'Could not start the camera. Use manual entry below instead.', false);
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    video.classList.remove('hidden');
    toggle.textContent = 'Stop camera';
    toggle.classList.replace('button-primary', 'button-ghost');
    result.className = 'scan-result';
    lastToken = '';
    frameRequest = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(frameRequest);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    video.classList.add('hidden');
    toggle.textContent = 'Scan with camera';
    toggle.classList.replace('button-ghost', 'button-primary');
    busy = false;
  }

  toggle.addEventListener('click', () => (stream ? stop() : start()));
  // Release the camera whenever the page is hidden or closed.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', stop);

  $('#checkinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget; // currentTarget is null once we await, so capture it first
    const ticketToken = new FormData(form).get('ticketToken').trim();
    if (await checkIn(ticketToken)) form.reset();
  });

  return { start, stop };
})();
