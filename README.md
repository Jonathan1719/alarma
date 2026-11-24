# Alerta IA · Monitor local

Prototipo académico del Grupo 4 de 4to A DS, basado en la especificación del Sistema Integrado de Alarma y Notificación Inteligente mediante IA. Incluye monitoreo, detección automática de posibles agresiones, aviso por correo y consulta de evidencias. Los flujos institucionales de cuentas, roles, brigadas, reportes y auditoría corresponden a una ampliación del proyecto.

## Arrancar en Windows

1. Instala Python 3.10 o superior y extrae el ZIP.
2. Abre la carpeta que contiene `app.py` en VS Code. En la terminal PowerShell ejecuta:

   ```powershell
   py app.py
   ```

3. Abre http://localhost:8000 en Chrome o Edge. La primera vez registra una cuenta local con correo, contraseña y WhatsApp ecuatoriano en formato `0983625739`; el cero inicial se conserva y se convierte automáticamente a `593983625739` al enviar por Cloud API. Después inicia sesión: se usará siempre el número guardado en la cuenta. La contraseña se guarda como hash. Al iniciar sesión, la app solicita permisos para encender la cámara y el micrófono y activar el reconocimiento de voz. La detección automática funciona mientras la página esté abierta y los permisos estén concedidos. El seguimiento descarga MediaPipe y los modelos de pose y manos por internet.

En Linux o macOS, ejecuta `python3 app.py`. El servidor escucha únicamente en la misma computadora. Si el puerto está ocupado, usa `$env:ALARMA_PORT = "8001"` antes de arrancar y abre el puerto correspondiente.

## Probar las funciones

- Al iniciar sesión, la cámara, el micrófono, el medidor de audio y la detección de amenazas por voz se activan automáticamente después de conceder los permisos del navegador. Los botones permiten apagarlos manualmente. El medidor procesa el audio en el navegador y no lo graba.
- Chrome puede enviar audio al servicio de reconocimiento de voz. No se guardan grabaciones; si detecta frases de amenaza configuradas, guarda el texto reconocido como evidencia. La detección por palabras clave puede equivocarse y no comprende el contexto.
- La detección automática se inicia con la cámara y busca movimientos rápidos de muñeca cerca de otra persona. Muestra cuadros transparentes suavizados alrededor de las manos y conserva brevemente el seguimiento si se pierde una detección. Al confirmar una posible agresión, activa la sirena y guarda una alerta; usa **Desactivar alarma** para apagarla. Si el navegador bloquea el audio, pulsa **Habilitar sonido de alarma**. Exige dos observaciones en 900 ms y tiene un intervalo mínimo de 20 segundos entre alertas automáticas. Solo registra amenazas detectadas por voz y posibles agresiones; el historial no muestra alertas de pánico anteriores. Es una heurística experimental: puede omitir incidentes o marcar movimientos normales. Prueba en un entorno controlado.
- El mapa integrado abre inicialmente el Instituto Superior Tecnológico Yavirac en Quito. Al activar la cámara también se inicia el GPS; permite el acceso para que el mapa y las alertas usen tu ubicación actual. Si el navegador bloquea el permiso, pulsa el icono junto a la dirección y permite **Ubicación**; en Windows, activa **Configuración > Privacidad y seguridad > Ubicación**, **Servicios de ubicación** y **Permitir que las aplicaciones de escritorio accedan a tu ubicación**. Si no hay GPS, el mapa conserva la dirección de Yavirac o la dirección escrita, pero la alerta no incluirá coordenadas actuales. Cada alerta automática toma la ubicación más reciente y manda el enlace de Google Maps al correo de la cuenta y al WhatsApp registrado.
- **Enviar ubicación por WhatsApp** envía la dirección y el enlace GPS a la cuenta y a los contactos de emergencia mediante WhatsApp Cloud API. Requiere la API oficial configurada; sin ella, el estado indica que no se envió.
- Abre una foto desde el historial para revisarla a tamaño completo. El historial muestra las 100 alertas recientes. Las alertas y las fotos JPEG se almacenan juntas en `datos/alertas.sqlite3` y persisten al cerrar la aplicación. Conserva esa carpeta para mantener las evidencias.
- Usa **Eliminar alerta y fotos** en una tarjeta para borrar ese incidente y sus evidencias. **Eliminar todo el historial** borra todos los incidentes y todas las fotos. Ambas acciones requieren confirmación y no se pueden deshacer.

