import {
  loadTracker, posesToTracks, possibleIncident, containsThreatPhrase, handsToBoxes, drawBoxes,
} from './tracker.js?v=hand-diagnostic-5';

const byId = id => document.getElementById(id);
const video = byId('video');
const overlay = byId('overlay');
const paint = overlay.getContext('2d');
const debugHands = new URLSearchParams(location.search).get('debugHands') === '1';
const status = byId('status');
const titles = {posible: 'Posible agresión', amenaza: 'Amenaza verbal', panico: 'Alarma de pánico'};
const authForm = byId('authForm');
const defaultMapQuery = 'Instituto Superior Tecnológico Yavirac, Quito, Ecuador';
const defaultMapCoordinates = '-0.2250844,-78.5166937';
let setupRequired = false;
let whatsappRecipient;
let camera, microphone, audioContext, detector, detectorPromise, cameraRun = 0;
let cameraStarting = false, microphoneStarting = false, microphoneRun = 0;
let sensorsRun = 0;
let tracks = [], handBoxes = [], handLandmarks = [], redUntil = 0, busy = false, pending, addressMapTimer;
let lastFrame = 0, lastVideo = -1, impulses = [], lastAuto = -Infinity;
let locationWatch, currentLocation, lastMapUpdate = 0;
let speechRecognition, speechEnabled = false, lastVoiceThreat = -Infinity;
let emergencyContacts = [];
let sirenContext, sirenTimer, alarmActive = false;

function whatsappUrl(number, message) {
  const digits = number.replace(/\D/g, '');
  const international = digits.startsWith('593') ? digits : `593${digits.replace(/^0/, '')}`;
  return `https://wa.me/${international}?text=${encodeURIComponent(message)}`;
}

function showWhatsAppFallback(statusNode, recipients, message, notice) {
  statusNode.replaceChildren(element(
    'span',
    notice || 'No se envió automáticamente por WhatsApp. Abre el chat y pulsa Enviar:',
  ));
  for (const recipient of recipients) {
    const link = element('a', ` WhatsApp de ${recipient.name}`);
    link.href = whatsappUrl(recipient.whatsapp, message);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    statusNode.append(link);
  }
}

function makeWhatsAppMessage(subject, address, location) {
  const lines = [subject, `Dirección: ${address}`];
  if (location.lat !== undefined && location.lon !== undefined) {
    lines.push(`Mapa: https://www.google.com/maps?q=${location.lat},${location.lon}`);
  } else if (location.error) {
    lines.push(`Ubicación GPS no disponible: ${location.error}`);
  }
  return lines.join('\n');
}

function renderContacts() {
  const container = byId('contacts');
  if (!emergencyContacts.length) {
    container.replaceChildren(element('p', 'No hay contactos registrados.'));
    return;
  }
  container.replaceChildren(...emergencyContacts.map(contact => {
    const item = element('div', '', 'contact-item');
    item.append(element('span', `${contact.name} · ${contact.whatsapp}`));
    const send = element('button', 'Enviar alerta por WhatsApp');
    send.type = 'button';
    send.onclick = () => sendContactAlert(contact, send);
    item.append(send);
    return item;
  }));
}

async function sendContactAlert(contact, button) {
  button.disabled = true;
  const statusText = byId('panicStatus');
  statusText.textContent = `Obteniendo ubicación para enviar a ${contact.name}…`;
  try {
  const location = await position();
  const address = byId('address').value.trim() || 'Dirección no indicada';
  const response = await fetch('/api/whatsapp/contact', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      contact_id: contact.id,
      address,
      lat: location.lat,
      lon: location.lon,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo enviar la alerta');
  if (result.delivery.includes('requiere API oficial de Meta')) {
    showWhatsAppFallback(statusText, [contact], makeWhatsAppMessage(
      'Alarma de pánico activada', address, location,
    ));
  } else {
    statusText.textContent = `${contact.name}: ${result.delivery}`;
  }
  } catch (error) {
  statusText.textContent = error.message || 'No se pudo enviar la alerta.';
  } finally {
  button.disabled = false;
  }
}

async function addEmergencyContact(event) {
  event.preventDefault();
  const name = byId('contactName').value.trim();
  const whatsapp = byId('contactWhatsapp').value.trim();
  try {
    const response = await fetch('/api/emergency-contacts', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name, whatsapp}),
    });
    const contact = await response.json();
    if (!response.ok) throw new Error(contact.error || 'No se pudo agregar el contacto');
    emergencyContacts.push(contact);
    emergencyContacts.sort((a, b) => a.name.localeCompare(b.name));
    renderContacts();
    byId('contactForm').reset();
  } catch (error) {
    byId('panicStatus').textContent = error.message;
  }
}

