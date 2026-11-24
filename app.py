import base64
import binascii
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("ALARMA_DB", ROOT / "datos" / "alertas.sqlite3"))
PORT = int(os.environ.get("ALARMA_PORT", 8000))
LIMIT = 6_000_000
PASSWORD_ITERATIONS = 600_000
SESSION_TTL = 8 * 60 * 60
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


def initialize():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DB)) as db, db:
        db.execute("""CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY, created TEXT NOT NULL, kind TEXT NOT NULL,
            address TEXT NOT NULL, lat REAL, lon REAL, delivery TEXT NOT NULL
        )""")
        columns = {row[1] for row in db.execute("PRAGMA table_info(alerts)")}
        if "details" not in columns:
            db.execute("ALTER TABLE alerts ADD COLUMN details TEXT NOT NULL DEFAULT ''")
        db.execute("""CREATE TABLE IF NOT EXISTS photos (
            alert_id TEXT NOT NULL REFERENCES alerts(id), position INTEGER NOT NULL,
            jpeg BLOB NOT NULL, PRIMARY KEY(alert_id, position)
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL UNIQUE,
            password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
            whatsapp TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS emergency_contacts (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, whatsapp TEXT NOT NULL
        )""")
        account = db.execute("SELECT whatsapp FROM users WHERE id=1").fetchone()
        if account:
            try:
                local_number, _ = normalize_whatsapp(account[0])
            except ValueError:
                pass
            else:
                if account[0] != local_number:
                    db.execute("UPDATE users SET whatsapp=? WHERE id=1", (local_number,))


def password_digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)


def normalize_whatsapp(value):
    if not isinstance(value, str):
        raise ValueError("Número de WhatsApp inválido")
    digits = re.sub(r"\D", "", value)
    if re.fullmatch(r"09\d{8}", digits):
        local_number = digits
        api_number = "593" + digits[1:]
    elif re.fullmatch(r"9\d{8}", digits):
        local_number = "0" + digits
        api_number = "593" + digits
    elif re.fullmatch(r"5939\d{8}", digits):
        local_number = "0" + digits[3:]
        api_number = digits
    else:
        raise ValueError("Usa el formato ecuatoriano 09XXXXXXXX")
    return local_number, api_number


def has_account():
    with closing(sqlite3.connect(DB)) as db:
        return db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None


def deliver_email(subject, address, maps, recipient, details):
    host = os.getenv("SMTP_HOST")
    sender = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER")
    if not all((host, recipient, sender)):
        return "Correo: SMTP sin configurar"
    try:
        message = EmailMessage()
        message["From"] = sender
        message["To"] = recipient
        message["Subject"] = subject
        detail_text = f"\nDetalle detectado: {details}" if details else ""
        message.set_content(f"{subject}\nDirección: {address or 'No indicada'}\n"
                            f"{detail_text}\n"
                            f"Mapa: {maps or 'Ubicación no disponible'}")
        with smtplib.SMTP_SSL(host, int(os.getenv("SMTP_PORT", "465")), timeout=10) as smtp:
            if os.getenv("SMTP_USER"):
                smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            smtp.send_message(message)
        return "Correo: aceptado por el servidor"
    except (OSError, smtplib.SMTPException, ValueError, KeyError):
        return "Correo: falló el envío"