## Configurar el correo

Con el servidor detenido, configura en PowerShell las credenciales de un proveedor con SMTP sobre TLS implícito. Los avisos se envían al correo usado para crear la cuenta.

```powershell
$env:SMTP_HOST = "smtp.gmail.com"
$env:SMTP_PORT = "465"
$env:SMTP_USER = "tu-cuenta@gmail.com"
$env:SMTP_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host "Contraseña SMTP" -AsSecureString)).Password
py app.py
```

Usa las credenciales SMTP que indique tu proveedor. `SMTP_FROM` es opcional y por defecto se usa `SMTP_USER`. Las alertas se envían a la dirección de correo registrada en la cuenta. Si cierras PowerShell, configura de nuevo las variables antes de volver a iniciar el servidor.

El historial distingue el guardado local del resultado SMTP. La aceptación por SMTP indica que el servidor aceptó el mensaje, y la recepción se verifica en la bandeja del contacto. Las fotos se conservan localmente. Este proyecto usa correo como canal de notificación.

## Configurar WhatsApp Business

El destinatario incluye el WhatsApp de la cuenta y todos los contactos de emergencia. Para envíos automáticos se necesita una cuenta de Meta Business, una aplicación con WhatsApp Cloud API, un número remitente configurado, el **Phone Number ID** de Meta, un token de acceso y una plantilla aprobada. El botón de pánico y las alertas detectadas envían el aviso al guardar; el botón de ubicación envía la dirección y el enlace GPS. Sin Cloud API, los botones de contacto y ubicación ofrecen abrir WhatsApp con el mensaje preparado, pero debes pulsar **Enviar** en WhatsApp. Un número telefónico o un enlace `wa.me` no permiten envíos automáticos. La plantilla debe tener tres campos de texto en el cuerpo, en este orden: tipo de alerta, dirección y enlace del mapa. Por ejemplo: `Alerta: {{1}}. Lugar: {{2}}. Mapa: {{3}}.`. Configura las credenciales en PowerShell antes de iniciar el servidor; nunca guardes el token en el código ni lo compartas:

```powershell
$env:WHATSAPP_API_VERSION = "vXX.0" # reemplaza por una versión vigente de Graph API
$env:WHATSAPP_PHONE_NUMBER_ID = "ID_DEL_NUMERO"
$env:WHATSAPP_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", (Read-Host "Token de acceso de WhatsApp" -AsSecureString)).Password
$env:WHATSAPP_TEMPLATE = "nombre_de_plantilla_aprobada"
$env:WHATSAPP_TEMPLATE_LANGUAGE = "es"
py app.py
```

El historial indica por separado si cada canal está sin configurar, falló o aceptó la alerta. Si falta configuración, la aplicación indica qué nombres de variables no llegaron al servidor, sin mostrar sus valores; si Meta rechaza el envío, muestra su código y motivo. La API puede aceptar el envío sin que eso garantice su entrega al destinatario. El número registrado debe estar autorizado como destinatario de WhatsApp Business.

La aplicación admite una sola cuenta local. Conserva `datos/alertas.sqlite3`: contiene la cuenta, el historial y las evidencias. No existe recuperación automática de contraseña; mantén segura la carpeta de datos y el equipo. Usa este prototipo en una demostración controlada, con consentimiento de quienes aparezcan en la cámara. Mantén la aplicación en localhost.