function showAuthMode(setup) {
  setupRequired = setup;
  byId('authView').hidden = false;
  byId('appView').hidden = true;
  byId('logout').hidden = true;
  byId('alertRecipient').hidden = true;
  byId('authTitle').textContent = setup ? 'Crear cuenta' : 'Iniciar sesión';
  byId('authHelp').textContent = setup
    ? 'Registra tu correo, una contraseña y el WhatsApp que recibirá las alertas. Usa el formato ecuatoriano 09XXXXXXXX.'
    : 'Accede para activar el monitoreo y las alertas.';
  byId('whatsappField').hidden = !setup;
  byId('authWhatsapp').required = setup;
  byId('authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  byId('authSubmit').textContent = setup ? 'Crear cuenta' : 'Iniciar sesión';
}

async function loadSession() {
  const retry = byId('authRetry');
  retry.hidden = true;
  byId('authStatus').textContent = '';
  try {
    const response = await fetch('/api/session', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`El servidor respondió HTTP ${response.status}`);
    const session = await response.json();
    if (session.authenticated) {
      byId('authView').hidden = true;
      byId('appView').hidden = false;
      byId('logout').hidden = false;
      byId('alertRecipient').textContent = `Alertas al WhatsApp: ${session.account.whatsapp}`;
      byId('alertRecipient').hidden = false;
      whatsappRecipient = session.account.whatsapp;
      emergencyContacts = session.contacts || [];
      renderContacts();
      updateMap();
      refresh();
      startSensors().catch(() => {
        byId('tracking').textContent = 'No se pudieron iniciar todos los sensores. Revisa los permisos del navegador.';
      });
    } else {
      showAuthMode(session.setup_required);
    }
  } catch (error) {
    showAuthMode(false);
    byId('authStatus').textContent =
      `No se pudo consultar el servidor local (${error.message || 'error de red'}). Comprueba que py app.py siga ejecutándose.`;
    retry.hidden = false;
  }
}

authForm.onsubmit = async event => {
  event.preventDefault();
  const submit = byId('authSubmit');
  submit.disabled = true;
  byId('authStatus').textContent = '';
  const payload = {
    email: byId('authEmail').value,
    password: byId('authPassword').value,
  };
  byId('authRetry').onclick = loadSession;
  if (setupRequired) payload.whatsapp = byId('authWhatsapp').value;
  try {
    const response = await fetch(setupRequired ? '/api/register' : '/api/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo iniciar sesión');
    authForm.reset();
    await loadSession();
  } catch (error) {
    byId('authStatus').textContent = error.message || 'No se pudo iniciar sesión.';
  } finally {
    submit.disabled = false;
  }
};

byId('logout').onclick = async () => {
  sensorsRun++;
  disableCamera();
  disableMic();
  stopSpeechRecognition();
  deactivateAlarm();
  await fetch('/api/logout', {method: 'POST'});
  await loadSession();
};

function disableCamera() {
  cameraRun++;
  camera?.getTracks().forEach(track => track.stop());
  stopLocationWatch();
  camera = undefined;
  video.srcObject = null;
  tracks = [];
  handBoxes = [];
  handLandmarks = [];
  impulses = [];
  lastFrame = 0;
  lastVideo = -1;
  paint.clearRect(0, 0, overlay.width, overlay.height);
  byId('placeholder').hidden = false;
  byId('camState').textContent = 'Apagada';
  byId('camera').textContent = 'Activar cámara';
  byId('tracking').textContent = 'La detección de manos se activa al encender la cámara.';
}

async function enableCamera() {
  if (camera || cameraStarting) return;
  cameraStarting = true;
  const button = byId('camera');
  button.disabled = true;
  const run = ++cameraRun;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices no disponible');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 960}}, audio: false});
    } catch (error) {
      if (error.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({video: true, audio: false});
      } else {
        throw error;
      }
    }
    if (run !== cameraRun) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    camera = stream;
    camera.getVideoTracks()[0].addEventListener('ended', () => {
      if (run === cameraRun) disableCamera();
    });
    video.srcObject = camera;
    await video.play();
    if (run !== cameraRun) return;
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    overlay.parentElement.style.aspectRatio = video.videoWidth + ' / ' + video.videoHeight;
    byId('placeholder').hidden = true;
    byId('camState').textContent = 'En vivo';
    button.textContent = 'Apagar cámara';
    byId('tracking').textContent = 'Cargando detección de personas y manos…';
    startLocationWatch();
    loadDetection(run);
  } catch (error) {
    if (run !== cameraRun) return;
    disableCamera();
    const message = error?.name === 'NotAllowedError'
      ? 'Permiso denegado. Permite la cámara en el icono del candado del navegador.'
      : error?.name === 'NotFoundError'
        ? 'No se encontró una cámara. Conecta o habilita una cámara.'
        : error?.name === 'NotReadableError'
          ? 'La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentarlo.'
          : 'No se pudo abrir la cámara. Usa localhost, Chrome/Edge y revisa el permiso.';
    byId('tracking').textContent = message;
    return;
  } finally {
    cameraStarting = false;
    button.disabled = false;
  }
}