def deliver_whatsapp(subject, address, maps, recipient, details):
    required_settings = (
        ("version", "WHATSAPP_API_VERSION"),
        ("phone_id", "WHATSAPP_PHONE_NUMBER_ID"),
        ("token", "WHATSAPP_ACCESS_TOKEN"),
        ("template", "WHATSAPP_TEMPLATE"),
    )
    settings = {
        key: os.getenv(env_name, "")
        for key, env_name in required_settings
    }
    missing = [env_name for key, env_name in required_settings if not settings[key]]
    if missing:
        return ("WhatsApp: requiere API oficial de Meta; faltan variables en el servidor: "
                + ", ".join(missing))
    if not re.fullmatch(r"v\d+\.\d+", settings["version"]):
        return "WhatsApp: versión de API inválida"
    try:
        _, api_recipient = normalize_whatsapp(recipient)
        alert_text = (
            subject
            if not details or details.casefold().startswith(subject.casefold())
            else f"{subject}: {details}"
        )
        payload = {
            "messaging_product": "whatsapp",
            "to": api_recipient,
            "type": "template",
            "template": {
                "name": settings["template"],
                "language": {"code": os.getenv("WHATSAPP_TEMPLATE_LANGUAGE", "es")},
                "components": [{
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": alert_text},
                        {"type": "text", "text": address or "No indicada"},
                        {"type": "text", "text": maps or "Ubicación no disponible"},
                    ],
                }],
            },
        }
        request = Request(
            f"https://graph.facebook.com/{settings['version']}/{settings['phone_id']}/messages",
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {settings['token']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlopen(request, timeout=10):
            return "WhatsApp: aceptado por la API"
    except HTTPError as error:
        try:
            response = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            response = {}
        api_error = response.get("error", {})
        if isinstance(api_error, dict) and api_error.get("message"):
            code = api_error.get("code")
            code_text = f", código {code}" if code is not None else ""
            return f"WhatsApp: Meta rechazó el envío (HTTP {error.code}{code_text}): {api_error['message']}"
        return f"WhatsApp: la API rechazó el envío (HTTP {error.code})"
    except URLError as error:
        return f"WhatsApp: no se pudo conectar con Meta ({error.reason})"
    except OSError:
        return "WhatsApp: error de red o tiempo agotado al conectar con Meta"
    except ValueError:
        return "WhatsApp: configuración inválida"


def deliver(kind, address, lat, lon, details, email, whatsapp):
    subject = {
        "amenaza": "Amenaza verbal detectada",
        "posible": "Posible agresión — revisar",
        "panico": "Alarma de pánico activada",
    }.get(kind, "Alerta detectada")
    maps = f"https://www.google.com/maps?q={lat},{lon}" if lat is not None else ""
    results = [
        deliver_email(subject, address, maps, email, details),
    ]
    with closing(sqlite3.connect(DB)) as db:
        recipients = [whatsapp]
        recipients.extend(
            row[0] for row in db.execute("SELECT whatsapp FROM emergency_contacts")
        )
    sent = set()
    for recipient in recipients:
        local_number, _ = normalize_whatsapp(recipient)
        if local_number in sent:
            continue
        sent.add(local_number)
        results.append(deliver_whatsapp(subject, address, maps, recipient, details))
    return " · ".join(results)


def deliver_location(address, lat, lon, primary_whatsapp):
    maps = f"https://www.google.com/maps?q={lat},{lon}" if lat is not None else ""
    with closing(sqlite3.connect(DB)) as db:
        recipients = [primary_whatsapp]
        recipients.extend(
            row[0] for row in db.execute("SELECT whatsapp FROM emergency_contacts")
        )
    results = []
    sent = set()
    for recipient in recipients:
        local_number, _ = normalize_whatsapp(recipient)
        if local_number in sent:
            continue
        sent.add(local_number)
        results.append(
            deliver_whatsapp("Ubicación compartida", address, maps, recipient, "")
        )
    return " · ".join(results)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type="application/json", headers=None):
        if content_type == "application/json":
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_payload(self, max_size=16_000):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= max_size or self.headers.get_content_type() != "application/json":
            raise ValueError()
        payload = json.loads(self.rfile.read(size))
        if not isinstance(payload, dict):
            raise ValueError()
        return payload

    def session_token(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get("alarma_session")
        token = morsel.value if morsel else ""
        with SESSIONS_LOCK:
            expiry = SESSIONS.get(token)
            if expiry and expiry > time.time():
                return token
            SESSIONS.pop(token, None)
        return None

    def create_session(self):
        token = secrets.token_urlsafe(32)
        with SESSIONS_LOCK:
            SESSIONS[token] = time.time() + SESSION_TTL
        return {
            "Set-Cookie": f"alarma_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}"
        }

    def guard(self):
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in {f"localhost:{PORT}", f"127.0.0.1:{PORT}"} or (
            origin and origin != f"http://{host}"
        ):
            self.reply(403, {"error": "Origen no permitido"})
            return False
        return True

    def do_GET(self):
        if not self.guard():
            return
        path = urlsplit(self.path).path
        assets = {
            "/": ("index.html", "text/html"),
            "/app.js": ("app.js", "text/javascript"),
            "/tracker.js": ("tracker.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"),
        }
        if path in assets:
            name, mime = assets[path]
            self.reply(200, (ROOT / "static" / name).read_bytes(), mime + "; charset=utf-8")
            return
        if path == "/api/session":
            authenticated = self.session_token() is not None
            account = None
            contacts = []
            if authenticated:
                with closing(sqlite3.connect(DB)) as db:
                    row = db.execute("SELECT email, whatsapp FROM users WHERE id=1").fetchone()
                    contacts = [
                        {"id": contact_id, "name": name, "whatsapp": whatsapp}
                        for contact_id, name, whatsapp in db.execute(
                            "SELECT id,name,whatsapp FROM emergency_contacts ORDER BY name"
                        )
                    ]
                if row:
                    try:
                        local_number, _ = normalize_whatsapp(row[1])
                    except ValueError:
                        local_number = row[1]
                    account = {"email": row[0], "whatsapp": local_number}
                else:
                    authenticated = False
            self.reply(200, {
                "authenticated": authenticated,
                "setup_required": not has_account(),
                "account": account,
                "contacts": contacts,
            })
            return
        if path != "/api/alertas" and not path.startswith("/api/foto/"):
            self.reply(404, {"error": "Recurso no encontrado"})
            return
        if self.session_token() is None:
            self.reply(401, {"error": "Inicia sesión para continuar"})
            return
        with closing(sqlite3.connect(DB)) as db:
            db.row_factory = sqlite3.Row
            if path == "/api/alertas":
                rows = [dict(row) for row in db.execute("""
                    SELECT alerts.*, (SELECT COUNT(*) FROM photos WHERE alert_id = alerts.id) count
                    FROM alerts WHERE kind IN ('posible','amenaza','panico') ORDER BY created DESC LIMIT 100
                """)]
                self.reply(200, rows)
                return
            parts = path.split("/")
            if len(parts) == 5 and parts[1:3] == ["api", "foto"] and parts[4] in {"0", "1", "2"}:
                row = db.execute("SELECT jpeg FROM photos WHERE alert_id=? AND position=?",
                                 (parts[3], parts[4])).fetchone()
                if row:
                    self.reply(200, row["jpeg"], "image/jpeg")
                    return
        self.reply(404, {"error": "Recurso no encontrado"})

    def do_POST(self):
        if not self.guard():
            return
        path = urlsplit(self.path).path
        if path == "/api/emergency-contacts":
            if self.session_token() is None:
                self.reply(401, {"error": "Inicia sesión para administrar contactos"})
                return
            try:
                payload = self.read_payload()
                name = payload["name"].strip()
                whatsapp, _ = normalize_whatsapp(payload["whatsapp"])
                if not name or len(name) > 80:
                    raise ValueError()
                contact_id = secrets.token_hex(16)
                with closing(sqlite3.connect(DB)) as db, db:
                    db.execute(
                        "INSERT INTO emergency_contacts (id,name,whatsapp) VALUES (?,?,?)",
                        (contact_id, name, whatsapp),
                    )
                self.reply(201, {"id": contact_id, "name": name, "whatsapp": whatsapp})
            except (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError):
                self.reply(400, {"error": "Nombre o número de WhatsApp inválido"})
            return
        if path == "/api/whatsapp/location":
            if self.session_token() is None:
                self.reply(401, {"error": "Inicia sesión para compartir ubicación"})
                return
            try:
                payload = self.read_payload()
                address = payload["address"].strip()
                lat, lon = payload.get("lat"), payload.get("lon")
                if not address or len(address) > 250:
                    raise ValueError()
                if lat is not None or lon is not None:
                    if not all(isinstance(value, (float, int)) and math.isfinite(value)
                               and abs(value) <= bound
                               for value, bound in [(lat, 90), (lon, 180)]):
                        raise ValueError()
                with closing(sqlite3.connect(DB)) as db:
                    account = db.execute("SELECT whatsapp FROM users WHERE id=1").fetchone()
                if not account:
                    self.reply(401, {"error": "No hay una cuenta configurada"})
                    return
            except (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError):
                self.reply(400, {"error": "Dirección o coordenadas inválidas"})
                return
            self.reply(200, {
                "delivery": deliver_location(address, lat, lon, account[0]),
            })
            return
        if path == "/api/whatsapp/contact":
            if self.session_token() is None:
                self.reply(401, {"error": "Inicia sesión para enviar una alerta"})
                return
            try:
                payload = self.read_payload()
                contact_id = payload["contact_id"]
                address = payload["address"].strip()
                lat, lon = payload.get("lat"), payload.get("lon")
                if (not re.fullmatch(r"[0-9a-f]{32}", contact_id)
                        or not address or len(address) > 250):
                    raise ValueError()
                if lat is not None or lon is not None:
                    if not all(isinstance(value, (float, int)) and math.isfinite(value)
                               and abs(value) <= bound
                               for value, bound in [(lat, 90), (lon, 180)]):
                        raise ValueError()
                with closing(sqlite3.connect(DB)) as db:
                    contact = db.execute(
                        "SELECT whatsapp FROM emergency_contacts WHERE id=?",
                        (contact_id,),
                    ).fetchone()
                if not contact:
                    self.reply(404, {"error": "Contacto de emergencia no encontrado"})
                    return
            except (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError):
                self.reply(400, {"error": "Dirección, contacto o coordenadas inválidas"})
                return
            maps = f"https://www.google.com/maps?q={lat},{lon}" if lat is not None else ""
            self.reply(200, {
                "delivery": deliver_whatsapp(
                    "Alarma de pánico activada",
                    address,
                    maps,
                    contact[0],
                    "",
                ),
            })
            return
        if path == "/api/register":
            if has_account():
                self.reply(409, {"error": "La cuenta ya está creada; inicia sesión"})
                return
            try:
                payload = self.read_payload()
                email = payload["email"].strip().lower()
                password = payload["password"]
                whatsapp, _ = normalize_whatsapp(payload["whatsapp"])
                if (len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email)
                        or not isinstance(password, str) or not 8 <= len(password) <= 128):
                    raise ValueError()
                salt = secrets.token_bytes(16)
                digest = password_digest(password, salt)
                with closing(sqlite3.connect(DB)) as db, db:
                    db.execute(
                        "INSERT INTO users (id,email,password_salt,password_hash,whatsapp) "
                        "VALUES (1,?,?,?,?)",
                        (email, salt.hex(), digest.hex(), whatsapp),
                    )
            except sqlite3.IntegrityError:
                self.reply(409, {"error": "La cuenta ya está creada; inicia sesión"})
                return
            except (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError):
                self.reply(400, {
                    "error": "Revisa el correo, la contraseña (8 caracteres mínimo) y el número internacional de WhatsApp"
                })
                return
            self.reply(201, {"authenticated": True}, headers=self.create_session())
            return
        if path == "/api/login":
            try:
                payload = self.read_payload()
                email = payload["email"].strip().lower()
                password = payload["password"]
                if not isinstance(password, str) or len(password) > 128:
                    raise ValueError()
                with closing(sqlite3.connect(DB)) as db:
                    row = db.execute(
                        "SELECT password_salt,password_hash FROM users WHERE id=1 AND email=?",
                        (email,),
                    ).fetchone()
                if not row or not hmac.compare_digest(
                    password_digest(password, bytes.fromhex(row[0])).hex(), row[1]
                ):
                    self.reply(401, {"error": "Correo o contraseña incorrectos"})
                    return
            except (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError):
                self.reply(400, {"error": "Datos de inicio de sesión inválidos"})
                return
            self.reply(200, {"authenticated": True}, headers=self.create_session())
            return
        if path == "/api/logout":
            token = self.session_token()
            if token:
                with SESSIONS_LOCK:
                    SESSIONS.pop(token, None)
            self.reply(200, {"authenticated": False}, headers={
                "Set-Cookie": "alarma_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
            })
            return
        if path != "/api/alertas":
            self.reply(404, {"error": "Recurso no encontrado"})
            return
        token = self.session_token()
        if token is None:
            self.reply(401, {"error": "Inicia sesión para enviar alertas"})
            return
        try:
            payload = self.read_payload(LIMIT)
            alert_id, kind = payload["id"], payload["kind"]
            if (len(alert_id) != 36 or any(c not in "0123456789abcdef-" for c in alert_id)
                    or kind not in {"posible", "amenaza", "panico"}):
                raise ValueError()
            address = payload["address"].strip()
            if len(address) > 250:
                raise ValueError()
            details = payload.get("details", "").strip()
            if len(details) > 250 or (kind == "amenaza" and not details):
                raise ValueError()
            lat, lon = payload.get("lat"), payload.get("lon")
            if lat is not None or lon is not None:
                if not all(isinstance(v, (float, int)) and math.isfinite(v)
                           and abs(v) <= bound for v, bound in [(lat, 90), (lon, 180)]):
                    raise ValueError()
            photos = payload["photos"]
            if not isinstance(photos, list) or len(photos) > 3:
                raise ValueError()
            photos = [base64.b64decode(photo, validate=True) for photo in photos]
            if any(not photo.startswith(b"\xff\xd8\xff") or not photo.endswith(b"\xff\xd9")
                   or len(photo) > 1_500_000 for photo in photos):
                raise ValueError()
        except (ValueError, TypeError, AttributeError, KeyError, binascii.Error, json.JSONDecodeError):
            self.reply(400, {"error": "Datos de alerta inválidos"})
            return
        with closing(sqlite3.connect(DB)) as db:
            account = db.execute("SELECT email, whatsapp FROM users WHERE id=1").fetchone()
            if not account:
                self.reply(401, {"error": "No hay una cuenta configurada"})
                return
            with db:
                insert = db.execute("""
                    INSERT OR IGNORE INTO alerts
                    (id,created,kind,address,lat,lon,delivery,details)
                    VALUES (?,?,?,?,?,?,?,?)
                """, (alert_id, datetime.now(timezone.utc).isoformat(),
                      kind, address, lat, lon, "Procesando avisos", details))
                created = insert.rowcount == 1
                if created:
                    db.executemany("INSERT INTO photos VALUES (?,?,?)",
                                   [(alert_id, index, photo) for index, photo in enumerate(photos)])
            if created:
                status = deliver(kind, address, lat, lon, details, account[0], account[1])
                with db:
                    db.execute("UPDATE alerts SET delivery=? WHERE id=?", (status, alert_id))
            else:
                status = db.execute("SELECT delivery FROM alerts WHERE id=?", (alert_id,)).fetchone()[0]
        self.reply(201 if created else 200, {"delivery": status})

    def do_DELETE(self):
        if not self.guard():
            return
        if self.session_token() is None:
            self.reply(401, {"error": "Inicia sesión para eliminar evidencias"})
            return
        path = urlsplit(self.path).path
        if path == "/api/fotos":
            with closing(sqlite3.connect(DB)) as db, db:
                deleted_photos = db.execute("DELETE FROM photos").rowcount
                deleted_alerts = db.execute("DELETE FROM alerts").rowcount
            self.reply(200, {
                "deleted_alerts": deleted_alerts,
                "deleted_photos": deleted_photos,
            })
            return
        match = re.fullmatch(r"/api/alertas/([0-9a-f-]{36})", path)
        if match:
            alert_id = match.group(1)
            with closing(sqlite3.connect(DB)) as db:
                deleted_photos = db.execute(
                    "DELETE FROM photos WHERE alert_id=?", (alert_id,)
                ).rowcount
                deleted_alerts = db.execute(
                    "DELETE FROM alerts WHERE id=?", (alert_id,)
                ).rowcount
            self.reply(200, {
                "deleted_alerts": deleted_alerts,
                "deleted_photos": deleted_photos,
            })
            return
        self.reply(404, {"error": "Recurso no encontrado"})
