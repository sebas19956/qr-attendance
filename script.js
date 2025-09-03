/* global Html5Qrcode, CONFIG */
const previewId = "preview";
let html5Qrcode;
let cameras = [];
let currentCameraIndex = 0;
let torchOn = false;

const $ = (id)=>document.getElementById(id);
const log = (m)=>{ const el=$("log"); const t=new Date().toLocaleString(); el.textContent = `[${t}] ${m}\n` + el.textContent; };
const status = (m)=>{ $("result").textContent = m; };

const offlineQueueKey = "qr_attendance_queue_v1";

async function loadCameras(){
  const devices = await Html5Qrcode.getCameras();
  cameras = devices || [];
  const sel = $("cameraSelect");
  sel.innerHTML = "";
  cameras.forEach((c,i)=>{
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = c.label || `Cámara ${i+1}`;
    sel.appendChild(opt);
  });
  if (cameras.length > 0) sel.value = currentCameraIndex;
}

async function startScanner(){
  if (!html5Qrcode) html5Qrcode = new Html5Qrcode(previewId, { verbose: false });
  const camId = cameras[currentCameraIndex]?.id || { facingMode: "environment" };
  const fps = 12;
  const qrbox = { width: 300, height: 200 };
  try{
    await html5Qrcode.start(
      camId,
      { fps, qrbox, aspectRatio: 1.77, experimentalFeatures: { useBarCodeDetectorIfSupported: true } },
      onScanSuccess,
      (err)=>{} // ignore scan failure noise
    );
    status("Escaneando…");
  }catch(e){
    status("No se pudo iniciar la cámara: " + e.message);
  }
}

async function stopScanner(){
  if (html5Qrcode && html5Qrcode.isScanning){
    await html5Qrcode.stop();
    status("Escáner detenido");
  }
}

async function switchCamera(){
  if (cameras.length < 2) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
  $("cameraSelect").value = currentCameraIndex;
  await stopScanner();
  await startScanner();
}

async function toggleTorch(){
  try{
    const tracks = document.querySelector("video")?.srcObject?.getVideoTracks?.();
    if (!tracks || !tracks[0]) return;
    torchOn = !torchOn;
    await tracks[0].applyConstraints({ advanced: [{ torch: torchOn }] });
  }catch(e){
    log("Linterna no soportada");
  }
}

function parseStudent(raw){
  // Soporta QR o código de barras con: código, documento o cualquier cadena.
  // Si el QR incluye JSON, intenta leer 'codigo' o 'id'.
  try {
    const j = JSON.parse(raw);
    return j.codigo || j.id || j.code || raw;
  } catch { return raw; }
}

async function sendRecord(studentId, mode, lab){
  const payload = {
    student_id: String(studentId).trim(),
    mode: mode || "auto",
    lab: lab || "",
    // timestamp del cliente solo para referencia, el servidor usará su hora
    client_ts: new Date().toISOString(),
    source: "pwa"
  };

  // Si no hay endpoint configurado aún, solo registra en log
  if (!CONFIG || !CONFIG.GAS_ENDPOINT){
    log("⚠️ Agrega tu GAS_ENDPOINT en config.js para enviar a Sheets.");
    return { ok:false, message:"Sin endpoint" };
  }

  try{
    const res = await fetch(CONFIG.GAS_ENDPOINT, {
      method: "POST",
      mode: "no-cors", // GAS webapp público puede requerir no-cors; en ese caso no habrá respuesta legible
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    // Cuando 'no-cors', no se puede leer res.ok; asumimos enviado
    return { ok:true, message:"Enviado" };
  }catch(e){
    // Si falla, guardamos en cola offline
    queueOffline(payload);
    return { ok:false, message:"Sin conexión. Guardado offline." };
  }
}

function queueOffline(item){
  const arr = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
  arr.push(item);
  localStorage.setItem(offlineQueueKey, JSON.stringify(arr));
  log("📦 Guardado para enviar luego.");
}

async function flushQueue(){
  if (!navigator.onLine) return;
  const arr = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
  if (!arr.length) return;
  for (const item of arr){
    try{
      await fetch(CONFIG.GAS_ENDPOINT, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item)
      });
    }catch{ /* keep */ }
  }
  localStorage.removeItem(offlineQueueKey);
  if (arr.length) log(`✅ Enviados ${arr.length} registros pendientes.`);
}

async function onScanSuccess(decodedText, decodedResult){
  await stopScanner(); // evita duplicados
  const lab = $("lab").value;
  const mode = $("modo").value;
  const id = parseStudent(decodedText);
  status(`Leído: ${id}. Enviando…`);
  log(`🔎 Código leído: ${id}`);

  const r = await sendRecord(id, mode, lab);
  if (r.ok){
    status(`Registro enviado para ${id}.`);
    log(`📤 ${id} → ${mode.toUpperCase()} (${lab || "sin lab"})`);
    beep();
  } else {
    status(`No se envió (offline). Queda en cola.`);
  }

  // Reinicia el escaneo tras breve pausa
  setTimeout(()=>startScanner(), 600);
}

function beep(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(880, ctx.currentTime);
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.1, ctx.currentTime);
    o.start(); o.stop(ctx.currentTime + 0.08);
  }catch{}
}

window.addEventListener("load", async ()=>{
  await loadCameras();
  $("startBtn").addEventListener("click", startScanner);
  $("stopBtn").addEventListener("click", stopScanner);
  $("switchBtn").addEventListener("click", switchCamera);
  $("torchBtn").addEventListener("click", toggleTorch);
  $("cameraSelect").addEventListener("change", async (e)=>{
    currentCameraIndex = Number(e.target.value);
    await stopScanner();
    await startScanner();
  });
  window.addEventListener("online", flushQueue);
  await flushQueue();
});