async function loadDetection(run) {
  try {
    detectorPromise ??= Promise.race([
      loadTracker(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado')), 25000)),
    ]);
    detector = await detectorPromise;
    if (run === cameraRun) {
      byId('tracking').textContent = debugHands
        ? 'Diagnóstico activo: los puntos magenta muestran lo que detecta el modelo.'
        : 'Detección de manos y personas activa.';
    }
  } catch {
    detectorPromise = undefined;
    if (run === cameraRun) byId('tracking').textContent = 'Modelo no disponible. Revisa internet y vuelve a encender la cámara.';
  }
}

byId('camera').onclick = () => {
  if (camera) disableCamera();
  else enableCamera();
};

function disableMic() {
  microphoneRun++;
  const old = audioContext;
  audioContext = undefined;
  if (old) old.close().catch(() => {});
  microphone?.getTracks().forEach(track => track.stop());
  microphone = undefined;
  byId('mic').textContent = 'Activar micrófono';
  byId('level').value = 0;
}

async function enableMic() {
  if (microphone || microphoneStarting) return;
  microphoneStarting = true;
  const button = byId('mic');
  button.disabled = true;
  const run = ++microphoneRun;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
    if (run !== microphoneRun) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    microphone = stream;
    microphone.getAudioTracks()[0].addEventListener('ended', disableMic, {once: true});
    button.textContent = 'Apagar micrófono';
    const context = audioContext = new AudioContext();
    context.resume().then(() => {
      if (run !== microphoneRun || context !== audioContext || !microphone) return;
      const analyzer = context.createAnalyser();
      context.createMediaStreamSource(microphone).connect(analyzer);
      const samples = new Float32Array(analyzer.fftSize);
      function measure() {
        if (context !== audioContext) return;
        analyzer.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        byId('level').value = Math.min(1, 3 * rms);
        requestAnimationFrame(measure);
      }
      measure();
    }).catch(() => {
      if (run !== microphoneRun || context !== audioContext) return;
      audioContext = undefined;
      context.close().catch(() => {});
      status.textContent = 'Micrófono activo; el medidor de audio no está disponible en este navegador.';
    });
  } catch {
    if (run !== microphoneRun) return;
    disableMic();
    status.textContent = 'No se pudo abrir el micrófono. Revisa el permiso y el dispositivo.';
  } finally {
    microphoneStarting = false;
    button.disabled = false;
  }
}

function stopSpeechRecognition() {
  speechEnabled = false;
  if (speechRecognition) {
    try {
      speechRecognition.stop();
    } catch (error) {
      if (error.name !== 'InvalidStateError') throw error;
    }
  }
  speechRecognition = undefined;
  const button = byId('speech');
  if (button) button.textContent = 'Activar detección de amenazas por voz';
}

function startSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    byId('speechStatus').textContent = 'Este navegador no ofrece reconocimiento de voz en español.';
    return;
  }
  const recognition = new Recognition();
  speechRecognition = recognition;
  speechEnabled = true;
  recognition.lang = 'es-EC';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  byId('speech').textContent = 'Detener detección de amenazas';
  byId('speechStatus').textContent = 'Solicitando permiso para reconocer voz…';
  recognition.onstart = () => {
    byId('speechStatus').textContent = 'Escuchando amenazas habladas. No se guardan grabaciones.';
  };
  recognition.onresult = event => {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      const transcript = result[0].transcript.trim().slice(0, 250);
      if (result.isFinal && containsThreatPhrase(transcript) &&
          !busy && !pending && performance.now() - lastVoiceThreat > 20000) {
        lastVoiceThreat = performance.now();
        createAlert('amenaza', transcript);
      }
    }
  };
  recognition.onerror = event => {
    const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'];
    byId('speechStatus').textContent = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Permiso de micrófono denegado. Permítelo en el navegador y vuelve a activar la detección.'
      : `Reconocimiento de voz: ${event.error}.`;
    if (fatal.includes(event.error)) {
      speechEnabled = false;
      byId('speech').textContent = 'Activar detección de amenazas por voz';
    }
  };
  recognition.onend = () => {
    if (!speechEnabled || speechRecognition !== recognition) return;
    setTimeout(() => {
      if (!speechEnabled || speechRecognition !== recognition) return;
      try {
        recognition.start();
      } catch (error) {
        if (error.name === 'InvalidStateError') return;
        speechEnabled = false;
        speechRecognition = undefined;
        byId('speech').textContent = 'Activar detección de amenazas por voz';
        byId('speechStatus').textContent = 'No se pudo reiniciar el reconocimiento. Vuelve a activarlo.';
      }
    }, 750);
  };
  try {
    recognition.start();
  } catch {
    speechEnabled = false;
    speechRecognition = undefined;
    byId('speech').textContent = 'Activar detección de amenazas por voz';
    byId('speechStatus').textContent =
      'No se pudo iniciar automáticamente. Pulsa Activar detección de amenazas por voz para reintentar.';
  }
}

byId('speech').onclick = () => {
  if (speechEnabled) {
    stopSpeechRecognition();
    byId('speechStatus').textContent = 'Reconocimiento de voz detenido.';
  } else {
    startSpeechRecognition();
  }
};

byId('mic').onclick = () => {
  if (microphone) {
    disableMic();
    return;
  }
  enableMic();
};

function startSensors() {
  const run = ++sensorsRun;
  return (async () => {
    await enableCamera();
    if (run !== sensorsRun) return;
    await enableMic();
    if (run !== sensorsRun) return;
    if (!speechEnabled) startSpeechRecognition();
  })();
}

function animate(now) {
  requestAnimationFrame(animate);
  if (!camera || video.readyState < 2) return;
  if (detector && now - lastFrame >= 85 && video.currentTime !== lastVideo) {
    try {
      const poseResult = detector.pose.detectForVideo(video, now);
      const handResult = detector.hands.detectForVideo(video, now);
      handLandmarks = handResult.landmarks;
      tracks = posesToTracks(poseResult.landmarks, tracks, (now - lastFrame) / 1000);
      handBoxes = handsToBoxes(handResult.landmarks, handBoxes);
      lastFrame = now;
      lastVideo = video.currentTime;
      impulses = impulses.filter(time => now - time < 900);
      if (possibleIncident(tracks)) {
        impulses.push(now);
        if (impulses.length >= 2 && !busy && !pending && now - lastAuto > 20000) {
          lastAuto = now;
          impulses = [];
          activateAlarm('Alarma activada automáticamente por posible agresión.');
          createAlert('posible');
        }
      }
    } catch {
      detector = detectorPromise = undefined;
      tracks = [];
      handBoxes = [];
      handLandmarks = [];
      byId('tracking').textContent = 'Se interrumpió el seguimiento. Reinicia la cámara.';
    }
  }
  if (now >= redUntil) redUntil = 0;
  drawBoxes(paint, handBoxes, now < redUntil);
  if (debugHands) {
    paint.fillStyle = '#ff2d55';
    const radius = Math.max(4, overlay.width / 180);
    handLandmarks.forEach(points => points.forEach(point => {
      paint.beginPath();
      paint.arc(point.x * overlay.width, point.y * overlay.height, radius, 0, Math.PI * 2);
      paint.fill();
    }));
  }
}
requestAnimationFrame(animate);

function position() {
  return new Promise(resolve => {
    if (currentLocation && Date.now() - currentLocation.timestamp < 30000) {
      return resolve({lat: currentLocation.lat, lon: currentLocation.lon});
    }
    if (!navigator.geolocation) {
      return resolve({error: 'Este navegador no permite obtener la ubicación.'});
    }
    const expiry = setTimeout(() => resolve({
      error: 'La ubicación tardó demasiado. Activa la ubicación de Windows y vuelve a intentarlo.',
    }), 22000);
    const finish = value => { clearTimeout(expiry); resolve(value); };
    navigator.geolocation.getCurrentPosition(
      ({coords}) => {
        currentLocation = {lat: coords.latitude, lon: coords.longitude, timestamp: Date.now()};
        updateMap();
        finish({lat: coords.latitude, lon: coords.longitude});
      },
      error => {
        const message = locationErrorMessage(error);
        byId('locationStatus').textContent = message;
        finish({error: message});
      },
      {enableHighAccuracy: false, timeout: 20000, maximumAge: 15000},
    );
  });
}

function locationErrorMessage(error) {
  if (error.code === error.PERMISSION_DENIED) {
    return 'Ubicación bloqueada: en Chrome, pulsa el icono junto a la dirección, permite Ubicación y recarga la página.';
  }
  if (error.code === error.POSITION_UNAVAILABLE) {
    return 'Windows no encontró tu ubicación. Activa Servicios de ubicación en Configuración y vuelve a intentarlo.';
  }
  return 'La búsqueda de ubicación tardó demasiado. Activa la ubicación de Windows y vuelve a intentarlo.';
}

function updateMap() {
  const query = currentLocation
    ? `${currentLocation.lat},${currentLocation.lon}`
    : byId('address').value.trim() || defaultMapQuery;
  const map = byId('liveMap');
  const coordinates = currentLocation ? query : defaultMapCoordinates;
  map.src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&ll=${coordinates}&z=17&output=embed`;
  map.hidden = false;
}

function stopLocationWatch() {
  if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = undefined;
  currentLocation = undefined;
  lastMapUpdate = 0;
  byId('location').textContent = 'Activar ubicación en vivo';
  byId('locationStatus').textContent = 'Ubicación en vivo apagada.';
  updateMap();
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    byId('locationStatus').textContent = 'Este navegador no permite obtener la ubicación.';
    return;
  }
  if (locationWatch !== undefined) {
    stopLocationWatch();
    return;
  }
  byId('location').textContent = 'Detener ubicación en vivo';
  byId('locationStatus').textContent = 'Esperando permiso y señal GPS…';
  locationWatch = navigator.geolocation.watchPosition(({coords}) => {
    currentLocation = {lat: coords.latitude, lon: coords.longitude, timestamp: Date.now()};
    byId('locationStatus').textContent =
      `GPS actualizado: ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`;
    if (!lastMapUpdate || Date.now() - lastMapUpdate >= 15000) {
      updateMap();
      lastMapUpdate = Date.now();
    }
  }, error => {
    if (locationWatch !== undefined) navigator.geolocation.clearWatch(locationWatch);
    locationWatch = undefined;
    currentLocation = undefined;
    byId('location').textContent = 'Activar ubicación en vivo';
    byId('locationStatus').textContent = locationErrorMessage(error);
    updateMap();
  }, {enableHighAccuracy: false, maximumAge: 5000, timeout: 20000});
}

byId('location').onclick = startLocationWatch;
byId('address').addEventListener('input', () => {
  clearTimeout(addressMapTimer);
  addressMapTimer = setTimeout(updateMap, 500);
});

byId('shareLocation').onclick = async () => {
  const button = byId('shareLocation');
  button.disabled = true;
  byId('shareStatus').textContent = 'Obteniendo ubicación y enviando por WhatsApp…';
  try {
    const address = byId('address').value.trim() || 'Dirección no indicada';
    const location = await position();
    const response = await fetch('/api/whatsapp/location', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        address,
        lat: location.lat,
        lon: location.lon,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo enviar la ubicación');
    if (result.delivery.includes('requiere API oficial de Meta')) {
      showWhatsAppFallback(
        byId('shareStatus'),
        [{name: 'tu cuenta', whatsapp: whatsappRecipient}, ...emergencyContacts],
        makeWhatsAppMessage('Ubicación compartida', address, location),
      );
    } else {
      byId('shareStatus').textContent = result.delivery;
    }
  } catch (error) {
    byId('shareStatus').textContent = error.message || 'No se pudo preparar el envío por WhatsApp.';
  } finally {
    button.disabled = false;
  }
};

function snapshot() {
  if (!camera || video.readyState < 2) return;
  drawBoxes(paint, handBoxes, performance.now() < redUntil);
  const capture = document.createElement('canvas');
  capture.width = Math.min(960, overlay.width);
  capture.height = Math.round(capture.width * overlay.height / overlay.width);
  const ctx = capture.getContext('2d');
  ctx.translate(capture.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, capture.width, capture.height);
  ctx.drawImage(overlay, 0, 0, capture.width, capture.height);
  return capture.toDataURL('image/jpeg', 0.78).split(',')[1];
}

function updateButtons() {
  byId('retry').hidden = busy || !pending;
}

async function save() {
  const response = await fetch('/api/alertas', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(pending),
    signal: AbortSignal.timeout(18000),
  });
  if (!response.ok) throw new Error('Error al guardar');
  const {delivery} = await response.json();
  const count = pending.photos.length;
  const alertLabel = {
    amenaza: 'Amenaza verbal guardada',
    posible: 'Posible agresión guardada',
    panico: 'Alarma de pánico guardada',
  }[pending.kind] || 'Alerta guardada';
  const summary = alertLabel +
    ' · ' + count + (count === 1 ? ' foto · ' : ' fotos · ') + delivery;
  if (delivery.includes('requiere API oficial de Meta')) {
    const alertText = pending.details
      ? `${titles[pending.kind]}: ${pending.details}`
      : titles[pending.kind];
    showWhatsAppFallback(
      status,
      [{name: 'tu cuenta', whatsapp: whatsappRecipient}, ...emergencyContacts],
      makeWhatsAppMessage(alertText, pending.address, pending),
      `${summary}. Abre un chat y pulsa Enviar para mandar el aviso manualmente:`,
    );
  } else {
    status.textContent = summary;
  }
  if (pending.kind === 'panico') byId('panicStatus').textContent = delivery;
  pending = undefined;
  refresh();
}

async function createAlert(kind, details = '') {
  if (busy || pending) return;
  busy = true;
  updateButtons();
  status.textContent = 'Preparando alerta…';
  const address = byId('address').value;
  const id = crypto.randomUUID();
  const location = position();
  const photos = [];
  if (kind === 'posible') {
    redUntil = performance.now() + 3500;
  }
  try {
    const captureRun = cameraRun;
    if (camera && video.readyState >= 2) {
      for (let i = 0; i < 3 && captureRun === cameraRun; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, 320));
        if (captureRun !== cameraRun) break;
        const photo = snapshot();
        if (photo) photos.push(photo);
      }
    }
    pending = {id, kind, address, details, photos, ...await location};
    await save();
  } catch {
    status.textContent = pending ? 'Guardado sin confirmar. Puedes reintentar.' : 'No se pudo preparar la alerta.';
  } finally {
    busy = false;
    updateButtons();
  }
}

byId('retry').onclick = async () => {
  busy = true;
  updateButtons();
  try {
    await save();
  } catch {
    status.textContent = 'Guardado sin confirmar. Puedes reintentar.';
  } finally {
    busy = false;
    updateButtons();
  }
};

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content) node.textContent = content;
  if (className) node.className = className;
  return node;
}

async function refresh() {
  const history = byId('history');
  try {
    const response = await fetch('/api/alertas');
    if (!response.ok) throw new Error('Historial no disponible');
    const rows = await response.json();
    history.replaceChildren(...rows.map(row => {
      const item = element('article');
      item.append(element('h3', titles[row.kind]),
        element('p', new Date(row.created).toLocaleString('es-EC') + ' · ' + row.delivery, 'meta'),
        element('p', row.address || 'Dirección sin indicar'));
      if (row.details) item.append(element('p', 'Texto detectado: ' + row.details));
      if (row.lat !== null) {
        const link = element('a', 'Ver ubicación en el mapa');
        link.href = 'https://www.google.com/maps?q=' + row.lat + ',' + row.lon;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        item.append(link);
      }
      const gallery = element('div', '', 'photos');
      for (let i = 0; i < row.count; i++) {
        const link = element('a');
        const image = element('img');
        link.href = image.src = '/api/foto/' + row.id + '/' + i;
        image.alt = 'Abrir evidencia ' + (i + 1);
        image.loading = 'lazy';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(image);
        gallery.append(link);
      }
      item.append(gallery);
      const remove = element('button', 'Eliminar alerta y fotos', 'delete-photos danger');
      remove.type = 'button';
      remove.onclick = () => deleteAlert(row.id);
      item.append(remove);
      return item;
    }));
    if (!rows.length) history.append(element('p', 'Todavía no hay alertas.'));
  } catch {
    history.replaceChildren(element('p', 'No se pudo cargar el historial.'));
  }
}

async function deleteAlert(alertId) {
  const allAlerts = !alertId;
  const confirmed = confirm(allAlerts
    ? '¿Eliminar todo el historial? Se borrarán todas las amenazas, agresiones y sus fotos. Esta acción no se puede deshacer.'
    : '¿Eliminar esta alerta y todas sus fotos? Esta acción no se puede deshacer.');
  if (!confirmed) return;
  try {
    const response = await fetch(allAlerts ? '/api/fotos' : `/api/alertas/${alertId}`, {
      method: 'DELETE',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo eliminar el historial');
    status.textContent = allAlerts
      ? `Alertas eliminadas: ${result.deleted_alerts} · Fotos eliminadas: ${result.deleted_photos}`
      : 'Alerta y fotos eliminadas.';
    await refresh();
  } catch (error) {
    status.textContent = error.message || 'No se pudo eliminar el historial.';
  }
}

byId('clearHistory').onclick = () => deleteAlert();
byId('refresh').onclick = refresh;
byId('contactForm').onsubmit = addEmergencyContact;

function stopSiren() {
  if (sirenTimer) clearInterval(sirenTimer);
  sirenTimer = undefined;
  if (sirenContext) {
    sirenContext.close().catch(() => {});
    sirenContext = undefined;
  }
}

function startSiren() {
  stopSiren();
  sirenContext = new AudioContext();
  const oscillator = sirenContext.createOscillator();
  const gain = sirenContext.createGain();
  oscillator.type = 'sawtooth';
  gain.gain.value = 0.12;
  oscillator.connect(gain);
  gain.connect(sirenContext.destination);
  oscillator.start();
  const context = sirenContext;
  if (context.state !== 'running') {
    context.resume().catch(() => {
      if (alarmActive && sirenContext === context) {
        byId('panic').textContent = 'Habilitar sonido de alarma';
        byId('panic').hidden = false;
        byId('panicStatus').textContent =
          'El navegador bloqueó el sonido. Pulsa Habilitar sonido de alarma para permitirlo.';
      }
    });
  }
  let high = false;
  sirenTimer = setInterval(() => {
    high = !high;
    oscillator.frequency.setTargetAtTime(high ? 900 : 500, sirenContext.currentTime, 0.08);
  }, 500);
}

function activateAlarm(message) {
  if (alarmActive) return;
  try {
    startSiren();
    alarmActive = true;
    byId('panic').hidden = true;
    byId('stopAlarm').hidden = false;
    byId('panicStatus').textContent = message;
  } catch {
    stopSiren();
    byId('panicStatus').textContent = 'No se pudo iniciar el sonido de la alarma en este navegador.';
  }
}

function deactivateAlarm() {
  alarmActive = false;
  stopSiren();
  byId('panic').hidden = false;
  byId('panic').textContent = 'Activar alarma de pánico';
  byId('stopAlarm').hidden = true;
  byId('panicStatus').textContent = 'Alarma desactivada.';
}

byId('panic').onclick = async () => {
  if (alarmActive) {
    try {
      startSiren();
      byId('panic').hidden = true;
      byId('panic').textContent = 'Activar alarma de pánico';
      byId('panicStatus').textContent = 'Alarma sonora activada.';
    } catch {
      stopSiren();
      byId('panicStatus').textContent = 'No se pudo iniciar el sonido de la alarma en este navegador.';
    }
    return;
  }
  activateAlarm('Alarma activada. Guardando y enviando avisos…');
  await createAlert('panico', 'Alarma de pánico activada por el usuario');
};
byId('stopAlarm').onclick = deactivateAlarm;
loadSession();
